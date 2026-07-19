/**
 * API traffic recorder – isolated-world bridge (document_start, all frames).
 *
 * Receives captured API calls posted by recorder-page.js (MAIN world) and forwards them
 * to the background service worker, which persists them (serialized, capped) only while
 * recording is enabled from the popup. Caches the enabled flag locally so a disabled
 * recorder costs one storage read per page, not one per call.
 */
(() => {
  let recording = false;

  chrome.storage.local.get('apiRecording').then(({ apiRecording }) => {
    recording = Boolean(apiRecording);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && 'apiRecording' in changes) {
      recording = Boolean(changes.apiRecording.newValue);
    }
  });

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.__ftApiRecord !== true) return;
    if (!recording) return;
    try {
      chrome.runtime.sendMessage({ type: 'RECORD_API_ENTRY', entry: event.data.entry });
    } catch (e) {
      // Extension reloaded mid-page - context gone; nothing to do.
    }
  });
})();
