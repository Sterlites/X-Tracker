/**
 * Pure identity reconciliation, pre-save filtering, scan validation, and relationship diff engine.
 * Environment-agnostic so it runs identically in Service Worker, Side Panel, and Node unit tests.
 */

import { DEFAULT_PRE_SAVE_FILTERS } from './constants.js';
import { makeCanonicalId, normalizeHandle, sanitizeAvatarUrl } from './utils.js';

/**
 * Evaluate whether a user record matches pre-save filter rules.
 * Whitelisted users always bypass exclusion filters.
 * @param {Object} user
 * @param {Object} filters
 * @param {Set<string>} whitelistIds
 * @returns {{ pass: boolean, reason: string|null }}
 */
export function evaluatePreSaveFilter(user, filters = DEFAULT_PRE_SAVE_FILTERS, whitelistIds = new Set()) {
  const id = makeCanonicalId(user);
  const handle = normalizeHandle(user?.username);
  if ((id && whitelistIds.has(id)) || (handle && whitelistIds.has(`handle:${handle}`))) {
    return { pass: true, reason: null };
  }

  const rule = { ...DEFAULT_PRE_SAVE_FILTERS, ...(filters || {}) };

  if (rule.verifiedMode === 'verified_only' && !user?.verified && !user?.isBlueVerified) {
    return { pass: false, reason: 'not_verified' };
  }
  if (rule.verifiedMode === 'blue_only' && !user?.isBlueVerified) {
    return { pass: false, reason: 'not_blue_verified' };
  }
  if (rule.verifiedMode === 'non_verified' && (user?.verified || user?.isBlueVerified)) {
    return { pass: false, reason: 'verified_excluded' };
  }

  if (rule.excludeDefaultAvatar && user?.defaultProfileImage) {
    return { pass: false, reason: 'default_avatar' };
  }

  const minFollowers = Number(rule.minFollowers) || 0;
  if (minFollowers > 0 && Number.isFinite(user?.followersCount) && user.followersCount < minFollowers) {
    return { pass: false, reason: 'below_min_followers' };
  }

  const keywords = Array.isArray(rule.excludeBioKeywords)
    ? rule.excludeBioKeywords
    : String(rule.excludeBioKeywords || '').split(',');
  const bioLower = String(user?.bio || '').toLowerCase();
  for (const rawKw of keywords) {
    const kw = String(rawKw || '').trim().toLowerCase();
    if (kw && bioLower.includes(kw)) {
      return { pass: false, reason: `bio_keyword:${kw}` };
    }
  }

  return { pass: true, reason: null };
}

/**
 * Merge an existing canonical profile with newly extracted user metadata.
 * Tracks handle changes when immutable restId stays identical.
 * @param {Object|null} existing
 * @param {Object} incoming
 * @param {number} now
 * @returns {{ profile: Object, renamedFrom: string|null }}
 */
