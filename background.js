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
const PROFILE_PROBE_MAX_ATTEMPTS = 2;
const PROFILE_PROBE_SETTLE_MS = 1200;

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
    lastScanTime: now,
    scanProgress: 100,
    scanProgressPhase: 'complete'
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
  const result = await getStorage([
    '_currentScanSource',
    '_currentScanUsername',
    'currentScanType',
    '_currentScanProfileCounts',
    '_currentScanExpectedCount',
    '_currentScanExpectedSource'
  ]);
  const errorMessage = request.error || 'Unknown scan error';
  const now = Date.now();
  const payload = {
    lastError: errorMessage,
    scanStatus: 'error',
    scanProgressPhase: 'error'
  };
  
  if (result._currentScanSource === 'auto') {
    payload.autoScanLastRunAt = now;
    payload.autoScanLastError = errorMessage;
    if (isRateLimitError(errorMessage)) {
      payload.autoScanCooldownUntil = now + AUTO_SCAN_RATE_LIMIT_COOLDOWN_MS;
    }
  }

  await appendScanFailureEvent(result._currentScanUsername || request.username, {
    scanType: request.scanType || result.currentScanType,
    error: errorMessage,
    source: result._currentScanSource,
    stats: request.stats,
    profileCounts: request.stats?.profileCounts || result._currentScanProfileCounts,
    expected: result._currentScanExpectedCount,
    expectedSource: result._currentScanExpectedSource
  });

  await setStorage(payload);
}

/**
 * Handle scan progress update
 * @param {Object} request - Request object containing progress percentage
 */
