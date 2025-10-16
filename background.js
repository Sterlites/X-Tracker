// ============================================
// FILE: background.js (ENHANCED VERSION)
// ============================================
// Background service worker with followers and following support

chrome.runtime.onInstalled.addListener(() => {
  console.log('[X Unfollow Tracker] Extension installed');
  
  // Initialize storage
  chrome.storage.local.get(['users'], (result) => {
    if (!result.users) {
      chrome.storage.local.set({
        users: {},
        userList: [],
        currentUser: null,
        scanStatus: 'idle'
      });
      console.log('[X Unfollow Tracker] Storage initialized');
    }
  });
});

// Listen for messages from popup or content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('[X Unfollow Tracker] Message received:', request.action);

  if (request.action === 'startScan') {
    const username = request.username;
    const scanType = request.scanType || 'followers';
    startScan(sendResponse, username, scanType);
    return true; // Indicates async response
  }

  if (request.action === 'getStats') {
    getStoredStats(sendResponse);
    return true;
  }

  if (request.action === 'scanComplete') {
    console.log('[X Unfollow Tracker] Scan completed successfully');
    
    chrome.storage.local.set({ 
      scanStatus: 'complete',
      lastScanTime: Date.now()
    });

    return;
  }

  if (request.action === 'scanError') {
    console.error('[X Unfollow Tracker] Scan error:', request.error);
    chrome.storage.local.set({ 
      lastError: request.error,
      scanStatus: 'error'
    });
    return;
  }

  if (request.action === 'scanProgress') {
    chrome.storage.local.set({ 
      scanProgress: request.progress 
    });
    return;
  }
});

async function startScan(sendResponse, providedUsername, scanType) {
  console.log('[X Unfollow Tracker] Starting scan:', scanType, 'for username:', providedUsername);

  try {
    // Validate username
    let username = providedUsername;
    if (!username) {
      const stored = await new Promise(resolve => 
        chrome.storage.local.get(['username'], resolve)
      );
      username = stored.username;
    }

    if (!username) {
      console.error('[X Unfollow Tracker] No username provided');
      sendResponse({ 
        status: 'error', 
        message: 'No username provided. Please enter your X username.' 
      });
      return;
    }

    // Remove @ symbol if present
    username = username.replace('@', '');

    // Build URL based on scan type
    const pageType = scanType === 'following' ? 'following' : 'followers';
    const targetUrl = `https://x.com/${encodeURIComponent(username)}/${pageType}`;
    console.log('[X Unfollow Tracker] Target URL:', targetUrl);
    
    // Get or create tab
    const [currentTab] = await chrome.tabs.query({ 
      active: true, 
      currentWindow: true 
    });

    if (!currentTab?.id) {
      console.error('[X Unfollow Tracker] No active tab found');
      sendResponse({ 
        status: 'error', 
        message: 'No active tab found. Please try again.' 
      });
      return;
    }

    const scanTabId = currentTab.id;

    // Set scanning status
    await new Promise(resolve => {
      chrome.storage.local.set({ 
        scanStatus: 'scanning',
        currentScanType: scanType,
        _currentScanTabId: scanTabId,
        _currentScanUsername: username 
      }, resolve);
    });

    // Navigate to page
    console.log('[X Unfollow Tracker] Navigating to page...');
    await chrome.tabs.update(scanTabId, { url: targetUrl });

    // Wait for page to fully load, then inject scraper
    let listenerAttached = false;
    
    const listener = (tabId, info, tab) => {
      if (tabId !== scanTabId) return;
      
      console.log('[X Unfollow Tracker] Tab status:', info.status, 'URL:', tab.url);

      // Check if we're on the right page and it's fully loaded
      if (info.status === 'complete' && tab.url && 
          (tab.url.includes('/followers') || tab.url.includes('/following'))) {
        if (listenerAttached) {
          chrome.tabs.onUpdated.removeListener(listener);
          listenerAttached = false;
        }

        console.log('[X Unfollow Tracker] Page loaded, injecting scraper...');

        // Small delay to ensure page is fully rendered
        setTimeout(() => {
          chrome.scripting.executeScript({
            target: { tabId: scanTabId },
            files: ['scraper.js']
          }).then(() => {
            console.log('[X Unfollow Tracker] Scraper injected successfully');
            sendResponse({ 
              status: 'scanning', 
              tabId: scanTabId 
            });
          }).catch(err => {
            console.error('[X Unfollow Tracker] Script injection failed:', err);
            chrome.storage.local.set({ scanStatus: 'error' });
            sendResponse({ 
              status: 'error', 
              message: `Failed to inject scraper: ${err.message}` 
            });
          });
        }, 1500);
      }
    };

    chrome.tabs.onUpdated.addListener(listener);
    listenerAttached = true;

    // Safety timeout - remove listener after 30 seconds
    setTimeout(() => {
      if (listenerAttached) {
        chrome.tabs.onUpdated.removeListener(listener);
        console.warn('[X Unfollow Tracker] Listener timeout - page may not have loaded');
      }
    }, 30000);

  } catch (error) {
    console.error('[X Unfollow Tracker] Error starting scan:', error);
    chrome.storage.local.set({ scanStatus: 'error' });
    sendResponse({ 
      status: 'error', 
      message: error.message || 'Failed to start scan' 
    });
  }
}

async function getStoredStats(sendResponse) {
  chrome.storage.local.get([
    'users',
    'currentUser'
  ], (result) => {
    const users = result.users || {};
    const currentUser = result.currentUser;
    const userData = users[currentUser] || {};
    
    sendResponse({
      totalFollowers: userData.followers?.length || 0,
      totalFollowing: userData.following?.length || 0,
      unfollowers: userData.unfollowers || [],
      newFollowers: userData.newFollowers || [],
      lastCheck: userData.lastFollowersCheck || userData.lastFollowingCheck
    });
  });
}

// Cleanup on extension unload
chrome.runtime.onSuspend.addListener(() => {
  console.log('[X Unfollow Tracker] Extension suspending, cleaning up...');
  chrome.storage.local.set({ scanStatus: 'idle' });
});