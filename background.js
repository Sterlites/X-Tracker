/**
 * X-Unfollow Tracker - Background Service Worker
 * Autonomous background tracking with chrome.alarms, direct API fetching,
 * session management, and notification system.
 *
 * ARCHITECTURE NOTE: All X API calls are made directly from this service worker,
 * which has host_permissions for x.com and therefore gets cookies attached
 * automatically. The offscreen document is ONLY used for parameter discovery
 * (parsing X's JS bundles to extract query IDs and feature flags).
 */

// Import data module
importScripts('data.js');

const {
  getDefaultSettings,
  getEmptyUserData,
  normalizeUsername,
  processScanResults,
  migrateDataIfNeeded,
  DEFAULT_SCAN_INTERVAL_HOURS,
  MIN_SCAN_INTERVAL_HOURS,
  MAX_SCAN_INTERVAL_HOURS,
  JITTER_MINUTES
} = self.DataModule;

// ================== Constants ==================
const ALARM_NAME = 'xTrackerAutoScan';
const OFFSCREEN_URL = 'offscreen.html';
const X_GRAPHQL_BASE = 'https://x.com/i/api/graphql';

// Bearer token (public, hardcoded in X's web client)
const BEARER_TOKEN = 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

// Cached parameters (resolved from offscreen discovery)
let apiConfig = null;

// Default fallback endpoints
const FALLBACK_ENDPOINTS = {
  followers: { queryId: 'xBB-_3k-LNxWg8TFpuQiWQ', operationName: 'Followers' },
  following: { queryId: 'OEx3R66nP411LbwQ0xgAIg', operationName: 'Following' },
  userByScreenName: { queryId: 'pLsOiyHJ1eFwPJlNmLp4Bg', operationName: 'UserByScreenName' }
};

// Default feature flags (copied from X's web client)
const DEFAULT_FEATURES = {
  "rweb_video_screen_enabled": false,
  "profile_label_improvements_pcf_label_in_post_enabled": true,
  "responsive_web_profile_redirect_enabled": false,
  "rweb_tipjar_consumption_enabled": false,
  "verified_phone_label_enabled": true,
  "creator_subscriptions_tweet_preview_api_enabled": true,
  "responsive_web_graphql_timeline_navigation_enabled": true,
  "responsive_web_graphql_skip_user_profile_image_extensions_enabled": false,
  "premium_content_api_read_enabled": false,
  "communities_web_enable_tweet_community_results_fetch": true,
  "c9s_tweet_anatomy_moderator_badge_enabled": true,
  "responsive_web_grok_analyze_button_fetch_trends_enabled": false,
  "responsive_web_grok_analyze_post_followups_enabled": true,
  "responsive_web_jetfuel_frame": true,
  "responsive_web_grok_share_attachment_enabled": true,
  "responsive_web_grok_annotations_enabled": true,
  "articles_preview_enabled": true,
  "responsive_web_edit_tweet_api_enabled": true,
  "graphql_is_translatable_rweb_tweet_is_translatable_enabled": true,
  "view_counts_everywhere_api_enabled": true,
  "longform_notetweets_consumption_enabled": true,
  "responsive_web_twitter_article_tweet_consumption_enabled": true,
  "tweet_awards_web_tipping_enabled": false,
  "content_disclosure_indicator_enabled": true,
  "content_disclosure_ai_generated_indicator_enabled": true,
  "responsive_web_grok_show_grok_translated_post": false,
  "responsive_web_grok_analysis_button_from_backend": true,
  "post_ctas_fetch_enabled": true,
  "freedom_of_speech_not_reach_fetch_enabled": true,
  "standardized_nudges_misinfo": true,
  "tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled": true,
  "longform_notetweets_rich_text_read_enabled": true,
  "longform_notetweets_inline_media_enabled": false,
  "responsive_web_grok_image_annotation_enabled": true,
  "responsive_web_grok_imagine_annotation_enabled": true,
  "responsive_web_grok_community_note_auto_translation_is_enabled": false,
  "responsive_web_enhance_cards_enabled": false
};

