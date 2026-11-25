/**
 * X Tracker - MV3 Service Worker (ES Module)
 * Orchestrates scans using chrome.storage.session locks, alarms, tab lifecycle guards,
 * background scan tabs, IndexedDB persistence, and opt-in notifications.
 */

import {
  APP_VERSION,
  AUTO_SCAN_ALARM,
  AUTO_SCAN_FORCED_SYNC_MS,
  AUTO_SCAN_RATE_LIMIT_COOLDOWN_MS,
  DEFAULT_AUTO_SCAN_INTERVAL_MINUTES,
  SCAN_SCOPES,
  SCAN_WATCHDOG_ALARM,
  SCAN_WATCHDOG_STALE_MS,
  SESSION_KEYS,
  STORAGE_KEYS
} from './shared/constants.js';
import {
  appendAppLog,
  appendAppLogs,
  appendDiagnosticSnapshot,
  clearAppLogs,
  commitScanResult,
  deleteCheckpoint,
  getAccount,
  getLatestCheckpoint,
  getSettings,
  listAccounts,
  migrateLegacyStorageIfNeeded,
  savePassiveCaptures,
  saveSettings,
  touchDbMutation,
  updateUnfollowerReason,
  upsertAccount,
  upsertCheckpoint
} from './shared/db.js';
import { makeScanId, normalizeHandle } from './shared/utils.js';

const SCAN_PAGE_TIMEOUT_MS = 45_000;
const PROFILE_SETTLE_MS = 1_100;
const SCRAPER_FILES = [
  'content/graphql-parser.js',
  'content/hud.js',
  'content/scraper.js'
];

function swLog(level, event, message, meta = null, extra = {}) {
  appendAppLog({
    level,
    source: 'sw',
    event,
    scanId: extra.scanId || null,
    accountKey: extra.accountKey || null,
    message,
    meta
  }).catch(() => {});
}

