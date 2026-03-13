/**
 * X-Unfollow Tracker - Data Management Module
 * Handles storage schema, time-series data, diff engine, and data migration
 */
(function() {
'use strict';

// ================== Constants ==================
const DATA_VERSION = 2;
const MAX_EVENTS = 1000;
const MAX_SNAPSHOTS = 90; // 90 days of daily snapshots
const MAX_FULL_DETAIL_DAYS = 30;
const DEFAULT_SCAN_INTERVAL_HOURS = 6;
const MIN_SCAN_INTERVAL_HOURS = 4;
const MAX_SCAN_INTERVAL_HOURS = 24;
const JITTER_MINUTES = 30;

// ================== Storage Schema ==================

/**
 * Get default settings
 * @returns {Object} Default settings object
 */
function getDefaultSettings() {
  return {
    scanIntervalHours: DEFAULT_SCAN_INTERVAL_HOURS,
    backgroundScanEnabled: true,
    notificationsEnabled: true,
    notifyOnUnfollow: true,
    notifyOnNewFollower: true,
    notifyOnSessionExpired: true,
    dataVersion: DATA_VERSION
  };
}

/**
 * Get empty user data structure
 * @returns {Object} Empty user data
 */
function getEmptyUserData() {
  return {
    // Current lists (full user objects)
    followers: [],
    following: [],

    // Event logs (timestamped follow/unfollow events)
    events: [],

    // Daily snapshots (count-only for trend charts)
    snapshots: [],

    // Computed lists (rebuilt from current data)
    unfollowers: [],
    newFollowers: [],
    fansList: [],
    notFollowingBack: [],

    // Metadata
    scanCount: 0,
    lastFollowersCheck: null,
    lastFollowingCheck: null,
    lastFollowersCount: null,
    lastFollowingCount: null,
    createdAt: Date.now(),
    dataVersion: DATA_VERSION
  };
}

// ================== Normalization ==================

/**
 * Normalize username
 * @param {string} value - Raw username
 * @returns {string} Normalized lowercase username without @
 */
function normalizeUsername(value) {
  return (value || '').replace(/^@/, '').trim().toLowerCase();
}

// ================== Diff Engine ==================

/**
 * Compute the diff between old and new follower/following lists
 * Returns arrays of new users and lost users
 * @param {Array} previousList - Previous scan's user list
 * @param {Array} currentList - Current scan's user list
 * @returns {Object} { gained: [], lost: [] }
 */
function computeListDiff(previousList, currentList) {
  const prevSet = new Map((previousList || []).map(u => [normalizeUsername(u.username), u]));
  const currSet = new Map((currentList || []).map(u => [normalizeUsername(u.username), u]));

  const gained = [];
  const lost = [];

  // Find gained: in current but not in previous
  for (const [username, user] of currSet) {
    if (!prevSet.has(username)) {
      gained.push(user);
    }
  }

  // Find lost: in previous but not in current
  for (const [username, user] of prevSet) {
    if (!currSet.has(username)) {
      lost.push(user);
    }
  }

  return { gained, lost };
}

/**
 * Create events from a diff result
 * @param {Object} diff - { gained, lost }
 * @param {string} scanType - 'followers' or 'following'
 * @param {number} timestamp - Event timestamp
 * @returns {Array} Array of event objects
 */
function createEventsFromDiff(diff, scanType, timestamp) {
  const events = [];

  if (scanType === 'followers') {
    diff.gained.forEach(user => {
      events.push({
        type: 'follow',
        username: normalizeUsername(user.username),
        displayName: user.name || user.username,
        avatar: user.avatar || '',
        verified: !!user.verified,
        timestamp: timestamp,
        bio: user.bio || ''
      });
    });

    diff.lost.forEach(user => {
      events.push({
        type: 'unfollow',
        username: normalizeUsername(user.username),
        displayName: user.name || user.username,
        avatar: user.avatar || '',
        verified: !!user.verified,
        timestamp: timestamp,
        bio: user.bio || ''
      });
    });
  }

  return events;
}

/**
 * Merge new users with existing users, preserving history fields
 * @param {Array} currentUsers - Users from latest scan
 * @param {Array} previousUsers - Users from previous scan
 * @returns {Array} Merged user list
 */
function mergeUserLists(currentUsers, previousUsers) {
  const prevMap = new Map((previousUsers || []).map(u => [normalizeUsername(u.username), u]));
  const now = Date.now();

  return currentUsers.map(user => {
    const key = normalizeUsername(user.username);
    const prev = prevMap.get(key) || {};

    // Sanitize any numeric ID to prevent corruption (remove non-digits)
    const sanitizedId = user.id ? String(user.id).replace(/[^0-9]/g, '') : prev.id;

    return {
      ...prev,
      ...user,
      id: sanitizedId,
      username: key,
      name: user.name || prev.name || key,
      bio: user.bio || prev.bio || '',
      avatar: user.avatar || prev.avatar || '',
      verified: typeof user.verified === 'boolean' ? user.verified : !!prev.verified,
      profileUrl: user.profileUrl || prev.profileUrl || `https://x.com/${key}`,
      firstSeenAt: prev.firstSeenAt || now,
      lastSeenAt: now
    };
  });
}

// ================== Snapshot Management ==================

/**
 * Create a daily snapshot from current data
 * @param {Object} userData - Full user data object
 * @returns {Object} Snapshot object
 */
function createSnapshot(userData) {
  const now = new Date();
  const dateKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  return {
    date: dateKey,
    timestamp: Date.now(),
    followerCount: (userData.followers || []).length,
    followingCount: (userData.following || []).length,
    unfollowerCount: (userData.unfollowers || []).length,
    newFollowerCount: (userData.newFollowers || []).length,
    fansCount: (userData.fansList || []).length,
    notFollowingBackCount: (userData.notFollowingBack || []).length,
    scanCount: userData.scanCount || 0
  };
}

/**
 * Add or update today's snapshot in the snapshots array
 * @param {Array} snapshots - Existing snapshots
 * @param {Object} newSnapshot - New snapshot to add
 * @returns {Array} Updated snapshots array
 */
function upsertSnapshot(snapshots, newSnapshot) {
  const existing = [...(snapshots || [])];
  const idx = existing.findIndex(s => s.date === newSnapshot.date);

  if (idx >= 0) {
    existing[idx] = newSnapshot;
  } else {
    existing.push(newSnapshot);
  }

  // Keep only the most recent MAX_SNAPSHOTS
  if (existing.length > MAX_SNAPSHOTS) {
    return existing.slice(-MAX_SNAPSHOTS);
  }

  return existing;
}

// ================== Computed Lists ==================

/**
 * Rebuild computed lists (unfollowers, fans, notFollowingBack) from current data
 * @param {Object} userData - User data object
 * @returns {Object} Updated userData with computed lists
 */
function rebuildComputedLists(userData) {
  const followers = userData.followers || [];
  const following = userData.following || [];

  const followerSet = new Set(followers.map(f => normalizeUsername(f.username)));
  const followingSet = new Set(following.map(f => normalizeUsername(f.username)));

  // Mark mutual follows
  followers.forEach(user => {
    user.followsBack = followingSet.has(normalizeUsername(user.username));
  });
  following.forEach(user => {
    user.followsBack = followerSet.has(normalizeUsername(user.username));
  });

  // Fans: followers you don't follow back
  userData.fansList = followers
    .filter(f => !followingSet.has(normalizeUsername(f.username)))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  // Not following back: following who don't follow you
  userData.notFollowingBack = following
    .filter(f => !followerSet.has(normalizeUsername(f.username)))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  return userData;
}

// ================== Process Scan Results ==================

/**
 * Process scan results: diff, create events, update lists, create snapshot
 * This is the main entry point called after an API scan completes
 * @param {string} username - Account username
 * @param {string} scanType - 'followers' or 'following'
 * @param {Array} scannedUsers - Users from the scan
 * @returns {Promise<Object>} Updated user data
 */
async function processScanResults(username, scanType, scannedUsers) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(['users', 'settings'], (result) => {
      const users = result.users || {};
      const normalizedKey = normalizeUsername(username);
      const existingKey = Object.keys(users).find(k => normalizeUsername(k) === normalizedKey);
      const storageKey = existingKey || username;

      let userData = users[storageKey] || getEmptyUserData();
      const now = Date.now();

      if (scanType === 'followers') {
        const previousFollowers = userData.followers || [];
        const hadPreviousScan = previousFollowers.length > 0 && userData.lastFollowersCheck;
        const merged = mergeUserLists(scannedUsers, previousFollowers);

        // Compute diff and create events
        if (hadPreviousScan) {
          const diff = computeListDiff(previousFollowers, merged);
          const newEvents = createEventsFromDiff(diff, 'followers', now);

          // Append events
          userData.events = [...(userData.events || []), ...newEvents];
          if (userData.events.length > MAX_EVENTS) {
            userData.events = userData.events.slice(-MAX_EVENTS);
          }

          // Update unfollowers list (from events)
          const unfollowEvents = (userData.events || []).filter(e => e.type === 'unfollow');
          const currentFollowerSet = new Set(merged.map(f => normalizeUsername(f.username)));

          userData.unfollowers = unfollowEvents
            .filter(e => !currentFollowerSet.has(normalizeUsername(e.username)))
            .map(e => ({
              username: e.username,
              name: e.displayName,
              avatar: e.avatar,
              verified: e.verified,
              bio: e.bio || '',
              unfollowedAt: e.timestamp,
              profileUrl: `https://x.com/${e.username}`
            }))
            .reduce((acc, u) => {
              // Deduplicate, keep latest
              const existing = acc.find(x => normalizeUsername(x.username) === normalizeUsername(u.username));
              if (!existing) acc.push(u);
              return acc;
            }, [])
            .sort((a, b) => (b.unfollowedAt || 0) - (a.unfollowedAt || 0))
            .slice(0, 500);

          // Update new followers list (from events)
          const followEvents = (userData.events || []).filter(e => e.type === 'follow');
          userData.newFollowers = followEvents
            .map(e => ({
              username: e.username,
              name: e.displayName,
              avatar: e.avatar,
              verified: e.verified,
              bio: e.bio || '',
              timestamp: e.timestamp,
              profileUrl: `https://x.com/${e.username}`
            }))
            .reduce((acc, u) => {
              const existing = acc.find(x => normalizeUsername(x.username) === normalizeUsername(u.username));
              if (!existing) acc.push(u);
              return acc;
            }, [])
            .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
            .slice(0, 500);
        }

        userData.followers = merged;
        userData.lastFollowersCheck = now;
        userData.lastFollowersCount = merged.length;

      } else if (scanType === 'following') {
        const previousFollowing = userData.following || [];
        const merged = mergeUserLists(scannedUsers, previousFollowing);

        userData.following = merged;
        userData.lastFollowingCheck = now;
        userData.lastFollowingCount = merged.length;
      }

      // Rebuild computed lists
      userData = rebuildComputedLists(userData);

      // Update scan metadata
      userData.scanCount = (userData.scanCount || 0) + 1;

      // Create/update daily snapshot
      const snapshot = createSnapshot(userData);
      userData.snapshots = upsertSnapshot(userData.snapshots, snapshot);

      // Save
      users[storageKey] = userData;
      chrome.storage.local.set({
        users: users,
        currentUser: storageKey,
        scanStatus: 'complete',
        lastScanTime: now
      }, () => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          resolve(userData);
        }
      });
    });
  });
}

