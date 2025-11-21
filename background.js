/**
 * X-Unfollow Tracker - Background Service Worker
 * Handles scan operations, message passing, and extension lifecycle events
 */

// Constants
const SCAN_TIMEOUT_MS = 45000; // 45 seconds timeout for initial page load and script injection
const SCRIPT_INJECTION_DELAY_MS = 2000; // Delay before injecting scraper script
const MAX_RETRIES = 3; // Maximum number of retry attempts for failed operations

/**
 * Initialize extension on installation
 * Sets up default storage structure
 */
chrome.runtime.onInstalled.addListener(() => {
  console.log('X-Unfollow Tracker installed');
  
  chrome.storage.local.get(['users'], (result) => {
    // Only initialize if no existing data
    if (!result.users) {
      chrome.storage.local.set({
        users: {},
        userList: [],
        currentUser: null,
        scanStatus: 'idle'
      });
      console.log('Initialized default storage');
    }
  });
});

/**
 * Clear any stuck scans on browser startup
 * Prevents scans from appearing stuck after browser restart
 */
chrome.runtime.onStartup.addListener(() => {
  console.log('Browser started - resetting scan status');
  chrome.storage.local.set({ scanStatus: 'idle' });
});

/**
 * Clear scans before extension suspension (for Manifest V3)
 */
chrome.runtime.onSuspend.addListener(() => {
  console.log('Service worker suspending - resetting scan status');
  chrome.storage.local.set({ scanStatus: 'idle' });
});

/**
 * Main message handler
 * Routes messages to appropriate handlers
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('Received message:', request.action);

  // Route message to appropriate handler
  switch (request.action) {
    case 'startScan':
      startScan(
        sendResponse,
        request.username,
        request.scanType || 'followers'
      );
      return true; // Keep channel open for async response

    case 'getStats':
      getStoredStats(sendResponse);
      return true; // Keep channel open for async response

    case 'scanComplete':
      handleScanComplete(request);
      return false;

    case 'scanError':
      handleScanError(request);
      return false;

    case 'scanProgress':
      handleScanProgress(request);
      return false;

    case 'forceStopScan':
      handleForceStopScan();
      return false;

    default:
      console.warn('Unknown message action:', request.action);
      return false;
  }
});

/**
 * Handle scan completion
 * @param {Object} request - Request object containing scan results
 */
function handleScanComplete(request) {
  console.log('Scan completed successfully');
  chrome.storage.local.set({
    scanStatus: 'complete',
    lastScanTime: Date.now()
  });
}

/**
 * Handle scan error
 * @param {Object} request - Request object containing error details
 */
function handleScanError(request) {
  console.error('Scan error:', request.error);
  chrome.storage.local.set({
    lastError: request.error,
    scanStatus: 'error'
  });
}

/**
 * Handle scan progress update
 * @param {Object} request - Request object containing progress percentage
 */
function handleScanProgress(request) {
  chrome.storage.local.set({
    scanProgress: request.progress
  });
}

/**
 * Handle force stop scan request
 */
function handleForceStopScan() {
  console.log('Force stopping scan');
  chrome.storage.local.set({ scanStatus: 'idle' });
}

/**
 * Start a follower/following scan
 * @param {Function} sendResponse - Callback to send response
 * @param {string} username - X username to scan
 * @param {string} scanType - Type of scan ('followers' or 'following')
 */
async function startScan(sendResponse, username, scanType) {
  try {
    // Get username from storage if not provided
    let targetUsername = username;
    if (!targetUsername) {
      const storage = await new Promise((resolve) => {
        chrome.storage.local.get(['username'], resolve);
      });
      targetUsername = storage.username;
    }

    // Validate username
    if (!targetUsername) {
      sendResponse({
        status: 'error',
        message: 'No username provided. Please add an account first.'
      });
      return;
    }

    // Clean username (remove @ symbol if present)
    targetUsername = targetUsername.replace('@', '');

    // Determine target page
    const pagePath = scanType === 'following' ? 'following' : 'followers';
    const targetUrl = `https://x.com/${encodeURIComponent(targetUsername)}/${pagePath}`;

    console.log(`Starting ${scanType} scan for @${targetUsername}`);
    console.log(`Target URL: ${targetUrl}`);

    // Get active tab
    const [activeTab] = await chrome.tabs.query({
      active: true,
      currentWindow: true
    });

    if (!activeTab?.id) {
      sendResponse({
        status: 'error',
        message: 'No active tab found. Please open a browser tab first.'
      });
      return;
    }

    const tabId = activeTab.id;

    // Update storage with scan state
    await new Promise((resolve) => {
      chrome.storage.local.set(
        {
          scanStatus: 'scanning',
          currentScanType: scanType,
          _currentScanTabId: tabId,
          _currentScanUsername: targetUsername,
          _scanStartTime: Date.now()
        },
        resolve
      );
    });

    // Navigate to target page
    await chrome.tabs.update(tabId, { url: targetUrl });

    // Set up listener for page load completion
    let listenerAttached = false;
    let timeoutId = null;

    const pageLoadListener = (updatedTabId, changeInfo, tab) => {
      // Only process updates for our target tab
      if (updatedTabId !== tabId) {
        return;
      }

      // Check if page is fully loaded and on correct URL
      if (
        changeInfo.status === 'complete' &&
        tab.url &&
        (tab.url.includes('/followers') || tab.url.includes('/following'))
      ) {
        console.log('Page loaded, preparing to inject script');

        // Remove listener to prevent duplicate injections
        if (listenerAttached) {
          chrome.tabs.onUpdated.removeListener(pageLoadListener);
          listenerAttached = false;
        }

        // Clear timeout
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }

        // Wait a moment for page to stabilize, then inject scraper
        setTimeout(() => {
          injectScraperScript(tabId, sendResponse);
        }, SCRIPT_INJECTION_DELAY_MS);
      }
    };

    // Attach listener
    chrome.tabs.onUpdated.addListener(pageLoadListener);
    listenerAttached = true;

    // Set timeout to prevent hanging
    timeoutId = setTimeout(() => {
      if (listenerAttached) {
        chrome.tabs.onUpdated.removeListener(pageLoadListener);
        listenerAttached = false;
        chrome.storage.local.set({ scanStatus: 'idle' });
        sendResponse({
          status: 'error',
          message: 'Scan timeout - page took too long to load. Please retry.'
        });
      }
    }, SCAN_TIMEOUT_MS);

  } catch (error) {
    console.error('Error starting scan:', error);
    chrome.storage.local.set({ scanStatus: 'error' });
    sendResponse({
      status: 'error',
      message: error.message || 'Failed to start scan. Please try again.'
    });
  }
}

/**
 * Inject scraper script into tab
 * @param {number} tabId - ID of tab to inject into
 * @param {Function} sendResponse - Callback to send response
 */
async function injectScraperScript(tabId, sendResponse) {
  try {
    console.log(`Injecting scraper script into tab ${tabId}`);

    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['scraper.js']
    });

    console.log('Scraper script injected successfully');
    sendResponse({
      status: 'scanning',
      tabId: tabId
    });

  } catch (error) {
    console.error('Script injection failed:', error);
    chrome.storage.local.set({ scanStatus: 'error' });
    sendResponse({
      status: 'error',
      message: `Script injection failed: ${error.message}. Make sure you're on the X website.`
    });
  }
}

/**
 * Get stored statistics for current user
 * @param {Function} sendResponse - Callback to send response with stats
 */
async function getStoredStats(sendResponse) {
  chrome.storage.local.get(['users', 'currentUser'], (result) => {
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