const USER_FEATURES = {
  "hidden_profile_subscriptions_enabled": true,
  "profile_label_improvements_pcf_label_in_post_enabled": true,
  "responsive_web_profile_redirect_enabled": false,
  "rweb_tipjar_consumption_enabled": false,
  "verified_phone_label_enabled": true,
  "subscriptions_verification_info_is_identity_verified_enabled": true,
  "subscriptions_verification_info_verified_since_enabled": true,
  "highlights_tweets_tab_ui_enabled": true,
  "responsive_web_twitter_article_notes_tab_enabled": true,
  "subscriptions_feature_can_gift_premium": true,
  "creator_subscriptions_tweet_preview_api_enabled": true,
  "responsive_web_graphql_skip_user_profile_image_extensions_enabled": false,
  "responsive_web_graphql_timeline_navigation_enabled": true
};

// ================== Installation & Startup ==================

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('X-Tracker installed/updated:', details.reason);

  const data = await chrome.storage.local.get(['users', 'settings']);

  if (!data.users) {
    await chrome.storage.local.set({
      users: {},
      userList: [],
      currentUser: null,
      scanStatus: 'idle'
    });
  }

  if (!data.settings) {
    await chrome.storage.local.set({
      settings: getDefaultSettings()
    });
  }

  await migrateDataIfNeeded();
  await setupAlarm();

  console.log('X-Tracker initialization complete');
});

chrome.runtime.onStartup.addListener(async () => {
  console.log('Browser started - setting up alarms');
  await chrome.storage.local.set({ scanStatus: 'idle' });
  await migrateDataIfNeeded();
  await setupAlarm();
});

chrome.runtime.onSuspend.addListener(() => {
  console.log('Service worker suspending');
  chrome.storage.local.set({ scanStatus: 'idle' });
});

// ================== Alarm System ==================

async function setupAlarm() {
  const data = await chrome.storage.local.get(['settings']);
  const settings = data.settings || getDefaultSettings();

  if (!settings.backgroundScanEnabled) {
    await chrome.alarms.clear(ALARM_NAME);
    console.log('Background scanning disabled - alarm cleared');
    return;
  }

  await chrome.alarms.clear(ALARM_NAME);

  const jitterMinutes = Math.round((Math.random() * 2 - 1) * JITTER_MINUTES);
  const periodMinutes = (settings.scanIntervalHours || DEFAULT_SCAN_INTERVAL_HOURS) * 60;
  const delayMinutes = Math.max(1, periodMinutes + jitterMinutes);

  chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: delayMinutes,
    periodInMinutes: periodMinutes
  });

  console.log(`Alarm set: first fire in ${delayMinutes}min, then every ${periodMinutes}min`);
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;

  console.log('Auto-scan alarm fired');

  const data = await chrome.storage.local.get(['settings', 'scanStatus']);
  const settings = data.settings || getDefaultSettings();

  if (!settings.backgroundScanEnabled) {
    console.log('Background scan disabled, skipping');
    return;
  }

  if (data.scanStatus === 'scanning') {
    console.log('Scan already in progress, skipping');
    return;
  }

  await runAutoScan();
});

// ================== Parameter Discovery ==================

/**
 * Ensure we have API parameters (query IDs, features).
 * Uses offscreen document for discovery, with fallback to hardcoded defaults.
 */
async function ensureApiConfig(forceRefresh = false) {
  if (apiConfig && !forceRefresh) return apiConfig;

  console.log('Resolving API parameters...');

  try {
    await ensureOffscreenDocument();

    const result = await chrome.runtime.sendMessage({
      target: 'offscreen',
      action: 'discoverParameters'
    });

    if (result && !result.error) {
      apiConfig = {
        endpoints: result.endpoints || FALLBACK_ENDPOINTS,
        features: result.features || DEFAULT_FEATURES,
        userFeatures: result.userFeatures || USER_FEATURES
      };
      console.log('API parameters resolved from discovery');
    } else {
      console.warn('Discovery returned error:', result?.error);
      apiConfig = {
        endpoints: { ...FALLBACK_ENDPOINTS },
        features: { ...DEFAULT_FEATURES },
        userFeatures: { ...USER_FEATURES }
      };
    }
  } catch (error) {
    console.warn('Discovery failed, using fallback parameters:', error.message);
    apiConfig = {
      endpoints: { ...FALLBACK_ENDPOINTS },
      features: { ...DEFAULT_FEATURES },
      userFeatures: { ...USER_FEATURES }
    };
  }

  // Close offscreen after discovery
  await closeOffscreenDocument();

  return apiConfig;
}

