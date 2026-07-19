/**
 * API traffic bridge (isolated world, document_start, all frames).
 *
 * Receives captured API calls from recorder-page.js (MAIN world) and:
 *  1. ALWAYS harvests the page's session auth headers to storage (ft-auth.js reads them for
 *     direct API calls) - this must work even when the debug recorder is off.
 *  2. Forwards full entries to the background traffic log ONLY while recording is enabled.
 */
(() => {
  let recording = false;
  let lastAuthSig = '';

  chrome.storage.local.get('apiRecording').then(({ apiRecording }) => {
    recording = Boolean(apiRecording);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && 'apiRecording' in changes) {
      recording = Boolean(changes.apiRecording.newValue);
    }
  });

  // Browser-managed / forbidden headers we must NOT replay (fetch sets its own).
  const SKIP = new Set([
    'content-type', 'content-length', 'cookie', 'host', 'origin', 'connection', 'accept-encoding',
  ]);

  /** Keep the app-set headers that carry auth (custom names + long token values + fturl),
   * drop the browser-managed ones. Returns null if no real token header is present. */
  function extractAuth(headers) {
    const out = {};
    let hasToken = false;
    for (const [name, value] of Object.entries(headers || {})) {
      const n = String(name).toLowerCase();
      if (SKIP.has(n) || n.startsWith(':')) continue;
      out[name] = value;
      if (value && String(value).length > 40) hasToken = true; // a token, not accept/cache-control
    }
    return hasToken ? out : null;
  }

  function harvestAuth(entry) {
    if (!/\/webprojects\//.test(entry.url || '')) return;
    const auth = extractAuth(entry.requestHeaders);
    if (!auth) return;
    const sig = JSON.stringify(auth);
    if (sig === lastAuthSig) return; // unchanged - avoid redundant writes; re-saves on token refresh
    lastAuthSig = sig;
    try {
      chrome.runtime.sendMessage({
        type: 'SAVE_FT_AUTH',
        auth: { headers: auth, page: entry.page, ts: entry.ts || new Date().toISOString() },
      });
    } catch (e) {}
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.__ftApiRecord !== true) return;
    const entry = event.data.entry;
    harvestAuth(entry); // always
    if (!recording) return;
    try {
      chrome.runtime.sendMessage({ type: 'RECORD_API_ENTRY', entry });
    } catch (e) {
      // Extension reloaded mid-page - context gone; nothing to do.
    }
  });
})();