async function handleScanProgress(request) {
  await setStorage({
    scanProgress: normalizeProgress(request.progress),
    scanProgressPhase: request.phase || 'scanning',
    scanProgressCount: Number.isFinite(request.count) ? request.count : null,
    scanProgressExpected: Number.isFinite(request.expected) ? request.expected : null,
    scanProgressExpectedSource: request.expectedSource || null
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

  let targetUsername = username;
  let targetScanType = scanType === 'following' ? 'following' : 'followers';
  const scanSource = options.scanSource || 'manual';
  let scanStateInitialized = false;

  try {
    // Get username from storage if not provided
    if (!targetUsername) {
      const storage = await new Promise((resolve) => {
        chrome.storage.local.get(['username'], resolve);
      });
      targetUsername = storage.username;
    }

    // Validate username
    if (!targetUsername) {
      await setStorage({
        scanStatus: 'error',
        lastError: 'No username provided. Please add an account first.',
        scanProgressPhase: 'error'
      });
      respond({
        status: 'error',
        message: 'No username provided. Please add an account first.'
      });
      return;
    }

    // Clean username (remove @ symbol if present)
    targetUsername = targetUsername.replace('@', '');

    // Determine target page
    const pagePath = targetScanType === 'following' ? 'following' : 'followers';
    const targetUrl = `https://x.com/${encodeURIComponent(targetUsername)}/${pagePath}`;

    console.log(`Starting ${targetScanType} scan for @${targetUsername}`);
    console.log(`Target URL: ${targetUrl}`);

    // Get active tab
    const [activeTab] = await chrome.tabs.query({
      active: true,
      currentWindow: true
    });

    if (!activeTab?.id) {
      const message = 'No active tab found. Please open a browser tab first.';
      await appendScanFailureEvent(targetUsername, {
        scanType: targetScanType,
        error: message,
        source: scanSource,
        expected: null,
        expectedSource: null,
        profileCounts: null
      });
      await setStorage({
        scanStatus: 'error',
        lastError: message,
        scanProgressPhase: 'error'
      });
      respond({
        status: 'error',
        message
      });
      return;
    }

    const tabId = activeTab.id;

    // Update storage with scan state
    await setStorage({
      scanStatus: 'scanning',
      currentScanType: targetScanType,
      scanProgress: 0,
      scanProgressPhase: 'profile',
      scanProgressCount: 0,
      scanProgressExpected: null,
      scanProgressExpectedSource: 'profile',
      _currentScanSource: scanSource,
      _currentScanTabId: tabId,
      _currentScanUsername: targetUsername,
      _currentScanProfileCounts: null,
      _currentScanExpectedCount: null,
      _currentScanExpectedSource: null,
      _scanStartTime: Date.now()
    });
    scanStateInitialized = true;

    await publishScanProgress({
      phase: 'profile',
      progress: 2,
      count: 0,
      expected: null,
      expectedSource: 'profile'
    });

    const profileCounts = hasCompleteProfileCounts(options.profileCounts)
      ? options.profileCounts
      : await probeProfileCountsWithRetry(tabId, targetUsername, {
        publishProgress: true
      });
    const expectedCount = targetScanType === 'following'
      ? profileCounts.following
      : profileCounts.followers;

    if (!Number.isFinite(expectedCount)) {
      throw new Error(`Unable to read ${targetScanType} count from @${targetUsername}'s profile.`);
    }

    await setStorage({
      _currentScanProfileCounts: profileCounts,
      _currentScanExpectedCount: expectedCount,
      _currentScanExpectedSource: 'profile'
    });

    await publishScanProgress({
      phase: 'loading',
      progress: 5,
      count: 0,
      expected: expectedCount,
      expectedSource: 'profile'
    });

    await navigateTabAndWait(tabId, targetUrl, SCAN_TIMEOUT_MS);
    await sleep(SCRIPT_INJECTION_DELAY_MS);
    await injectScraperScript(tabId, respond);

  } catch (error) {
    console.error('Error starting scan:', error);
    await appendScanFailureEvent(targetUsername, {
      scanType: targetScanType,
      error: error.message || 'Failed to start scan. Please try again.',
      source: scanSource,
      ...(scanStateInitialized ? {} : {
        expected: null,
        expectedSource: null,
        profileCounts: null
      })
    });
    await setStorage({
      scanStatus: 'error',
      lastError: error.message || 'Failed to start scan. Please try again.',
      scanProgressPhase: 'error'
    });
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
  let profileCounts;
  try {
    profileCounts = await probeProfileCountsWithRetry(tab.id, username);
  } catch (error) {
    const message = error.message || 'Unable to read profile follower count.';
    await setStorage({
      autoScanLastRunAt: now,
      autoScanLastCountProbeAt: now,
      autoScanLastProfileFollowerCount: null,
      autoScanLastError: message
    });
    await appendProbeEvent(username, {
      timestamp: now,
      type: 'followers_probe',
      source: 'auto',
      probeCount: null,
      countChanged: null,
      status: 'failed',
      reason: message
    });
    await ensureAutoScanAlarm();
    return { status: 'error', message };
  }

  const probeCount = profileCounts.followers;
  const probeEvent = {
    timestamp: now,
    type: 'followers_probe',
    source: 'auto',
    probeCount: Number.isFinite(probeCount) ? probeCount : null,
    profileCounts,
    countChanged:
      Number.isFinite(probeCount) && Number.isFinite(lastFollowersCount)
        ? probeCount !== lastFollowersCount
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
    !Number.isFinite(probeCount) ||
    !Number.isFinite(lastFollowersCount) ||
    probeCount !== lastFollowersCount;

  if (!shouldScan) {
    await ensureAutoScanAlarm();
    return { status: 'probe_only', count: probeCount };
  }

  const startResponse = await startScanWithPromise(username, 'followers', 'auto', profileCounts);
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
    refollowers: [],
    fansList: [],
    notFollowingBack: [],
    scanCount: 0,
    scanHistory: [],
    snapshots: [],
    relationshipsByHandle: {},
    relationshipModelVersion: 2
  };
  userData.scanHistory = userData.scanHistory || [];
  userData.scanHistory.push(event);
  if (userData.scanHistory.length > 200) {
    userData.scanHistory = userData.scanHistory.slice(-200);
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
  if (Number.isFinite(users[key].lastFollowersExpected)) {
    return users[key].lastFollowersExpected;
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

async function startScanWithPromise(username, scanType, scanSource, profileCounts = null) {
  return new Promise((resolve) => {
    startScan(resolve, username, scanType, { scanSource, profileCounts });
  });
}

function hasCompleteProfileCounts(profileCounts) {
  return (
    profileCounts &&
    Number.isFinite(profileCounts.followers) &&
    Number.isFinite(profileCounts.following)
  );
}

async function probeProfileCountsWithRetry(tabId, username, options = {}) {
  let lastResult = null;

  for (let attempt = 1; attempt <= PROFILE_PROBE_MAX_ATTEMPTS; attempt++) {
    if (options.publishProgress) {
      await publishScanProgress({
        phase: 'profile',
        progress: attempt === 1 ? 2 : 4,
        count: 0,
        expected: null,
        expectedSource: 'profile'
      });
    }

    const result = await probeProfileCounts(tabId, username);
    if (result.error) {
      throw new Error(result.error);
    }

    lastResult = result;
    if (Number.isFinite(result.followers) && Number.isFinite(result.following)) {
      return result;
    }

    if (attempt < PROFILE_PROBE_MAX_ATTEMPTS) {
      await sleep(PROFILE_PROBE_SETTLE_MS);
    }
  }

  const missing = [];
  if (!Number.isFinite(lastResult?.followers)) missing.push('followers');
  if (!Number.isFinite(lastResult?.following)) missing.push('following');
  throw new Error(`Unable to read profile ${missing.join(' and ')} count from @${username}. Please retry after the profile page fully loads.`);
}

async function probeProfileCounts(tabId, username) {
  const cleanUsername = username.replace('@', '');
  const targetUrl = `https://x.com/${encodeURIComponent(cleanUsername)}`;

  await navigateTabAndWait(tabId, targetUrl, SCAN_TIMEOUT_MS);
  await sleep(PROFILE_PROBE_SETTLE_MS);

  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    args: [cleanUsername],
    func: (profileUsername) => {
      const normalizeUsername = (value) => (value || '').replace(/^@/, '').trim().toLowerCase();
      const normalizedUsername = normalizeUsername(profileUsername);

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

      const getPageIssue = () => {
        const path = window.location.pathname || '';
        if (path.startsWith('/i/flow/login') || path.startsWith('/login')) {
          return 'You are not logged in. Please log in to X and retry.';
        }

        const bodyText = (document.body?.innerText || '').toLowerCase().replace(/\u2019/g, "'");
        if (bodyText.includes('rate limit') || bodyText.includes('too many requests')) {
          return 'Rate limit detected. Please wait and try again later.';
        }
        if (bodyText.includes("account doesn't exist") || bodyText.includes('account does not exist')) {
          return 'This account does not exist or is unavailable.';
        }
        if (bodyText.includes('these posts are protected') || bodyText.includes('only approved followers')) {
          return 'This account is protected and cannot be scanned.';
        }
        if (bodyText.includes('log in') && bodyText.includes('sign up')) {
          return 'Please log in to X before scanning.';
        }
        if (bodyText.includes('something went wrong') || bodyText.includes('try again')) {
          return 'X returned an error. Please refresh the page and retry.';
        }
        return null;
      };

      const readLinkedCount = (type) => {
        const candidates = [];
        const links = Array.from(document.querySelectorAll('a[href]'));
        links.forEach((link) => {
          const href = (link.getAttribute('href') || '').toLowerCase();
          const isFollowersLink =
            type === 'followers' &&
            (
              href.includes(`/${normalizedUsername}/followers`) ||
              href.includes(`/${normalizedUsername}/verified_followers`)
            );
          const isFollowingLink =
            type === 'following' && href.includes(`/${normalizedUsername}/following`);

          if (!isFollowersLink && !isFollowingLink) return;

          const text = (link.innerText || link.textContent || '').trim();
          const countFromText = parseCount(text);
          if (countFromText !== null) candidates.push(countFromText);

          const countFromAria = parseCount(link.getAttribute('aria-label') || '');
          if (countFromAria !== null) candidates.push(countFromAria);
        });

        if (candidates.length) {
          return Math.max(...candidates.filter(Number.isFinite));
        }

        const mainText = (
          document.querySelector('[data-testid="primaryColumn"]')?.innerText ||
          document.querySelector('main')?.innerText ||
          document.body?.innerText ||
          ''
        );
        const regex = type === 'followers'
          ? /(\d+(?:[.,]\d+)?\s*[KMB]?)\s*followers/i
          : /(\d+(?:[.,]\d+)?\s*[KMB]?)\s*following/i;
        const match = mainText.match(regex);
        return match ? parseCount(match[1]) : null;
      };

      return {
        followers: readLinkedCount('followers'),
        following: readLinkedCount('following'),
        error: getPageIssue(),
        source: 'profile',
        url: window.location.href
      };
    }
  });

  return result?.result || {
    followers: null,
    following: null,
    error: 'Unable to read the profile page.',
    source: 'profile'
  };
}

async function navigateTabAndWait(tabId, url, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Timeout waiting for page to load.'));
    }, timeoutMs);

    const finish = (callback, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      callback(value);
    };

    const listener = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId !== tabId || changeInfo.status !== 'complete') {
        return;
      }
      finish(resolve, tab);
    };

    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.update(tabId, { url }, (tab) => {
      const err = chrome.runtime.lastError;
      if (err) {
        finish(reject, new Error(err.message));
        return;
      }
      if (tab?.status === 'complete') {
        finish(resolve, tab);
      }
    });
  });
}

