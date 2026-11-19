/**
 * Session auth for direct FormTitan API calls.
 *
 * FormTitan authenticates each /webprojects/ call with a set of custom, session-specific
 * request headers (dynamically-named tokens like `kbgr8jmwl3r1ffbw3nilg`, `sfauthhash`, plus
 * `fturl`) issued after the operator's SMS login - NOT cookies. The side panel's "🔑 התחבר"
 * login (ft-login.js) persists them to `chrome.storage.local.ftAuth`, and we replay them on our
 * own requests. They expire; callers should surface an auth error and prompt the operator to
 * log in again.
 */
export async function getFtAuth() {
  const { ftAuth } = await chrome.storage.local.get('ftAuth');
  return ftAuth || null;
}

export async function clearFtAuth() {
  await chrome.storage.local.remove('ftAuth');
}
