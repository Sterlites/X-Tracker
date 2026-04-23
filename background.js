/**
 * X-Unfollow Tracker - Background Service Worker
 * Handles scan operations, message passing, and extension lifecycle events
 */

// Constants
const SCAN_TIMEOUT_MS = 45000; // 45 seconds timeout for initial page load and script injection
const SCRIPT_INJECTION_DELAY_MS = 2000; // Delay before injecting scraper script
const MAX_RETRIES = 3; // Maximum number of retry attempts for failed operations
const AUTO_SCAN_ALARM = 'autoFollowersScan';
const DEFAULT_AUTO_SCAN_INTERVAL_MINUTES = 120;
const AUTO_SCAN_FORCED_SYNC_MS = 24 * 60 * 60 * 1000;
const AUTO_SCAN_RATE_LIMIT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

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
        scanStatus: 'idle',
        autoScanEnabled: false,
        autoScanIntervalMinutes: DEFAULT_AUTO_SCAN_INTERVAL_MINUTES
      });
      console.log('Initialized default storage');
    }
  });

  ensureAutoScanAlarm();
});

/**
 * Clear any stuck scans on browser startup
 * Prevents scans from appearing stuck after browser restart
 */
chrome.runtime.onStartup.addListener(() => {
  console.log('Browser started - resetting scan status');
  chrome.storage.local.set({ scanStatus: 'idle' });
  ensureAutoScanAlarm();
});

/**
 * Clear scans before extension suspension (for Manifest V3)
 */
chrome.runtime.onSuspend.addListener(() => {
  console.log('Service worker suspending - resetting scan status');
  chrome.storage.local.set({ scanStatus: 'idle' });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== AUTO_SCAN_ALARM) {
    return;
  }
  await runAutoScanCycle();
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
        request.scanType || 'followers',
        { scanSource: request.scanSource || 'manual' }
      );
      return true; // Keep channel open for async response

    case 'getStats':
      getStoredStats(sendResponse);
      return true; // Keep channel open for async response

    case 'scanComplete':
      handleScanComplete(request)
        .then(() => sendResponse({ status: 'ok' }))
        .catch((error) => sendResponse({ status: 'error', message: error.message }));
      return true;

    case 'scanError':
      handleScanError(request)
        .then(() => sendResponse({ status: 'ok' }))
        .catch((error) => sendResponse({ status: 'error', message: error.message }));
      return true;

    case 'scanProgress':
      handleScanProgress(request)
        .then(() => sendResponse({ status: 'ok' }))
        .catch((error) => sendResponse({ status: 'error', message: error.message }));
      return true;

    case 'forceStopScan':
      handleForceStopScan()
        .then(() => sendResponse({ status: 'ok' }))
        .catch((error) => sendResponse({ status: 'error', message: error.message }));
      return true;

    case 'getAutoScanSettings':
      getAutoScanSettings(sendResponse);
      return true;

    case 'setAutoScanSettings':
      setAutoScanSettings(sendResponse, request.settings || {});
      return true;

    case 'runAutoScanNow':
      runAutoScanCycle(true)
        .then((result) => sendResponse(result))
        .catch((error) =>
          sendResponse({ status: 'error', message: error.message || 'Auto scan failed' })
        );
      return true;

    default:
      console.warn('Unknown message action:', request.action);
      return false;
  }
});

/**
 * Handle scan completion
 * @param {Object} request - Request object containing scan results
 */
async function handleScanComplete(request) {
  console.log('Scan completed successfully');
  const result = await getStorage(['_currentScanSource']);
  const now = Date.now();
  const payload = {
    scanStatus: 'complete',
    lastScanTime: now
  };
  
  if (result._currentScanSource === 'auto') {
    payload.autoScanLastRunAt = now;
    payload.autoScanLastSuccessAt = now;
    payload.autoScanLastError = null;
  }
  
  await setStorage(payload);
}

/**
 * Handle scan error
 * @param {Object} request - Request object containing error details
 */
async function handleScanError(request) {
  console.error('Scan error:', request.error);
  const result = await getStorage(['_currentScanSource']);
  const errorMessage = request.error || 'Unknown scan error';
  const now = Date.now();
  const payload = {
    lastError: errorMessage,
    scanStatus: 'error'
  };
  
  if (result._currentScanSource === 'auto') {
    payload.autoScanLastRunAt = now;
    payload.autoScanLastError = errorMessage;
    if (isRateLimitError(errorMessage)) {
      payload.autoScanCooldownUntil = now + AUTO_SCAN_RATE_LIMIT_COOLDOWN_MS;
    }
  }
  
  await setStorage(payload);
}

/**
 * Handle scan progress update
 * @param {Object} request - Request object containing progress percentage
 */
async function handleScanProgress(request) {
  await setStorage({
    scanProgress: request.progress
  });
}

/**
 * Handle force stop scan request
 */
async function handleForceStopScan() {
  console.log('Force stopping scan');
  await setStorage({ scanStatus: 'idle' });
}

/**
 * Start a follower/following scan
 * @param {Function} sendResponse - Callback to send response
 * @param {string} username - X username to scan
 * @param {string} scanType - Type of scan ('followers' or 'following')
 */
