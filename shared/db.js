/**
 * Normalized IndexedDB persistence layer (XTrackerDB) shared by Service Worker and Side Panel,
 * with automatic one-time migration from legacy v2 chrome.storage.local.users blobs.
 */

import {
  APP_VERSION,
  DB_NAME,
  DB_VERSION,
  DEFAULT_PRE_SAVE_FILTERS,
  DEFAULT_SETTINGS,
  MAX_APP_LOGS,
  STORAGE_KEYS
} from './constants.js';
import { computeScanDiff, evaluatePreSaveFilter, reconcileUserProfile } from './diff.js';
import { makeCanonicalId, makeScanId, normalizeHandle } from './utils.js';

let dbPromise = null;

/**
 * Open (or upgrade) XTrackerDB.
 * @returns {Promise<IDBDatabase>}
 */
export function openDB() {
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains('accounts')) {
        db.createObjectStore('accounts', { keyPath: 'accountKey' });
      }

      if (!db.objectStoreNames.contains('profiles')) {
        const profiles = db.createObjectStore('profiles', { keyPath: 'id' });
        profiles.createIndex('byHandle', 'username', { unique: false });
        profiles.createIndex('byRestId', 'restId', { unique: false });
      }

      if (!db.objectStoreNames.contains('snapshots')) {
        const snapshots = db.createObjectStore('snapshots', { keyPath: 'scanId' });
        snapshots.createIndex('byAccountAt', ['accountKey', 'timestamp'], { unique: false });
      }

      if (!db.objectStoreNames.contains('events')) {
        const events = db.createObjectStore('events', { keyPath: 'eventId' });
        events.createIndex('byAccountAt', ['accountKey', 'at'], { unique: false });
        events.createIndex('byAccountTarget', ['accountKey', 'targetId'], { unique: false });
        events.createIndex('byAccountType', ['accountKey', 'type'], { unique: false });
      }

      if (!db.objectStoreNames.contains('captures')) {
        const captures = db.createObjectStore('captures', { keyPath: 'captureId' });
        captures.createIndex('byAccountScopeAt', ['accountKey', 'scope', 'capturedAt'], { unique: false });
      }

      if (!db.objectStoreNames.contains('checkpoints')) {
        const checkpoints = db.createObjectStore('checkpoints', { keyPath: 'scanId' });
        checkpoints.createIndex('byAccount', 'accountKey', { unique: false });
      }

      if (!db.objectStoreNames.contains('logs')) {
        const logs = db.createObjectStore('logs', { keyPath: 'id' });
        logs.createIndex('byAt', 'at', { unique: false });
        logs.createIndex('byLevel', 'level', { unique: false });
        logs.createIndex('byScanId', 'scanId', { unique: false });
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };

    request.onerror = () => {
      dbPromise = null;
      reject(request.error || new Error('Failed to open IndexedDB'));
    };
  });

  return dbPromise;
}

function txPromise(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}

function reqPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB request failed'));
  });
}

/**
 * Create a clean default account record.
 * @param {string} username
 * @param {Object} extras
 * @returns {Object}
 */
export function createEmptyAccountRecord(username, extras = {}) {
  const accountKey = normalizeHandle(username);
  return {
    accountKey,
    username: accountKey,
    restId: extras.restId || null,
    name: extras.name || accountKey,
    avatar: extras.avatar || '',
    createdAt: extras.createdAt || Date.now(),
    followerIds: [],
    followingIds: [],
    verifiedFollowerIds: [],
    mutualFollowerIds: [],
    fansIds: [],
    notFollowingBackIds: [],
    whitelistIds: [],
    activeUnfollowers: {},
    activeNewFollowers: {},
    refollowers: {},
    scanCount: 0,
    lastFollowersCheck: null,
    lastFollowingCheck: null,
    lastVerifiedFollowersCheck: null,
    lastMutualFollowersCheck: null,
    lastSuccessfulScan: null,
    lastFollowersCount: null,
    lastFollowingCount: null,
    lastFollowersExpected: null,
    lastFollowingExpected: null,
    lastFollowersCoverage: null,
    lastFollowingCoverage: null,
    lastFollowersQuality: null,
    lastFollowingQuality: null,
    lastFollowersExpectedSource: null,
    lastFollowingExpectedSource: null,
    lastProfileCounts: null
  };
}

/**
 * Notify extension contexts that IndexedDB was mutated so UI refreshes reactively.
 */
export async function touchDbMutation() {
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    await chrome.storage.local.set({ [STORAGE_KEYS.lastDbMutationAt]: Date.now() });
  }
}

/**
 * Read extension settings merged with defaults.
 * @returns {Promise<Object>}
 */
export async function getSettings() {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return {
      ...DEFAULT_SETTINGS,
      preSaveFilters: { ...DEFAULT_PRE_SAVE_FILTERS }
    };
  }
  const result = await chrome.storage.local.get([STORAGE_KEYS.settings]);
  const stored = result[STORAGE_KEYS.settings] || {};
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    preSaveFilters: {
      ...DEFAULT_PRE_SAVE_FILTERS,
      ...(stored.preSaveFilters || {})
    }
  };
}