export function reconcileUserProfile(existing, incoming, now = Date.now()) {
  const incomingHandle = normalizeHandle(incoming?.username || incoming?.screen_name || existing?.username);
  const existingHandle = normalizeHandle(existing?.username);
  const restId = incoming?.restId
    ? String(incoming.restId).trim()
    : (existing?.restId ? String(existing.restId).trim() : null);

  const id = restId || (incomingHandle ? `handle:${incomingHandle}` : existing?.id || '');
  const renamedFrom =
    existingHandle && incomingHandle && existingHandle !== incomingHandle && restId
      ? existingHandle
      : null;

  const previousHandles = Array.isArray(existing?.previousHandles) ? [...existing.previousHandles] : [];
  if (renamedFrom && !previousHandles.includes(renamedFrom)) {
    previousHandles.push(renamedFrom);
  }

  const sanitizedAvatar = sanitizeAvatarUrl(incoming?.avatar) || sanitizeAvatarUrl(existing?.avatar) || '';

  const profile = {
    id,
    restId,
    username: incomingHandle || existingHandle,
    previousHandles,
    name: (incoming?.name && String(incoming.name).trim()) || existing?.name || incomingHandle || 'Unknown',
    bio: incoming?.bio !== undefined && incoming?.bio !== '' ? String(incoming.bio) : (existing?.bio || ''),
    avatar: sanitizedAvatar,
    verified: Boolean(incoming?.verified ?? incoming?.isBlueVerified ?? existing?.verified),
    isBlueVerified: Boolean(incoming?.isBlueVerified ?? existing?.isBlueVerified),
    verifiedType: incoming?.verifiedType ?? existing?.verifiedType ?? null,
    protected: Boolean(incoming?.protected ?? existing?.protected),
    suspended: Boolean(incoming?.suspended ?? existing?.suspended),
    defaultProfileImage: Boolean(incoming?.defaultProfileImage ?? existing?.defaultProfileImage),
    followersCount: Number.isFinite(incoming?.followersCount)
      ? incoming.followersCount
      : (Number.isFinite(existing?.followersCount) ? existing.followersCount : null),
    followingCount: Number.isFinite(incoming?.followingCount)
      ? incoming.followingCount
      : (Number.isFinite(existing?.followingCount) ? existing.followingCount : null),
    statusesCount: Number.isFinite(incoming?.statusesCount)
      ? incoming.statusesCount
      : (Number.isFinite(existing?.statusesCount) ? existing.statusesCount : null),
    createdAt: incoming?.createdAt || existing?.createdAt || null,
    followedBy: typeof incoming?.followedBy === 'boolean' ? incoming.followedBy : (existing?.followedBy ?? null),
    following: typeof incoming?.following === 'boolean' ? incoming.following : (existing?.following ?? null),
    canDm: typeof incoming?.canDm === 'boolean' ? incoming.canDm : (existing?.canDm ?? null),
    profileUrl: incomingHandle ? `https://x.com/${incomingHandle}` : (existing?.profileUrl || ''),
    firstSeenAt: existing?.firstSeenAt || incoming?.firstSeenAt || incoming?.timestamp || now,
    lastSeenAt: now
  };

  return { profile, renamedFrom };
}

/**
 * Evaluate scan quality and validity without rejecting small fast scans or ghost-adjusted counts.
 * @param {{ currentCount: number, expectedCount: number|null, previousCount: number, partial?: boolean }} params
 * @returns {{ isValid: boolean, qualityStatus: string, coverage: number|null, reason: string|null }}
 */
export function evaluateScanQuality({ currentCount, expectedCount, previousCount = 0, partial = false }) {
  const hasExpected = Number.isFinite(expectedCount) && expectedCount >= 0;
  const coverage = hasExpected
    ? (expectedCount === 0 ? (currentCount === 0 ? 1 : 1) : Number((currentCount / expectedCount).toFixed(3)))
    : null;

  if (hasExpected && expectedCount >= 10 && currentCount === 0) {
    return {
      isValid: false,
      qualityStatus: 'failed',
      coverage: 0,
      reason: `No users extracted despite ${expectedCount.toLocaleString()} expected on profile.`
    };
  }

  if (!partial && !hasExpected && previousCount > 100 && currentCount < previousCount * 0.25) {
    return {
      isValid: false,
      qualityStatus: 'failed',
      coverage: null,
      reason: `Suspicious drop (${currentCount} vs ${previousCount} previously) with no profile count baseline.`
    };
  }

  if (partial) {
    return {
      isValid: true,
      qualityStatus: 'partial',
      coverage,
      reason: 'Scan stopped before completion. Baseline preserved.'
    };
  }

  if (coverage === null) {
    return {
      isValid: true,
      qualityStatus: 'complete',
      coverage: null,
      reason: null
    };
  }

  // Strict SOTA Rule: When initial number is known, scan must match initial number!
  if (currentCount >= expectedCount) {
    return {
      isValid: true,
      qualityStatus: 'verified_complete',
      coverage,
      reason: null
    };
  }

  // Final scan numbers did not match initial expected count: strictly partial, must not update baseline stats
  return {
    isValid: true,
    qualityStatus: 'partial',
    coverage,
    reason: `Scan count (${currentCount}) did not match initial expected number (${expectedCount}). Data and statistics preserved.`
  };
}