if (typeof globalThis.addEventListener === 'function') {
  globalThis.addEventListener('error', (event) => {
    swLog('error', 'sw.uncaught_error', event?.message || 'Uncaught SW error', {
      filename: event?.filename || null,
      lineno: event?.lineno || null
    });
  });

  globalThis.addEventListener('unhandledrejection', (event) => {
    const err = event?.reason;
    swLog('error', 'sw.unhandled_rejection', err?.message || String(err || 'Unhandled promise rejection'));
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampProgress(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0;
}

async function getSessionScan() {
  const data = await chrome.storage.session.get([SESSION_KEYS.activeScan]);
  return data[SESSION_KEYS.activeScan] || null;
}

async function setSessionScan(scan) {
  if (!scan) {
    await chrome.storage.session.remove(SESSION_KEYS.activeScan);
  } else {
    await chrome.storage.session.set({ [SESSION_KEYS.activeScan]: scan });
  }
}

async function publishLiveState(patch) {
  const current = await chrome.storage.local.get([STORAGE_KEYS.scanState]);
  const nextState = {
    ...(current[STORAGE_KEYS.scanState] || {}),
    ...patch,
    updatedAt: Date.now()
  };
  await chrome.storage.local.set({
    [STORAGE_KEYS.scanStatus]: nextState.status || 'idle',
    [STORAGE_KEYS.scanState]: nextState
  });
}

async function resolveXOrigin() {
  const xTabs = await chrome.tabs.query({ url: '*://x.com/*' });
  if (xTabs.length > 0) {
    return 'https://x.com';
  }
  const twitterTabs = await chrome.tabs.query({ url: '*://twitter.com/*' });
  if (twitterTabs.length > 0) {
    return 'https://twitter.com';
  }
  return 'https://x.com';
}

async function ensureSidePanelBehavior() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (err) {
    console.warn('setPanelBehavior failed:', err?.message);
  }
}

// ================== Lifecycle Listeners (Synchronous Top-Level) ==================

chrome.runtime.onInstalled.addListener(async (details) => {
  await ensureSidePanelBehavior();
  await migrateLegacyStorageIfNeeded();
  await ensureAutoScanAlarm();
  swLog('info', 'sw.installed', `Extension ready (${details?.reason || 'install'})`, { version: APP_VERSION });
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureSidePanelBehavior();
  await migrateLegacyStorageIfNeeded();
  await setSessionScan(null);
  await publishLiveState({ status: 'idle', phase: 'idle', progress: 0 });
  await chrome.alarms.clear(SCAN_WATCHDOG_ALARM);
  await ensureAutoScanAlarm();
  swLog('info', 'sw.startup', 'Browser startup initialized SW state', { version: APP_VERSION });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === AUTO_SCAN_ALARM) {
    await runAutoScanCycle(false);
  } else if (alarm.name === SCAN_WATCHDOG_ALARM) {
    await checkScanWatchdog();
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const active = await getSessionScan();
  if (!active || active.tabId !== tabId) return;

  swLog('warn', 'scan.tab_removed', 'Scan tab was closed before completion', { tabId }, {
    scanId: active.scanId,
    accountKey: active.username
  });
  await setSessionScan(null);
  await chrome.alarms.clear(SCAN_WATCHDOG_ALARM);
  await publishLiveState({
    status: 'error',
    phase: 'interrupted',
    error: 'Scan tab was closed before completion. Partial progress was checkpointed.'
  });
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab?.url) return;

  const active = await getSessionScan();
  if (active && active.tabId === tabId && active.state === 'scanning') {
    const isX = tab.url.startsWith('https://x.com/') || tab.url.startsWith('https://twitter.com/');
    if (!isX) {
      swLog('warn', 'scan.nav_away', 'Scan tab navigated away from X', { url: tab.url }, {
        scanId: active.scanId,
        accountKey: active.username
      });
      await setSessionScan(null);
      await chrome.alarms.clear(SCAN_WATCHDOG_ALARM);
      await publishLiveState({
        status: 'error',
        phase: 'interrupted',
        error: 'Scan tab navigated away from X. Partial progress was checkpointed.'
      });
      return;
    }
  }

  // Optional in-page profile status pill when user browses X profiles
  const settings = await getSettings();
  if (settings.inPageBadgeEnabled && !active) {
    maybeShowProfileBadge(tabId, tab.url).catch(() => {});
  }
});

chrome.notifications.onClicked.addListener(async () => {
  try {
    const win = await chrome.windows.getLastFocused({ populate: false });
    if (win?.id) {
      await chrome.sidePanel.open({ windowId: win.id });
    }
  } catch {
    // Ignore if sidePanel.open cannot be invoked in current window state
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  (async () => {
    switch (request?.action) {
      case 'startScan':
        return await startScan(request);

      case 'pauseScan':
        return await controlActiveScan('pauseScan', 'paused');

      case 'resumeScan':
        return await controlActiveScan('resumeScan', 'scanning');

      case 'stopScan':
        return await controlActiveScan('stopScan', 'stopping');

      case 'forceResetScan':
        return await forceResetScan();

      case 'detectActiveXAccount':
        return await detectActiveXAccount();

      case 'checkUnfollowerReasons':
        return await checkUnfollowerReasons(request.accountKey, request.handles || []);

      case 'togglePassiveCapture':
        return await togglePassiveCapture(request.scopes || []);

      case 'scanCheckpoint':
        return await handleScanCheckpoint(request);

      case 'scanProgress':
        return await handleScanProgress(request);

      case 'scanFinalize':
        return await handleScanFinalize(request);

      case 'scanCancelled':
        return await handleScanCancelled(request);

      case 'scanError':
        return await handleScanError(request);

      case 'savePassiveCapture':
        return await handleSavePassiveCapture(request);

      case 'appendAppLogs':
        return { status: 'ok', saved: await appendAppLogs(request.entries || []) };

      case 'clearAppLogs':
        await clearAppLogs();
        return { status: 'ok' };

      case 'getRuntimeDiagnostics': {
        const localData = await chrome.storage.local.get([
          STORAGE_KEYS.scanState,
          STORAGE_KEYS.autoScanMeta,
          STORAGE_KEYS.lastDbMutationAt,
          STORAGE_KEYS.lastLogMutationAt
        ]);
        return {
          status: 'ok',
          runtime: {
            appVersion: APP_VERSION,
            activeScanSession: await getSessionScan(),
            scanLiveState: localData[STORAGE_KEYS.scanState] || null,
            autoScanMeta: localData[STORAGE_KEYS.autoScanMeta] || null,
            lastDbMutationAt: localData[STORAGE_KEYS.lastDbMutationAt] || null,
            lastLogMutationAt: localData[STORAGE_KEYS.lastLogMutationAt] || null
          }
        };
      }

      case 'getAutoScanSettings':
        return await getAutoScanStatus();

      case 'setAutoScanSettings':
        return await updateAutoScanSettings(request.settings || {});

      case 'runAutoScanNow':
        return await runAutoScanCycle(true);

      case 'updateSettings':
        return { status: 'ok', settings: await saveSettings(request.settings || {}) };

      default:
        return { status: 'ignored' };
    }
  })()
    .then((result) => sendResponse(result))
    .catch((error) => {
      console.error('SW message error:', error);
      swLog('error', 'sw.message_error', error?.message || 'Unexpected SW error', {
        action: request?.action || 'unknown'
      });
      sendResponse({ status: 'error', message: error?.message || 'Unexpected service worker error' });
    });

  return true;
});

// ================== Tab Navigation & Script Injection ==================

async function ensureContentScripts(tabId) {
  try {
    const ping = await chrome.tabs.sendMessage(tabId, { action: 'pingScraper' });
    if (ping?.ok) return;
  } catch {
    // Not injected yet
  }

  // Ensure MAIN observer is also installed if tab predates extension install/reload
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    files: ['content/main-interceptor.js']
  }).catch(() => {});

  await chrome.scripting.executeScript({
    target: { tabId },
    files: SCRAPER_FILES
  });
}

/**
 * Navigate a tab and wait until the NEW navigation completes (eliminating stale 'complete' races).
 */