/**
 * Persist updated extension settings.
 * @param {Object} patch
 * @returns {Promise<Object>}
 */
export async function saveSettings(patch) {
  const current = await getSettings();
  const next = {
    ...current,
    ...patch,
    preSaveFilters: {
      ...current.preSaveFilters,
      ...(patch?.preSaveFilters || {})
    }
  };
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    await chrome.storage.local.set({ [STORAGE_KEYS.settings]: next });
  }
  return next;
}

/**
 * Migrate legacy v2 chrome.storage.local data (users, userList, autoScan*) into IndexedDB once.
 */
export async function migrateLegacyStorageIfNeeded() {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return false;
  }

  const legacy = await chrome.storage.local.get([
    STORAGE_KEYS.legacyMigrated,
    'users',
    'userList',
    'currentUser',
    'autoScanEnabled',
    'autoScanIntervalMinutes',
    'autoScanNextRunAt',
    'autoScanCooldownUntil',
    'autoScanLastRunAt',
    'autoScanLastCountProbeAt',
    'autoScanLastProfileFollowerCount',
    'autoScanLastError'
  ]);

  if (legacy[STORAGE_KEYS.legacyMigrated]) {
    return false;
  }

  const db = await openDB();
  const usersObj = legacy.users || {};
  const userList = Array.isArray(legacy.userList) ? legacy.userList : [];
  const allHandles = new Set([
    ...Object.keys(usersObj).map(normalizeHandle),
    ...userList.map(normalizeHandle)
  ].filter(Boolean));

  if (allHandles.size > 0) {
    const tx = db.transaction(['accounts', 'profiles', 'snapshots', 'events'], 'readwrite');
    const accountStore = tx.objectStore('accounts');
    const profileStore = tx.objectStore('profiles');
    const snapshotStore = tx.objectStore('snapshots');
    const eventStore = tx.objectStore('events');

    const seenProfileMap = new Map();

    const upsertLegacyUser = (raw) => {
      const handle = normalizeHandle(raw?.username);
      if (!handle) return null;
      const id = makeCanonicalId(raw);
      const prev = seenProfileMap.get(id) || null;
      const { profile } = reconcileUserProfile(prev, { ...raw, username: handle }, raw?.lastSeenAt || Date.now());
      seenProfileMap.set(id, profile);
      return id;
    };

    for (const accountKey of allHandles) {
      const rawKey = Object.keys(usersObj).find((k) => normalizeHandle(k) === accountKey);
      const rawData = (rawKey && usersObj[rawKey]) || {};
      const account = createEmptyAccountRecord(accountKey, {
        lastProfileCounts: rawData.lastFollowersProfileCounts || rawData.lastFollowingProfileCounts || null
      });

      const followerIds = (rawData.followers || []).map(upsertLegacyUser).filter(Boolean);
      const followingIds = (rawData.following || []).map(upsertLegacyUser).filter(Boolean);
      const followingSet = new Set(followingIds);
      const followerSet = new Set(followerIds);

      account.followerIds = Array.from(followerSet);
      account.followingIds = Array.from(followingSet);
      account.fansIds = account.followerIds.filter((id) => !followingSet.has(id));
      account.notFollowingBackIds = account.followingIds.filter((id) => !followerSet.has(id));
      account.scanCount = rawData.scanCount || 0;
      account.lastFollowersCheck = rawData.lastFollowersCheck || null;
      account.lastFollowingCheck = rawData.lastFollowingCheck || null;
      account.lastSuccessfulScan = rawData.lastSuccessfulScan || null;
      account.lastFollowersCount = rawData.lastFollowersCount ?? account.followerIds.length;
      account.lastFollowingCount = rawData.lastFollowingCount ?? account.followingIds.length;
      account.lastFollowersExpected = rawData.lastFollowersExpected ?? null;
      account.lastFollowingExpected = rawData.lastFollowingExpected ?? null;
      account.lastFollowersCoverage = rawData.lastFollowersCoverage ?? null;
      account.lastFollowingCoverage = rawData.lastFollowingCoverage ?? null;

      for (const u of rawData.unfollowers || []) {
        const id = upsertLegacyUser(u);
        if (id) {
          account.activeUnfollowers[id] = {
            id,
            unfollowedAt: u.unfollowedAt || u.timestamp || Date.now(),
            scanId: u.scanId || 'legacy',
            repeatUnfollow: Boolean(u.repeatUnfollow),
            unfollowReason: 'unfollowed'
          };
        }
      }

      for (const u of rawData.newFollowers || []) {
        const id = upsertLegacyUser(u);
        if (id) {
          account.activeNewFollowers[id] = {
            id,
            followedAt: u.timestamp || Date.now(),
            scanId: u.scanId || 'legacy',
            refollowed: Boolean(u.refollowed)
          };
        }
      }

      for (const u of rawData.refollowers || []) {
        const id = upsertLegacyUser(u);
        if (id) {
          account.refollowers[id] = {
            id,
            refollowedAt: u.refollowedAt || u.timestamp || Date.now(),
            scanId: u.scanId || 'legacy'
          };
        }
      }

      accountStore.put(account);

      // Migrate snapshots & scanHistory
      const historyItems = [
        ...(Array.isArray(rawData.snapshots) ? rawData.snapshots : []),
        ...(Array.isArray(rawData.scanHistory) ? rawData.scanHistory : [])
      ];
      const seenScanIds = new Set();
      for (const item of historyItems) {
        if (!item || !Number.isFinite(item.timestamp)) continue;
        const scanId = item.scanId || makeScanId(item.type || 'legacy', item.timestamp);
        if (seenScanIds.has(scanId)) continue;
        seenScanIds.add(scanId);
        snapshotStore.put({
          ...item,
          scanId,
          accountKey
        });
      }

      // Migrate relationship events
      const rels = rawData.relationshipsByHandle || {};
      for (const [handleKey, rec] of Object.entries(rels)) {
        const targetId = upsertLegacyUser({ ...rec, username: rec?.username || handleKey });
        if (!targetId) continue;
        for (const ev of rec?.events || []) {
          if (!ev?.type || !Number.isFinite(ev.at)) continue;
          const eventId = `${accountKey}:${ev.at}:${targetId}:${ev.type}`;
          eventStore.put({
            eventId,
            accountKey,
            targetId,
            type: ev.type,
            at: ev.at,
            scanId: ev.scanId || 'legacy',
            scanType: ev.scanType || 'followers',
            source: ev.source || 'legacy'
          });
        }
      }
    }

    for (const profile of seenProfileMap.values()) {
      profileStore.put(profile);
    }

    await txPromise(tx);
  }

  // Preserve settings & clean up heavy legacy blob
  const currentSettings = await getSettings();
  const migratedSettings = {
    ...currentSettings,
    autoScanEnabled: typeof legacy.autoScanEnabled === 'boolean'
      ? legacy.autoScanEnabled
      : currentSettings.autoScanEnabled,
    autoScanIntervalMinutes: Number(legacy.autoScanIntervalMinutes) || currentSettings.autoScanIntervalMinutes
  };

  const normalizedCurrent = normalizeHandle(legacy.currentUser) || Array.from(allHandles)[0] || null;
  await chrome.storage.local.set({
    [STORAGE_KEYS.legacyMigrated]: true,
    [STORAGE_KEYS.currentUser]: normalizedCurrent,
    [STORAGE_KEYS.settings]: migratedSettings,
    [STORAGE_KEYS.autoScanMeta]: {
      nextRunAt: legacy.autoScanNextRunAt || null,
      cooldownUntil: legacy.autoScanCooldownUntil || null,
      lastRunAt: legacy.autoScanLastRunAt || null,
      lastCountProbeAt: legacy.autoScanLastCountProbeAt || null,
      lastProfileFollowerCount: legacy.autoScanLastProfileFollowerCount ?? null,
      lastError: legacy.autoScanLastError || null
    },
    [STORAGE_KEYS.lastDbMutationAt]: Date.now()
  });

  await chrome.storage.local.remove(['users', 'userList']);
  return true;
}