// ================== Data Migration ==================

/**
 * Migrate old data format (v1) to new format (v2)
 * Preserves existing follower/following lists, converts unfollowers/newFollowers to events
 * @returns {Promise<void>}
 */
async function migrateDataIfNeeded() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['users', 'settings'], (result) => {
      const users = result.users || {};
      let migrated = false;

      for (const [username, userData] of Object.entries(users)) {
        if (userData.dataVersion === DATA_VERSION) continue;

        // Migrate from v1 (original format)
        const events = userData.events || [];
        const now = Date.now();

        // Convert existing unfollowers to unfollow events
        if (userData.unfollowers && userData.unfollowers.length > 0) {
          userData.unfollowers.forEach(u => {
            if (u && u.username) {
              events.push({
                type: 'unfollow',
                username: normalizeUsername(u.username),
                displayName: u.name || u.username,
                avatar: u.avatar || '',
                verified: !!u.verified,
                timestamp: u.unfollowedAt || now,
                bio: u.bio || ''
              });
            }
          });
        }

        // Convert existing newFollowers to follow events
        if (userData.newFollowers && userData.newFollowers.length > 0) {
          userData.newFollowers.forEach(u => {
            if (u && u.username) {
              events.push({
                type: 'follow',
                username: normalizeUsername(u.username),
                displayName: u.name || u.username,
                avatar: u.avatar || '',
                verified: !!u.verified,
                timestamp: u.timestamp || now,
                bio: u.bio || ''
              });
            }
          });
        }

        userData.events = events.slice(-MAX_EVENTS);

        // Initialize snapshots if not present
        if (!userData.snapshots) {
          userData.snapshots = [];
          const snapshot = createSnapshot(userData);
          userData.snapshots.push(snapshot);
        }

        // Initialize dates
        if (!userData.createdAt) {
          userData.createdAt = userData.lastFollowersCheck || userData.lastFollowingCheck || now;
        }

        // Clean up old scanHistory (replaced by snapshots)
        delete userData.scanHistory;

        userData.dataVersion = DATA_VERSION;
        users[username] = userData;
        migrated = true;
      }

      if (migrated) {
        chrome.storage.local.set({ users }, () => {
          console.log('Data migration to v2 complete');
          resolve();
        });
      } else {
        resolve();
      }
    });
  });
}

