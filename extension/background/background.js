chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

const MAX_LOG_ENTRIES = 1000;

// Appends run through a promise chain so entries arriving concurrently from multiple
// frames don't clobber each other in the read-modify-write against storage.
let appendChain = Promise.resolve();

function appendApiEntry(entry) {
  appendChain = appendChain.then(async () => {
    const { apiRecording, apiTrafficLog } = await chrome.storage.local.get(['apiRecording', 'apiTrafficLog']);
    if (!apiRecording) return;
    const log = apiTrafficLog || [];
    log.push(entry);
    if (log.length > MAX_LOG_ENTRIES) log.splice(0, log.length - MAX_LOG_ENTRIES);
    await chrome.storage.local.set({ apiTrafficLog: log });
  }).catch(() => {});
  return appendChain;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'GET_ACTIVE_TAB') {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      sendResponse({ tabId: tab?.id, url: tab?.url });
    });
    return true;
  }
  if (message.type === 'RECORD_API_ENTRY') {
    appendApiEntry(message.entry).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message.type === 'SAVE_FT_AUTH') {
    chrome.storage.local.set({ ftAuth: message.auth }).then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});