async function navigateTabAndWait(tabId, targetUrl, timeoutMs = SCAN_PAGE_TIMEOUT_MS) {
  let sawLoading = false;
  const targetObj = new URL(targetUrl);

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out loading ${targetObj.pathname}`));
    }, timeoutMs);

    const cleanup = () => {
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };

    const onUpdated = (updatedId, changeInfo, tab) => {
      if (settled || updatedId !== tabId) return;
      if (changeInfo.status === 'loading') {
        sawLoading = true;
      }
      if (changeInfo.status === 'complete' && sawLoading) {
        cleanup();
        resolve(tab);
      }
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.update(tabId, { url: targetUrl }).then((updatedTab) => {
      // Fallback for fast in-memory transitions where loading event coalesced
      setTimeout(async () => {
        if (settled) return;
        try {
          const fresh = await chrome.tabs.get(tabId);
          if (fresh?.status === 'complete' && fresh?.url?.includes(targetObj.pathname)) {
            cleanup();
            resolve(fresh);
          }
        } catch {
          // Tab closed
        }
      }, 1500);
      void updatedTab;
    }).catch((err) => {
      if (!settled) {
        cleanup();
        reject(new Error(err?.message || 'Failed to update tab URL'));
      }
    });
  });
}

async function acquireScanTab(initialUrl, tabPlacement = 'dedicated') {
  const mode =
    typeof tabPlacement === 'boolean'
      ? (tabPlacement ? 'background' : 'active')
      : tabPlacement;

  if (mode === 'active') {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab?.id) {
      await navigateTabAndWait(activeTab.id, initialUrl, SCAN_PAGE_TIMEOUT_MS);
      return { tabId: activeTab.id, dedicatedTab: false, restoreTabId: null };
    }
    const created = await chrome.tabs.create({ url: initialUrl, active: true });
    await waitForInitialTabComplete(created.id, SCAN_PAGE_TIMEOUT_MS);
    return { tabId: created.id, dedicatedTab: true, restoreTabId: null };
  }

  if (mode === 'background') {
    const created = await chrome.tabs.create({ url: initialUrl, active: false });
    await waitForInitialTabComplete(created.id, SCAN_PAGE_TIMEOUT_MS);
    return { tabId: created.id, dedicatedTab: true, restoreTabId: null };
  }

  const [prevActive] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  const created = await chrome.tabs.create({ url: initialUrl, active: true });
  await waitForInitialTabComplete(created.id, SCAN_PAGE_TIMEOUT_MS);
  return {
    tabId: created.id,
    dedicatedTab: true,
    restoreTabId: prevActive?.id && prevActive.id !== created.id ? prevActive.id : null
  };
}

function waitForInitialTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for new tab load.'));
    }, timeoutMs);
    const cleanup = () => {
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
    const onUpdated = (id, info, tab) => {
      if (id === tabId && info.status === 'complete') {
        cleanup();
        resolve(tab);
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then((tab) => {
      if (!settled && tab?.status === 'complete' && tab?.url && tab.url !== 'about:blank') {
        cleanup();
        resolve(tab);
      }
    }).catch(() => {});
  });
}

async function releaseDedicatedTab(session) {
  if (!session?.dedicatedTab || !session?.tabId) return;
  let shouldRestore = false;
  if (session.restoreTabId && session.restoreTabId !== session.tabId) {
    const [currentActive] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
    shouldRestore = currentActive?.id === session.tabId;
  }
  await chrome.tabs.remove(session.tabId).catch(() => {});
  if (shouldRestore) {
    await chrome.tabs.update(session.restoreTabId, { active: true }).catch(() => {});
  }
}

async function releaseScanResources(session) {
  // Clear active session state before closing tab so tabs.onRemoved ignores intentional cleanup
  await setSessionScan(null);
  await chrome.alarms.clear(SCAN_WATCHDOG_ALARM);
  await releaseDedicatedTab(session);
}

// ================== Guided Scan Orchestration ==================

async function probeProfile(tabId, username) {
  await ensureContentScripts(tabId);
  for (let attempt = 1; attempt <= 6; attempt++) {
    await sleep(attempt === 1 ? 800 : 650);
    const res = await chrome.tabs.sendMessage(tabId, {
      action: 'probeProfileDom',
      username
    }).catch(() => null);

    if (res?.error) {
      swLog('warn', 'scan.probe_error', res.error, { attempt }, { accountKey: username });
      throw new Error(res.error);
    }
    if (res && (Number.isFinite(res.followers) || Number.isFinite(res.following))) {
      swLog('info', 'scan.probe_ok', `Profile counts read (${res.source || 'dom'})`, {
        attempt,
        followers: res.followers,
        following: res.following,
        source: res.source
      }, { accountKey: username });
      return res;
    }
  }
  swLog('warn', 'scan.probe_missing', 'Profile counts unavailable after polling', { attempts: 6 }, {
    accountKey: username
  });
  return { followers: null, following: null, source: 'unknown' };
}

async function startScan({
  username,
  scanType = 'followers',
  scanSource = 'manual',
  resumeScanId = null,
  preloadedProfileCounts = null
}) {
  const cleanUser = normalizeHandle(username);
  if (!cleanUser) {
    return { status: 'error', message: 'Please select or add an X account first.' };
  }

  const scope = SCAN_SCOPES[scanType] || SCAN_SCOPES.followers;

  // Atomic transitional session lock prevents double-starts
  const existing = await getSessionScan();
  if (existing && existing.state !== 'idle') {
    return { status: 'error', message: 'A scan is already running.' };
  }

  const settings = await getSettings();
  const scanId = resumeScanId || makeScanId(scope.id);
  let resumeCheckpoint = null;
  if (resumeScanId) {
    resumeCheckpoint = await getLatestCheckpoint(cleanUser, scope.id);
  }

  // Always use 'dedicated' (active foreground tab) for manual scans:
  // background tabs are severely throttled by Chrome (rAF paused, IntersectionObserver frozen,
  // scroll events suppressed), which prevents X's infinite-scroll pagination from triggering
  // subsequent GraphQL requests — resulting in only the first page (~50 users) being captured.
  const tabPlacement = scanSource === 'auto' ? 'background' : 'dedicated';
  const origin = await resolveXOrigin();
  const profileUrl = `${origin}/${encodeURIComponent(cleanUser)}`;
  const listUrl = `${origin}/${encodeURIComponent(cleanUser)}/${scope.path}`;

  swLog('info', 'scan.start', `Starting ${scope.id} scan (${tabPlacement})`, {
    scanSource,
    tabPlacement,
    origin,
    resuming: Boolean(resumeCheckpoint)
  }, { scanId, accountKey: cleanUser });

  await setSessionScan({
    scanId,
    username: cleanUser,
    scanType: scope.id,
    source: scanSource,
    state: 'starting',
    startedAt: Date.now(),
    lastHeartbeatAt: Date.now(),
    tabId: null,
    dedicatedTab: tabPlacement !== 'active',
    restoreTabId: null
  });

  await publishLiveState({
    status: 'scanning',
    scanId,
    username: cleanUser,
    scanType: scope.id,
    phase: 'profile',
    progress: 3,
    count: resumeCheckpoint?.users?.length || 0,
    expected: null,
    error: null
  });

  await chrome.alarms.create(SCAN_WATCHDOG_ALARM, { periodInMinutes: 1 });

  let tabInfo = null;
  try {
    let profileCounts = preloadedProfileCounts;

    if (!profileCounts) {
      tabInfo = await acquireScanTab(profileUrl, tabPlacement);
      await setSessionScan({
        scanId,
        username: cleanUser,
        scanType: scope.id,
        source: scanSource,
        state: 'probing',
        startedAt: Date.now(),
        lastHeartbeatAt: Date.now(),
        tabId: tabInfo.tabId,
        dedicatedTab: tabInfo.dedicatedTab,
        restoreTabId: tabInfo.restoreTabId || null
      });
      profileCounts = await probeProfile(tabInfo.tabId, cleanUser);

      // Persist latest profile metadata (restId, avatar, name)
      await upsertAccount(cleanUser, {
        restId: profileCounts.restId || undefined,
        name: profileCounts.name || undefined,
        avatar: profileCounts.avatar || undefined,
        lastProfileCounts: profileCounts
      });
    } else {
      tabInfo = await acquireScanTab(listUrl, tabPlacement);
    }

    const expectedCount =
      scope.id === 'following'
        ? profileCounts?.following
        : (scope.id === 'followers' ? profileCounts?.followers : null);

    await publishLiveState({
      status: 'scanning',
      scanId,
      username: cleanUser,
      scanType: scope.id,
      phase: 'loading',
      progress: 7,
      count: resumeCheckpoint?.users?.length || 0,
      expected: Number.isFinite(expectedCount) ? expectedCount : null
    });

    if (!preloadedProfileCounts) {
      await navigateTabAndWait(tabInfo.tabId, listUrl, SCAN_PAGE_TIMEOUT_MS);
      await sleep(500);
    }

    await ensureContentScripts(tabInfo.tabId);

    await setSessionScan({
      scanId,
      username: cleanUser,
      scanType: scope.id,
      source: scanSource,
      state: 'scanning',
      startedAt: Date.now(),
      lastHeartbeatAt: Date.now(),
      tabId: tabInfo.tabId,
      dedicatedTab: tabInfo.dedicatedTab,
      restoreTabId: tabInfo.restoreTabId || null,
      expectedCount
    });

    const scanConfig = {
      scanId,
      username: cleanUser,
      scanType: scope.id,
      scanLabel: scope.label,
      expectedCount: Number.isFinite(expectedCount) ? expectedCount : null,
      expectedSource: profileCounts?.source || 'profile',
      profileCounts,
      resumeUsers: resumeCheckpoint?.users || null,
      resumeCursor: resumeCheckpoint?.cursor || null
    };

    // Require an immediate start ack so failed delivery never leaves UI stuck at 7%
    let startAck = await chrome.tabs
      .sendMessage(tabInfo.tabId, { action: 'runGuidedScan', config: scanConfig })
      .catch(() => null);

    if (!startAck?.ok && startAck?.status !== 'busy') {
      await sleep(500);
      await ensureContentScripts(tabInfo.tabId);
      startAck = await chrome.tabs
        .sendMessage(tabInfo.tabId, { action: 'runGuidedScan', config: scanConfig })
        .catch(() => null);
    }

    if (startAck?.status === 'busy') {
      throw new Error('Another scan is already active in this X tab.');
    }
    if (!startAck?.ok) {
      throw new Error('Could not start X list scanner inside the tab.');
    }

    return { status: 'scanning', scanId, tabId: tabInfo.tabId };
  } catch (error) {
    const active = await getSessionScan();
    await releaseScanResources(active || tabInfo);
    await appendDiagnosticSnapshot(cleanUser, {
      scanId,
      type: scope.id,
      source: scanSource,
      status: 'failed',
      reason: error?.message || 'Failed to start scan'
    });
    await publishLiveState({
      status: 'error',
      phase: 'error',
      error: error?.message || 'Failed to start scan'
    });
    return { status: 'error', message: error?.message || 'Failed to start scan' };
  }
}

async function controlActiveScan(actionName, nextPhase) {
  const active = await getSessionScan();
  if (!active?.tabId) {
    return { status: 'error', message: 'No active scan session.' };
  }
  await chrome.tabs.sendMessage(active.tabId, { action: actionName }).catch(() => {});
  await setSessionScan({
    ...active,
    state: nextPhase,
    lastHeartbeatAt: Date.now()
  });
  await publishLiveState({ phase: nextPhase });
  return { status: 'ok' };
}

async function forceResetScan() {
  const active = await getSessionScan();
  if (active?.tabId) {
    await chrome.tabs.sendMessage(active.tabId, { action: 'stopScan' }).catch(() => {});
  }
  await releaseScanResources(active);
  await publishLiveState({ status: 'idle', phase: 'idle', progress: 0, error: null });
  return { status: 'ok' };
}

async function checkScanWatchdog() {
  const active = await getSessionScan();
  if (!active) {
    await chrome.alarms.clear(SCAN_WATCHDOG_ALARM);
    return;
  }

  if (active.state === 'paused' || active.state === 'rate_limited') {
    return;
  }

  let tabAlive = false;
  if (active.tabId) {
    tabAlive = await chrome.tabs.get(active.tabId).then(() => true).catch(() => false);
  } else if (Date.now() - active.startedAt < 60_000) {
    tabAlive = true;
  }

  const stale = Date.now() - (active.lastHeartbeatAt || active.startedAt) > SCAN_WATCHDOG_STALE_MS;
  if (!tabAlive || stale) {
    await setSessionScan(null);
    await chrome.alarms.clear(SCAN_WATCHDOG_ALARM);
    await publishLiveState({
      status: 'error',
      phase: 'interrupted',
      error: tabAlive
        ? 'Scan stalled without heartbeat. Resume from your saved checkpoint.'
        : 'Scan tab closed unexpectedly. Resume from your saved checkpoint.'
    });
  }
}

// ================== Scan Progress, Checkpoint, Finalize ==================

async function handleScanCheckpoint(request) {
  const active = await getSessionScan();
  if (active) {
    await setSessionScan({ ...active, lastHeartbeatAt: Date.now() });
  }

  const cleanUser = normalizeHandle(request.username);
  const existing = await getLatestCheckpoint(cleanUser, request.scanType);
  const mergedMap = new Map();

  for (const u of existing?.users || []) {
    const k = u.restId || normalizeHandle(u.username);
    if (k) mergedMap.set(k, u);
  }
  for (const u of request.users || []) {
    const k = u.restId || normalizeHandle(u.username);
    if (k) mergedMap.set(k, u);
  }

  await upsertCheckpoint({
    scanId: request.scanId,
    accountKey: cleanUser,
    scanType: request.scanType,
    startedAt: existing?.startedAt || Date.now(),
    updatedAt: Date.now(),
    cursor: request.cursor || existing?.cursor || null,
    users: Array.from(mergedMap.values())
  });

  return { status: 'ok', saved: mergedMap.size };
}

async function handleScanProgress(request) {
  const active = await getSessionScan();
  if (active) {
    await setSessionScan({
      ...active,
      state: request.phase === 'paused' || request.phase === 'rate_limited' ? request.phase : 'scanning',
      lastHeartbeatAt: Date.now()
    });
  }

  await publishLiveState({
    status: 'scanning',
    scanId: request.scanId || active?.scanId || null,
    phase: request.phase || 'scanning',
    progress: clampProgress(request.progress),
    count: Number.isFinite(request.count) ? request.count : null,
    expected: Number.isFinite(request.expected) ? request.expected : null,
    sourceMode: request.sourceMode || null,
    rateLimitResetAt: request.rateLimitResetAt || null
  });

  return { status: 'ok' };
}

async function handleScanFinalize(request) {
  const active = await getSessionScan();
  const cleanUser = normalizeHandle(request.username);

  try {
    const diffOut = await commitScanResult({
      accountKey: cleanUser,
      scanType: request.scanType,
      users: request.users || [],
      expectedCount: request.expectedCount ?? null,
      expectedSource: request.expectedSource || 'profile',
      scanSource: active?.source || 'manual',
      partial: Boolean(request.partial),
      profileCounts: request.profileCounts || null,
      scanId: request.scanId
    });

    const now = Date.now();
    const isComplete = Boolean(diffOut.snapshot.isComplete);
    if (active?.source === 'auto' && isComplete) {
      const meta = (await chrome.storage.local.get([STORAGE_KEYS.autoScanMeta]))[STORAGE_KEYS.autoScanMeta] || {};
      await chrome.storage.local.set({
        [STORAGE_KEYS.autoScanMeta]: {
          ...meta,
          lastRunAt: now,
          lastSuccessAt: now,
          lastError: null
        }
      });
    }

    await publishLiveState({
      status: isComplete ? 'complete' : 'partial',
      phase: isComplete ? 'complete' : 'partial',
      progress: isComplete ? 100 : (diffOut.quality.coverage ? Math.min(99, Math.round(diffOut.quality.coverage * 100)) : 95),
      count: diffOut.snapshot.count,
      expected: diffOut.snapshot.expected,
      lastQuality: diffOut.quality.qualityStatus,
      message: isComplete
        ? `Scan complete: ${diffOut.snapshot.count.toLocaleString()} accounts synced.`
        : `Partial scan: collected ${diffOut.snapshot.count.toLocaleString()} of ${diffOut.snapshot.expected?.toLocaleString() || '?'}. Baseline stats preserved.`
    });

    if (isComplete) {
      await maybeNotifyScanResult(cleanUser, diffOut);
    }
    swLog('info', 'scan.finalize', `Completed ${request.scanType} scan (${diffOut.snapshot.count} users)`, {
      scanType: request.scanType,
      count: diffOut.snapshot.count,
      expected: diffOut.snapshot.expected ?? null,
      quality: diffOut.quality.qualityStatus,
      partial: Boolean(request.partial),
      gained: diffOut.snapshot.delta?.gained?.length || 0,
      lost: diffOut.snapshot.delta?.lost?.length || 0
    }, { scanId: request.scanId, accountKey: cleanUser });
    return { status: 'ok', snapshot: diffOut.snapshot };
  } finally {
    await releaseScanResources(active);
  }
}

async function handleScanCancelled(request) {
  const active = await getSessionScan();
  swLog('info', 'scan.cancelled', 'Scan cancelled cleanly by user', null, {
    scanId: request.scanId,
    accountKey: active?.username || null
  });
  await deleteCheckpoint(request.scanId);
  await releaseScanResources(active);
  await publishLiveState({ status: 'idle', phase: 'idle', progress: 0 });
  return { status: 'ok' };
}

async function handleScanError(request) {
  const active = await getSessionScan();
  const cleanUser = normalizeHandle(request.username || active?.username);
  const now = Date.now();

  swLog('error', 'scan.error', request.error || 'Scan failed', {
    code: request.code || null,
    partialCount: request.partialCount ?? null,
    scanType: request.scanType || active?.scanType || 'followers'
  }, { scanId: request.scanId || active?.scanId || null, accountKey: cleanUser });

  await appendDiagnosticSnapshot(cleanUser, {
    scanId: request.scanId,
    type: request.scanType || active?.scanType || 'followers',
    source: active?.source || 'manual',
    count: Number.isFinite(request.partialCount) ? request.partialCount : null,
    status: 'failed',
    reason: request.error || 'Scan error'
  });

  if (active?.source === 'auto' || request.code === 'rate_limit') {
    const meta = (await chrome.storage.local.get([STORAGE_KEYS.autoScanMeta]))[STORAGE_KEYS.autoScanMeta] || {};
    const cooldownUntil = request.resetAtMs || (request.code === 'rate_limit' ? now + AUTO_SCAN_RATE_LIMIT_COOLDOWN_MS : meta.cooldownUntil);
    await chrome.storage.local.set({
      [STORAGE_KEYS.autoScanMeta]: {
        ...meta,
        lastRunAt: now,
        lastError: request.error,
        cooldownUntil: cooldownUntil || null
      }
    });
    await ensureAutoScanAlarm();
  }

  await publishLiveState({
    status: 'error',
    phase: 'error',
    error: request.error || 'Scan failed',
    rateLimitResetAt: request.resetAtMs || null
  });

  await releaseScanResources(active);
  return { status: 'ok' };
}

// ================== Notifications ==================

async function maybeNotifyScanResult(username, diffOut) {
  const settings = await getSettings();
  if (!settings.notificationsEnabled) return;

  const lost = diffOut.snapshot?.delta?.lost?.length || 0;
  const gained = diffOut.snapshot?.delta?.gained?.length || 0;
  const renamed = diffOut.renamedRecords?.length || 0;

  if (lost === 0 && gained === 0 && renamed === 0) {
    return;
  }

  const parts = [];
  if (lost > 0) parts.push(`${lost} unfollower${lost === 1 ? '' : 's'}`);
  if (gained > 0) parts.push(`${gained} new follower${gained === 1 ? '' : 's'}`);
  if (renamed > 0) parts.push(`${renamed} handle rename${renamed === 1 ? '' : 's'}`);

  await chrome.notifications.create(`x-tracker-${Date.now()}`, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: `X Tracker · @${username}`,
    message: `Detected ${parts.join(', ')}.`
  }).catch(() => {});
}

// ================== Auto-Scan Alarm Engine ==================

async function getAutoScanStatus() {
  const settings = await getSettings();
  const data = await chrome.storage.local.get([STORAGE_KEYS.autoScanMeta]);
  const meta = data[STORAGE_KEYS.autoScanMeta] || {};
  return {
    autoScanEnabled: Boolean(settings.autoScanEnabled),
    autoScanIntervalMinutes: settings.autoScanIntervalMinutes || DEFAULT_AUTO_SCAN_INTERVAL_MINUTES,
    autoScanNextRunAt: meta.nextRunAt || null,
    autoScanCooldownUntil: meta.cooldownUntil || null,
    autoScanLastRunAt: meta.lastRunAt || null,
    autoScanLastSuccessAt: meta.lastSuccessAt || null,
    autoScanLastProfileFollowerCount: meta.lastProfileFollowerCount ?? null,
    autoScanLastError: meta.lastError || null
  };
}

async function updateAutoScanSettings(patch) {
  const interval = Math.min(24 * 60, Math.max(60, Number(patch.autoScanIntervalMinutes) || DEFAULT_AUTO_SCAN_INTERVAL_MINUTES));
  await saveSettings({
    autoScanEnabled: Boolean(patch.autoScanEnabled),
    autoScanIntervalMinutes: interval
  });
  await ensureAutoScanAlarm();
  return { status: 'ok', ...(await getAutoScanStatus()) };
}

async function ensureAutoScanAlarm() {
  const settings = await getSettings();
  await chrome.alarms.clear(AUTO_SCAN_ALARM);

  const meta = (await chrome.storage.local.get([STORAGE_KEYS.autoScanMeta]))[STORAGE_KEYS.autoScanMeta] || {};

  if (!settings.autoScanEnabled) {
    await chrome.storage.local.set({
      [STORAGE_KEYS.autoScanMeta]: { ...meta, nextRunAt: null }
    });
    return;
  }

  const intervalMinutes = Math.max(60, Number(settings.autoScanIntervalMinutes) || DEFAULT_AUTO_SCAN_INTERVAL_MINUTES);
  const now = Date.now();
  const cooldownUntil = Number(meta.cooldownUntil) || 0;
  const delayMinutes = cooldownUntil > now
    ? Math.max(1, Math.ceil((cooldownUntil - now) / 60_000))
    : intervalMinutes;

  await chrome.alarms.create(AUTO_SCAN_ALARM, {
    delayInMinutes: delayMinutes,
    periodInMinutes: intervalMinutes
  });

  await chrome.storage.local.set({
    [STORAGE_KEYS.autoScanMeta]: {
      ...meta,
      nextRunAt: now + delayMinutes * 60_000
    }
  });
}

async function runAutoScanCycle(forceRun = false) {
  const settings = await getSettings();
  if (!forceRun && !settings.autoScanEnabled) {
    return { status: 'skipped', reason: 'disabled' };
  }

  const active = await getSessionScan();
  if (active) {
    return { status: 'skipped', reason: 'scan_in_progress' };
  }

  const meta = (await chrome.storage.local.get([STORAGE_KEYS.autoScanMeta, STORAGE_KEYS.currentUser]))[STORAGE_KEYS.autoScanMeta] || {};
  const now = Date.now();
  if (!forceRun && meta.cooldownUntil && meta.cooldownUntil > now) {
    await ensureAutoScanAlarm();
    return { status: 'skipped', reason: 'cooldown' };
  }

  const accounts = await listAccounts();
  const curData = await chrome.storage.local.get([STORAGE_KEYS.currentUser]);
  const username = normalizeHandle(curData[STORAGE_KEYS.currentUser]) || accounts[0]?.accountKey;
  if (!username) {
    return { status: 'skipped', reason: 'no_user' };
  }

  const account = await getAccount(username);
  const lastFollowersExpected = account?.lastFollowersExpected ?? account?.lastFollowersCount ?? null;

  // Lightweight background tab probe before deciding whether full scroll is required
  const origin = await resolveXOrigin();
  const profileUrl = `${origin}/${encodeURIComponent(username)}`;
  let tabInfo = null;
  try {
    tabInfo = await acquireScanTab(profileUrl, true);
    const profileCounts = await probeProfile(tabInfo.tabId, username);

    const probeCount = profileCounts?.followers ?? null;
    await appendDiagnosticSnapshot(username, {
      type: 'followers_probe',
      source: 'auto',
      count: probeCount,
      expected: probeCount,
      status: 'complete',
      timestamp: now
    });

    await chrome.storage.local.set({
      [STORAGE_KEYS.autoScanMeta]: {
        ...meta,
        lastRunAt: now,
        lastCountProbeAt: now,
        lastProfileFollowerCount: probeCount,
        lastError: null
      }
    });

    const forceSyncDue = !meta.lastSuccessAt || now - meta.lastSuccessAt >= AUTO_SCAN_FORCED_SYNC_MS;
    const countChanged =
      !Number.isFinite(probeCount) ||
      !Number.isFinite(lastFollowersExpected) ||
      probeCount !== lastFollowersExpected;

    if (!forceRun && !forceSyncDue && !countChanged) {
      await releaseDedicatedTab(tabInfo);
      await ensureAutoScanAlarm();
      return { status: 'probe_only', count: probeCount };
    }

    // Release probe tab cleanly so startScan manages its scan lifecycle in one clean tab
    await releaseDedicatedTab(tabInfo);

    const result = await startScan({
      username,
      scanType: 'followers',
      scanSource: 'auto',
      preloadedProfileCounts: profileCounts
    });
    await ensureAutoScanAlarm();
    return result;
  } catch (error) {
    await releaseDedicatedTab(tabInfo);
    await chrome.storage.local.set({
      [STORAGE_KEYS.autoScanMeta]: {
        ...meta,
        lastRunAt: now,
        lastError: error?.message || 'Auto check failed'
      }
    });
    await ensureAutoScanAlarm();
    return { status: 'error', message: error?.message || 'Auto check failed' };
  }
}

// ================== Active Account Detection, Reason Probe & Passive Captures ==================

async function detectActiveXAccount() {
  const tabs = await chrome.tabs.query({ url: ['*://x.com/*', '*://twitter.com/*'] });
  // Prefer a non-login/non-settings X tab if multiple are open
  const isNormalXTab = (t) =>
    t?.url && !t.url.includes('/i/flow/login') && !t.url.includes('/login');
  let targetTab = tabs.find((t) => t.active && isNormalXTab(t)) || tabs.find(isNormalXTab) || tabs[0] || null;
  let createdTemp = false;

  if (!targetTab) {
    const created = await chrome.tabs.create({ url: 'https://x.com/home', active: false });
    await waitForInitialTabComplete(created.id, SCAN_PAGE_TIMEOUT_MS);
    targetTab = created;
    createdTemp = true;
  }

  try {
    // 1. Fast MAIN-world __INITIAL_STATE__ check (works even if tab predates extension reload)
    const [mainProbe] = await chrome.scripting.executeScript({
      target: { tabId: targetTab.id },
      world: 'MAIN',
      func: () => {
        try {
          const st = window.__INITIAL_STATE__;
          const uid = st?.session?.user_id;
          const user = uid && st?.entities?.users?.entities?.[uid];
          if (user?.screen_name) {
            return {
              username: String(user.screen_name).toLowerCase(),
              restId: String(uid),
              name: user.name || user.screen_name,
              avatar: user.profile_image_url_https || ''
            };
          }
        } catch {
          // Ignore
        }
        return null;
      }
    }).catch(() => [null]);

    if (mainProbe?.result?.username) {
      swLog('info', 'detect.account_ok', `Detected @${mainProbe.result.username} via MAIN state`, null, {
        accountKey: mainProbe.result.username
      });
      return { status: 'ok', account: mainProbe.result };
    }

    // 2. Fallback to ISOLATED scraper DOM + Viewer polling
    await ensureContentScripts(targetTab.id);
    const res = await chrome.tabs.sendMessage(targetTab.id, { action: 'detectActiveAccount' });
    if (!res?.account) {
      const freshTab = await chrome.tabs.get(targetTab.id).catch(() => null);
      const url = freshTab?.url || '';
      if (url.includes('/login') || url.includes('/i/flow/login')) {
        swLog('warn', 'detect.not_logged_in', 'X tab redirected to login', { url });
        return { status: 'ok', account: null, reason: 'not_logged_in' };
      }
      swLog('warn', 'detect.account_missing', 'No logged-in account found on X tab', { url });
    } else {
      swLog('info', 'detect.account_ok', `Detected @${res.account.username} via DOM/Viewer`, null, {
        accountKey: res.account.username
      });
    }
    return { status: 'ok', account: res?.account || null };
  } finally {
    if (createdTemp && targetTab?.id) {
      await chrome.tabs.remove(targetTab.id).catch(() => {});
    }
  }
}

/**
 * Check up to 10 unfollowers in a gentle background tab to classify active unfollow vs suspended vs deactivated.
 */
async function checkUnfollowerReasons(accountKey, targets = []) {
  const cleanAccount = normalizeHandle(accountKey);
  if (!cleanAccount || !targets.length) {
    return { status: 'ok', checked: 0 };
  }

  const batch = targets.slice(0, 10);
  const origin = await resolveXOrigin();
  let tabInfo = null;
  let checked = 0;

  try {
    tabInfo = await acquireScanTab(`${origin}/home`, true);
    for (const item of batch) {
      const handle = normalizeHandle(item.username);
      if (!handle) continue;
      await navigateTabAndWait(tabInfo.tabId, `${origin}/${encodeURIComponent(handle)}`, SCAN_PAGE_TIMEOUT_MS);
      await ensureContentScripts(tabInfo.tabId);
      await sleep(1100);
      const res = await chrome.tabs.sendMessage(tabInfo.tabId, {
        action: 'probeProfileDom',
        username: handle
      }).catch(() => null);

      let reason = 'unfollowed';
      const errText = String(res?.error || '').toLowerCase();
      if (errText.includes('suspended')) {
        reason = 'suspended';
      } else if (errText.includes('does not exist') || errText.includes('unavailable')) {
        reason = 'deactivated';
      }

      await updateUnfollowerReason(cleanAccount, item.id, reason, res?.username ? res : null);
      checked++;
      await sleep(900 + Math.round(Math.random() * 800));
    }
    return { status: 'ok', checked };
  } finally {
    await releaseDedicatedTab(tabInfo);
  }
}

async function togglePassiveCapture(scopes = []) {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab?.id || !activeTab.url?.match(/^https:\/\/(?:x|twitter)\.com\//)) {
    return { status: 'error', message: 'Open an x.com tab first to capture the current session.' };
  }
  await ensureContentScripts(activeTab.id);
  await chrome.storage.session.set({ [SESSION_KEYS.passiveCapture]: scopes });
  const res = await chrome.tabs.sendMessage(activeTab.id, {
    action: 'setPassiveCapture',
    scopes
  });
  return { status: 'ok', scopes: res?.scopes || scopes };
}

async function handleSavePassiveCapture(request) {
  const curData = await chrome.storage.local.get([STORAGE_KEYS.currentUser]);
  const accounts = await listAccounts();
  const accountKey = normalizeHandle(curData[STORAGE_KEYS.currentUser]) || accounts[0]?.accountKey || 'default';
  const result = await savePassiveCaptures(accountKey, request.scope || 'feed', request.items || []);
  return { status: 'ok', ...result };
}

async function maybeShowProfileBadge(tabId, url) {
  const match = url.match(/^https:\/\/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/?$/);
  if (!match) return;
  const visitedHandle = normalizeHandle(match[1]);
  const curData = await chrome.storage.local.get([STORAGE_KEYS.currentUser]);
  const activeKey = normalizeHandle(curData[STORAGE_KEYS.currentUser]);
  if (!activeKey || activeKey === visitedHandle) return;

  const account = await getAccount(activeKey);
  if (!account) return;
  const dataset = await import('./shared/db.js').then((m) => m.loadAccountDataset(activeKey));
  if (!dataset) return;

  const profileMatch = Array.from(dataset.profileMap.values()).find(
    (p) => normalizeHandle(p.username) === visitedHandle
  );
  if (!profileMatch) return;

  const isFollower = (account.followerIds || []).includes(profileMatch.id);
  const isFollowing = (account.followingIds || []).includes(profileMatch.id);
  const unfollowedMeta = account.activeUnfollowers?.[profileMatch.id];

  let badgeText = '';
  let detailText = '';
  let tone = 'neutral';
  if (unfollowedMeta) {
    badgeText = 'Unfollowed you';
    detailText = new Date(unfollowedMeta.unfollowedAt).toLocaleDateString();
    tone = 'loss';
  } else if (isFollower && isFollowing) {
    badgeText = 'Mutual';
    detailText = 'Follows you back';
  } else if (isFollower) {
    badgeText = 'Fan';
    detailText = 'Follows you';
  } else if (isFollowing) {
    badgeText = 'Not following back';
    detailText = 'You follow';
  }

  if (badgeText) {
    await ensureContentScripts(tabId);
    await chrome.tabs.sendMessage(tabId, {
      action: 'showProfileBadge',
      badgeText,
      detailText,
      tone
    }).catch(() => {});
  }
}