/**
 * Resolve canonical ID for an incoming user against existing profile maps,
 * upgrading handle:<name> keys to restId when newly discovered.
 */
function resolveIncomingIdentity(incoming, profilesById, handleToId) {
  const restId = incoming?.restId ? String(incoming.restId).trim() : null;
  const handle = normalizeHandle(incoming?.username || incoming?.screen_name);
  const legacyHandleKey = handle ? `handle:${handle}` : '';

  if (restId) {
    // If an older scan stored this user under handle:<name>, migrate that record to restId
    let existing = profilesById.get(restId) || null;
    let upgradedFromId = null;
    if (!existing && legacyHandleKey && profilesById.has(legacyHandleKey)) {
      existing = profilesById.get(legacyHandleKey);
      upgradedFromId = legacyHandleKey;
    } else if (!existing && handle && handleToId.has(handle)) {
      const mappedId = handleToId.get(handle);
      if (mappedId && mappedId.startsWith('handle:') && profilesById.has(mappedId)) {
        existing = profilesById.get(mappedId);
        upgradedFromId = mappedId;
      }
    }
    return { canonicalId: restId, existing, upgradedFromId };
  }

  if (handle && handleToId.has(handle)) {
    const mappedId = handleToId.get(handle);
    return {
      canonicalId: mappedId,
      existing: profilesById.get(mappedId) || null,
      upgradedFromId: null
    };
  }

  return {
    canonicalId: legacyHandleKey,
    existing: legacyHandleKey ? (profilesById.get(legacyHandleKey) || null) : null,
    upgradedFromId: null
  };
}

/**
 * Pure diffing engine for followers, verified_followers, followers_you_follow, and following scans.
 * Only full 'followers' and 'following' scopes update unfollow/follow state and mutual flags;
 * scoped slices ('verified_followers', 'followers_you_follow') update canonical profiles & slice membership cleanly.
 *
 * @param {Object} params
 */