async function publishScanProgress(details = {}) {
  const payload = {
    action: 'scanProgress',
    phase: details.phase || 'scanning',
    progress: normalizeProgress(details.progress),
    count: Number.isFinite(details.count) ? details.count : null,
    expected: Number.isFinite(details.expected) ? details.expected : null,
    expectedSource: details.expectedSource || null
  };

  await setStorage({
    scanProgress: payload.progress,
    scanProgressPhase: payload.phase,
    scanProgressCount: payload.count,
    scanProgressExpected: payload.expected,
    scanProgressExpectedSource: payload.expectedSource
  });

  try {
    chrome.runtime.sendMessage(payload, () => {
      void chrome.runtime.lastError;
    });
  } catch (error) {
    // Popup may be closed; storage already has the latest progress.
  }
}

function normalizeProgress(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

async function appendScanFailureEvent(username, details = {}) {
  if (!username) {
    return;
  }

  const data = await getStorage([
    'users',
    '_currentScanSource',
    'currentScanType',
    '_currentScanProfileCounts',
    '_currentScanExpectedCount',
    '_currentScanExpectedSource'
  ]);
  const users = data.users || {};
  const normalized = normalizeUsername(username);
  const existingKey = Object.keys(users).find((key) => normalizeUsername(key) === normalized);
  const storageKey = existingKey || username;
  const userData = users[storageKey] || {
    followers: [],
    following: [],
    unfollowers: [],
    newFollowers: [],
    refollowers: [],
    fansList: [],
    notFollowingBack: [],
    scanCount: 0,
    scanHistory: [],
    snapshots: [],
    relationshipsByHandle: {},
    relationshipModelVersion: 2
  };

  const stats = details.stats || {};
  const hasStatsExpected = Object.prototype.hasOwnProperty.call(stats, 'expected');
  const hasDetailsExpected = Object.prototype.hasOwnProperty.call(details, 'expected');
  const hasDetailsProfileCounts = Object.prototype.hasOwnProperty.call(details, 'profileCounts');
  const hasDetailsExpectedSource = Object.prototype.hasOwnProperty.call(details, 'expectedSource');
  const expected = Number.isFinite(stats.expected)
    ? stats.expected
    : (hasStatsExpected
      ? null
      : (Number.isFinite(details.expected)
        ? details.expected
        : (hasDetailsExpected
          ? null
          : (Number.isFinite(data._currentScanExpectedCount) ? data._currentScanExpectedCount : null))));
  const count = Number.isFinite(stats.total) ? stats.total : null;
  const profileCounts = hasDetailsProfileCounts
    ? details.profileCounts
    : (data._currentScanProfileCounts || null);
  const expectedSource =
    details.expectedSource ||
    (hasDetailsExpectedSource ? null : data._currentScanExpectedSource) ||
    (Number.isFinite(expected) ? 'profile' : null);
  const coverage = Number.isFinite(count) && Number.isFinite(expected) && expected > 0
    ? Number((count / expected).toFixed(3))
    : (count === 0 && expected === 0 ? 1 : null);

  userData.scanHistory = userData.scanHistory || [];
  userData.scanHistory.push({
    type: details.scanType || data.currentScanType || 'followers',
    source: details.source || data._currentScanSource || 'manual',
    count,
    expected,
    coverage,
    timestamp: Date.now(),
    status: 'failed',
    reason: details.error || 'Scan failed',
    profileCounts,
    expectedSource,
    countMatchesExpected:
      Number.isFinite(count) && Number.isFinite(expected) ? count === expected : null
  });

  if (userData.scanHistory.length > 200) {
    userData.scanHistory = userData.scanHistory.slice(-200);
  }

  users[storageKey] = userData;
  await setStorage({ users });
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