// ================== X API Functions ==================

/**
 * Get all x.com cookies as a string for the Cookie header.
 * Service worker fetch with credentials:'include' doesn't reliably attach
 * cross-origin cookies, so we read them explicitly via chrome.cookies API
 * and set them as a header (allowed for extensions with host_permissions).
 */
async function getCookieString() {
  try {
    const cookies = await chrome.cookies.getAll({ domain: '.x.com' });
    // Also get cookies set directly on x.com (no leading dot)
    const cookies2 = await chrome.cookies.getAll({ url: 'https://x.com' });
    const all = new Map();
    for (const c of [...cookies, ...cookies2]) {
      all.set(c.name, c.value);
    }
    return Array.from(all.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
  } catch (error) {
    console.error('Failed to get cookies:', error);
    return '';
  }
}

/**
 * Build headers for X API requests
 */
function buildHeaders(csrfToken, cookieString) {
  const headers = {
    'authorization': BEARER_TOKEN,
    'x-csrf-token': csrfToken,
    'x-twitter-auth-type': 'OAuth2Session',
    'x-twitter-active-user': 'yes',
    'x-twitter-client-language': 'en',
    'content-type': 'application/json',
    'referer': 'https://x.com/',
    'origin': 'https://x.com'
  };
  if (cookieString) {
    headers['Cookie'] = cookieString;
  }
  return headers;
}

/**
 * Get user ID from screen name via X's GraphQL API.
 * Called directly from service worker (has host_permissions).
 */
async function getUserByScreenName(screenName, csrfToken, retried = false) {
  const config = await ensureApiConfig();
  const endpoint = config.endpoints.userByScreenName;
  const cookieString = await getCookieString();

  const variables = {
    screen_name: screenName,
    withSafetyModeUserFields: true
  };

  const fieldToggles = { withPayments: false, withAuxiliaryUserLabels: true };

  const url = `${X_GRAPHQL_BASE}/${endpoint.queryId}/${endpoint.operationName}?variables=${encodeURIComponent(JSON.stringify(variables))}&features=${encodeURIComponent(JSON.stringify(config.userFeatures))}&fieldToggles=${encodeURIComponent(JSON.stringify(fieldToggles))}`;

  console.log(`Fetching UserByScreenName: @${screenName}`);
  console.log(`[DIAG] Cookies present: ${cookieString ? cookieString.split(';').map(c => c.trim().split('=')[0]).join(', ') : 'NONE'}`);

  const response = await fetch(url, {
    method: 'GET',
    headers: buildHeaders(csrfToken, cookieString),
    credentials: 'omit'
  });

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error('SESSION_EXPIRED');
    }
    if (response.status === 429) {
      throw new Error('RATE_LIMITED');
    }
    if ((response.status === 404 || response.status === 400) && !retried) {
      console.warn(`Got ${response.status} for UserByScreenName - forcing re-discovery...`);
      apiConfig = null;
      await ensureApiConfig(true);
      return getUserByScreenName(screenName, csrfToken, true);
    }
    const errorBody = await response.text().catch(() => 'No body');
    console.error(`UserByScreenName API Error ${response.status}:`, errorBody);
    throw new Error(`API error: ${response.status}`);
  }

  const responseData = await response.json();
  const user = responseData?.data?.user?.result;

  if (!user || !user.rest_id) {
    console.error('UserByScreenName: unexpected response:', JSON.stringify(responseData).substring(0, 500));
    throw new Error(`User @${screenName} not found in API response`);
  }

  const rawId = user.rest_id;
  const cleanId = String(rawId).replace(/[^0-9]/g, '');

  console.log(`Resolved @${screenName} → ID: ${cleanId}, followers: ${user.legacy?.followers_count}, following: ${user.legacy?.friends_count}`);

  return {
    id: cleanId,
    name: user.legacy?.name,
    username: user.legacy?.screen_name?.toLowerCase(),
    followersCount: user.legacy?.followers_count,
    followingCount: user.legacy?.friends_count,
    verified: user.is_blue_verified || false,
    avatar: user.legacy?.profile_image_url_https?.replace('_normal', '_200x200') || '',
    bio: user.legacy?.description || ''
  };
}

