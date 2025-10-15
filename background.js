// ============================================
// FILE: background.js
// ============================================
// Background service worker for the extension

chrome.runtime.onInstalled.addListener(() => {
  console.log('X Unfollow Tracker installed');
  
  // Initialize storage
  chrome.storage.local.get(['followers', 'lastCheck'], (result) => {
    if (!result.followers) {
      chrome.storage.local.set({
        followers: [],
        unfollowers: [],
        newFollowers: [],
        lastCheck: null,
        scanHistory: []
      });
    }
  });
});

// Listen for messages from popup or content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'startScan') {
    // Accept username from popup or use stored username
    const username = request.username;
    startFollowerScan(sendResponse, username);
    return true; // Indicates async response
  }

  if (request.action === 'getStats') {
    getStoredStats(sendResponse);
    return true;
  }

  // Messages from content script
  if (request.action === 'scanComplete') {
    // Update scanHistory
    chrome.storage.local.get(['scanHistory'], (res) => {
      const history = res.scanHistory || [];
      history.unshift({ timestamp: Date.now(), stats: request.stats || {} });
      if (history.length > 50) history.length = 50;
      chrome.storage.local.set({ scanHistory: history });
    });

    // Close the scan tab if provided
    if (request.tabId) {
      try { chrome.tabs.remove(request.tabId); } catch (e) {}
    }

    return;
  }

  if (request.action === 'scanError') {
    console.error('Scan error reported:', request.error);
    chrome.storage.local.set({ lastError: request.error });
    return;
  }
});

async function startFollowerScan(sendResponse, providedUsername) {
  try {
    // Resolve username: provided or stored
    let username = providedUsername;
    if (!username) {
      const stored = await new Promise(resolve => chrome.storage.local.get(['username'], resolve));
      username = stored.username;
    }

    if (!username) {
      sendResponse({ status: 'error', message: 'No username provided or stored' });
      return;
    }

    const followersUrl = `https://x.com/${encodeURIComponent(username)}/followers`;

    // Create a new tab to scan followers (inactive)
    const scanTab = await chrome.tabs.create({ url: followersUrl, active: false });
    const scanTabId = scanTab.id;

    // Wait for page to load, then inject content script
    chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
      if (tabId === scanTabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);

        // Store current scan context for the content script to use if needed
        chrome.storage.local.set({ _currentScanTabId: scanTabId, _currentScanUsername: username }, () => {
          // Inject the scraper
          chrome.scripting.executeScript({
            target: { tabId: scanTabId },
            files: ['scraper.js']
          }).then(() => {
            sendResponse({ status: 'scanning', tabId: scanTabId });
          }).catch(err => {
            sendResponse({ status: 'error', message: err.message });
          });
        });
      }
    });
  } catch (error) {
    sendResponse({ status: 'error', message: error.message });
  }
}

async function getStoredStats(sendResponse) {
  chrome.storage.local.get([
    'followers',
    'unfollowers',
    'newFollowers',
    'lastCheck',
    'scanHistory'
  ], (result) => {
    sendResponse({
      totalFollowers: result.followers?.length || 0,
      unfollowers: result.unfollowers || [],
      newFollowers: result.newFollowers || [],
      lastCheck: result.lastCheck,
      scanHistory: result.scanHistory || []
    });
  });
}