// ================== Query Helpers ==================

/**
 * Get follower count trend for the last N days
 * @param {Object} userData - User data
 * @param {number} days - Number of days
 * @returns {Array} Array of { date, count } objects
 */
function getFollowerTrend(userData, days = 30) {
  const snapshots = userData.snapshots || [];
  return snapshots
    .slice(-days)
    .map(s => ({ date: s.date, count: s.followerCount, timestamp: s.timestamp }));
}

/**
 * Get following count trend
 * @param {Object} userData - User data
 * @param {number} days - Number of days
 * @returns {Array}
 */
function getFollowingTrend(userData, days = 30) {
  const snapshots = userData.snapshots || [];
  return snapshots
    .slice(-days)
    .map(s => ({ date: s.date, count: s.followingCount, timestamp: s.timestamp }));
}

/**
 * Get recent events (follow/unfollow)
 * @param {Object} userData - User data
 * @param {number} limit - Max events to return
 * @param {string} [filterType] - Optional: 'follow' or 'unfollow'
 * @returns {Array}
 */
function getRecentEvents(userData, limit = 50, filterType = null) {
  let events = userData.events || [];
  if (filterType) {
    events = events.filter(e => e.type === filterType);
  }
  return events.slice(-limit).reverse();
}

/**
 * Calculate account health score (0-100)
 * Based on follower/following ratio, churn rate, growth trend
 * @param {Object} userData - User data
 * @returns {Object} { score, breakdown }
 */