/**
 * Fetch a page of followers or following from X's GraphQL API.
 */
async function fetchUserList(userId, scanType, csrfToken, cursor = null, retried = false) {
  const config = await ensureApiConfig();
  const endpoint = config.endpoints[scanType];
  const cookieString = await getCookieString();

  const variables = {
    userId: userId,
    count: 20,
    includePromotedContent: false,
    withGrokTranslatedBio: false
  };
  if (cursor) variables.cursor = cursor;

  const url = `${X_GRAPHQL_BASE}/${endpoint.queryId}/${endpoint.operationName}?variables=${encodeURIComponent(JSON.stringify(variables))}&features=${encodeURIComponent(JSON.stringify(config.features))}`;

  // === DIAGNOSTIC LOGGING ===
  console.log(`[DIAG] ${scanType} request URL (first 300 chars): ${url.substring(0, 300)}`);
  console.log(`[DIAG] ${scanType} queryId=${endpoint.queryId}, userId=${userId}, retried=${retried}`);
  console.log(`[DIAG] Cookies present: ${cookieString ? cookieString.split(';').map(c => c.trim().split('=')[0]).join(', ') : 'NONE'}`);

  const response = await fetch(url, {
    method: 'GET',
    headers: buildHeaders(csrfToken, cookieString),
    credentials: 'omit'
  });

  // Log response metadata
  console.log(`[DIAG] ${scanType} response: status=${response.status}, redirected=${response.redirected}, finalURL=${response.url?.substring(0, 200)}`);

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error('SESSION_EXPIRED');
    }
    if (response.status === 429) {
      throw new Error('RATE_LIMITED');
    }
    if ((response.status === 404 || response.status === 400) && !retried) {
      console.warn(`Got ${response.status} for ${scanType} - forcing re-discovery...`);
      apiConfig = null;
      await ensureApiConfig(true);
      return fetchUserList(userId, scanType, csrfToken, cursor, true);
    }
    const errorBody = await response.text().catch(() => 'No body');
    console.error(`${scanType} API Error ${response.status}:`, errorBody);
    // Log response headers for debugging
    const hdrs = {};
    response.headers.forEach((v, k) => hdrs[k] = v);
    console.error(`[DIAG] ${scanType} response headers:`, JSON.stringify(hdrs));
    throw new Error(`API error ${response.status} for ${scanType}`);
  }

  const data = await response.json();

  // Parse timeline entries
  const timeline = data?.data?.user?.result?.timeline?.timeline;
  if (!timeline) {
    return { users: [], nextCursor: null };
  }

  const instructions = timeline.instructions || [];
  const users = [];
  let nextCursor = null;

  for (const instruction of instructions) {
    const entries = instruction.entries || [];

    for (const entry of entries) {
      // User entries
      if (entry.content?.entryType === 'TimelineTimelineItem' ||
          entry.content?.__typename === 'TimelineTimelineItem') {
        const userResult = entry.content?.itemContent?.user_results?.result;
        if (userResult && userResult.__typename === 'User') {
          const legacy = userResult.legacy || {};
          users.push({
            username: (legacy.screen_name || '').toLowerCase(),
            name: legacy.name || legacy.screen_name || '',
            bio: (legacy.description || '').substring(0, 160),
            avatar: (legacy.profile_image_url_https || '').replace('_normal', '_200x200'),
            verified: userResult.is_blue_verified || false,
            profileUrl: `https://x.com/${(legacy.screen_name || '').toLowerCase()}`,
            followersCount: legacy.followers_count || 0,
            followingCount: legacy.friends_count || 0,
            timestamp: Date.now()
          });
        }
      }

      // Cursor entries
      if (entry.content?.entryType === 'TimelineTimelineCursor' ||
          entry.content?.__typename === 'TimelineTimelineCursor') {
        if (entry.content.cursorType === 'Bottom') {
          nextCursor = entry.content.value;
        }
      }
    }
  }

  return { users, nextCursor };
}

