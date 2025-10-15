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
    startFollowerScan(sendResponse);
    return true; // Indicates async response
  }
  
  if (request.action === 'getStats') {
    getStoredStats(sendResponse);
    return true;
  }
});

async function startFollowerScan(sendResponse) {
  try {
    // Get current X username by checking active tab or stored preference
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    // Create a new tab to scan followers
    const scanTab = await chrome.tabs.create({
      url: 'https://x.com/YOUR_USERNAME/followers',
      active: false
    });

    // Wait for page to load, then inject content script
    chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
      if (tabId === scanTab.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        
        // Inject the scraper
        chrome.scripting.executeScript({
          target: { tabId: scanTab.id },
          files: ['scraper.js']
        }).then(() => {
          sendResponse({ status: 'scanning' });
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