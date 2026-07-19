/**
 * FormTitan 2FA login (id + password + SMS code) -> session tokens.
 *
 * Flow (decoded from recordings):
 *   1. POST smart-v/request {step:"email", credentials} -> server sends the SMS code.
 *   2. POST smart-v/request {step:"code", password:<sms code>, credentials} -> returns
 *      accessToken + accessSalt (704-hex each), which ARE the session header VALUES the app
 *      sends on every /webprojects/ call, under stable project header names:
 *        accessToken -> kbgr8jmwl3r1ffbw3nilg,  accessSalt -> tc4gftmj5twjryy3bxcbqs3n
 *
 * These builders return {url,method,headers,body}; the caller executes them via the content
 * script's API_FETCH (same-origin on ifcjil.formtitan.com - cookies + correct Origin). The
 * verify response is turned into the same `ftAuth` shape the recorder harvests, so downstream
 * API calls don't care whether the session came from harvesting or from this login.
 *
 * Credentials are supplied by the caller (from Settings) and never stored here.
 */
const SMARTV_URL = 'https://ifcjil.formtitan.com/webprojects/smart-v/request';
export const HOME_URL = 'https://ifcjil.formtitan.com/ftproject/ifcjaid/IFCJAIDHOME';

// Stable per-project session header names (verified identical across sessions/recordings).
export const SESSION_HEADERS = {
  accessToken: 'kbgr8jmwl3r1ffbw3nilg',
  accessSalt: 'tc4gftmj5twjryy3bxcbqs3n',
};

function credentials(idNo, password) {
  return { Id_no__c: String(idNo ?? ''), Personal_password__c: String(password ?? '') };
}

function baseHeaders(fturl) {
  return { 'Content-Type': 'application/json', fturl };
}

/** Step 1: trigger the SMS code for these credentials. */
export function buildSmsRequest(idNo, password, fturl = HOME_URL) {
  return {
    url: SMARTV_URL,
    method: 'POST',
    headers: baseHeaders(fturl),
    body: JSON.stringify({ type: 'sfsmartv', credentials: credentials(idNo, password), token: null, step: 'email' }),
  };
}

/** Step 2: submit the SMS code; the response carries the session tokens. */
export function buildVerifyRequest(idNo, password, smsCode, fturl = HOME_URL) {
  return {
    url: SMARTV_URL,
    method: 'POST',
    headers: baseHeaders(fturl),
    body: JSON.stringify({ type: 'sfsmartv', password: String(smsCode ?? ''), credentials: credentials(idNo, password), step: 'code' }),
  };
}

/** Turns the step:code response text into { ok, auth } (the ftAuth to persist) or { ok:false, error }. */
export function parseVerifyResponse(text, fturl = HOME_URL) {
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: 'תשובת שרת לא תקינה' };
  }
  if (!json?.accessToken || !json?.accessSalt) {
    const msg = json?.messages && Object.keys(json.messages).length ? JSON.stringify(json.messages) : '';
    return { ok: false, error: msg ? msg.slice(0, 200) : 'הקוד שגוי או שההתחברות נכשלה' };
  }
  return {
    ok: true,
    auth: {
      headers: {
        [SESSION_HEADERS.accessToken]: json.accessToken,
        [SESSION_HEADERS.accessSalt]: json.accessSalt,
        fturl,
      },
      ts: new Date().toISOString(),
      via: 'login',
    },
  };
}