/**
 * Fetch all followers or following with pagination
 */
async function fetchAllUsers(userId, scanType, csrfToken, onProgress, expectedCount) {
  const allUsers = new Map();
  let cursor = null;
  let pageCount = 0;
  const maxPages = 100;

  do {
    pageCount++;

    const result = await fetchUserList(userId, scanType, csrfToken, cursor);

    for (const user of result.users) {
      if (user.username && !allUsers.has(user.username)) {
        allUsers.set(user.username, user);
      }
    }

    cursor = result.nextCursor;

    const progress = expectedCount > 0
      ? Math.min(95, Math.round((allUsers.size / expectedCount) * 100))
      : Math.min(95, pageCount * 10);

    if (onProgress) {
      onProgress(progress, allUsers.size);
    }

    if (result.users.length === 0) break;

    // Random delay between pages (2-5 seconds)
    await sleep(2000, 5000);

    // Extra pause every 10 pages
    if (pageCount % 10 === 0) {
      await sleep(5000, 10000);
    }
  } while (cursor && pageCount < maxPages);

  return Array.from(allUsers.values());
}

// ================== Auto Scan ==================

async function runAutoScan() {
  const data = await chrome.storage.local.get(['userList', 'scanStatus']);

  if (data.scanStatus === 'scanning') {
    console.log('Already scanning, aborting');
    return;
  }

  const userList = data.userList || [];
  if (!userList.length) {
    console.log('No accounts to scan');
    return;
  }

  console.log(`Starting auto-scan for ${userList.length} account(s)`);
  await chrome.storage.local.set({ scanStatus: 'scanning' });

  try {
    const csrfToken = await getCsrfToken();
    if (!csrfToken) {
      console.warn('No CSRF token - user not logged in');
      await chrome.storage.local.set({
        scanStatus: 'paused',
        lastError: 'Not logged into X.com. Please log in and try again.'
      });
      await notifySessionExpired();
      return;
    }

    for (const username of userList) {
      try {
        await runSingleScan(username, 'followers', csrfToken);
        await sleep(10000, 30000);
        await runSingleScan(username, 'following', csrfToken);

        if (userList.indexOf(username) < userList.length - 1) {
          await sleep(30000, 60000);
        }
      } catch (error) {
        console.error(`Error scanning @${username}:`, error);

        if (error.message === 'SESSION_EXPIRED') {
          await chrome.storage.local.set({
            scanStatus: 'paused',
            lastError: 'Session expired. Please log into X.com.'
          });
          await notifySessionExpired();
          return;
        }

        if (error.message === 'RATE_LIMITED') {
          console.warn('Rate limited - stopping scan cycle');
          await chrome.storage.local.set({
            scanStatus: 'idle',
            lastError: 'Rate limited by X. Will retry next cycle.'
          });
          return;
        }

        continue;
      }
    }

    await chrome.storage.local.set({
      scanStatus: 'complete',
      lastScanTime: Date.now(),
      lastError: null
    });

    console.log('Auto-scan cycle complete');

  } catch (error) {
    console.error('Auto-scan failed:', error);
    await chrome.storage.local.set({
      scanStatus: 'error',
      lastError: error.message
    });
  }
}

/**
 * Run a single scan for one account + type.
 * All API calls happen directly in this service worker.
 */
