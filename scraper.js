/**
 * X-Unfollow Tracker - Content Script (Scraper)
 * Runs on X follower/following pages to collect user data
 */

// Immediately Invoked Async Function Expression (IIFE)
(async function() {
  // Prevent multiple instances from running simultaneously
  if (window.xUnfollowTrackerRunning) {
    console.log('Scanner already running - aborting duplicate instance');
    return;
  }

  // Set running flag
  window.xUnfollowTrackerRunning = true;
  window.xScannerShouldStop = false;
  window.xScannerStopReason = null;

  // ================== Constants ==================
  const SCAN_START_TIME = Date.now();
  const MAX_SCAN_TIME_MS = 600000; // 10 minutes maximum
  const BASE_SCROLL_DELAY_MS = 700;
  const MAX_SCROLL_DELAY_MS = 2500;
  const LONG_SCROLL_DELAY_MS = 1200;
  const PAUSE_EVERY_N_SCROLLS = 20;
  const PAUSE_DURATION_MS = 2000;
  const MAX_SCROLLS = 500;
  const STABILITY_THRESHOLD = 7;
  const MIN_USERS_FOUND = 5;
  const MIN_SCAN_DURATION_MS = 5000;
  const EXPECTED_COVERAGE_SMALL = 0.85;
  const EXPECTED_COVERAGE_MEDIUM = 0.75;
  const EXPECTED_COVERAGE_LARGE = 0.6;
  const STRICT_COVERAGE_SMALL = 0.96;
  const STRICT_COVERAGE_MEDIUM = 0.93;
  const PAGE_READY_MAX_WAIT_ATTEMPTS = 60;
  const USERNAME_REGEX = /^[a-zA-Z0-9_]{1,15}$/;
  const RELATIONSHIP_MODEL_VERSION = 2;
  const MAX_RELATIONSHIP_EVENTS_PER_HANDLE = 40;
  const MAX_SNAPSHOTS = 400;
  const MAX_SCAN_HISTORY = 200;

  const RESERVED_PATHS = new Set([
    'i',
    'home',
    'search',
    'hashtag',
    'explore',
    'notifications',
    'messages',
    'settings',
    'compose',
    'login',
    'signup',
    'logout',
    'tos',
    'privacy',
    'about',
    'intent',
    'share',
    'account',
    'topics',
    'lists',
    'bookmarks'
  ]);

  // ================== Utility Functions ==================
  
  /**
   * Sleep for specified milliseconds
   * @param {number} ms - Milliseconds to sleep
   * @returns {Promise<void>}
   */
  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Safely send runtime message without crashing scan flow
   * @param {Object} payload - Message payload
   * @returns {Promise<any|null>}
   */
  function safeSendMessage(payload) {
    return new Promise((resolve) => {
      try {
        if (!chrome?.runtime?.id) {
          resolve(null);
          return;
        }
        chrome.runtime.sendMessage(payload, (response) => {
          const err = chrome.runtime.lastError;
          if (err) {
            const msg = String(err.message || '').toLowerCase();
            if (!msg.includes('extension context invalidated')) {
              console.warn('sendMessage warning:', err.message);
            }
            resolve(null);
            return;
          }
          resolve(response || null);
        });
      } catch (error) {
        const msg = String(error?.message || '').toLowerCase();
        if (!msg.includes('extension context invalidated')) {
          console.warn('sendMessage failed:', error);
        }
        resolve(null);
      }
    });
  }

  function getStorage(keys) {
    return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
  }

  /**
   * Normalize username for consistent comparisons
   * @param {string} value - Raw username
   * @returns {string} Normalized username
   */
  function normalizeUsername(value) {
    return (value || '').replace(/^@/, '').trim().toLowerCase();
  }

  /**
   * Get primary column container
   * @returns {Element} Primary column element
   */
  function getPrimaryColumn() {
    return (
      document.querySelector('[data-testid="primaryColumn"]') ||
      document.querySelector('main[role="main"]') ||
      document.querySelector('main') ||
      document.body
    );
  }

  /**
   * Get timeline container within primary column
   * @param {Element} primaryColumn - Primary column element
   * @returns {Element} Timeline container
   */
  function getTimelineContainer(primaryColumn) {
    const root = primaryColumn || document;
    return (
      root.querySelector('section[aria-label*="Timeline"]') ||
      root.querySelector('[aria-label*="Timeline"]') ||
      root
    );
  }

  /**
   * Get list container for user cells
   * @returns {Object} Container elements
   */
  function getListContainer() {
    const primary = getPrimaryColumn();
    const timeline = getTimelineContainer(primary);
    return { primary, timeline };
  }

  /**
   * Get scroll element used for loading more users
   * @returns {Element} Scrollable element
   */
  function getScrollElement() {
    return (
      document.querySelector('[data-testid="primaryColumn"]') ||
      document.scrollingElement ||
      document.documentElement
    );
  }

  /**
   * Detect common page issues (login, rate limit, errors)
   * @returns {string|null} Error message if issue detected
   */
  function detectPageIssue() {
    const path = window.location.pathname || '';
    if (path.startsWith('/i/flow/login') || path.startsWith('/login')) {
      return 'You are not logged in. Please log in to X and retry.';
    }

    const errorElement = document.querySelector('[data-testid="error-detail"], [data-testid="toast"], [role="alert"]');
    const errorText = (errorElement?.innerText || '').toLowerCase();
    const bodyText = (document.body?.innerText || '').toLowerCase();
    const text = `${errorText}\n${bodyText.slice(0, 2500)}`.replace(/\u2019/g, "'");

    if (text.includes('rate limit') || text.includes('too many requests')) {
      return 'Rate limit detected. Please wait and try again later.';
    }

    if (text.includes('something went wrong') || text.includes('try again')) {
      return 'X returned an error. Please refresh the page and retry.';
    }

    if (text.includes("account doesn't exist") || text.includes('account does not exist')) {
      return 'This account does not exist or is unavailable.';
    }

    if (text.includes('these posts are protected') || text.includes('only approved followers')) {
      return 'This account is protected and cannot be scanned.';
    }

    if (text.includes('log in') && text.includes('sign up')) {
      return 'Please log in to X before scanning.';
    }

    return null;
  }

  /**
   * Detect empty state when there are zero followers/following
   * @param {string} scanType - followers or following
   * @param {Element} root - Root container
   * @returns {boolean} Whether empty state is detected
   */
  function detectEmptyState(scanType, root) {
    const container = root || document.body;
    const empty = container.querySelector('[data-testid="emptyState"], [data-testid="empty-state"]');
    if (!empty) {
      return false;
    }

    const text = (empty.innerText || '').toLowerCase();
    if (scanType === 'followers') {
      return text.includes('followers') || text.includes('no one follows');
    }
    if (scanType === 'following') {
      return text.includes('following') || text.includes('not following');
    }
    return true;
  }

  /**
   * Wait for page to be ready with timeline loaded
   * @returns {Promise<void>}
   */
  async function waitForPageReady(scanType) {
    let attempts = 0;

    return new Promise((resolve, reject) => {
      const checkInterval = setInterval(() => {
        // Check if user stopped scan
        if (window.xScannerShouldStop) {
          clearInterval(checkInterval);
          const reason = window.xScannerStopReason || 'manual';
          reject(new Error(reason === 'timeout' ? 'Scan timed out while loading page.' : 'Scan stopped by user'));
          return;
        }

        const pageIssue = detectPageIssue();
        if (pageIssue) {
          clearInterval(checkInterval);
          reject(new Error(pageIssue));
          return;
        }

        attempts++;

        const { primary, timeline } = getListContainer();
        const userCells = getUserCells(timeline);
        const emptyState = detectEmptyState(scanType, primary);

        if ((timeline && userCells.length > 0) || emptyState) {
          console.log(`Page ready - found ${userCells.length} initial users`);
          clearInterval(checkInterval);
          resolve();
          return;
        }

        // Timeout if page doesn't load
        if (attempts >= PAGE_READY_MAX_WAIT_ATTEMPTS) {
          clearInterval(checkInterval);
          reject(new Error('Timeout waiting for page to load. Try refreshing the page.'));
        }
      }, 500);
    });
  }

  /**
   * Get valid user cells (excluding sidebar suggestions)
   * @returns {Array<Element>} Array of user cell elements
   */
  function getUserCells(root) {
    const scope = root || document;
    const allCells = scope.querySelectorAll('[data-testid="UserCell"]');
    const validCells = [];
    const primaryColumn = document.querySelector('[data-testid="primaryColumn"]');

    allCells.forEach(cell => {
      if (!cell || !cell.isConnected) {
        return;
      }

      if (primaryColumn && !primaryColumn.contains(cell)) {
        return;
      }

      if (cell.closest('aside') || cell.closest('[data-testid="sidebarColumn"]')) {
        return;
      }

      if (cell.closest('[aria-label*="Who to follow"], [aria-label*="Relevant people"], [aria-label*="You might like"], [aria-label*="Similar accounts"]')) {
        return;
      }

      validCells.push(cell);
    });

    return validCells;
  }

  /**
   * Extract username from a profile link
   * @param {string} href - Link href
   * @returns {string|null} Username or null if invalid
   */
  function extractUsernameFromHref(href) {
    if (!href) return null;
    let path = href;

    try {
      if (href.startsWith('http')) {
        path = new URL(href).pathname || '';
      }
    } catch (error) {
      path = href;
    }

    path = path.split('?')[0];
    const parts = path.split('/').filter(Boolean);
    if (!parts.length) return null;

    const candidate = normalizeUsername(parts[0]);
    if (!candidate || !USERNAME_REGEX.test(candidate)) return null;
    if (RESERVED_PATHS.has(candidate)) return null;

    return candidate;
  }

  /**
   * Find the profile link and username in a user cell
   * @param {Element} cell - User cell
   * @returns {Object|null} Profile link and username
   */
  function findProfileLink(cell) {
    const links = Array.from(cell.querySelectorAll('a[href]'));
    for (const link of links) {
      const username = extractUsernameFromHref(link.getAttribute('href'));
      if (username) {
        return { link, username };
      }
    }
    return null;
  }

  /**
   * Extract display name from user cell
   * @param {Element} cell - User cell
   * @param {string} username - Username fallback
   * @returns {string} Display name
   */
  function extractDisplayName(cell, username) {
    const nameContainer = cell.querySelector('[data-testid="User-Name"]');
    if (nameContainer) {
      const spans = Array.from(nameContainer.querySelectorAll('span'));
      for (const span of spans) {
        const text = (span.textContent || '').trim();
        if (!text) continue;
        if (text.startsWith('@')) continue;
        if (text.toLowerCase() === 'follows you') continue;
        return text;
      }
    }

    const spans = Array.from(cell.querySelectorAll('span'));
    for (const span of spans) {
      const text = (span.textContent || '').trim();
      if (!text || text.startsWith('@')) continue;
      if (text.length > 100) continue;
      if (text.toLowerCase().includes('follow')) continue;
      if (text.includes('·')) continue;

      const parent = span.parentElement;
      if (parent) {
        const style = window.getComputedStyle(parent);
        const weight = style.fontWeight;
        const numericWeight = parseInt(weight, 10);

        if (weight === '700' || weight === 'bold' || numericWeight >= 600) {
          return text;
        }
      }
    }

    return username;
  }

  /**
   * Extract bio from user cell
   * @param {Element} cell - User cell
   * @returns {string} Bio text
   */
  function extractBio(cell) {
    const desc = cell.querySelector('[data-testid="UserDescription"]');
    if (!desc) return '';
    const text = (desc.textContent || '').trim();
    return text ? text.substring(0, 160) : '';
  }

  /**
   * Extract avatar URL from user cell
   * @param {Element} cell - User cell
   * @returns {string} Avatar URL
   */
  function extractAvatar(cell) {
    const img = cell.querySelector(
      'img[src*="profile_images"], img[src*="twimg.com/profile_images"], img[src*="pbs.twimg.com/profile_images"], img[src*="profile"]'
    );
    return img ? img.src : '';
  }

  /**
   * Extract verified status from user cell
   * @param {Element} cell - User cell
   * @returns {boolean} Verified status
   */
  function extractVerified(cell) {
    return Boolean(
      cell.querySelector('[data-testid="icon-verified"]') ||
      cell.querySelector('[aria-label*="Verified"]') ||
      cell.querySelector('svg[aria-label*="Verified"]')
    );
  }

  /**
   * Parse a follower/following count from text
   * @param {string} text - Raw text
   * @returns {number|null} Parsed count
   */
  function parseCount(text) {
    if (!text) return null;
    const normalized = text.replace(/,/g, '').trim();
    const match = normalized.match(/(\d+(?:\.\d+)?)(\s*[KMB])?/i);
    if (!match) return null;

    let value = parseFloat(match[1]);
    const suffix = (match[2] || '').trim().toUpperCase();

    if (suffix === 'K') value *= 1000;
    if (suffix === 'M') value *= 1000000;
    if (suffix === 'B') value *= 1000000000;

    if (!Number.isFinite(value)) return null;
    return Math.round(value);
  }

  /**
   * Read expected followers/following count from page header
   * @param {string} scanType - followers or following
   * @param {string} username - Username being scanned
   * @returns {number|null} Expected count
   */
  function getExpectedCountFromPage(scanType, username) {
    const normalizedUsername = normalizeUsername(username);
    const candidates = [];

    const links = Array.from(document.querySelectorAll('a[href]'));
    links.forEach(link => {
      const href = (link.getAttribute('href') || '').toLowerCase();
      if (!href.includes(`/${normalizedUsername}/`)) return;
      if (!href.includes(`/${scanType}`)) return;

      const text = (link.innerText || link.textContent || '').trim();
      const countFromText = parseCount(text);
      if (countFromText !== null) candidates.push(countFromText);

      const aria = link.getAttribute('aria-label');
      const countFromAria = parseCount(aria || '');
      if (countFromAria !== null) candidates.push(countFromAria);
    });

    if (!candidates.length) {
      const header = document.querySelector('header');
      if (header) {
        const text = header.innerText || '';
        const regex = scanType === 'followers'
          ? /(\d+(?:[.,]\d+)?\s*[KMB]?)\s*followers/i
          : /(\d+(?:[.,]\d+)?\s*[KMB]?)\s*following/i;
        const match = text.match(regex);
        if (match) {
          const count = parseCount(match[1]);
          if (count !== null) candidates.push(count);
        }
      }
    }

    if (!candidates.length) return null;
    return Math.max(...candidates.filter(n => Number.isFinite(n)));
  }

  async function getStoredScanContext(username, scanType) {
    const result = await getStorage([
      '_currentScanUsername',
      '_currentScanExpectedCount',
      '_currentScanExpectedSource',
      '_currentScanProfileCounts'
    ]);
    const storedUsername = normalizeUsername(result._currentScanUsername);
    const activeUsername = normalizeUsername(username);
    const expectedCount = Number.isFinite(result._currentScanExpectedCount)
      ? result._currentScanExpectedCount
      : null;
    const profileCounts = result._currentScanProfileCounts || null;

    if (storedUsername && storedUsername !== activeUsername) {
      return {
        expectedCount: null,
        expectedSource: null,
        profileCounts,
        hasProfileCounts: false
      };
    }

    const expectedFromProfile = scanType === 'following'
      ? profileCounts?.following
      : profileCounts?.followers;

    return {
      expectedCount: Number.isFinite(expectedCount)
        ? expectedCount
        : (Number.isFinite(expectedFromProfile) ? expectedFromProfile : null),
      expectedSource: result._currentScanExpectedSource || (Number.isFinite(expectedFromProfile) ? 'profile' : null),
      profileCounts,
      hasProfileCounts:
        Number.isFinite(profileCounts?.followers) && Number.isFinite(profileCounts?.following)
    };
  }

  /**
   * Get minimum coverage threshold based on expected count
   * @param {number} expectedCount - Expected count from page
   * @returns {number} Coverage threshold
   */
  function getCoverageThreshold(expectedCount) {
    if (expectedCount > 5000) return EXPECTED_COVERAGE_LARGE;
    if (expectedCount > 1000) return EXPECTED_COVERAGE_MEDIUM;
    return EXPECTED_COVERAGE_SMALL;
  }

  /**
   * Get stricter coverage threshold for follower accuracy
   * @param {number} expectedCount - Expected count from page
   * @returns {number} Strict coverage threshold
   */
  function getStrictCoverageThreshold(expectedCount) {
    if (expectedCount > 5000) return EXPECTED_COVERAGE_LARGE;
    if (expectedCount > 1000) return STRICT_COVERAGE_MEDIUM;
    return STRICT_COVERAGE_SMALL;
  }

  /**
   * Merge current scan users with previous data to preserve details
   * @param {Array<Object>} currentUsers - Current scan users
   * @param {Array<Object>} previousUsers - Previous scan users
   * @returns {Array<Object>} Merged user data
   */
  function mergeUsers(currentUsers, previousUsers) {
    const prevMap = new Map((previousUsers || []).map(u => [normalizeUsername(u.username), u]));
    const now = Date.now();

    return currentUsers.map(user => {
      const key = normalizeUsername(user.username);
      const prev = prevMap.get(key) || {};
      const name = user.name || prev.name || key;
      const bio = user.bio || prev.bio || '';
      const avatar = user.avatar || prev.avatar || '';
      const verified = typeof user.verified === 'boolean' ? user.verified : !!prev.verified;
      const profileUrl = user.profileUrl || prev.profileUrl || `https://x.com/${key}`;

      return {
        ...prev,
        ...user,
        username: key,
        name: name,
        bio: bio,
        avatar: avatar,
        verified: verified,
        profileUrl: profileUrl,
        firstSeenAt: prev.firstSeenAt || user.timestamp || now,
        lastSeenAt: now
      };
    });
  }

  function ensureRelationshipModel(userData, now = Date.now()) {
    userData.relationshipModelVersion = RELATIONSHIP_MODEL_VERSION;
    userData.relationshipsByHandle = userData.relationshipsByHandle || {};
    userData.snapshots = Array.isArray(userData.snapshots) ? userData.snapshots : [];
    userData.refollowers = Array.isArray(userData.refollowers) ? userData.refollowers : [];

    seedRelationshipEvents(userData, userData.unfollowers || [], 'unfollowed', 'unfollowedAt', now);
    seedRelationshipEvents(
      userData,
      (userData.newFollowers || []).filter(user => !user.refollowed),
      'followed',
      'timestamp',
      now
    );
    seedRelationshipEvents(userData, userData.refollowers || [], 'refollowed', 'timestamp', now);

    Object.values(userData.relationshipsByHandle).forEach(record => {
      if (!Array.isArray(record.events)) {
        record.events = [];
      }
      record.events = record.events
        .filter(event => event && event.type && Number.isFinite(event.at))
        .sort((a, b) => a.at - b.at)
        .slice(-MAX_RELATIONSHIP_EVENTS_PER_HANDLE);
    });
  }

  function seedRelationshipEvents(userData, users, eventType, timestampKey, fallbackTimestamp) {
    users.forEach(user => {
      const at = Number(user?.[timestampKey]);
      if (!Number.isFinite(at)) {
        return;
      }
      const record = upsertRelationshipRecord(userData, user, fallbackTimestamp);
      if (!record) {
        return;
      }

      if (!record.events.some(event => event.type === eventType && event.at === at)) {
        record.events.push({
          type: eventType,
          at,
          scanId: user.scanId || 'legacy',
          source: 'legacy'
        });
      }
    });
  }

  function getRelationshipRecord(userData, username) {
    const key = normalizeUsername(username);
    if (!key || !userData.relationshipsByHandle) {
      return null;
    }
    return userData.relationshipsByHandle[key] || null;
  }

  function upsertRelationshipRecord(userData, user, now = Date.now()) {
    const key = normalizeUsername(user?.username);
    if (!key) {
      return null;
    }

    userData.relationshipsByHandle = userData.relationshipsByHandle || {};
    const previous = userData.relationshipsByHandle[key] || {};
    const record = {
      username: key,
      name: user?.name || previous.name || key,
      bio: user?.bio || previous.bio || '',
      avatar: user?.avatar || previous.avatar || '',
      verified: typeof user?.verified === 'boolean' ? user.verified : !!previous.verified,
      profileUrl: user?.profileUrl || previous.profileUrl || `https://x.com/${key}`,
      firstSeenAt: previous.firstSeenAt || user?.firstSeenAt || user?.timestamp || now,
      lastSeenAt: now,
      current: {
        followsYou: !!previous.current?.followsYou,
        youFollow: !!previous.current?.youFollow
      },
      events: Array.isArray(previous.events) ? previous.events : []
    };

    userData.relationshipsByHandle[key] = record;
    return record;
  }

  function addRelationshipEvent(record, event) {
    if (!record || !event?.type || !Number.isFinite(event.at)) {
      return;
    }

    const duplicate = record.events.some(existing =>
      existing.type === event.type &&
      existing.scanId === event.scanId &&
      Math.abs(existing.at - event.at) < 1000
    );

    if (!duplicate) {
      record.events.push(event);
      record.events = record.events
        .sort((a, b) => a.at - b.at)
        .slice(-MAX_RELATIONSHIP_EVENTS_PER_HANDLE);
    }
  }

  function hasFollowerLoss(record) {
    return !!record?.events?.some(event =>
      event.type === 'unfollowed' || event.type === 'reunfollowed'
    );
  }

  function applyRelationshipDiff(userData, scanType, currentUsers, previousUsers, now, scanId, source, hasBaseline) {
    const currentMap = createUserMap(currentUsers);
    const previousMap = createUserMap(previousUsers);
    const result = {
      gained: [],
      lost: [],
      refollowed: [],
      relost: [],
      followingAdded: [],
      followingRemoved: []
    };

    currentMap.forEach((user, key) => {
      const existing = getRelationshipRecord(userData, key);
      if (existing) {
        const record = upsertRelationshipRecord(userData, user, now);
        if (scanType === 'followers') {
          record.current.followsYou = true;
        } else {
          record.current.youFollow = true;
        }
      }
    });

    previousMap.forEach((user, key) => {
      const existing = getRelationshipRecord(userData, key);
      if (existing && currentMap.has(key)) {
        const record = upsertRelationshipRecord(userData, currentMap.get(key) || user, now);
        if (scanType === 'followers') {
          record.current.followsYou = true;
        } else {
          record.current.youFollow = true;
        }
      }
    });

    if (!hasBaseline) {
      return result;
    }

    currentMap.forEach((user, key) => {
      if (previousMap.has(key)) {
        return;
      }

      const record = upsertRelationshipRecord(userData, user, now);
      if (scanType === 'followers') {
        const eventType = hasFollowerLoss(record) ? 'refollowed' : 'followed';
        record.current.followsYou = true;
        addRelationshipEvent(record, {
          type: eventType,
          at: now,
          scanId,
          scanType,
          source
        });
        result.gained.push(key);
        if (eventType === 'refollowed') {
          result.refollowed.push(key);
        }
      } else {
        record.current.youFollow = true;
        addRelationshipEvent(record, {
          type: 'you_followed',
          at: now,
          scanId,
          scanType,
          source
        });
        result.followingAdded.push(key);
      }
    });

    previousMap.forEach((user, key) => {
      if (currentMap.has(key)) {
        return;
      }

      const record = upsertRelationshipRecord(userData, user, now);
      if (scanType === 'followers') {
        const eventType = hasFollowerLoss(record) ? 'reunfollowed' : 'unfollowed';
        record.current.followsYou = false;
        addRelationshipEvent(record, {
          type: eventType,
          at: now,
          scanId,
          scanType,
          source
        });
        result.lost.push(key);
        if (eventType === 'reunfollowed') {
          result.relost.push(key);
        }
      } else {
        record.current.youFollow = false;
        addRelationshipEvent(record, {
          type: 'you_unfollowed',
          at: now,
          scanId,
          scanType,
          source
        });
        result.followingRemoved.push(key);
      }
    });

    return result;
  }

  function createUserMap(users) {
    const map = new Map();
    (users || []).forEach(user => {
      const key = normalizeUsername(user?.username);
      if (key) {
        map.set(key, user);
      }
    });
    return map;
  }

  function appendSnapshot(userData, snapshot) {
    userData.snapshots = Array.isArray(userData.snapshots) ? userData.snapshots : [];
    userData.snapshots.push(snapshot);
    if (userData.snapshots.length > MAX_SNAPSHOTS) {
      userData.snapshots = userData.snapshots.slice(-MAX_SNAPSHOTS);
    }
  }

  function makeScanId(scanType, timestamp) {
    return `${scanType}-${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Wait for new user cells to load after a scroll
   * @param {Element} container - Container being observed
   * @param {number} previousCount - Previous cell count
   * @param {number} delayMs - Scroll delay
   * @returns {Promise<boolean>} Whether new cells appeared
   */
  async function waitForNewCells(container, previousCount, delayMs) {
    const root = container || document.body;
    const timeoutMs = Math.max(LONG_SCROLL_DELAY_MS, delayMs + 300);

    return new Promise(resolve => {
      let resolved = false;

      const finish = (found) => {
        if (resolved) return;
        resolved = true;
        observer.disconnect();
        clearInterval(poller);
        clearTimeout(timeoutId);
        resolve(found);
      };

      const check = () => {
        const current = getUserCells(root).length;
        if (current > previousCount) {
          finish(true);
        }
      };

      const observer = new MutationObserver(check);
      observer.observe(root, { childList: true, subtree: true });

      const poller = setInterval(check, 250);
      const timeoutId = setTimeout(() => finish(false), timeoutMs);
    });
  }

  /**
   * Collect all users by scrolling through the list
   * @param {number|null} expectedCount - Expected count from profile page
   * @param {string|null} expectedSource - Source for expected count
   * @returns {Promise<Array<Object>>} Array of user objects
   */
  async function collectAllUsers(expectedCount, expectedSource) {
    const foundUsers = new Map();
    let stabilityCounter = 0;
    let scrollCount = 0;
    let scrollDelay = BASE_SCROLL_DELAY_MS;
    let hardStallCycles = 0;

    const { primary, timeline } = getListContainer();
    const container = timeline || primary || document;

    if (expectedCount === 0) {
      updateIndicator('No users to scan');
      safeSendMessage({
        action: 'scanProgress',
        phase: 'scanning',
        progress: 100,
        count: 0,
        expected: 0,
        expectedSource: expectedSource || null
      });
      return [];
    }

    updateIndicator('Starting scan...');

    const collectFromCells = () => {
      const cells = getUserCells(container);
      let newUsers = 0;

      cells.forEach(cell => {
        const user = extractUserFromCell(cell);
        if (user && user.username && !foundUsers.has(user.username)) {
          foundUsers.set(user.username, user);
          newUsers++;
        }
      });

      return newUsers;
    };

    collectFromCells();

    while (stabilityCounter < STABILITY_THRESHOLD && scrollCount < MAX_SCROLLS) {
      // Check if user stopped scan
      if (window.xScannerShouldStop) {
        updateIndicator('Stopping...');
        break;
      }

      scrollCount++;

      const beforeCellCount = getUserCells(container).length;
      const beforeFoundCount = foundUsers.size;

      // Scroll the page
      await scrollPage(scrollCount, scrollDelay);

      const hadNewCells = await waitForNewCells(container, beforeCellCount, scrollDelay);
      const newUsersThisCycle = collectFromCells();
      const currentCount = foundUsers.size;
      
      // Use the profile count for scan progress when available; fall back only if unknown.
      const expectedProgress = expectedCount
        ? Math.min(95, Math.round((currentCount / expectedCount) * 100))
        : 0;
      const scrollProgress = Math.min(95, Math.round((scrollCount / MAX_SCROLLS) * 100));
      const stabilityProgress = Math.min(95, Math.round((stabilityCounter / STABILITY_THRESHOLD) * 95));
      const progress = expectedCount
        ? expectedProgress
        : Math.max(scrollProgress, stabilityProgress);
      
      // Update UI
      const countLabel = expectedCount ? `${currentCount}/${expectedCount}` : `${currentCount}`;
      updateIndicator(`Found ${countLabel} users... (${progress}%)`);
      
      // Send progress to extension
      safeSendMessage({
        action: 'scanProgress',
        phase: 'scanning',
        progress: progress,
        count: currentCount,
        expected: Number.isFinite(expectedCount) ? expectedCount : null,
        expectedSource: expectedSource || null
      });

      // Check if we found new users
      if (newUsersThisCycle === 0 && !hadNewCells && currentCount === beforeFoundCount) {
        stabilityCounter++;
        hardStallCycles++;
        scrollDelay = Math.min(MAX_SCROLL_DELAY_MS, Math.round(scrollDelay * 1.25));
      } else {
        stabilityCounter = 0;
        hardStallCycles = 0;
        scrollDelay = Math.max(BASE_SCROLL_DELAY_MS, Math.round(scrollDelay * 0.9));
      }

      if (expectedCount && currentCount >= expectedCount && stabilityCounter >= 2) {
        console.log('Reached expected count, finishing early');
        break;
      }

      // If the page is clearly exhausted (repeated no-growth cycles), finish early.
      if (hardStallCycles >= 4) {
        console.log('No new users for multiple cycles, finishing scan');
        break;
      }

      // Pause periodically to avoid rate limiting
      if (scrollCount % PAUSE_EVERY_N_SCROLLS === 0) {
        console.log(`Pausing briefly to avoid rate limiting (scroll ${scrollCount})`);
        await sleep(PAUSE_DURATION_MS);
      }
    }

    // Final collection update; validation and save still need to pass before completion.
    updateIndicator(`Validating scan results... Found ${foundUsers.size} users`);
    safeSendMessage({
      action: 'scanProgress',
      phase: 'validating',
      progress: 100,
      count: foundUsers.size,
      expected: Number.isFinite(expectedCount) ? expectedCount : null,
      expectedSource: expectedSource || null
    });

    console.log(`Scan completed: ${foundUsers.size} users found in ${scrollCount} scrolls`);
    
    return Array.from(foundUsers.values());
  }

 /**
  * Scroll the page to load more users
  * @param {number} scrollCount - Current scroll count
  * @param {number} delayMs - Delay between scrolls
  * @returns {Promise<void>}
  */
  async function scrollPage(scrollCount, delayMs) {
    // Scroll the main timeline container
    const scrollElement = getScrollElement();
    
    scrollElement.scrollTo({
      top: scrollElement.scrollHeight,
      behavior: 'smooth'
    });

    await sleep(delayMs);

    // Also scroll window to ensure all content loads
    window.scrollTo(0, document.documentElement.scrollHeight);

    await sleep(Math.max(LONG_SCROLL_DELAY_MS, Math.round(delayMs * 1.2)));
  }

  /**
   * Extract user data from a UserCell element
   * @param {Element} cell - UserCell DOM element
   * @returns {Object|null} User object or null if extraction failed
   */
  function extractUserFromCell(cell) {
    try {
      const profile = findProfileLink(cell);
      if (!profile) {
        return null;
      }

      const username = profile.username;
      const profileUrl = profile.link?.href
        ? profile.link.href
        : `https://x.com/${username}`;

      const displayName = extractDisplayName(cell, username);
      const bio = extractBio(cell);
      const avatar = extractAvatar(cell);
      const verified = extractVerified(cell);

      return {
        username: username,
        name: displayName,
        bio: bio,
        avatar: avatar,
        verified: verified,
        profileUrl: profileUrl,
        timestamp: Date.now()
      };

    } catch (error) {
      console.warn('Error extracting user from cell:', error);
      return null;
    }
  }

  /**
   * Validate scan results
 * @param {Array<Object>} currentUsers - Users found in current scan
 * @param {string} username - Username being scanned
 * @param {string} scanType - Type of scan
 * @param {number|null} expectedCount - Expected count from page
 * @returns {Promise<Object>} Validation result object
   */
  async function validateScan(currentUsers, username, scanType, expectedCount) {
    return new Promise((resolve) => {
      chrome.storage.local.get(['users', '_scanStartTime'], (result) => {
        const users = result.users || {};
        const normalizedKey = normalizeUsername(username);
        const existingKey = Object.keys(users).find(key => normalizeUsername(key) === normalizedKey);
        const userData = users[existingKey] || {};
        const previousUsers = scanType === 'following' 
          ? (userData.following || []) 
          : (userData.followers || []);
        
        const scanDuration = Date.now() - (result._scanStartTime || Date.now());

        const minUsers = expectedCount !== null && expectedCount !== undefined
          ? Math.min(MIN_USERS_FOUND, expectedCount)
          : MIN_USERS_FOUND;

        // Check 1: Minimum users found (adjusted for expected count)
        if (currentUsers.length < minUsers) {
          resolve({
            isValid: false,
            reason: `Too few users found (${currentUsers.length}). Expected at least ${minUsers}.`
          });
          return;
        }

        // Check 2: Suspiciously low count compared to previous scan (only when expected count is unknown)
        if (!expectedCount && previousUsers.length > 100 && currentUsers.length < previousUsers.length * 0.3) {
          resolve({
            isValid: false,
            reason: `Suspiciously low count (${currentUsers.length} vs ${previousUsers.length} previously). Page may not have loaded properly.`
          });
          return;
        }

        // Check 3: Coverage vs expected count
        if (expectedCount && expectedCount >= MIN_USERS_FOUND) {
          const minCoverage = getCoverageThreshold(expectedCount);
          const coverage = currentUsers.length / expectedCount;
          if (coverage < minCoverage) {
            resolve({
              isValid: false,
              reason: `Incomplete coverage (${Math.round(coverage * 100)}% of expected ${expectedCount}). Page may not have loaded fully.`
            });
            return;
          }

          // Check 3b: Stricter follower accuracy check for small/medium accounts.
          // Prevents saving noticeably under-counted follower scans (premature stops).
          if (scanType === 'followers' && expectedCount <= 5000) {
            const strictMinCoverage = getStrictCoverageThreshold(expectedCount);
            const maxAllowedGap = Math.max(8, Math.ceil(expectedCount * 0.03));
            const actualGap = Math.max(0, expectedCount - currentUsers.length);

            if (coverage < strictMinCoverage || actualGap > maxAllowedGap) {
              resolve({
                isValid: false,
                reason: `Follower scan appears incomplete (${currentUsers.length}/${expectedCount}). Please retry to improve accuracy.`
              });
              return;
            }
          }
        }

        // Check 4: Minimum scan duration (skip for zero-count scans)
        if (expectedCount !== 0 && scanDuration < MIN_SCAN_DURATION_MS) {
          resolve({
            isValid: false,
            reason: `Scan too fast (${Math.round(scanDuration / 1000)}s). Page may not have loaded properly.`
          });
          return;
        }

        // All checks passed
        resolve({ isValid: true });
      });
    });
  }

  /**
   * Save collected data to storage
 * @param {Array<Object>} currentUsers - Users collected in current scan
 * @param {string} username - Username being scanned
 * @param {string} scanType - Type of scan
 * @param {number|null} expectedCount - Expected count from profile page
 * @param {Object} metadata - Scan metadata
 * @returns {Promise<void>}
   */
  async function saveData(currentUsers, username, scanType, expectedCount, metadata = {}) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(['users', '_currentScanSource'], (result) => {
        const users = result.users || {};
        const scanSource = result._currentScanSource || 'manual';
        const normalizedKey = normalizeUsername(username);
        const existingKey = Object.keys(users).find(key => normalizeUsername(key) === normalizedKey);
        const storageKey = existingKey || username;
        
        // Get or initialize user data
        const userData = users[storageKey] || {
          followers: [],
          following: [],
          unfollowers: [],
          newFollowers: [],
          refollowers: [],
          fansList: [],
          notFollowingBack: [],
          scanCount: 0,
          lastFollowersCheck: null,
          lastFollowingCheck: null,
          scanHistory: [],
          snapshots: [],
          relationshipsByHandle: {},
          relationshipModelVersion: RELATIONSHIP_MODEL_VERSION
        };

        const now = Date.now();
        const scanId = makeScanId(scanType, now);
        const coverage = expectedCount
          ? Number((currentUsers.length / expectedCount).toFixed(3))
          : (expectedCount === 0 && currentUsers.length === 0 ? 1 : null);
        const countMatchesExpected = Number.isFinite(expectedCount)
          ? currentUsers.length === expectedCount
          : null;
        const scanStatus = countMatchesExpected ? 'verified_complete' : 'complete';
        const profileCounts = metadata.profileCounts || null;
        const expectedSource = metadata.expectedSource || null;
        const listPageExpected = Number.isFinite(metadata.listPageExpected)
          ? metadata.listPageExpected
          : null;
        let relationshipDelta = {
          gained: [],
          lost: [],
          refollowed: [],
          relost: [],
          followingAdded: [],
          followingRemoved: []
        };

        ensureRelationshipModel(userData, now);

        if (scanType === 'following') {
          // Update following data
          const previousFollowing = userData.following || [];
          const hadPreviousFollowingScan = previousFollowing.length > 0 && userData.lastFollowingCheck;
          const mergedFollowing = mergeUsers(currentUsers, previousFollowing);
          relationshipDelta = applyRelationshipDiff(
            userData,
            scanType,
            currentUsers,
            previousFollowing,
            now,
            scanId,
            scanSource,
            hadPreviousFollowingScan
          );

          userData.following = mergedFollowing;
          userData.lastFollowingCheck = now;
          userData.lastFollowingCount = mergedFollowing.length;
          userData.lastFollowingExpected = Number.isFinite(expectedCount) ? expectedCount : null;
          userData.lastFollowingCoverage = Number.isFinite(coverage) ? coverage : null;
          userData.lastFollowingExpectedSource = expectedSource;
          userData.lastFollowingProfileCounts = profileCounts;

          // Mark which following users follow back
          const followerSet = new Set((userData.followers || []).map(f => normalizeUsername(f.username)));
          userData.following.forEach(user => {
            user.followsBack = followerSet.has(normalizeUsername(user.username));
          });

          // Calculate "not following back" list
          userData.notFollowingBack = mergedFollowing
            .filter(f => !f.followsBack)
            .sort((a, b) => a.name.localeCompare(b.name));

        } else {
          // Update followers data
          const previousFollowers = userData.followers || [];
          const hadPreviousScan = previousFollowers.length > 0 && userData.lastFollowersCheck;
          const mergedFollowers = mergeUsers(currentUsers, previousFollowers);
          relationshipDelta = applyRelationshipDiff(
            userData,
            scanType,
            currentUsers,
            previousFollowers,
            now,
            scanId,
            scanSource,
            hadPreviousScan
          );

          userData.followers = mergedFollowers;
          userData.lastFollowersCheck = now;
          userData.lastFollowersCount = mergedFollowers.length;
          userData.lastFollowersExpected = Number.isFinite(expectedCount) ? expectedCount : null;
          userData.lastFollowersCoverage = Number.isFinite(coverage) ? coverage : null;
          userData.lastFollowersExpectedSource = expectedSource;
          userData.lastFollowersProfileCounts = profileCounts;

          // Detect unfollowers and new followers
          if (hadPreviousScan) {
            const currentSet = new Set(mergedFollowers.map(f => normalizeUsername(f.username)));
            const previousSet = new Set(previousFollowers.map(f => normalizeUsername(f.username)));

            // Unfollowers: users who were in previous but not in current
            const unfollowers = previousFollowers.filter(
              f => !currentSet.has(normalizeUsername(f.username)) && f.username
            );

            // New followers: users who are in current but not in previous
            const newFollowers = mergedFollowers.filter(
              f => !previousSet.has(normalizeUsername(f.username)) && f.username
            );

            // Merge with existing unfollowers/new followers (preserve timestamps)
            const existingUnfollowersMap = new Map(
              (userData.unfollowers || []).map(x => [normalizeUsername(x.username), x])
            );
            const existingNewFollowersMap = new Map(
              (userData.newFollowers || []).map(x => [normalizeUsername(x.username), x])
            );
            const existingRefollowersMap = new Map(
              (userData.refollowers || []).map(x => [normalizeUsername(x.username), x])
            );

            // Add new unfollowers with timestamp
            unfollowers.forEach(f => {
              const key = normalizeUsername(f.username);
              if (!existingUnfollowersMap.has(key)) {
                existingUnfollowersMap.set(key, {
                  ...f,
                  unfollowedAt: now,
                  scanId,
                  repeatUnfollow: relationshipDelta.relost.includes(key)
                });
              }
            });

            // Add new followers with timestamp
            newFollowers.forEach(f => {
              const key = normalizeUsername(f.username);
              const isRefollower = existingUnfollowersMap.has(key) || relationshipDelta.refollowed.includes(key);
              if (!existingNewFollowersMap.has(key) || isRefollower) {
                const previousNewFollower = existingNewFollowersMap.get(key) || {};
                existingNewFollowersMap.set(key, {
                  ...previousNewFollower,
                  ...f,
                  timestamp: now,
                  scanId,
                  refollowed: isRefollower
                });
              }
              if (isRefollower) {
                const previousRefollower = existingRefollowersMap.get(key) || {};
                existingRefollowersMap.set(key, {
                  ...previousRefollower,
                  ...f,
                  timestamp: now,
                  refollowedAt: now,
                  scanId
                });
              }
            });

            // Remove refollowers from unfollowers list
            const refollowerSet = new Set(newFollowers.map(f => normalizeUsername(f.username)));
            userData.unfollowers = Array.from(existingUnfollowersMap.values())
              .filter(x => x.username && !refollowerSet.has(normalizeUsername(x.username)))
              .sort((a, b) => (b.unfollowedAt || 0) - (a.unfollowedAt || 0))
              .slice(0, 500); // Keep last 500

            userData.newFollowers = Array.from(existingNewFollowersMap.values())
              .filter(x => x.username)
              .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
              .slice(0, 500); // Keep last 500

            userData.refollowers = Array.from(existingRefollowersMap.values())
              .filter(x => x.username)
              .sort((a, b) => (b.refollowedAt || b.timestamp || 0) - (a.refollowedAt || a.timestamp || 0))
              .slice(0, 500); // Keep last 500
          }

          // Mark which followers follow back
          const followingSet = new Set((userData.following || []).map(f => normalizeUsername(f.username)));
          userData.followers.forEach(user => {
            user.followsBack = followingSet.has(normalizeUsername(user.username));
          });

          // Calculate fans list (followers you don't follow back)
          userData.fansList = userData.followers
            .filter(f => !followingSet.has(normalizeUsername(f.username)))
            .sort((a, b) => a.name.localeCompare(b.name));
        }

        // Update scan metadata
        userData.scanCount = (userData.scanCount || 0) + 1;
        userData.lastSuccessfulScan = now;

        // Add to scan history
        userData.scanHistory = userData.scanHistory || [];
        const scanEvent = {
          scanId,
          type: scanType,
          source: scanSource,
          count: currentUsers.length,
          expected: Number.isFinite(expectedCount) ? expectedCount : null,
          coverage: Number.isFinite(coverage) ? coverage : null,
          timestamp: now,
          verified: currentUsers.filter(f => f.verified).length,
          profileCounts,
          expectedSource,
          listPageExpected,
          countMatchesExpected,
          status: scanStatus,
          delta: relationshipDelta
        };
        userData.scanHistory.push(scanEvent);

        // Keep enough history for meaningful trend analysis without unbounded growth.
        if (userData.scanHistory.length > MAX_SCAN_HISTORY) {
          userData.scanHistory = userData.scanHistory.slice(-MAX_SCAN_HISTORY);
        }

        appendSnapshot(userData, {
          ...scanEvent,
          followersCount: userData.followers?.length || 0,
          followingCount: userData.following?.length || 0,
          unfollowersCount: userData.unfollowers?.length || 0,
          newFollowersCount: userData.newFollowers?.length || 0,
          refollowersCount: userData.refollowers?.length || 0,
          fansCount: userData.fansList?.length || 0,
          notFollowingBackCount: userData.notFollowingBack?.length || 0
        });

        // Save to storage
        users[storageKey] = userData;
        chrome.storage.local.set(
          {
            users: users,
            currentUser: storageKey,
            scanStatus: 'complete'
          },
          () => {
            if (chrome.runtime.lastError) {
              reject(chrome.runtime.lastError);
            } else {
              console.log('Data saved successfully');
              resolve();
            }
          }
        );
      });
    });
  }

  /**
   * Show scanning indicator overlay
   */
  function showIndicator() {
    removeIndicator(); // Remove any existing indicator

    const indicator = document.createElement('div');
    indicator.id = 'xUnfollowTrackerIndicator';
    indicator.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      color: white;
      padding: 16px 24px;
      border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
      z-index: 999999;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 14px;
      font-weight: 500;
      border: 2px solid rgba(59, 130, 246, 0.5);
      min-width: 280px;
      backdrop-filter: blur(10px);
    `;

    indicator.innerHTML = `
      <div style="display: flex; align-items: center; gap: 12px">
        <div style="width: 12px; height: 12px; background: #3b82f6; border-radius: 50%; animation: pulse 2s infinite"></div>
        <div style="flex: 1">
          <div style="font-weight: 600; margin-bottom: 4px">X Unfollow Tracker</div>
          <div id="xUnfollowTrackerStatus" style="font-size: 12px; color: rgba(255, 255, 255, 0.7)">Starting...</div>
        </div>
        <button id="xStopScanBtn" style="background: rgba(239, 68, 68, 0.2); border: 1px solid rgba(239, 68, 68, 0.5); color: #ef4444; padding: 6px 12px; border-radius: 6px; font-size: 11px; font-weight: 600; cursor: pointer; transition: all 0.2s">Stop</button>
      </div>
      <style>
        @keyframes pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.4; transform: scale(1.1); }
        }
        #xStopScanBtn:hover {
          background: rgba(239, 68, 68, 0.4);
          border-color: #ef4444;
        }
      </style>
    `;

    document.body.appendChild(indicator);

    // Add stop button listener
    const stopButton = document.getElementById('xStopScanBtn');
    if (stopButton) {
      stopButton.addEventListener('click', () => {
        window.xScannerShouldStop = true;
        window.xScannerStopReason = 'manual';
        stopButton.disabled = true;
        stopButton.textContent = 'Stopping...';
        updateIndicator('Stopping scan...');
      });
    }
  }

  /**
   * Update indicator status text
   * @param {string} text - Status text to display
   */
  function updateIndicator(text) {
    const statusElement = document.getElementById('xUnfollowTrackerStatus');
    if (statusElement) {
      statusElement.textContent = text;
    }
  }

  /**
   * Show success state on indicator
   * @param {number} count - Number of users found
   */
  function showSuccess(count) {
    updateIndicator(`✓ Complete! Found ${count} users`);
    
    const indicator = document.getElementById('xUnfollowTrackerIndicator');
    if (indicator) {
      indicator.style.borderColor = 'rgba(16, 185, 129, 0.5)';
      indicator.style.background = 'linear-gradient(135deg, #064e3b 0%, #065f46 100%)';
      
      const stopButton = document.getElementById('xStopScanBtn');
      if (stopButton) {
        stopButton.style.display = 'none';
      }
    }
  }

  /**
   * Show error state on indicator
   * @param {string} errorMessage - Error message to display
   */
  function showError(errorMessage) {
    const indicator = document.getElementById('xUnfollowTrackerIndicator');
    if (indicator) {
      indicator.style.borderColor = 'rgba(239, 68, 68, 0.5)';
      indicator.style.background = 'linear-gradient(135deg, #7f1d1d 0%, #991b1b 100%)';
      indicator.innerHTML = `
        <div style="display: flex; align-items: center; gap: 12px">
          <div style="width: 12px; height: 12px; background: #ef4444; border-radius: 50%"></div>
          <div>
            <div style="font-weight: 600; margin-bottom: 4px">Scan Failed</div>
            <div style="font-size: 12px; color: rgba(255, 255, 255, 0.7); line-height: 1.4">${errorMessage}</div>
          </div>
        </div>
      `;
    }
  }

  /**
   * Remove indicator from page
   */
  function removeIndicator() {
    const indicator = document.getElementById('xUnfollowTrackerIndicator');
    if (indicator) {
      indicator.style.transition = 'opacity 0.3s, transform 0.3s';
      indicator.style.opacity = '0';
      indicator.style.transform = 'translateX(20px)';
      setTimeout(() => indicator.remove(), 300);
    }
  }

  // ================== Main Execution ==================

  // Set up timeout to stop scan if it runs too long
  const scanTimeout = setTimeout(() => {
    if (!window.xScannerShouldStop) {
      window.xScannerShouldStop = true;
      window.xScannerStopReason = 'timeout';
      console.log('Scan timeout reached - stopping');
    }
  }, MAX_SCAN_TIME_MS);

  let username = null;
  let scanType = null;
  let expectedCount = null;
  let expectedSource = null;
  let profileCounts = null;
  let listPageExpectedCount = null;
  let users = [];

  try {
    // Show scanning indicator to user
    showIndicator();

    // Extract username from URL
    const urlMatch = window.location.pathname.match(/^\/([^/]+)\/(?:verified_)?(?:followers|following)/);
    if (!urlMatch) {
      throw new Error('Not on followers/following page. Please navigate to the correct page.');
    }

    username = normalizeUsername(urlMatch[1]);
    scanType = window.location.pathname.includes('following') ? 'following' : 'followers';
    
    console.log(`Starting ${scanType} scan for @${username}`);

    const scanContext = await getStoredScanContext(username, scanType);
    expectedCount = scanContext.expectedCount;
    expectedSource = scanContext.expectedSource;
    profileCounts = scanContext.profileCounts;

    if (!scanContext.hasProfileCounts || !Number.isFinite(expectedCount) || expectedSource !== 'profile') {
      throw new Error('Profile counts were not available for this scan. Please restart the scan.');
    }

    await safeSendMessage({
      action: 'scanProgress',
      phase: 'loading',
      progress: 5,
      count: 0,
      expected: expectedCount,
      expectedSource
    });

    // Wait for page to be ready
    await waitForPageReady(scanType);

    // Read the list-page count only as a diagnostic; profile count is canonical.
    listPageExpectedCount = getExpectedCountFromPage(scanType, username);
    if (listPageExpectedCount !== null) {
      console.log(`List page ${scanType} count: ${listPageExpectedCount}`);
    }
    console.log(`Profile ${scanType} count: ${expectedCount}`);

    // Collect all users by scrolling
    users = await collectAllUsers(expectedCount, expectedSource);

    // Check if scan was manually stopped
    if (window.xScannerShouldStop) {
      const reason = window.xScannerStopReason || 'manual';
      throw new Error(reason === 'timeout'
        ? 'Scan timed out. Please retry and keep the followers tab active.'
        : 'Scan stopped by user');
    }

    // Validate results
    if (!users.length && expectedCount !== 0) {
      throw new Error('No users found. The page may not have loaded properly.');
    }

    // Validate scan quality
    const validationResult = await validateScan(users, username, scanType, expectedCount);
    if (!validationResult.isValid) {
      throw new Error(`Incomplete scan: ${validationResult.reason}. Please retry.`);
    }

    // Save data to storage
    await saveData(users, username, scanType, expectedCount, {
      profileCounts,
      expectedSource,
      listPageExpected: listPageExpectedCount
    });

    // Show success message
    showSuccess(users.length);

    // Notify background script
    await safeSendMessage({
      action: 'scanComplete',
      username: username,
      scanType: scanType,
      stats: {
        total: users.length,
        expected: Number.isFinite(expectedCount) ? expectedCount : null,
        expectedSource,
        profileCounts,
        listPageExpected: Number.isFinite(listPageExpectedCount) ? listPageExpectedCount : null,
        countMatchesExpected: Number.isFinite(expectedCount) ? users.length === expectedCount : null
      }
    });

    // Auto-close indicator after a delay
    setTimeout(() => {
      removeIndicator();
      window.xUnfollowTrackerRunning = false;
      window.xScannerShouldStop = false;
      window.xScannerStopReason = null;
    }, 2000);

  } catch (error) {
    if ((error?.message || '').toLowerCase().includes('stopped by user')) {
      console.warn('Scan stopped intentionally');
    } else {
      console.error('Scan error:', error);
    }
    showError(error.message);

    // Notify background script of error
    await safeSendMessage({
      action: 'scanError',
      error: error.message,
      username,
      scanType,
      stats: {
        total: Array.isArray(users) ? users.length : null,
        expected: Number.isFinite(expectedCount) ? expectedCount : null,
        expectedSource,
        profileCounts,
        listPageExpected: Number.isFinite(listPageExpectedCount) ? listPageExpectedCount : null,
        countMatchesExpected:
          Array.isArray(users) && Number.isFinite(expectedCount) ? users.length === expectedCount : null
      }
    });

    // Clean up after error
    setTimeout(() => {
      removeIndicator();
      window.xUnfollowTrackerRunning = false;
      window.xScannerShouldStop = false;
      window.xScannerStopReason = null;
    }, 3000);
  } finally {
    // Clear the timeout
    clearTimeout(scanTimeout);
  }
})();
