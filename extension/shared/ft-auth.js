/**
 * Session auth for direct FormTitan API calls.
 *
 * FormTitan authenticates each /webprojects/ call with a set of custom, session-specific
 * request headers (dynamically-named tokens like `kbgr8jmwl3r1ffbw3nilg`, `sfauthhash`, plus
 * `fturl`) issued after the operator's SMS login - NOT cookies. The recorder content scripts
 * harvest these headers from the page's own traffic and persist the latest set to
 * `chrome.storage.local.ftAuth`. We replay them on our own requests instead of reimplementing
 * login. They expire, so a captured set can go stale; callers should surface an auth error and
 * prompt the operator to re-open/refresh the site (which re-harvests a fresh set).
 */
export async function getFtAuth() {
  const { ftAuth } = await chrome.storage.local.get('ftAuth');
  return ftAuth || null;
}

export async function clearFtAuth() {
  await chrome.storage.local.remove('ftAuth');
}