async function runSingleScan(username, scanType, csrfToken) {
  console.log(`=== SCAN START: ${scanType} for @${username} ===`);

  try {
    // 1. Resolve username to user ID
    const userInfo = await getUserByScreenName(username, csrfToken);
    if (!userInfo.id) {
      throw new Error('Could not resolve user ID');
    }

    // 2. Report progress
    await chrome.storage.local.set({
      scanProgress: 5,
      currentScanType: scanType
    });

    // 3. Fetch all users with pagination
    const users = await fetchAllUsers(
      userInfo.id,
      scanType,
      csrfToken,
      (progress, count) => {
        chrome.storage.local.set({
          scanProgress: progress,
          currentScanType: scanType
        });
      },
      scanType === 'followers' ? userInfo.followersCount : userInfo.followingCount
    );

    console.log(`Fetched ${users.length} ${scanType} for @${username}`);

    // 4. Process results through data module
    const userData = await processScanResults(username, scanType, users);

    // 5. Notify on significant changes
    await checkAndNotify(username, scanType, userData);

    console.log(`=== SCAN COMPLETE: ${scanType} for @${username} ===`);
    return userData;

  } catch (error) {
    console.error(`=== SCAN FAILED: ${scanType} for @${username} ===`, error.message, error.stack || '');
    throw error;
  }
}

// ================== Offscreen Document Management ==================

async function ensureOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
  });

  if (existingContexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['DOM_SCRAPING'],
    justification: 'Discovering X API parameters from JS bundles'
  });

  console.log('Offscreen document created');
}

async function closeOffscreenDocument() {
  try {
    await chrome.offscreen.closeDocument();
    console.log('Offscreen document closed');
  } catch (error) {
    // Ignore - may already be closed
  }
}

// ================== Session Management ==================

async function getCsrfToken() {
  try {
    const cookie = await chrome.cookies.get({
      url: 'https://x.com',
      name: 'ct0'
    });
    return cookie?.value || null;
  } catch (error) {
    console.error('Failed to get CSRF token:', error);
    return null;
  }
}

async function isLoggedIn() {
  const csrfToken = await getCsrfToken();
  return !!csrfToken;
}

// ================== Notifications ==================

async function notifySessionExpired() {
  const data = await chrome.storage.local.get(['settings']);
  const settings = data.settings || getDefaultSettings();

  if (!settings.notificationsEnabled || !settings.notifyOnSessionExpired) return;

  chrome.notifications.create('session-expired', {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'X Tracker - Session Expired',
    message: 'Please log into X.com to continue tracking. Background scans are paused.',
    priority: 2
  });
}

async function checkAndNotify(username, scanType, userData) {
  if (scanType !== 'followers') return;

  const data = await chrome.storage.local.get(['settings']);
  const settings = data.settings || getDefaultSettings();

  if (!settings.notificationsEnabled) return;

  const events = userData.events || [];
  const recentEvents = events.filter(e => {
    const ageMs = Date.now() - e.timestamp;
    return ageMs < 60000;
  });

  const unfollows = recentEvents.filter(e => e.type === 'unfollow');
  const follows = recentEvents.filter(e => e.type === 'follow');

  if (unfollows.length > 0 && settings.notifyOnUnfollow) {
    const names = unfollows.slice(0, 3).map(e => `@${e.username}`).join(', ');
    const extra = unfollows.length > 3 ? ` and ${unfollows.length - 3} more` : '';

    chrome.notifications.create(`unfollow-${Date.now()}`, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: `X Tracker - ${unfollows.length} Unfollower(s)`,
      message: `${names}${extra} unfollowed @${username}`,
      priority: 1
    });
  }

  if (follows.length > 0 && settings.notifyOnNewFollower) {
    const names = follows.slice(0, 3).map(e => `@${e.username}`).join(', ');
    const extra = follows.length > 3 ? ` and ${follows.length - 3} more` : '';

    chrome.notifications.create(`follow-${Date.now()}`, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: `X Tracker - ${follows.length} New Follower(s)`,
      message: `${names}${extra} followed @${username}`,
      priority: 1
    });
  }
}