/**
 * List all tracked accounts.
 * @returns {Promise<Array<Object>>}
 */
export async function listAccounts() {
  const db = await openDB();
  const tx = db.transaction('accounts', 'readonly');
  const all = await reqPromise(tx.objectStore('accounts').getAll());
  return (all || []).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

/**
 * Get a single tracked account record by key.
 * @param {string} accountKey
 * @returns {Promise<Object|null>}
 */
export async function getAccount(accountKey) {
  const key = normalizeHandle(accountKey);
  if (!key) return null;
  const db = await openDB();
  const tx = db.transaction('accounts', 'readonly');
  return (await reqPromise(tx.objectStore('accounts').get(key))) || null;
}

/**
 * Create or update a tracked account.
 * @param {string} username
 * @param {Object} patch
 * @returns {Promise<Object>}
 */
export async function upsertAccount(username, patch = {}) {
  const key = normalizeHandle(username);
  if (!key) throw new Error('Invalid username');
  const db = await openDB();
  const tx = db.transaction('accounts', 'readwrite');
  const store = tx.objectStore('accounts');
  const existing = await reqPromise(store.get(key));
  const record = existing
    ? { ...existing, ...patch, accountKey: key, username: key }
    : createEmptyAccountRecord(key, patch);
  store.put(record);
  await txPromise(tx);
  await touchDbMutation();
  return record;
}

/**
 * Delete a tracked account and its associated snapshots, events, captures, and checkpoints.
 * @param {string} accountKey
 */
export async function deleteAccount(accountKey) {
  const key = normalizeHandle(accountKey);
  if (!key) return;
  const db = await openDB();
  const tx = db.transaction(['accounts', 'snapshots', 'events', 'captures', 'checkpoints'], 'readwrite');

  tx.objectStore('accounts').delete(key);

  const deleteByIndexRange = async (storeName, indexName, range) => {
    const store = tx.objectStore(storeName);
    const index = store.index(indexName);
    const keys = await reqPromise(index.getAllKeys(range));
    for (const k of keys) {
      store.delete(k);
    }
  };

  await deleteByIndexRange('snapshots', 'byAccountAt', IDBKeyRange.bound([key, 0], [key, Number.MAX_SAFE_INTEGER]));
  await deleteByIndexRange('events', 'byAccountAt', IDBKeyRange.bound([key, 0], [key, Number.MAX_SAFE_INTEGER]));
  await deleteByIndexRange('checkpoints', 'byAccount', IDBKeyRange.only(key));
  await deleteByIndexRange(
    'captures',
    'byAccountScopeAt',
    IDBKeyRange.bound([key, '', 0], [key, '\uffff', Number.MAX_SAFE_INTEGER])
  );

  await txPromise(tx);
  await touchDbMutation();
}

/**
 * Save or update an in-progress scan checkpoint in IndexedDB.
 */
export async function upsertCheckpoint(checkpoint) {
  const db = await openDB();
  const tx = db.transaction('checkpoints', 'readwrite');
  tx.objectStore('checkpoints').put(checkpoint);
  await txPromise(tx);
}

/**
 * Get latest checkpoint for an account (optionally matching scanType).
 * @param {string} accountKey
 * @param {string|null} scanType
 */
export async function getLatestCheckpoint(accountKey, scanType = null) {
  const key = normalizeHandle(accountKey);
  if (!key) return null;
  const db = await openDB();
  const tx = db.transaction('checkpoints', 'readonly');
  const items = await reqPromise(tx.objectStore('checkpoints').index('byAccount').getAll(IDBKeyRange.only(key)));
  const filtered = (items || [])
    .filter((item) => !scanType || item.scanType === scanType)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return filtered[0] || null;
}

/**
 * Remove a completed or discarded checkpoint.
 * @param {string} scanId
 */
export async function deleteCheckpoint(scanId) {
  if (!scanId) return;
  const db = await openDB();
  const tx = db.transaction('checkpoints', 'readwrite');
  tx.objectStore('checkpoints').delete(scanId);
  await txPromise(tx);
}

/**
 * Record a failed or probe-only snapshot entry cleanly into snapshots store.
 * @param {string} accountKey
 * @param {Object} snapshot
 */
export async function appendDiagnosticSnapshot(accountKey, snapshot) {
  const key = normalizeHandle(accountKey);
  if (!key) return;
  const db = await openDB();
  const tx = db.transaction(['accounts', 'snapshots'], 'readwrite');
  const accountStore = tx.objectStore('accounts');
  let account = await reqPromise(accountStore.get(key));
  if (!account) {
    account = createEmptyAccountRecord(key);
    accountStore.put(account);
  }
  const timestamp = snapshot.timestamp || Date.now();
  const scanId = snapshot.scanId || makeScanId(snapshot.type || 'diag', timestamp);
  tx.objectStore('snapshots').put({
    ...snapshot,
    scanId,
    accountKey: key,
    timestamp
  });
  await txPromise(tx);
  await touchDbMutation();
}

/**
 * Commit a completed or partial scan result through the pure diff engine into IndexedDB.
 */
export async function commitScanResult({
  accountKey,
  scanType,
  users,
  expectedCount = null,
  expectedSource = 'profile',
  scanSource = 'manual',
  partial = false,
  profileCounts = null,
  scanId = makeScanId(scanType),
  now = Date.now()
}) {
  const key = normalizeHandle(accountKey);
  if (!key) throw new Error('Account key missing');

  const settings = await getSettings();
  const db = await openDB();

  // Read account, existing profiles referenced or handle-matched, and historical loss IDs
  const readTx = db.transaction(['accounts', 'profiles', 'events'], 'readonly');
  const account = (await reqPromise(readTx.objectStore('accounts').get(key))) || createEmptyAccountRecord(key);
  const readProfileStore = readTx.objectStore('profiles');
  const profileCount = await reqPromise(readProfileStore.count());

  let existingProfiles = {};
  if (profileCount <= 3000) {
    const allProfiles = await reqPromise(readProfileStore.getAll());
    existingProfiles = Object.fromEntries((allProfiles || []).map((p) => [p.id, p]));
  } else {
    // Large DB: selectively load account-relevant profiles to avoid pulling massive tables into RAM
    const relevantIds = new Set([
      ...(account.followerIds || []),
      ...(account.followingIds || []),
      ...(account.verifiedFollowerIds || []),
      ...(account.mutualFollowerIds || []),
      ...Object.keys(account.activeUnfollowers || {}),
      ...Object.keys(account.activeNewFollowers || {}),
      ...Object.keys(account.refollowers || {})
    ]);
    for (const u of (users || []).slice(0, 500)) {
      if (u.restId) relevantIds.add(String(u.restId).trim());
      if (u.username) relevantIds.add(`handle:${normalizeHandle(u.username)}`);
    }
    const promises = Array.from(relevantIds).map((id) => reqPromise(readProfileStore.get(id)));
    const loaded = await Promise.all(promises);
    existingProfiles = Object.fromEntries(loaded.filter(Boolean).map((p) => [p.id, p]));
  }

  const lossEvents = await reqPromise(
    readTx.objectStore('events').index('byAccountAt').getAll(IDBKeyRange.bound([key, 0], [key, Number.MAX_SAFE_INTEGER]))
  );
  await txPromise(readTx);

  const priorLossIds = new Set(
    (lossEvents || [])
      .filter((e) => e.type === 'unfollowed' || e.type === 'reunfollowed')
      .map((e) => e.targetId)
  );

  const diffOut = computeScanDiff({
    account,
    existingProfiles,
    incomingUsers: users,
    scanType,
    expectedCount,
    expectedSource,
    scanSource,
    now,
    scanId,
    partial,
    preSaveFilters: settings.preSaveFilters,
    priorLossIds,
    priorActiveUnfollowerMap: new Map(Object.entries(account.activeUnfollowers || {})),
    priorActiveNewFollowerMap: new Map(Object.entries(account.activeNewFollowers || {})),
    priorRefollowerMap: new Map(Object.entries(account.refollowers || {}))
  });

  if (profileCounts) {
    diffOut.account.lastProfileCounts = profileCounts;
  }

  // Persist atomically in IndexedDB
  const writeTx = db.transaction(['accounts', 'profiles', 'snapshots', 'events', 'checkpoints'], 'readwrite');
  writeTx.objectStore('accounts').put(diffOut.account);

  const profileStore = writeTx.objectStore('profiles');
  for (const oldHandleId of Object.keys(diffOut.upgradedIdMap)) {
    profileStore.delete(oldHandleId);
  }
  for (const profile of Object.values(diffOut.profiles)) {
    profileStore.put(profile);
  }

  writeTx.objectStore('snapshots').put({
    ...diffOut.snapshot,
    profileCounts
  });

  const eventStore = writeTx.objectStore('events');
  for (const ev of diffOut.events) {
    eventStore.put(ev);
  }

  // Also migrate any historical event targetIds that upgraded from handle:<name> -> restId
  if (Object.keys(diffOut.upgradedIdMap).length > 0) {
    for (const ev of lossEvents || []) {
      const upgraded = diffOut.upgradedIdMap[ev.targetId];
      if (upgraded) {
        eventStore.put({ ...ev, targetId: upgraded });
      }
    }
  }

  // Clean up checkpoint for this scanId
  writeTx.objectStore('checkpoints').delete(scanId);

  await txPromise(writeTx);
  await touchDbMutation();
  return diffOut;
}

/**
 * Toggle whitelist status for a target ID on an account.
 */
export async function toggleWhitelist(accountKey, targetId) {
  const key = normalizeHandle(accountKey);
  if (!key || !targetId) return false;
  const db = await openDB();
  const tx = db.transaction('accounts', 'readwrite');
  const store = tx.objectStore('accounts');
  const account = await reqPromise(store.get(key));
  if (!account) {
    await txPromise(tx);
    return false;
  }
  const set = new Set(account.whitelistIds || []);
  let added = false;
  if (set.has(targetId)) {
    set.delete(targetId);
  } else {
    set.add(targetId);
    added = true;
  }
  account.whitelistIds = Array.from(set);
  store.put(account);
  await txPromise(tx);
  await touchDbMutation();
  return added;
}

/**
 * Annotate an active unfollower with verified reason ('unfollowed', 'suspended', 'deactivated', 'renamed').
 */
export async function updateUnfollowerReason(accountKey, targetId, reason, updatedProfile = null) {
  const key = normalizeHandle(accountKey);
  if (!key || !targetId) return;
  const db = await openDB();
  const tx = db.transaction(['accounts', 'profiles', 'events'], 'readwrite');
  const accountStore = tx.objectStore('accounts');
  const account = await reqPromise(accountStore.get(key));
  if (!account) {
    await txPromise(tx);
    return;
  }

  if (account.activeUnfollowers?.[targetId]) {
    account.activeUnfollowers[targetId] = {
      ...account.activeUnfollowers[targetId],
      unfollowReason: reason,
      checkedAt: Date.now()
    };
    accountStore.put(account);
  }

  if (updatedProfile) {
    const profileStore = tx.objectStore('profiles');
    const existing = await reqPromise(profileStore.get(targetId));
    const { profile } = reconcileUserProfile(existing, updatedProfile, Date.now());
    if (reason === 'suspended') profile.suspended = true;
    profileStore.put(profile);
  }

  if (reason === 'suspended' || reason === 'deactivated') {
    const now = Date.now();
    tx.objectStore('events').put({
      eventId: `${key}:${now}:${targetId}:${reason}`,
      accountKey: key,
      targetId,
      type: reason,
      at: now,
      scanId: 'probe',
      scanType: 'unfollower_audit',
      source: 'manual'
    });
  }

  await txPromise(tx);
  await touchDbMutation();
}

/**
 * Store passive session capture items (profile, thread, search, bookmarks, feed) after applying pre-save filters.
 */
export async function savePassiveCaptures(accountKey, scope, items = []) {
  const key = normalizeHandle(accountKey);
  if (!key || !items.length) return { saved: 0, filtered: 0 };

  const settings = await getSettings();
  const db = await openDB();
  const account = (await getAccount(key)) || createEmptyAccountRecord(key);
  const whitelistSet = new Set(account.whitelistIds || []);

  const tx = db.transaction(['captures', 'profiles'], 'readwrite');
  const captureStore = tx.objectStore('captures');
  const profileStore = tx.objectStore('profiles');

  let saved = 0;
  let filtered = 0;
  const now = Date.now();

  for (const item of items) {
    if (item.author) {
      const { pass } = evaluatePreSaveFilter(item.author, settings.preSaveFilters, whitelistSet);
      if (!pass) {
        filtered++;
        continue;
      }
      const authorId = makeCanonicalId(item.author);
      if (authorId) {
        const existing = await reqPromise(profileStore.get(authorId));
        const { profile } = reconcileUserProfile(existing, item.author, now);
        profileStore.put(profile);
      }
    }

    const captureId = item.captureId || `${key}:${scope}:${item.tweetId || makeCanonicalId(item.author) || Math.random().toString(36).slice(2)}`;
    captureStore.put({
      ...item,
      captureId,
      accountKey: key,
      scope,
      capturedAt: item.capturedAt || now
    });
    saved++;
  }

  await txPromise(tx);
  if (saved > 0) {
    await touchDbMutation();
  }
  return { saved, filtered };
}

/**
 * Load full hydrated dashboard dataset for a single tracked account.
 */
export async function loadAccountDataset(accountKey) {
  const key = normalizeHandle(accountKey);
  if (!key) return null;

  const db = await openDB();
  const tx = db.transaction(['accounts', 'profiles', 'snapshots', 'events', 'captures', 'checkpoints'], 'readonly');
  const account = await reqPromise(tx.objectStore('accounts').get(key));
  if (!account) {
    await txPromise(tx);
    return null;
  }

  const [allProfiles, snapshots, events, captures, checkpoints] = await Promise.all([
    reqPromise(tx.objectStore('profiles').getAll()),
    reqPromise(tx.objectStore('snapshots').index('byAccountAt').getAll(IDBKeyRange.bound([key, 0], [key, Number.MAX_SAFE_INTEGER]))),
    reqPromise(tx.objectStore('events').index('byAccountAt').getAll(IDBKeyRange.bound([key, 0], [key, Number.MAX_SAFE_INTEGER]))),
    reqPromise(tx.objectStore('captures').index('byAccountScopeAt').getAll(IDBKeyRange.bound([key, '', 0], [key, '\uffff', Number.MAX_SAFE_INTEGER]))),
    reqPromise(tx.objectStore('checkpoints').index('byAccount').getAll(IDBKeyRange.only(key)))
  ]);
  await txPromise(tx);

  const profileMap = new Map((allProfiles || []).map((p) => [p.id, p]));
  const eventsByTarget = new Map();
  for (const ev of events || []) {
    let list = eventsByTarget.get(ev.targetId);
    if (!list) {
      list = [];
      eventsByTarget.set(ev.targetId, list);
    }
    list.push(ev);
  }
  for (const list of eventsByTarget.values()) {
    list.sort((a, b) => a.at - b.at);
  }

  const followerSet = new Set(account.followerIds || []);
  const followingSet = new Set(account.followingIds || []);
  const whitelistSet = new Set(account.whitelistIds || []);

  const hydrate = (id, extras = {}) => {
    const profile = profileMap.get(id) || {
      id,
      username: id.startsWith('handle:') ? id.slice(7) : id,
      name: id.startsWith('handle:') ? id.slice(7) : id,
      bio: '',
      avatar: '',
      verified: false,
      profileUrl: ''
    };
    return {
      ...profile,
      ...extras,
      followsBack: followerSet.has(id),
      youFollow: followingSet.has(id),
      whitelisted: whitelistSet.has(id),
      events: eventsByTarget.get(id) || []
    };
  };

  const followers = (account.followerIds || []).map((id) => hydrate(id));
  const following = (account.followingIds || []).map((id) => hydrate(id));
  const verifiedFollowers = (account.verifiedFollowerIds || []).map((id) => hydrate(id));
  const mutualFollowers = (account.mutualFollowerIds || []).map((id) => hydrate(id));
  const fans = (account.fansIds || []).map((id) => hydrate(id));
  const notFollowingBack = (account.notFollowingBackIds || []).map((id) => hydrate(id));

  const unfollowers = Object.values(account.activeUnfollowers || {})
    .map((meta) => hydrate(meta.id, meta))
    .sort((a, b) => (b.unfollowedAt || 0) - (a.unfollowedAt || 0));

  const newFollowers = Object.values(account.activeNewFollowers || {})
    .map((meta) => hydrate(meta.id, meta))
    .sort((a, b) => (b.followedAt || 0) - (a.followedAt || 0));

  const refollowers = Object.values(account.refollowers || {})
    .map((meta) => hydrate(meta.id, meta))
    .sort((a, b) => (b.refollowedAt || 0) - (a.refollowedAt || 0));

  const sortedSnapshots = (snapshots || []).sort((a, b) => a.timestamp - b.timestamp);
  const sortedEvents = (events || []).sort((a, b) => a.at - b.at);
  const sortedCaptures = (captures || []).sort((a, b) => (b.capturedAt || 0) - (a.capturedAt || 0));
  const sortedCheckpoints = (checkpoints || []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  return {
    account,
    followers,
    following,
    verifiedFollowers,
    mutualFollowers,
    fans,
    notFollowingBack,
    unfollowers,
    newFollowers,
    refollowers,
    snapshots: sortedSnapshots,
    events: sortedEvents,
    captures: sortedCaptures,
    checkpoints: sortedCheckpoints,
    profileMap
  };
}

/**
 * Export a full restorable JSON archive for one or all accounts.
 * @param {string|null} accountKey - If omitted, exports all accounts.
 */
export async function exportArchiveBundle(accountKey = null) {
  const db = await openDB();
  const tx = db.transaction(['accounts', 'profiles', 'snapshots', 'events', 'captures'], 'readonly');
  const accounts = accountKey
    ? [await reqPromise(tx.objectStore('accounts').get(normalizeHandle(accountKey)))].filter(Boolean)
    : await reqPromise(tx.objectStore('accounts').getAll());
  const [profiles, snapshots, events, captures] = await Promise.all([
    reqPromise(tx.objectStore('profiles').getAll()),
    reqPromise(tx.objectStore('snapshots').getAll()),
    reqPromise(tx.objectStore('events').getAll()),
    reqPromise(tx.objectStore('captures').getAll())
  ]);
  await txPromise(tx);

  const settings = await getSettings();
  const allowedKeys = new Set(accounts.map((a) => a.accountKey));

  return {
    schemaVersion: 3,
    appVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    settings,
    accounts,
    profiles: profiles || [],
    snapshots: (snapshots || []).filter((s) => allowedKeys.has(s.accountKey)),
    events: (events || []).filter((e) => allowedKeys.has(e.accountKey)),
    captures: (captures || []).filter((c) => allowedKeys.has(c.accountKey))
  };
}

/**
 * Import and restore a v3 JSON archive bundle (supports merge or replace).
 */
export async function importArchiveBundle(bundle, { replace = false } = {}) {
  if (!bundle || bundle.schemaVersion !== 3 || !Array.isArray(bundle.accounts)) {
    throw new Error('Unsupported backup format. Expected a v3 X Tracker JSON archive.');
  }

  const db = await openDB();
  const tx = db.transaction(['accounts', 'profiles', 'snapshots', 'events', 'captures'], 'readwrite');
  const accountStore = tx.objectStore('accounts');
  const profileStore = tx.objectStore('profiles');
  const snapshotStore = tx.objectStore('snapshots');
  const eventStore = tx.objectStore('events');
  const captureStore = tx.objectStore('captures');

  if (replace) {
    await Promise.all([
      reqPromise(accountStore.clear()),
      reqPromise(profileStore.clear()),
      reqPromise(snapshotStore.clear()),
      reqPromise(eventStore.clear()),
      reqPromise(captureStore.clear())
    ]);
  }

  for (const acc of bundle.accounts) {
    if (acc?.accountKey) accountStore.put(acc);
  }
  for (const prof of bundle.profiles || []) {
    if (prof?.id) profileStore.put(prof);
  }
  for (const snap of bundle.snapshots || []) {
    if (snap?.scanId) snapshotStore.put(snap);
  }
  for (const ev of bundle.events || []) {
    if (ev?.eventId) eventStore.put(ev);
  }
  for (const cap of bundle.captures || []) {
    if (cap?.captureId) captureStore.put(cap);
  }

  await txPromise(tx);

  if (bundle.settings) {
    await saveSettings(bundle.settings);
  }
  if (bundle.accounts.length > 0) {
    await chrome.storage.local.set({
      [STORAGE_KEYS.currentUser]: bundle.accounts[0].accountKey
    });
  }
  await touchDbMutation();

  return {
    accountsImported: bundle.accounts.length,
    profilesImported: (bundle.profiles || []).length,
    snapshotsImported: (bundle.snapshots || []).length
  };
}


// ================== App & Scan Runtime Telemetry Logs ==================

function normalizeLogEntry(raw = {}) {
  const at = Number.isFinite(raw.at) ? raw.at : Date.now();
  const level = raw.level === 'error' || raw.level === 'warn' || raw.level === 'debug' ? raw.level : 'info';
  const source = ['sw', 'scraper', 'main', 'ui'].includes(raw.source) ? raw.source : 'sw';
  const rand = Math.random().toString(36).slice(2, 7);

  let safeMeta = null;
  if (raw.meta && typeof raw.meta === 'object') {
    try {
      const json = JSON.stringify(raw.meta);
      safeMeta = json.length <= 1600 ? JSON.parse(json) : { truncatedPreview: json.slice(0, 1500) };
    } catch {
      safeMeta = null;
    }
  }

  return {
    id: raw.id || `log_${at}_${rand}`,
    at,
    level,
    source,
    event: String(raw.event || 'app.event').slice(0, 64),
    scanId: raw.scanId ? String(raw.scanId).slice(0, 80) : null,
    accountKey: raw.accountKey ? normalizeHandle(raw.accountKey) : null,
    message: String(raw.message || '').slice(0, 500),
    meta: safeMeta
  };
}

export async function touchLogMutation() {
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    await chrome.storage.local.set({ [STORAGE_KEYS.lastLogMutationAt]: Date.now() }).catch(() => {});
  }
}

/**
 * Append one or more structured diagnostic logs, keeping at most MAX_APP_LOGS entries.
 */
export async function appendAppLogs(entries = []) {
  if (typeof indexedDB === 'undefined' || !Array.isArray(entries) || entries.length === 0) {
    return 0;
  }
  try {
    const normalized = entries.slice(-100).map(normalizeLogEntry);
    const db = await openDB();
    const tx = db.transaction('logs', 'readwrite');
    const store = tx.objectStore('logs');

    for (const item of normalized) {
      store.put(item);
    }

    const currentCount = await reqPromise(store.count());
    if (currentCount > MAX_APP_LOGS) {
      let dropCount = currentCount - MAX_APP_LOGS;
      const index = store.index('byAt');
      // Cursor in ascending order prunes oldest entries with zero in-memory getAll()
      await new Promise((resolve) => {
        const cursorReq = index.openCursor();
        cursorReq.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor && dropCount > 0) {
            cursor.delete();
            dropCount--;
            cursor.continue();
          } else {
            resolve();
          }
        };
        cursorReq.onerror = () => resolve();
      });
    }

    await txPromise(tx);
    await touchLogMutation();
    return normalized.length;
  } catch {
    return 0;
  }
}

