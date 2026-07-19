/**
 * API traffic recorder – MAIN-world content script (document_start).
 *
 * Patches window.fetch and XMLHttpRequest in the page's own JS world so we can see the
 * FormTitan app's API calls *including request/response bodies and custom auth headers*
 * (sfauthhash etc.) - none of which DevTools HAR exports preserve across navigations.
 * Each captured call is posted to the isolated-world bridge (recorder-bridge.js) via
 * window.postMessage; the bridge forwards to the background, which persists only while
 * recording is enabled from the popup. Patching is unconditional but records only
 * /webprojects/ calls on this origin - negligible overhead when recording is off.
 */
(() => {
  if (window.__ftApiRecorderInstalled) return;
  window.__ftApiRecorderInstalled = true;

  const MAX_BODY = 300 * 1024; // per-body cap, keeps storage sane
  const MARK = '__ftApiRecord';

  const shouldRecord = (url) => {
    try {
      const u = new URL(url, location.href);
      return u.hostname.includes('formtitan.com') && u.pathname.includes('/webprojects/');
    } catch (e) {
      return false;
    }
  };

  const cap = (s) => {
    const str = String(s ?? '');
    return str.length > MAX_BODY ? str.slice(0, MAX_BODY) + `…[truncated ${str.length}B]` : str;
  };

  const post = (entry) => {
    try {
      window.postMessage({ [MARK]: true, entry }, location.origin);
    } catch (e) {}
  };

  const bodyToText = async (body) => {
    if (body == null) return '';
    if (typeof body === 'string') return body;
    if (body instanceof FormData) {
      const parts = [];
      for (const [k, v] of body.entries()) parts.push(`${k}=${typeof v === 'string' ? v : '[file]'}`);
      return 'FormData: ' + parts.join('\n');
    }
    if (body instanceof URLSearchParams) return body.toString();
    if (body instanceof Blob) {
      try { return await body.text(); } catch (e) { return '[blob]'; }
    }
    try { return JSON.stringify(body); } catch (e) { return String(body); }
  };

  // ---- fetch ----
  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : input?.url || String(input);
    if (!shouldRecord(url)) return origFetch.apply(this, arguments);

    const method = (init?.method || (typeof input === 'object' && input?.method) || 'GET').toUpperCase();
    const headers = {};
    try {
      const h = init?.headers || (typeof input === 'object' && input?.headers);
      if (h instanceof Headers) for (const [k, v] of h.entries()) headers[k] = v;
      else if (Array.isArray(h)) for (const [k, v] of h) headers[k] = v;
      else if (h) Object.assign(headers, h);
    } catch (e) {}
    const reqBody = await bodyToText(init?.body);

    const started = Date.now();
    const res = await origFetch.apply(this, arguments);
    const entry = {
      ts: new Date(started).toISOString(),
      via: 'fetch',
      page: location.href,
      method,
      url: new URL(url, location.href).href,
      requestHeaders: headers,
      requestBody: cap(reqBody),
      status: res.status,
      responseHeaders: { 'content-type': res.headers.get('content-type') || '' },
      durationMs: Date.now() - started,
    };
    const ctype = entry.responseHeaders['content-type'];
    if (ctype.includes('text/event-stream')) {
      entry.responseBody = '[sse stream - not captured]';
      post(entry);
    } else {
      // Read the body from a clone so the page still consumes its own copy untouched.
      res.clone().text().then(
        (t) => { entry.responseBody = cap(t); post(entry); },
        () => { entry.responseBody = '[unreadable]'; post(entry); }
      );
    }
    return res;
  };

  // ---- XMLHttpRequest ----
  const OrigXHR = window.XMLHttpRequest;
  const openOrig = OrigXHR.prototype.open;
  const sendOrig = OrigXHR.prototype.send;
  const setHeaderOrig = OrigXHR.prototype.setRequestHeader;

  OrigXHR.prototype.open = function (method, url) {
    this.__ftRec = shouldRecord(url) ? { method: String(method).toUpperCase(), url: new URL(url, location.href).href, headers: {} } : null;
    return openOrig.apply(this, arguments);
  };
  OrigXHR.prototype.setRequestHeader = function (name, value) {
    if (this.__ftRec) this.__ftRec.headers[name] = value;
    return setHeaderOrig.apply(this, arguments);
  };
  OrigXHR.prototype.send = function (body) {
    const rec = this.__ftRec;
    if (rec) {
      const started = Date.now();
      bodyToText(body).then((reqBody) => { rec.requestBody = cap(reqBody); });
      this.addEventListener('loadend', () => {
        let respText = '';
        try {
          respText = this.responseType === '' || this.responseType === 'text' ? this.responseText : `[responseType=${this.responseType}]`;
        } catch (e) {
          respText = '[unreadable]';
        }
        post({
          ts: new Date(started).toISOString(),
          via: 'xhr',
          page: location.href,
          method: rec.method,
          url: rec.url,
          requestHeaders: rec.headers,
          requestBody: rec.requestBody || '',
          status: this.status,
          responseHeaders: { 'content-type': this.getResponseHeader?.('content-type') || '' },
          responseBody: cap(respText),
          durationMs: Date.now() - started,
        });
      });
    }
    return sendOrig.apply(this, arguments);
  };
})();