export function computeScanDiff({
  account,
  existingProfiles = {},
  incomingUsers = [],
  scanType = 'followers',
  expectedCount = null,
  expectedSource = 'profile',
  scanSource = 'manual',
  now = Date.now(),
  scanId,
  partial = false,
  preSaveFilters = DEFAULT_PRE_SAVE_FILTERS,
  priorLossIds = new Set(),
  priorActiveUnfollowerMap = new Map(),
  priorActiveNewFollowerMap = new Map(),
  priorRefollowerMap = new Map()
}) {
  const profilesById = new Map(Object.entries(existingProfiles));
  const handleToId = new Map();
  for (const [id, prof] of profilesById.entries()) {
    const h = normalizeHandle(prof?.username);
    if (h && !handleToId.has(h)) {
      handleToId.set(h, id);
    }
  }

  const whitelistSet = new Set((account?.whitelistIds || []).map(String));
  const upgradedIdMap = new Map(); // oldHandleId -> newRestId
  const renamedRecords = [];
  const dedupedIncomingById = new Map();
  let filteredTagCount = 0;

  // Deduplicate incoming users and reconcile identity / handle renames
  for (const rawUser of incomingUsers) {
    const { canonicalId, existing, upgradedFromId } = resolveIncomingIdentity(rawUser, profilesById, handleToId);
    if (!canonicalId) {
      continue;
    }

    if (upgradedFromId && upgradedFromId !== canonicalId) {
      upgradedIdMap.set(upgradedFromId, canonicalId);
      profilesById.delete(upgradedFromId);
    }

    const { profile, renamedFrom } = reconcileUserProfile(existing, rawUser, now);
    const filterResult = evaluatePreSaveFilter(profile, preSaveFilters, whitelistSet);
    if (!filterResult.pass) {
      profile.filterFlag = filterResult.reason;
      filteredTagCount++;
    } else {
      delete profile.filterFlag;
    }

    profilesById.set(canonicalId, profile);
    handleToId.set(profile.username, canonicalId);

    if (renamedFrom) {
      renamedRecords.push({
        id: canonicalId,
        previousHandle: renamedFrom,
        username: profile.username,
        name: profile.name
      });
    }

    dedupedIncomingById.set(canonicalId, profile);
  }

  const remapId = (id) => upgradedIdMap.get(id) || id;
  const remapArray = (arr) => Array.from(new Set((arr || []).map(remapId)));

  const currentIds = Array.from(dedupedIncomingById.keys());
  const currentSet = new Set(currentIds);

  const prevFollowersIds = remapArray(account?.followerIds);
  const prevFollowingIds = remapArray(account?.followingIds);
  const prevVerifiedFollowerIds = remapArray(account?.verifiedFollowerIds);
  const prevMutualFollowerIds = remapArray(account?.mutualFollowerIds);

  const newEvents = [];
  for (const ren of renamedRecords) {
    newEvents.push({
      eventId: `${account.accountKey}:${now}:${ren.id}:renamed`,
      accountKey: account.accountKey,
      targetId: ren.id,
      type: 'renamed',
      at: now,
      scanId,
      scanType,
      source: scanSource,
      meta: {
        previousHandle: ren.previousHandle,
        newHandle: ren.username
      }
    });
  }

  const nextAccount = {
    ...account,
    followerIds: prevFollowersIds,
    followingIds: prevFollowingIds,
    verifiedFollowerIds: prevVerifiedFollowerIds,
    mutualFollowerIds: prevMutualFollowerIds,
    whitelistIds: remapArray(account?.whitelistIds)
  };

  const activeUnfollowers = new Map();
  for (const [k, v] of priorActiveUnfollowerMap.entries()) {
    activeUnfollowers.set(remapId(k), { ...v, id: remapId(k) });
  }
  const activeNewFollowers = new Map();
  for (const [k, v] of priorActiveNewFollowerMap.entries()) {
    activeNewFollowers.set(remapId(k), { ...v, id: remapId(k) });
  }
  const refollowers = new Map();
  for (const [k, v] of priorRefollowerMap.entries()) {
    refollowers.set(remapId(k), { ...v, id: remapId(k) });
  }

  const delta = {
    gained: [],
    lost: [],
    refollowed: [],
    relost: [],
    renamed: renamedRecords.map((r) => `${r.previousHandle}->${r.username}`),
    followingAdded: [],
    followingRemoved: []
  };

  const previousListLength =
    scanType === 'following'
      ? prevFollowingIds.length
      : scanType === 'verified_followers'
        ? prevVerifiedFollowerIds.length
        : scanType === 'followers_you_follow'
          ? prevMutualFollowerIds.length
          : prevFollowersIds.length;

  const quality = evaluateScanQuality({
    currentCount: currentIds.length,
    expectedCount,
    previousCount: previousListLength,
    partial
  });

  const hasExpected = Number.isFinite(expectedCount) && expectedCount >= 0;
  // SOTA Completion Criteria: Only deemed complete and worthy of updating current stats
  // when the initial number matches the final scan numbers (or when initial number was genuinely unknown).
  const isCompleteAndWorthy =
    hasExpected
      ? currentIds.length >= expectedCount && !partial && quality.isValid
      : !partial && quality.isValid;

  if (scanType === 'followers') {
    const hadBaseline = Boolean(account?.lastFollowersCheck) || prevFollowersIds.length > 0;
    const prevSet = new Set(prevFollowersIds);

    if (isCompleteAndWorthy) {
      if (hadBaseline) {
        for (const id of currentIds) {
          if (!prevSet.has(id)) {
            const isRefollow =
              activeUnfollowers.has(id) || priorLossIds.has(remapId(id));
            const eventType = isRefollow ? 'refollowed' : 'followed';
            delta.gained.push(id);
            if (isRefollow) {
              delta.refollowed.push(id);
            }

            activeUnfollowers.delete(id);
            activeNewFollowers.set(id, {
              id,
              followedAt: now,
              scanId,
              refollowed: isRefollow
            });
            if (isRefollow) {
              refollowers.set(id, {
                id,
                refollowedAt: now,
                scanId
              });
            }

            newEvents.push({
              eventId: `${account.accountKey}:${now}:${id}:${eventType}`,
              accountKey: account.accountKey,
              targetId: id,
              type: eventType,
              at: now,
              scanId,
              scanType,
              source: scanSource
            });
          }
        }

        for (const prevId of prevFollowersIds) {
          if (!currentSet.has(prevId)) {
            const wasPreviouslyLost = priorLossIds.has(prevId);
            const eventType = wasPreviouslyLost ? 'reunfollowed' : 'unfollowed';
            delta.lost.push(prevId);
            if (wasPreviouslyLost) {
              delta.relost.push(prevId);
            }

            activeUnfollowers.set(prevId, {
              id: prevId,
              unfollowedAt: now,
              scanId,
              repeatUnfollow: wasPreviouslyLost,
              unfollowReason: 'unfollowed'
            });

            newEvents.push({
              eventId: `${account.accountKey}:${now}:${prevId}:${eventType}`,
              accountKey: account.accountKey,
              targetId: prevId,
              type: eventType,
              at: now,
              scanId,
              scanType,
              source: scanSource
            });
          }
        }
      }

      nextAccount.followerIds = currentIds;
      nextAccount.lastFollowersCheck = now;
      nextAccount.lastFollowersCount = nextAccount.followerIds.length;
      nextAccount.lastFollowersExpected = hasExpected ? expectedCount : null;
      nextAccount.lastFollowersCoverage = quality.coverage;
      nextAccount.lastFollowersExpectedSource = expectedSource;
      nextAccount.lastFollowersQuality = quality.qualityStatus;
    } else {
      // Incomplete / partial / failed scan: MUST NOT update data or statistics!
      nextAccount.followerIds = prevFollowersIds;
      nextAccount.lastFollowersCount = Number.isFinite(account?.lastFollowersCount)
        ? account.lastFollowersCount
        : prevFollowersIds.length;
      nextAccount.lastFollowersExpected = hasExpected ? expectedCount : null;
      nextAccount.lastFollowersCoverage = quality.coverage;
      nextAccount.lastFollowersExpectedSource = expectedSource;
      nextAccount.lastFollowersQuality = quality.qualityStatus;
      nextAccount.lastFollowersPartialAt = now;
    }
  } else if (scanType === 'following') {
    const hadBaseline = Boolean(account?.lastFollowingCheck) || prevFollowingIds.length > 0;
    const prevSet = new Set(prevFollowingIds);

    if (isCompleteAndWorthy) {
      if (hadBaseline) {
        for (const id of currentIds) {
          if (!prevSet.has(id)) {
            delta.followingAdded.push(id);
            newEvents.push({
              eventId: `${account.accountKey}:${now}:${id}:you_followed`,
              accountKey: account.accountKey,
              targetId: id,
              type: 'you_followed',
              at: now,
              scanId,
              scanType,
              source: scanSource
            });
          }
        }
        for (const prevId of prevFollowingIds) {
          if (!currentSet.has(prevId)) {
            delta.followingRemoved.push(prevId);
            newEvents.push({
              eventId: `${account.accountKey}:${now}:${prevId}:you_unfollowed`,
              accountKey: account.accountKey,
              targetId: prevId,
              type: 'you_unfollowed',
              at: now,
              scanId,
              scanType,
              source: scanSource
            });
          }
        }
      }

      nextAccount.followingIds = currentIds;
      nextAccount.lastFollowingCheck = now;
      nextAccount.lastFollowingCount = nextAccount.followingIds.length;
      nextAccount.lastFollowingExpected = hasExpected ? expectedCount : null;
      nextAccount.lastFollowingCoverage = quality.coverage;
      nextAccount.lastFollowingExpectedSource = expectedSource;
      nextAccount.lastFollowingQuality = quality.qualityStatus;
    } else {
      // Incomplete / partial / failed scan: MUST NOT update data or statistics!
      nextAccount.followingIds = prevFollowingIds;
      nextAccount.lastFollowingCount = Number.isFinite(account?.lastFollowingCount)
        ? account.lastFollowingCount
        : prevFollowingIds.length;
      nextAccount.lastFollowingExpected = hasExpected ? expectedCount : null;
      nextAccount.lastFollowingCoverage = quality.coverage;
      nextAccount.lastFollowingExpectedSource = expectedSource;
      nextAccount.lastFollowingQuality = quality.qualityStatus;
      nextAccount.lastFollowingPartialAt = now;
    }
  } else if (scanType === 'verified_followers') {
    if (isCompleteAndWorthy) {
      nextAccount.verifiedFollowerIds = currentIds;
      nextAccount.lastVerifiedFollowersCheck = now;
    } else {
      nextAccount.verifiedFollowerIds = account?.verifiedFollowerIds || [];
    }
  } else if (scanType === 'followers_you_follow') {
    if (isCompleteAndWorthy) {
      nextAccount.mutualFollowerIds = currentIds;
      nextAccount.lastMutualFollowersCheck = now;
    } else {
      nextAccount.mutualFollowerIds = account?.mutualFollowerIds || [];
    }
  }

  // Recompute derived relationships only when scan was complete and worthy
  if (isCompleteAndWorthy) {
    const followerSet = new Set(nextAccount.followerIds);
    const followingSet = new Set(nextAccount.followingIds);

    const fansIds = nextAccount.followerIds.filter((id) => !followingSet.has(id));
    const notFollowingBackIds = nextAccount.followingIds.filter((id) => !followerSet.has(id));

    nextAccount.fansIds = fansIds;
    nextAccount.notFollowingBackIds = notFollowingBackIds;
    nextAccount.activeUnfollowers = Object.fromEntries(activeUnfollowers.entries());
    nextAccount.activeNewFollowers = Object.fromEntries(activeNewFollowers.entries());
    nextAccount.refollowers = Object.fromEntries(refollowers.entries());
    nextAccount.scanCount = (account?.scanCount || 0) + 1;
    nextAccount.lastSuccessfulScan = now;
  } else {
    nextAccount.fansIds = account?.fansIds || [];
    nextAccount.notFollowingBackIds = account?.notFollowingBackIds || [];
    nextAccount.activeUnfollowers = Object.fromEntries(priorActiveUnfollowerMap.entries());
    nextAccount.activeNewFollowers = Object.fromEntries(priorActiveNewFollowerMap.entries());
    nextAccount.refollowers = Object.fromEntries(priorRefollowerMap.entries());
    nextAccount.scanCount = account?.scanCount || 0;
  }

  const snapshot = {
    scanId,
    accountKey: nextAccount.accountKey,
    type: scanType,
    source: scanSource,
    timestamp: now,
    count: currentIds.length,
    expected: hasExpected ? expectedCount : null,
    expectedSource,
    status: isCompleteAndWorthy ? 'complete' : quality.qualityStatus,
    isComplete: isCompleteAndWorthy,
    partial: !isCompleteAndWorthy,
    qualityStatus: quality.qualityStatus,
    coverage: quality.coverage,
    reason: quality.reason,
    filteredTagCount,
    verified: currentIds.filter((id) => {
      const p = profilesById.get(id);
      return Boolean(p?.verified || p?.isBlueVerified);
    }).length,
    followersCount: nextAccount.followerIds.length,
    followingCount: nextAccount.followingIds.length,
    unfollowersCount: activeUnfollowers.size,
    newFollowersCount: activeNewFollowers.size,
    refollowersCount: refollowers.size,
    fansCount: nextAccount.fansIds.length,
    notFollowingBackCount: nextAccount.notFollowingBackIds.length,
    delta: isCompleteAndWorthy ? delta : { gained: [], lost: [], refollowed: [], relost: [], followingAdded: [], followingRemoved: [] },
    filterStats: { filteredTagCount, preSaveFilters }
  };

  return {
    account: nextAccount,
    profiles: Object.fromEntries(profilesById.entries()),
    snapshot,
    events: newEvents,
    quality,
    renamedRecords,
    upgradedIdMap: Object.fromEntries(upgradedIdMap.entries())
  };
}