export async function appendAppLog(entry) {
  return appendAppLogs([entry]);
}

/**
 * Query newest runtime telemetry logs with optional level/source filters.
 */
export async function listAppLogs({ limit = 250, level = 'all', source = 'all' } = {}) {
  if (typeof indexedDB === 'undefined') return [];
  const db = await openDB();
  const tx = db.transaction('logs', 'readonly');
  const all = (await reqPromise(tx.objectStore('logs').index('byAt').getAll())) || [];
  await txPromise(tx);

  return all
    .sort((a, b) => (b.at || 0) - (a.at || 0))
    .filter((item) => {
      if (level === 'warn_error' && item.level !== 'warn' && item.level !== 'error') return false;
      if (level !== 'all' && level !== 'warn_error' && item.level !== level) return false;
      if (source !== 'all' && item.source !== source) return false;
      return true;
    })
    .slice(0, limit);
}

export async function clearAppLogs() {
  if (typeof indexedDB === 'undefined') return;
  const db = await openDB();
  const tx = db.transaction('logs', 'readwrite');
  tx.objectStore('logs').clear();
  await txPromise(tx);
  await touchLogMutation();
}

/**
 * Build a sanitized diagnostic report for troubleshooting and continuous improvement.
 */
export async function buildDiagnosticReport({ accountKey = null, runtime = null } = {}) {
  const settings = await getSettings();
  const key = normalizeHandle(accountKey);
  const account = key ? await getAccount(key) : null;
  const logs = await listAppLogs({ limit: 400 });

  let recentSnapshots = [];
  if (key && typeof indexedDB !== 'undefined') {
    const db = await openDB();
    const tx = db.transaction('snapshots', 'readonly');
    const snaps = await reqPromise(
      tx.objectStore('snapshots').index('byAccountAt').getAll(IDBKeyRange.bound([key, 0], [key, Number.MAX_SAFE_INTEGER]))
    );
    await txPromise(tx);
    recentSnapshots = (snaps || []).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, 25);
  }

  return {
    reportVersion: 1,
    appVersion: APP_VERSION,
    generatedAt: new Date().toISOString(),
    environment: {
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown'
    },
    settings,
    runtime,
    accountSummary: account
      ? {
          accountKey: account.accountKey,
          followerIdsCount: account.followerIds?.length || 0,
          followingIdsCount: account.followingIds?.length || 0,
          lastFollowersCheck: account.lastFollowersCheck || null,
          lastFollowingCheck: account.lastFollowingCheck || null,
          lastFollowersExpected: account.lastFollowersExpected ?? null,
          lastFollowingExpected: account.lastFollowingExpected ?? null,
          lastFollowersQuality: account.lastFollowersQuality || null,
          lastProfileCounts: account.lastProfileCounts || null
        }
      : null,
    recentSnapshots,
    logs: logs.map((l) => ({
      at: new Date(l.at).toISOString(),
      level: l.level,
      source: l.source,
      event: l.event,
      scanId: l.scanId,
      accountKey: l.accountKey,
      message: l.message,
      meta: l.meta
    }))
  };
}