async function startScan(sendResponse, username, scanType, options = {}) {
  const respond = (payload) => {
    if (typeof sendResponse === 'function') {
      sendResponse(payload);
    }
  };

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
      respond({
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
      respond({
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
          _currentScanSource: options.scanSource || 'manual',
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
          injectScraperScript(tabId, respond);
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
        respond({
          status: 'error',
          message: 'Scan timeout - page took too long to load. Please retry.'
        });
      }
    }, SCAN_TIMEOUT_MS);

  } catch (error) {
    console.error('Error starting scan:', error);
    chrome.storage.local.set({ scanStatus: 'error' });
    respond({
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

async function getAutoScanSettings(sendResponse) {
  chrome.storage.local.get(
    [
      'autoScanEnabled',
      'autoScanIntervalMinutes',
      'autoScanNextRunAt',
      'autoScanCooldownUntil',
      'autoScanLastRunAt',
      'autoScanLastCountProbeAt',
      'autoScanLastProfileFollowerCount',
      'autoScanLastError'
    ],
    (result) => {
      sendResponse({
        autoScanEnabled: !!result.autoScanEnabled,
        autoScanIntervalMinutes:
          Number(result.autoScanIntervalMinutes) || DEFAULT_AUTO_SCAN_INTERVAL_MINUTES,
        autoScanNextRunAt: result.autoScanNextRunAt || null,
        autoScanCooldownUntil: result.autoScanCooldownUntil || null,
        autoScanLastRunAt: result.autoScanLastRunAt || null,
        autoScanLastCountProbeAt: result.autoScanLastCountProbeAt || null,
        autoScanLastProfileFollowerCount: Number.isFinite(result.autoScanLastProfileFollowerCount)
          ? result.autoScanLastProfileFollowerCount
          : null,
        autoScanLastError: result.autoScanLastError || null
      });
    }
  );
}

async function setAutoScanSettings(sendResponse, settings) {
  const autoScanEnabled = !!settings.autoScanEnabled;
  const interval = Number(settings.autoScanIntervalMinutes) || DEFAULT_AUTO_SCAN_INTERVAL_MINUTES;
  const autoScanIntervalMinutes = Math.min(24 * 60, Math.max(60, interval));
  const nextRunAt = Date.now() + autoScanIntervalMinutes * 60 * 1000;

  chrome.storage.local.set(
    {
      autoScanEnabled,
      autoScanIntervalMinutes,
      autoScanNextRunAt: autoScanEnabled ? nextRunAt : null
    },
    async () => {
      if (chrome.runtime.lastError) {
        sendResponse({ status: 'error', message: chrome.runtime.lastError.message });
        return;
      }
      await ensureAutoScanAlarm();
      sendResponse({
        status: 'ok',
        autoScanEnabled,
        autoScanIntervalMinutes,
        autoScanNextRunAt: autoScanEnabled ? nextRunAt : null
      });
    }
  );
}

async function ensureAutoScanAlarm() {
  const config = await getStorage([
    'autoScanEnabled',
    'autoScanIntervalMinutes',
    'autoScanCooldownUntil'
  ]);
  await chrome.alarms.clear(AUTO_SCAN_ALARM);

  if (!config.autoScanEnabled) {
    return;
  }

  const intervalMinutes =
    Number(config.autoScanIntervalMinutes) || DEFAULT_AUTO_SCAN_INTERVAL_MINUTES;
  const now = Date.now();
  const cooldownUntil = Number(config.autoScanCooldownUntil) || 0;
  const delayMinutes = cooldownUntil > now
    ? Math.max(1, Math.ceil((cooldownUntil - now) / 60000))
    : Math.max(1, intervalMinutes);

  await chrome.alarms.create(AUTO_SCAN_ALARM, {
    delayInMinutes: delayMinutes,
    periodInMinutes: Math.max(1, intervalMinutes)
  });

  await setStorage({
    autoScanNextRunAt: now + delayMinutes * 60 * 1000
  });
}

async function runAutoScanCycle(forceRun = false) {
  const state = await getStorage([
    'autoScanEnabled',
    'autoScanIntervalMinutes',
    'autoScanCooldownUntil',
    'scanStatus',
    'currentUser',
    'userList',
    'users',
    'autoScanLastRunAt'
  ]);

  if (!forceRun && !state.autoScanEnabled) {
    return { status: 'skipped', reason: 'disabled' };
  }
  if (state.scanStatus === 'scanning') {
    return { status: 'skipped', reason: 'scan_in_progress' };
  }

  const now = Date.now();
  const cooldownUntil = Number(state.autoScanCooldownUntil) || 0;
  if (!forceRun && cooldownUntil > now) {
    await ensureAutoScanAlarm();
    return { status: 'skipped', reason: 'cooldown' };
  }

  const username = resolveTargetUser(state);
  if (!username) {
    return { status: 'skipped', reason: 'no_user' };
  }

  const tab = await getUsableXTab();
  if (!tab?.id) {
    return { status: 'skipped', reason: 'no_x_tab' };
  }

  const lastFollowersCount = getLastFollowersCount(state.users || {}, username);
  const probeResult = await probeFollowerCount(tab.id, username);
  const probeEvent = {
    timestamp: now,
    type: 'followers_probe',
    source: 'auto',
    probeCount: Number.isFinite(probeResult.count) ? probeResult.count : null,
    countChanged:
      Number.isFinite(probeResult.count) && Number.isFinite(lastFollowersCount)
        ? probeResult.count !== lastFollowersCount
        : null
  };

  await setStorage({
    autoScanLastRunAt: now,
    autoScanLastCountProbeAt: now,
    autoScanLastProfileFollowerCount: probeEvent.probeCount
  });
  await appendProbeEvent(username, probeEvent);

  const shouldForceSync =
    !state.autoScanLastRunAt || now - Number(state.autoScanLastRunAt) >= AUTO_SCAN_FORCED_SYNC_MS;
  const shouldScan =
    forceRun ||
    shouldForceSync ||
    !Number.isFinite(probeResult.count) ||
    !Number.isFinite(lastFollowersCount) ||
    probeResult.count !== lastFollowersCount;

  if (!shouldScan) {
    await ensureAutoScanAlarm();
    return { status: 'probe_only', count: probeResult.count };
  }

  const startResponse = await startScanWithPromise(username, 'followers', 'auto');
  await ensureAutoScanAlarm();
  return startResponse;
}

async function appendProbeEvent(username, event) {
  const data = await getStorage(['users']);
  const users = data.users || {};
  const normalized = normalizeUsername(username);
  const existingKey = Object.keys(users).find((key) => normalizeUsername(key) === normalized);
  const storageKey = existingKey || username;
  const userData = users[storageKey] || {
    followers: [],
    following: [],
    unfollowers: [],
    newFollowers: [],
    fansList: [],
    notFollowingBack: [],
    scanCount: 0,
    scanHistory: []
  };
  userData.scanHistory = userData.scanHistory || [];
  userData.scanHistory.push(event);
  if (userData.scanHistory.length > 20) {
    userData.scanHistory = userData.scanHistory.slice(-20);
  }
  users[storageKey] = userData;
  await setStorage({ users });
}

function resolveTargetUser(state) {
  if (state.currentUser) {
    return state.currentUser;
  }
  if (Array.isArray(state.userList) && state.userList.length) {
    return state.userList[0];
  }
  return null;
}

function normalizeUsername(value) {
  return (value || '').replace(/^@/, '').trim().toLowerCase();
}

function getLastFollowersCount(users, username) {
  const normalized = normalizeUsername(username);
  const key = Object.keys(users || {}).find((item) => normalizeUsername(item) === normalized);
  if (!key) {
    return null;
  }
  return Number.isFinite(users[key].lastFollowersCount) ? users[key].lastFollowersCount : null;
}

async function getUsableXTab() {
  const xTabs = await chrome.tabs.query({ url: '*://x.com/*' });
  if (xTabs.length) {
    return xTabs[0];
  }
  const twitterTabs = await chrome.tabs.query({ url: '*://twitter.com/*' });
  return twitterTabs[0] || null;
}

async function startScanWithPromise(username, scanType, scanSource) {
  return new Promise((resolve) => {
    startScan(resolve, username, scanType, { scanSource });
  });
}

async function probeFollowerCount(tabId, username) {
  const targetUrl = `https://x.com/${encodeURIComponent(username.replace('@', ''))}`;
  await chrome.tabs.update(tabId, { url: targetUrl });

  await waitForTabComplete(tabId, SCAN_TIMEOUT_MS);
  await sleep(1200);

  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const parseCount = (text) => {
        if (!text) return null;
        const normalized = text.replace(/,/g, '').trim();
        const match = normalized.match(/(\d+(?:\.\d+)?)(\s*[KMB])?/i);
        if (!match) return null;
        let value = parseFloat(match[1]);
        const suffix = (match[2] || '').trim().toUpperCase();
        if (suffix === 'K') value *= 1000;
        if (suffix === 'M') value *= 1000000;
        if (suffix === 'B') value *= 1000000000;
        return Number.isFinite(value) ? Math.round(value) : null;
      };

      const links = Array.from(document.querySelectorAll('a[href*="/followers"]'));
      const candidates = [];
      links.forEach((link) => {
        const text = (link.innerText || link.textContent || '').trim();
        const fromText = parseCount(text);
        if (fromText !== null) candidates.push(fromText);
        const aria = parseCount(link.getAttribute('aria-label') || '');
        if (aria !== null) candidates.push(aria);
      });
      return {
        count: candidates.length ? Math.max(...candidates) : null
      };
    }
  });

  return result?.result || { count: null };
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Timeout waiting for tab load'));
    }, timeoutMs);

    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId || changeInfo.status !== 'complete' || done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(message) {
  const text = (message || '').toLowerCase();
  return text.includes('rate limit') || text.includes('too many requests');
}

function getStorage(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function setStorage(value) {
  return new Promise((resolve) => chrome.storage.local.set(value, resolve));
}