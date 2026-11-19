chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// The API traffic recorder was removed - drop its stored log/flag from older installs.
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.remove(['apiTrafficLog', 'apiRecording']).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'GET_ACTIVE_TAB') {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      sendResponse({ tabId: tab?.id, url: tab?.url });
    });
    return true;
  }
  return false;
});