function getAccountHealth(userData) {
  const followers = (userData.followers || []).length;
  const following = (userData.following || []).length;
  const unfollowers = (userData.unfollowers || []).length;
  const newFollowers = (userData.newFollowers || []).length;
  const snapshots = userData.snapshots || [];

  let ratioScore = 50;
  if (following > 0) {
    const ratio = followers / following;
    if (ratio >= 2) ratioScore = 100;
    else if (ratio >= 1) ratioScore = 80;
    else if (ratio >= 0.5) ratioScore = 60;
    else if (ratio >= 0.25) ratioScore = 40;
    else ratioScore = 20;
  }

  // Churn score: lower churn = better
  let churnScore = 80;
  if (followers > 0) {
    const churnRate = unfollowers / followers;
    if (churnRate < 0.01) churnScore = 100;
    else if (churnRate < 0.03) churnScore = 80;
    else if (churnRate < 0.05) churnScore = 60;
    else if (churnRate < 0.1) churnScore = 40;
    else churnScore = 20;
  }

  // Growth score
  let growthScore = 50;
  if (snapshots.length >= 2) {
    const first = snapshots[0].followerCount || 0;
    const last = snapshots[snapshots.length - 1].followerCount || 0;
    const growth = last - first;
    if (growth > 100) growthScore = 100;
    else if (growth > 50) growthScore = 90;
    else if (growth > 10) growthScore = 75;
    else if (growth > 0) growthScore = 60;
    else if (growth === 0) growthScore = 50;
    else growthScore = 30;
  }

  // Engagement score (follow-back rate)
  let engagementScore = 50;
  if (followers > 0) {
    const fans = (userData.fansList || []).length;
    const followBackRate = (followers - fans) / followers;
    engagementScore = Math.round(followBackRate * 100);
  }

  const score = Math.round(
    ratioScore * 0.3 +
    churnScore * 0.25 +
    growthScore * 0.25 +
    engagementScore * 0.2
  );

  return {
    score: Math.min(100, Math.max(0, score)),
    breakdown: {
      ratio: ratioScore,
      churn: churnScore,
      growth: growthScore,
      engagement: engagementScore
    }
  };
}

/**
 * Get daily change stats for the last N days
 * @param {Object} userData - User data
 * @param {number} days - Number of days
 * @returns {Array} Array of { date, gained, lost, net }
 */
function getDailyChanges(userData, days = 14) {
  const events = userData.events || [];
  const dailyMap = new Map();

  events.forEach(e => {
    const d = new Date(e.timestamp);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (!dailyMap.has(key)) {
      dailyMap.set(key, { date: key, gained: 0, lost: 0 });
    }
    const entry = dailyMap.get(key);
    if (e.type === 'follow') entry.gained++;
    else if (e.type === 'unfollow') entry.lost++;
  });

  return Array.from(dailyMap.values())
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-days)
    .map(d => ({ ...d, net: d.gained - d.lost }));
}

// Export for use in other scripts (service worker compatible)
const _exportTarget = typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis);
_exportTarget.DataModule = {
  getDefaultSettings,
  getEmptyUserData,
  normalizeUsername,
  computeListDiff,
  createEventsFromDiff,
  mergeUserLists,
  createSnapshot,
  upsertSnapshot,
  rebuildComputedLists,
  processScanResults,
  migrateDataIfNeeded,
  getFollowerTrend,
  getFollowingTrend,
  getRecentEvents,
  getAccountHealth,
  getDailyChanges,
  DATA_VERSION,
  DEFAULT_SCAN_INTERVAL_HOURS,
  MIN_SCAN_INTERVAL_HOURS,
  MAX_SCAN_INTERVAL_HOURS,
  JITTER_MINUTES
};

})(); // End IIFE