// ================== Utility Functions ==================

function sleep(minMs, maxMs) {
  const duration = minMs + Math.random() * ((maxMs || minMs) - minMs);
  return new Promise(resolve => setTimeout(resolve, duration));
}

// ================== Message Handler ==================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Ignore offscreen progress messages
  if (request.action === 'scanProgress') {
    chrome.storage.local.set({
      scanProgress: request.progress,
      currentScanType: request.scanType
    });
    return false;
  }

  switch (request.action) {
    case 'manualScan':
      handleManualScan(request, sendResponse);
      return true;

    case 'getStatus':
      handleGetStatus(sendResponse);
      return true;

    case 'updateSettings':
      handleUpdateSettings(request.settings, sendResponse);
      return true;

    case 'forceStopScan':
      handleForceStop(sendResponse);
      return true;

    case 'checkSession':
      handleCheckSession(sendResponse);
      return true;

    case 'scanComplete':
      chrome.storage.local.set({
        scanStatus: 'complete',
        lastScanTime: Date.now()
      });
      return false;

    case 'scanError':
      chrome.storage.local.set({
        lastError: request.error,
        scanStatus: 'error'
      });
      return false;

    default:
      return false;
  }
});

async function handleManualScan(request, sendResponse) {
  try {
    const { username, scanType } = request;

    const status = await chrome.storage.local.get(['scanStatus']);
    if (status.scanStatus === 'scanning') {
      sendResponse({ status: 'error', message: 'Scan already in progress' });
      return;
    }

    const csrfToken = await getCsrfToken();
    if (!csrfToken) {
      sendResponse({ status: 'error', message: 'Not logged into X.com. Please log in first.' });
      return;
    }

    sendResponse({ status: 'scanning' });

    await chrome.storage.local.set({ scanStatus: 'scanning' });

    if (scanType === 'both' || !scanType) {
      await runSingleScan(username, 'followers', csrfToken);
      await sleep(5000, 10000);
      await runSingleScan(username, 'following', csrfToken);
    } else {
      await runSingleScan(username, scanType, csrfToken);
    }

    await chrome.storage.local.set({
      scanStatus: 'complete',
      lastScanTime: Date.now(),
      lastError: null
    });

  } catch (error) {
    console.error('Manual scan failed:', error);
    await chrome.storage.local.set({
      scanStatus: 'error',
      lastError: error.message
    });
  }
}

async function handleGetStatus(sendResponse) {
  const data = await chrome.storage.local.get([
    'scanStatus', 'lastScanTime', 'lastError', 'settings', 'scanProgress'
  ]);

  const alarm = await chrome.alarms.get(ALARM_NAME);
  const loggedIn = await isLoggedIn();

  sendResponse({
    scanStatus: data.scanStatus || 'idle',
    lastScanTime: data.lastScanTime || null,
    lastError: data.lastError || null,
    nextScanTime: alarm?.scheduledTime || null,
    scanProgress: data.scanProgress || null,
    isLoggedIn: loggedIn,
    settings: data.settings || getDefaultSettings()
  });
}

async function handleUpdateSettings(newSettings, sendResponse) {
  const data = await chrome.storage.local.get(['settings']);
  const settings = { ...(data.settings || getDefaultSettings()), ...newSettings };

  settings.scanIntervalHours = Math.max(
    MIN_SCAN_INTERVAL_HOURS,
    Math.min(MAX_SCAN_INTERVAL_HOURS, settings.scanIntervalHours)
  );

  await chrome.storage.local.set({ settings });
  await setupAlarm();

  sendResponse({ status: 'ok', settings });
}

async function handleForceStop(sendResponse) {
  await chrome.storage.local.set({ scanStatus: 'idle' });
  await closeOffscreenDocument();
  if (sendResponse) sendResponse({ status: 'ok' });
}

async function handleCheckSession(sendResponse) {
  const loggedIn = await isLoggedIn();
  sendResponse({ isLoggedIn: loggedIn });
}