/**
 * X Tracker - ISOLATED-World Extraction & Passive Capture Engine
 * Combines passive MAIN-world GraphQL/REST payloads with a virtual-scroll-aware
 * semantic DOM fallback, human-like jittered pacing, rate-limit pause/recovery,
 * incremental checkpoints, and Shadow DOM HUD feedback.
 */
(function initXTrackerScraper() {
  if (window.__xTrackerScraperInstalled) {
    return;
  }
  window.__xTrackerScraperInstalled = true;

  const RESERVED_PATHS = new Set([
    'i', 'home', 'search', 'hashtag', 'explore', 'notifications', 'messages',
    'settings', 'compose', 'login', 'signup', 'logout', 'tos', 'privacy',
    'about', 'intent', 'share', 'account', 'topics', 'lists', 'bookmarks',
    'communities', 'grok', 'jobs', 'spaces', 'articles', 'premium', 'verified',
    'downloads', 'help', 'ads', 'analytics', 'directory'
  ]);

  const USERNAME_REGEX = /^[a-zA-Z0-9_]{1,15}$/;
  const CHECKPOINT_BATCH_SIZE = 50;
  const BASE_SCROLL_DELAY_MS = 650;
  const JITTER_MS = 450;
  const MAX_SCROLL_DELAY_MS = 2600;
  const PAUSE_EVERY_N_SCROLLS = 18;
  const PAUSE_DURATION_MS = 1800;
  const MAX_SCROLLS = 800;
  const MAX_SCAN_TIME_MS = 900_000; // 15 minutes max

  const state = {
    running: false,
    paused: false,
    shouldStop: false,
    stopMode: 'save', // 'save' | 'abort'
    activeScanId: null,
    activeAccountKey: null,
    passiveScopes: new Set(),
    gqlUsers: new Map(), // canonicalKey -> user
    gqlProfileCounts: null,
    gqlViewer: null,
    gqlBottomCursor: null,
    gqlPayloadsReceived: 0,
    rateLimitResetAtMs: 0,
    rateLimitRemaining: null,
    lastNetworkAt: 0,
    observedOps: new Map(),
    logBuffer: [],
    logFlushTimer: null
  };

  function summarizeOps() {
    const out = {};
    for (const [op, info] of state.observedOps.entries()) {
      out[op] = `${info.status}x${info.count}@${info.host}`;
    }
    return out;
  }

  function flushLogs() {
    if (state.logFlushTimer) {
      clearTimeout(state.logFlushTimer);
      state.logFlushTimer = null;
    }
    if (!state.logBuffer.length) return Promise.resolve();
    const entries = state.logBuffer.splice(0, state.logBuffer.length);
    return safeSendMessage({ action: 'appendAppLogs', entries });
  }

  function queueLog(level, event, message, meta = null, extra = {}) {
    state.logBuffer.push({
      at: Date.now(),
      level,
      source: extra.source || 'scraper',
      event,
      scanId: extra.scanId ?? state.activeScanId ?? null,
      accountKey: extra.accountKey ?? state.activeAccountKey ?? null,
      message,
      meta
    });
    if (state.logBuffer.length > 50) {
      state.logBuffer.shift();
    }
    if (level === 'error' || level === 'warn' || state.logBuffer.length >= 12) {
      void flushLogs();
    } else if (!state.logFlushTimer) {
      state.logFlushTimer = setTimeout(() => {
        state.logFlushTimer = null;
        void flushLogs();
      }, 1200);
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function jitteredDelay(baseMs, spreadMs = JITTER_MS) {
    return Math.round(baseMs + Math.random() * spreadMs);
  }

  function normalizeHandle(value) {
    return String(value || '').trim().replace(/^@+/, '').trim().toLowerCase();
  }

  function canonicalUserKey(user) {
    if (user?.restId) return String(user.restId).trim();
    const h = normalizeHandle(user?.username);
    return h ? `handle:${h}` : '';
  }

  function parseLocalizedCount(raw) {
    if (typeof raw === 'number') return Number.isFinite(raw) ? Math.round(raw) : null;
    if (!raw) return null;
    const text = String(raw).trim();
    const match = text.match(/(\d[\d\s.,\u00A0\u202F]*)\s*(mil|mio|тыс\.?|млн|mrd|K|M|B|T|万|萬|亿|億)?/i);
    if (!match) return null;

    const multipliers = {
      k: 1_000, mil: 1_000, тыс: 1_000,
      m: 1_000_000, mio: 1_000_000, млн: 1_000_000,
      b: 1_000_000_000, mrd: 1_000_000_000, t: 1_000_000_000_000,
      万: 10_000, 萬: 10_000, 亿: 100_000_000, 億: 100_000_000
    };

    let numToken = match[1].replace(/[\s\u00A0\u202F]/g, '');
    const suffix = (match[2] || '').replace(/\.$/, '').toLowerCase();
    const mult = suffix ? (multipliers[suffix] || 1) : 1;

    if (numToken.includes(',') && numToken.includes('.')) {
      numToken = numToken.lastIndexOf(',') > numToken.lastIndexOf('.')
        ? numToken.replaceAll('.', '').replace(',', '.')
        : numToken.replaceAll(',', '');
    } else if (numToken.includes(',')) {
      if (/^\d{1,3}(,\d{3})+$/.test(numToken) && mult === 1) {
        numToken = numToken.replaceAll(',', '');
      } else {
        numToken = numToken.replaceAll(',', '.');
      }
    } else if (numToken.includes('.')) {
      if (/^\d{1,3}(\.\d{3})+$/.test(numToken) && mult === 1) {
        numToken = numToken.replaceAll('.', '');
      }
    }

    const num = Number.parseFloat(numToken);
    return Number.isFinite(num) ? Math.round(num * mult) : null;
  }

  function safeSendMessage(payload) {
    return new Promise((resolve) => {
      try {
        if (!chrome?.runtime?.id) {
          resolve(null);
          return;
        }
        chrome.runtime.sendMessage(payload, (response) => {
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }
          resolve(response || null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  function mergeRichUser(existing, incoming) {
    if (!existing) return { ...incoming };
    return {
      ...existing,
      ...incoming,
      restId: incoming.restId || existing.restId || null,
      username: normalizeHandle(incoming.username || existing.username),
      name: incoming.name || existing.name,
      bio: incoming.bio !== undefined && incoming.bio !== '' ? incoming.bio : (existing.bio || ''),
      avatar: incoming.avatar || existing.avatar || '',
      verified: Boolean(incoming.verified ?? existing.verified),
      isBlueVerified: Boolean(incoming.isBlueVerified ?? existing.isBlueVerified),
      verifiedType: incoming.verifiedType ?? existing.verifiedType ?? null,
      followersCount: Number.isFinite(incoming.followersCount) ? incoming.followersCount : existing.followersCount,
      followingCount: Number.isFinite(incoming.followingCount) ? incoming.followingCount : existing.followingCount,
      statusesCount: Number.isFinite(incoming.statusesCount) ? incoming.statusesCount : existing.statusesCount,
      defaultProfileImage: Boolean(incoming.defaultProfileImage ?? existing.defaultProfileImage),
      protected: Boolean(incoming.protected ?? existing.protected),
      followedBy: typeof incoming.followedBy === 'boolean' ? incoming.followedBy : existing.followedBy,
      following: typeof incoming.following === 'boolean' ? incoming.following : existing.following,
      createdAt: incoming.createdAt || existing.createdAt || null
    };
  }

  // Listen to MAIN-world telemetry (ALL GraphQL/REST ops on allowed X origins)
  document.addEventListener('x-tracker:telemetry', (event) => {
    let tel;
    try {
      tel = typeof event.detail === 'string' ? JSON.parse(event.detail) : event.detail;
    } catch {
      return;
    }
    if (!tel?.op) return;

    const prev = state.observedOps.get(tel.op) || { count: 0, status: tel.status, host: tel.host };
    state.observedOps.set(tel.op, {
      count: prev.count + 1,
      status: tel.status ?? prev.status,
      host: tel.host || prev.host
    });

    if (tel.kind === 'http_error' || (Number.isFinite(tel.status) && tel.status >= 400)) {
      queueLog('warn', 'main.http_error', `${tel.op} HTTP ${tel.status}`, tel, { source: 'main' });
    } else if (tel.kind === 'gql_unmatched' && state.running && prev.count === 0) {
      queueLog('debug', 'main.gql_unmatched', `Observed unmatched op ${tel.op}`, {
        op: tel.op,
        host: tel.host,
        status: tel.status,
        durationMs: tel.durationMs
      }, { source: 'main' });
    }
  });

  // Listen to MAIN-world network observer envelopes
  document.addEventListener('x-tracker:network', (event) => {
    const parser = globalThis.__XTrackerGraphQL;
    if (!parser) return;

    let envelope;
    try {
      envelope = typeof event.detail === 'string' ? JSON.parse(event.detail) : event.detail;
    } catch {
      return;
    }
    if (!envelope) return;

    state.lastNetworkAt = Date.now();

    if (envelope.rateLimit) {
      if (Number.isFinite(envelope.rateLimit.remaining)) {
        state.rateLimitRemaining = envelope.rateLimit.remaining;
        if (envelope.status >= 200 && envelope.status < 300 && envelope.rateLimit.remaining > 0) {
          state.rateLimitResetAtMs = 0;
        }
      }
    }

    if (envelope.status === 429) {
      const resetMs = envelope.rateLimit?.resetAtMs || Date.now() + 60_000;
      state.rateLimitResetAtMs = resetMs;
      state.rateLimitRemaining = 0;
      queueLog('warn', 'main.rate_limit', `${envelope.op} hit HTTP 429 rate limit`, {
        op: envelope.op,
        resetAtMs: resetMs,
        limit: envelope.rateLimit?.limit ?? null
      }, { source: 'main' });
      return;
    }

    if (!envelope.json) return;

    if (envelope.op === 'Viewer') {
      const extracted = parser.extractTimelinePayload(envelope.json);
      if (extracted.users.length > 0) {
        state.gqlViewer = extracted.users[0];
      }
      return;
    }

    if (envelope.op === 'UserByScreenName' || envelope.op === 'UserByRestId') {
      const counts = parser.extractProfileCounts(envelope.json);
      if (counts) {
        const prev = state.gqlProfileCounts;
        state.gqlProfileCounts =
          prev && prev.username === counts.username && !counts.unavailable
            ? {
                ...prev,
                ...counts,
                followers: Number.isFinite(counts.followers) ? counts.followers : prev.followers,
                following: Number.isFinite(counts.following) ? counts.following : prev.following
              }
            : counts;
        queueLog('info', 'gql.profile_counts', `Parsed ${envelope.op} profile counts`, {
          username: state.gqlProfileCounts.username || null,
          followers: state.gqlProfileCounts.followers ?? null,
          following: state.gqlProfileCounts.following ?? null,
          unavailable: Boolean(state.gqlProfileCounts.unavailable)
        });
      }
      return;
    }

    if (
      envelope.op === 'Followers' ||
      envelope.op === 'BlueVerifiedFollowers' ||
      envelope.op === 'Following' ||
      envelope.op === 'FollowersYouKnow' ||
      envelope.op === 'RestUserList'
    ) {
      const extracted = parser.extractTimelinePayload(envelope.json);
      state.gqlPayloadsReceived++;
      if (extracted.bottomCursor) {
        state.gqlBottomCursor = extracted.bottomCursor;
      }
      for (const u of extracted.users) {
        const key = canonicalUserKey(u);
        if (!key) continue;
        // If handle:<name> already exists in gqlUsers and now we got restId, upgrade cleanly
        const handleKey = u.username ? `handle:${u.username}` : '';
        if (u.restId && handleKey && state.gqlUsers.has(handleKey)) {
          const prev = state.gqlUsers.get(handleKey);
          state.gqlUsers.delete(handleKey);
          state.gqlUsers.set(key, mergeRichUser(prev, u));
        } else {
          state.gqlUsers.set(key, mergeRichUser(state.gqlUsers.get(key), u));
        }
      }
      queueLog('info', 'gql.list_payload', `${envelope.op} yielded ${extracted.users.length} users`, {
        op: envelope.op,
        batchUsers: extracted.users.length,
        totalGqlUsers: state.gqlUsers.size,
        hasBottomCursor: Boolean(extracted.bottomCursor),
        payloadsReceived: state.gqlPayloadsReceived,
        rateLimitRemaining: envelope.rateLimit?.remaining ?? null,
        rateLimitLimit: envelope.rateLimit?.limit ?? null
      });
      return;
    }

    // Passive session captures (thread, search, bookmarks, feed, profile)
    if (envelope.category && envelope.category !== 'core' && state.passiveScopes.has(envelope.category)) {
      const extracted = parser.extractTimelinePayload(envelope.json);
      if (extracted.tweets.length > 0 || extracted.users.length > 0) {
        const items = extracted.tweets.length
          ? extracted.tweets
          : extracted.users.map((u) => ({
              captureId: `user:${u.restId || u.username}:${envelope.category}`,
              author: u,
              text: u.bio || '',
              url: u.profileUrl
            }));
        safeSendMessage({
          action: 'savePassiveCapture',
          scope: envelope.category,
          items
        });
      }
    }
  });

  function requestMainHandshake() {
    document.dispatchEvent(new CustomEvent('x-tracker:handshake'));
  }

  function syncMainConfig() {
    document.dispatchEvent(
      new CustomEvent('x-tracker:config', {
        detail: JSON.stringify({ captureScopes: Array.from(state.passiveScopes) })
      })
    );
  }

  // ================== Scoped DOM Helpers (Fallback & Page Diagnostics) ==================

  function getPrimaryColumn() {
    return (
      document.querySelector('[data-testid="primaryColumn"]') ||
      document.querySelector('main[role="main"]') ||
      document.querySelector('main') ||
      document.body
    );
  }

  function getScrollContainer() {
    const primary = document.querySelector('[data-testid="primaryColumn"]');
    if (primary && primary.scrollHeight > primary.clientHeight + 40) {
      const style = getComputedStyle(primary);
      if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
        return primary;
      }
    }
    return document.scrollingElement || document.documentElement;
  }

  function detectScopedPageIssue() {
    const path = window.location.pathname || '';
    if (path.startsWith('/i/flow/login') || path.startsWith('/login')) {
      return { code: 'not_logged_in', message: 'You are not logged in to X. Please sign in and retry.' };
    }
    if (path.startsWith('/account/access') || path.startsWith('/i/flow/consent')) {
      return {
        code: 'challenge',
        message: 'X requested an interactive account verification check in browser. Open X and resolve it, then retry.'
      };
    }

    // Inspect ONLY dedicated error/alert nodes rather than follower bios
    const alertNodes = Array.from(
      document.querySelectorAll('[data-testid="error-detail"], [data-testid="toast"], [role="alert"]')
    );
    const alertText = alertNodes
      .map((n) => (n.innerText || '').toLowerCase())
      .join('\n')
      .replace(/\u2019/g, "'");

    if (alertText.includes('rate limit') || alertText.includes('too many requests')) {
      return { code: 'rate_limit', message: 'X rate limit detected.' };
    }
    if (alertText.includes('something went wrong') || alertText.includes('try again')) {
      return { code: 'x_error', message: 'X returned a temporary page error.' };
    }

    // Empty/protected state inside primary column (exclude UserCell bios!)
    const primary = getPrimaryColumn();
    const emptyState = primary?.querySelector('[data-testid="emptyState"], [data-testid="empty-state"]');
    if (emptyState) {
      const text = (emptyState.innerText || '').toLowerCase().replace(/\u2019/g, "'");
      if (text.includes('protected') || text.includes('only approved followers')) {
        return { code: 'protected', message: 'This account is protected and its lists cannot be viewed.' };
      }
      if (text.includes("doesn't exist") || text.includes('does not exist')) {
        return { code: 'not_found', message: 'This X account does not exist.' };
      }
      if (text.includes('suspended')) {
        return { code: 'suspended', message: 'This X account is suspended.' };
      }
    }

    return null;
  }

  function isEmptyListState(root) {
    if (getUserCells(document).length > 0) return false;
    const scope = root || getPrimaryColumn();
    if (!scope) return false;

    const empty = scope.querySelector(
      '[data-testid="emptyState"], [data-testid="empty-state"], [data-testid^="empty_state"]'
    );
    if (empty) {
      const text = (empty.innerText || '').toLowerCase().replace(/\u2019/g, "'");
      if (text.includes('protected') || text.includes("doesn't exist") || text.includes('suspended')) {
        return false;
      }
      return true;
    }

    if (scope.querySelector('[role="progressbar"]')) {
      return false;
    }

    const text = (scope.innerText || '').toLowerCase().replace(/\u2019/g, "'");
    if (
      text.includes('protected') ||
      text.includes("doesn't exist") ||
      text.includes('does not exist') ||
      text.includes('suspended')
    ) {
      return false;
    }

    // X uses many possible empty-state messages across locales and feature variants
    const emptyPatterns = [
      'looking for followers',
      'when someone follows this account',
      "doesn't have any followers",
      "isn't following anyone",
      'not following anyone',
      'no followers yet',
      'be the first to follow',
      "doesn't have any verified followers",
      'no verified followers',
      // Additional patterns for newer X UI variants
      'no one is here yet',
      'no results',
      'no people to show',
      'this list is empty',
      "hasn't followed anyone",
      "doesn't follow anyone",
      'no followers to show'
    ];
    return emptyPatterns.some((pattern) => text.includes(pattern));
  }

  function getUserCells(root) {
    const scope = root || getPrimaryColumn();
    const allCells = scope.querySelectorAll('[data-testid="UserCell"]');
    const valid = [];
    for (const cell of allCells) {
      if (!cell || !cell.isConnected) continue;
      if (cell.closest('aside') || cell.closest('[data-testid="sidebarColumn"]')) continue;
      if (
        cell.closest(
          '[aria-label*="Who to follow"], [aria-label*="Relevant people"], [aria-label*="You might like"], [aria-label*="Similar accounts"]'
        )
      ) {
        continue;
      }
      valid.push(cell);
    }
    return valid;
  }

  function extractUsernameFromHref(href) {
    if (!href) return null;
    let path = href;
    try {
      if (href.startsWith('http')) path = new URL(href).pathname || '';
    } catch {
      path = href;
    }
    path = path.split('?')[0];
    const parts = path.split('/').filter(Boolean);
    if (!parts.length) return null;
    const candidate = normalizeHandle(parts[0]);
    if (!candidate || !USERNAME_REGEX.test(candidate) || RESERVED_PATHS.has(candidate)) {
      return null;
    }
    return candidate;
  }

  function extractUserFromDomCell(cell) {
    try {
      let profileHandle = null;
      let profileHref = '';
      for (const link of cell.querySelectorAll('a[href]')) {
        const candidate = extractUsernameFromHref(link.getAttribute('href'));
        if (candidate) {
          profileHandle = candidate;
          profileHref = link.href || `https://x.com/${candidate}`;
          break;
        }
      }
      if (!profileHandle) return null;

      let name = profileHandle;
      const nameContainer = cell.querySelector('[data-testid="User-Name"]');
      if (nameContainer) {
        for (const span of nameContainer.querySelectorAll('span')) {
          const t = (span.textContent || '').trim();
          if (!t || t.startsWith('@')) continue;
          if (t.toLowerCase() === 'follows you') continue;
          name = t;
          break;
        }
      }

      const desc = cell.querySelector('[data-testid="UserDescription"]');
      const bio = desc ? (desc.textContent || '').trim() : '';

      const img = cell.querySelector('img[src*="profile_images"]');
      const avatar = img?.src || '';

      const verified = Boolean(
        cell.querySelector('[data-testid="icon-verified"], svg[aria-label*="Verified"], [aria-label*="Verified"]')
      );

      return {
        restId: null,
        username: profileHandle,
        name,
        bio,
        avatar,
        verified,
        isBlueVerified: verified,
        profileUrl: profileHref,
        timestamp: Date.now()
      };
    } catch {
      return null;
    }
  }

  /**
   * Read profile counts from GraphQL first, then DOM links/headers as fallback.
   */
  function readProfileCountsFromPage(targetHandle) {
    const clean = normalizeHandle(targetHandle);
    if (
      state.gqlProfileCounts &&
      (!clean || state.gqlProfileCounts.username === clean || state.gqlProfileCounts.unavailable)
    ) {
      if (state.gqlProfileCounts.unavailable) {
        return { error: `Account is unavailable (${state.gqlProfileCounts.reason}).` };
      }
      if (
        Number.isFinite(state.gqlProfileCounts.followers) &&
        Number.isFinite(state.gqlProfileCounts.following)
      ) {
        return {
          ...state.gqlProfileCounts,
          source: 'graphql'
        };
      }
    }

    const issue = detectScopedPageIssue();
    if (issue) {
      return { error: issue.message };
    }

    const readLinkCount = (type) => {
      const candidates = [];
      for (const link of document.querySelectorAll('a[href]')) {
        const href = (link.getAttribute('href') || '').toLowerCase();
        const match =
          type === 'followers'
            ? href.includes(`/${clean}/followers`) || href.includes(`/${clean}/verified_followers`)
            : href.includes(`/${clean}/following`);
        if (!match) continue;

        const titleAttr = link.getAttribute('title');
        const aria = link.getAttribute('aria-label');
        const text = (link.innerText || link.textContent || '').trim();
        for (const raw of [titleAttr, aria, text]) {
          const parsed = parseLocalizedCount(raw);
          if (parsed !== null) candidates.push(parsed);
        }
      }
      return candidates.length ? Math.max(...candidates) : null;
    };

    const followers = readLinkCount('followers');
    const following = readLinkCount('following');

    return {
      restId: state.gqlProfileCounts?.restId || null,
      username: clean,
      name: state.gqlProfileCounts?.name || clean,
      avatar: state.gqlProfileCounts?.avatar || '',
      followers,
      following,
      source: 'dom',
      error: null
    };
  }

  /**
   * Detect the currently logged-in X user from Viewer GraphQL, sidebar switcher,
   * profile links, or React hydration (polling briefly for SPA mount).
   */
  function tryReadDomActiveAccount() {
    if (state.gqlViewer?.username) {
      return {
        username: state.gqlViewer.username,
        restId: state.gqlViewer.restId || null,
        name: state.gqlViewer.name || state.gqlViewer.username,
        avatar: state.gqlViewer.avatar || ''
      };
    }

    // 1. Primary left rail Profile link
    const profileLink =
      document.querySelector('[data-testid="AppTabBar_Profile_Link"]') ||
      document.querySelector('[data-testid="DashButton_ProfileIcon_Link"]') ||
      document.querySelector('nav a[aria-label="Profile"]') ||
      document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    let handle = profileLink ? extractUsernameFromHref(profileLink.getAttribute('href')) : null;

    // 2. Bottom-left Account Switcher button always contains @handle text when signed in
    const switcher = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
    if (!handle && switcher) {
      const textMatch = (switcher.innerText || switcher.textContent || '').match(/@([a-zA-Z0-9_]{1,15})/);
      if (textMatch) {
        handle = normalizeHandle(textMatch[1]);
      }
    }

    // 3. Fallback: avatar img alt or primary nav links
    if (!handle) {
      const navLinks = document.querySelectorAll('header nav a[href^="/"]');
      for (const link of navLinks) {
        const label = (link.getAttribute('aria-label') || '').toLowerCase();
        if (label.includes('profile')) {
          const candidate = extractUsernameFromHref(link.getAttribute('href'));
          if (candidate) {
            handle = candidate;
            break;
          }
        }
      }
    }

    if (!handle) {
      return null;
    }

    const accountBtnImg = switcher?.querySelector('img');
    const switcherName = switcher?.querySelector('span')?.textContent?.trim();
    return {
      username: handle,
      restId: null,
      name: switcherName && !switcherName.startsWith('@') ? switcherName : handle,
      avatar: accountBtnImg?.src || ''
    };
  }

  async function detectActiveAccount() {
    requestMainHandshake();
    for (let attempt = 0; attempt < 20; attempt++) {
      const detected = tryReadDomActiveAccount();
      if (detected) {
        return detected;
      }
      await sleep(250);
    }
    return null;
  }

  // ================== Guided Scroll + Hybrid Collection Loop ==================

  async function waitForListReady(config) {
    const maxWaitMs = document.hidden ? 55_000 : 35_000;
    const startedAt = Date.now();
    let lastHandshakeAt = 0;
    let lastHeartbeatAt = 0;
    let nudgedScroll = 0;
    let clickedRetry = false;

    queueLog('info', 'scan.wait_start', `Waiting for X user list on ${window.location.pathname}`, {
      expectedCount: config?.expectedCount ?? null,
      hidden: document.hidden
    });

    while (Date.now() - startedAt < maxWaitMs) {
      if (state.shouldStop) throw new Error('Scan stopped by user');
      const issue = detectScopedPageIssue();
      if (issue) {
        queueLog('warn', 'scan.page_issue', issue.message, {
          code: issue.code,
          path: window.location.pathname
        });
        throw new Error(issue.message);
      }

      const primary = getPrimaryColumn();
      const cells = getUserCells(document);
      const elapsed = Date.now() - startedAt;
      const hasSpinner = Boolean(primary?.querySelector('[role="progressbar"]'));

      let readyReason = null;
      if (state.gqlUsers.size > 0) {
        readyReason = 'gql_users';
      } else if (cells.length > 0) {
        readyReason = 'dom_cells';
      } else if (isEmptyListState(primary)) {
        readyReason = 'empty_state';
      } else if (state.gqlPayloadsReceived > 0 && elapsed > 1200) {
        readyReason = 'gql_list_payload';
      } else if (config?.expectedCount === 0 && elapsed > 3000 && primary && !hasSpinner && cells.length === 0) {
        readyReason = 'expected_zero_settled';
      } else if (
        elapsed > 8000 &&
        primary &&
        !hasSpinner &&
        cells.length === 0 &&
        state.gqlPayloadsReceived === 0 &&
        !document.hidden
      ) {
        // Fallback: if no GQL payloads, no DOM cells, no spinner, and not hidden after 8s,
        // treat as empty/settled. This covers zero-follower accounts where X renders a plain
        // empty page without an explicit emptyState data-testid.
        readyReason = 'no_data_settled';
      }

      if (readyReason) {
        queueLog('info', 'scan.wait_ready', `List ready (${readyReason}) in ${elapsed}ms`, {
          reason: readyReason,
          elapsedMs: elapsed,
          gqlPayloadsReceived: state.gqlPayloadsReceived,
          gqlUsers: state.gqlUsers.size,
          cells: cells.length,
          ops: summarizeOps()
        });
        return readyReason;
      }

      if (elapsed - lastHandshakeAt >= 2000) {
        lastHandshakeAt = elapsed;
        requestMainHandshake();
      }

      if (elapsed - lastHeartbeatAt >= 4500 && config?.scanId) {
        lastHeartbeatAt = elapsed;
        safeSendMessage({
          action: 'scanProgress',
          scanId: config.scanId,
          phase: 'loading',
          progress: Math.min(12, 7 + Math.floor(elapsed / 5000)),
          count: 0,
          expected: config.expectedCount ?? null
        });
      }

      if (!clickedRetry && elapsed > 3000 && primary) {
        for (const btn of primary.querySelectorAll('button, [role="button"]')) {
          const label = (btn.innerText || '').trim().toLowerCase();
          if (label === 'retry' || label === 'try again') {
            clickedRetry = true;
            queueLog('warn', 'scan.retry_click', 'Clicked inline X Retry button', { elapsedMs: elapsed });
            btn.click();
            break;
          }
        }
      }

      if ((nudgedScroll === 0 && elapsed > 4000) || (nudgedScroll === 1 && elapsed > 10_000)) {
        nudgedScroll++;
        window.scrollBy(0, 120);
      }

      await sleep(300);
    }

    const opsSummary = summarizeOps();
    const diag = `path=${window.location.pathname}, gql=${state.gqlPayloadsReceived}, users=${state.gqlUsers.size}, cells=${getUserCells(document).length}, hidden=${document.hidden}, ops=${Object.keys(opsSummary).length}`;
    const primaryPreview = (getPrimaryColumn()?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 140);
    queueLog('error', 'scan.wait_timeout', `Timed out waiting for X list (${diag})`, {
      path: window.location.pathname,
      title: document.title || '',
      hidden: document.hidden,
      gqlPayloadsReceived: state.gqlPayloadsReceived,
      gqlUsers: state.gqlUsers.size,
      cells: getUserCells(document).length,
      ops: opsSummary,
      primaryPreview
    });
    await flushLogs();
    throw new Error(`Timed out waiting for X user list to load (${diag}).`);
  }

  async function runGuidedScan(config) {
    if (state.running) {
      return { status: 'busy' };
    }

    state.running = true;
    state.paused = false;
    state.shouldStop = false;
    state.stopMode = 'save';
    state.activeScanId = config.scanId;
    state.activeAccountKey = normalizeHandle(config.username) || null;
    state.gqlUsers.clear();
    state.gqlPayloadsReceived = 0;
    state.gqlBottomCursor = config.resumeCursor || null;
    state.rateLimitResetAtMs = 0;

    const hud = globalThis.__XTrackerHud;
    const collected = new Map(); // canonicalKey -> user
    const handleLookup = new Map(); // normalizedHandle -> canonicalKey
    let unsentBatch = [];
    let lastProgressSentAt = 0;

    const ingestUser = (rawUser) => {
      const handle = normalizeHandle(rawUser?.username);
      if (!handle) return false;
      const incomingKey = canonicalUserKey(rawUser);
      if (!incomingKey) return false;

      // Upgrade handle:<name> -> restId seamlessly if both seen
      let key = incomingKey;
      const legacyKey = `handle:${handle}`;
      if (rawUser.restId && collected.has(legacyKey)) {
        const prev = collected.get(legacyKey);
        collected.delete(legacyKey);
        const merged = mergeRichUser(prev, rawUser);
        collected.set(key, merged);
        handleLookup.set(handle, key);
        unsentBatch.push(merged);
        return false; // upgraded existing record
      }

      if (!rawUser.restId && handleLookup.has(handle)) {
        key = handleLookup.get(handle);
      }

      const existed = collected.has(key);
      const merged = mergeRichUser(collected.get(key), rawUser);
      collected.set(key, merged);
      handleLookup.set(handle, key);

      if (!existed) {
        unsentBatch.push(merged);
        return true;
      }
      return false;
    };

    // Seed from resume checkpoint if provided
    if (Array.isArray(config.resumeUsers)) {
      for (const u of config.resumeUsers) {
        ingestUser(u);
      }
      unsentBatch = []; // Already saved in checkpoint
    }

    const flushCheckpoint = async (force = false) => {
      if (!unsentBatch.length && !force) return;
      const batch = unsentBatch.splice(0, unsentBatch.length);
      if (!batch.length) return;
      await safeSendMessage({
        action: 'scanCheckpoint',
        scanId: config.scanId,
        username: config.username,
        scanType: config.scanType,
        users: batch,
        cursor: state.gqlBottomCursor,
        totalCount: collected.size
      });
    };

    try {
      hud?.mountHud({
        title: `@${config.username} · ${config.scanLabel || config.scanType}`,
        source: 'GraphQL + DOM',
        onPauseToggle: () => {
          state.paused = !state.paused;
          hud?.updateHud({
            tone: state.paused ? 'paused' : 'scanning',
            pauseLabel: state.paused ? 'Resume' : 'Pause',
            status: state.paused ? 'Paused by user' : `Resuming (${collected.size} found)...`
          });
          safeSendMessage({
            action: 'scanProgress',
            scanId: config.scanId,
            phase: state.paused ? 'paused' : 'scanning',
            count: collected.size,
            expected: config.expectedCount
          });
        },
        onStop: () => {
          state.shouldStop = true;
          state.stopMode = 'save';
          state.paused = false;
        }
      });

      requestMainHandshake();
      const readyReason = await waitForListReady(config);

      const primary = getPrimaryColumn();
      const scrollEl = getScrollContainer();
      const scanStartedAt = Date.now();
      let scrollCount = 0;
      let noNewCycles = 0;
      let scrollDelay = BASE_SCROLL_DELAY_MS;
      let lastGqlSeenCount = 0;
      let stopReason = 'loop_exit';

      // Observe DOM mutations during scroll cycles so recycled virtualized cells are never missed
      const observer = new MutationObserver(() => {
        for (const cell of getUserCells(primary)) {
          const domUser = extractUserFromDomCell(cell);
          if (domUser) ingestUser(domUser);
        }
      });
      observer.observe(primary, { childList: true, subtree: true });

      const drainSources = () => {
        let added = 0;
        for (const u of state.gqlUsers.values()) {
          if (ingestUser(u)) added++;
        }
        for (const cell of getUserCells(primary)) {
          const domUser = extractUserFromDomCell(cell);
          if (domUser && ingestUser(domUser)) added++;
        }
        return added;
      };

      drainSources();

      // Confirm 0-follower/empty list without wasting unnecessary scroll retries
      let skipScrollLoop = false;
      if (
        collected.size === 0 &&
        !state.gqlBottomCursor &&
        (readyReason === 'empty_state' ||
          readyReason === 'expected_zero_settled' ||
          readyReason === 'no_data_settled' ||
          (readyReason === 'gql_list_payload' && state.gqlUsers.size === 0))
      ) {
        await sleep(450);
        drainSources();
        if (collected.size === 0 && !detectScopedPageIssue()) {
          skipScrollLoop = true;
          stopReason = `empty_${readyReason}`;
        }
      }

      while (!skipScrollLoop && !state.shouldStop && scrollCount < MAX_SCROLLS) {
        if (Date.now() - scanStartedAt > MAX_SCAN_TIME_MS) {
          stopReason = 'max_time';
          break;
        }

        // Handle user pause
        while (state.paused && !state.shouldStop) {
          await sleep(400);
        }
        if (state.shouldStop) {
          stopReason = 'user_stop';
          break;
        }

        // Handle HTTP 429 rate-limit pause & auto-recovery
        if (state.rateLimitResetAtMs > Date.now()) {
          const waitRemainingMs = state.rateLimitResetAtMs - Date.now();
          await flushCheckpoint(true);
          if (waitRemainingMs <= 120_000) {
            while (Date.now() < state.rateLimitResetAtMs && !state.shouldStop) {
              const sec = Math.ceil((state.rateLimitResetAtMs - Date.now()) / 1000);
              hud?.updateHud({
                tone: 'paused',
                status: `Rate limited — resuming in ${sec}s (${collected.size} saved)`,
                pauseLabel: 'Resume'
              });
              await safeSendMessage({
                action: 'scanProgress',
                scanId: config.scanId,
                phase: 'rate_limited',
                count: collected.size,
                expected: config.expectedCount,
                rateLimitResetAt: state.rateLimitResetAtMs
              });
              await sleep(1000);
            }
            state.rateLimitResetAtMs = 0;
            if (state.shouldStop) {
              stopReason = 'user_stop';
              break;
            }
          } else {
            throw Object.assign(
              new Error(`Rate limit cooldown until ${new Date(state.rateLimitResetAtMs).toLocaleTimeString()}. Checkpoint saved (${collected.size} users).`),
              { code: 'rate_limit', resetAtMs: state.rateLimitResetAtMs, partialCount: collected.size }
            );
          }
        }

        scrollCount++;
        const beforeCount = collected.size;
        const beforeGqlPayloads = state.gqlPayloadsReceived;

        // Incremental viewport-step scroll; instant mode when tab is hidden so compositor rAF never stalls scrolling
        const stepPx = Math.max(420, Math.round((window.innerHeight || 800) * 0.78));
        const scrollBehavior = document.hidden ? 'instant' : 'smooth';
        if (scrollEl === document.scrollingElement || scrollEl === document.documentElement) {
          window.scrollBy({ top: stepPx, behavior: scrollBehavior });
        } else {
          scrollEl.scrollBy({ top: stepPx, behavior: scrollBehavior });
        }

        // Wait with adaptive jittered pacing (slower if remaining rate limit is low)
        const rateSlowdown =
          Number.isFinite(state.rateLimitRemaining) && state.rateLimitRemaining <= 6 ? 1200 : 0;
        await sleep(jitteredDelay(scrollDelay + rateSlowdown));

        const addedFromDrain = drainSources();
        const afterCount = collected.size;
        const hadGqlGrowth =
          state.gqlPayloadsReceived > beforeGqlPayloads || state.gqlUsers.size > lastGqlSeenCount;
        lastGqlSeenCount = state.gqlUsers.size;

        const atScrollBottom =
          scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 24;

        if (afterCount === beforeCount && addedFromDrain === 0 && !hadGqlGrowth) {
          noNewCycles += atScrollBottom ? 1 : 0.5;
          scrollDelay = Math.min(MAX_SCROLL_DELAY_MS, Math.round(scrollDelay * 1.2));
        } else {
          noNewCycles = 0;
          scrollDelay = Math.max(BASE_SCROLL_DELAY_MS, Math.round(scrollDelay * 0.92));
        }

        if (unsentBatch.length >= CHECKPOINT_BATCH_SIZE) {
          await flushCheckpoint();
        }

        const expected = Number.isFinite(config.expectedCount) && config.expectedCount > 0
          ? config.expectedCount
          : null;
        const pct = expected
          ? Math.min(97, Math.round((afterCount / expected) * 100))
          : Math.min(95, Math.round((scrollCount / 40) * 100));
        const sourceLabel = state.gqlPayloadsReceived > 0 ? 'GraphQL + DOM' : 'DOM Fallback';
        const statusText = expected
          ? `${afterCount.toLocaleString()} / ${expected.toLocaleString()} collected (${pct}%)`
          : `${afterCount.toLocaleString()} collected`;

        hud?.updateHud({
          tone: 'scanning',
          source: sourceLabel,
          status: statusText,
          progress: pct
        });

        if (Date.now() - lastProgressSentAt >= 750) {
          lastProgressSentAt = Date.now();
          safeSendMessage({
            action: 'scanProgress',
            scanId: config.scanId,
            phase: 'scanning',
            progress: pct,
            count: afterCount,
            expected,
            sourceMode: sourceLabel
          });
        }

        // Stop early if we matched expected count cleanly, hit confirmed empty list, or hit bottom repeatedly
        if (noNewCycles >= 2 && collected.size === 0 && (isEmptyListState(primary) || config.expectedCount === 0)) {
          stopReason = 'empty_list_confirmed';
          break;
        }
        if (expected && afterCount >= expected && noNewCycles >= 2) {
          stopReason = 'expected_matched';
          break;
        }
        if (noNewCycles >= 6 && atScrollBottom) {
          stopReason = 'bottom_stalled';
          // Detect background-tab throttling: if we have an expected count, received very few
          // GraphQL pages, and coverage is catastrophically low, this is a throttling failure,
          // not a genuine end of list. Throw an error so the scan is NOT committed as complete.
          if (
            document.hidden &&
            expected &&
            afterCount < expected * 0.50 &&
            state.gqlPayloadsReceived <= 2
          ) {
            throw new Error(
              `Background tab throttled: only ${afterCount}/${expected} users captured in ${state.gqlPayloadsReceived} pages. ` +
              `Please use a foreground (dedicated) tab. Checkpoint saved (${afterCount} users).`
            );
          }
          break;
        }

        // Human-like periodic pause
        if (scrollCount % PAUSE_EVERY_N_SCROLLS === 0) {
          await sleep(jitteredDelay(PAUSE_DURATION_MS, 700));
        }

        // Check scoped errors (do not treat user bios as errors!)
        const issue = detectScopedPageIssue();
        if (issue?.code === 'rate_limit') {
          state.rateLimitResetAtMs = Date.now() + 60_000;
          queueLog('warn', 'scan.rate_limit_dom', issue.message, { collected: collected.size });
        } else if (issue && collected.size === 0) {
          throw new Error(issue.message);
        }
      }

      if (state.shouldStop && stopReason === 'loop_exit') {
        stopReason = 'user_stop';
      } else if (scrollCount >= MAX_SCROLLS && stopReason === 'loop_exit') {
        stopReason = 'max_scrolls';
      }

      observer.disconnect();
      drainSources();
      await flushCheckpoint(true);

      const finalUsers = Array.from(collected.values());
      const wasManualStop = state.shouldStop;

      queueLog('info', 'scan.scroll_done', `Collection finished (${stopReason}): ${finalUsers.length} users`, {
        stopReason,
        scrollCount,
        collected: finalUsers.length,
        gqlPayloadsReceived: state.gqlPayloadsReceived,
        gqlUsers: state.gqlUsers.size,
        ops: summarizeOps()
      });
      await flushLogs();

      if (wasManualStop && finalUsers.length === 0) {
        hud?.updateHud({
          tone: 'paused',
          status: 'Scan cancelled (0 collected).',
          showActions: false
        });
        hud?.removeHud(1600);
        await safeSendMessage({
          action: 'scanCancelled',
          scanId: config.scanId
        });
        return { status: 'cancelled', count: 0 };
      }

      hud?.updateHud({
        tone: 'scanning',
        status: `Saving ${finalUsers.length.toLocaleString()} accounts...`,
        progress: 99,
        showActions: false
      });

      const finalResponse = await safeSendMessage({
        action: 'scanFinalize',
        scanId: config.scanId,
        username: config.username,
        scanType: config.scanType,
        users: finalUsers,
        expectedCount: config.expectedCount,
        expectedSource: config.expectedSource,
        profileCounts: config.profileCounts,
        partial: wasManualStop
      });

      if (finalResponse?.status === 'error') {
        throw new Error(finalResponse.message || 'Failed to save scan data.');
      }

      hud?.updateHud({
        tone: 'success',
        status: `Complete · ${finalUsers.length.toLocaleString()} accounts synced`,
        progress: 100,
        showActions: false
      });
      hud?.removeHud(2200);

      return { status: 'complete', count: finalUsers.length };
    } catch (error) {
      queueLog('error', 'scan.run_error', error?.message || 'Scan failed', {
        collected: collected.size,
        gqlPayloadsReceived: state.gqlPayloadsReceived,
        ops: summarizeOps()
      });
      await flushLogs();
      await flushCheckpoint(true);
      hud?.updateHud({
        tone: 'error',
        status: error.message || 'Scan failed',
        showActions: false
      });
      hud?.removeHud(4000);

      await safeSendMessage({
        action: 'scanError',
        scanId: config.scanId,
        username: config.username,
        scanType: config.scanType,
        error: error.message || 'Scan failed',
        code: error.code || null,
        resetAtMs: error.resetAtMs || null,
        partialCount: collected.size
      });
      return { status: 'error', message: error.message };
    } finally {
      await flushLogs();
      state.running = false;
      state.paused = false;
      state.shouldStop = false;
      state.activeScanId = null;
      state.activeAccountKey = null;
    }
  }

  // Listen for commands from Service Worker
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message?.action) {
      case 'pingScraper':
        sendResponse({ ok: true, running: state.running });
        return false;

      case 'detectActiveAccount':
        detectActiveAccount()
          .then((account) => sendResponse({ account }))
          .catch(() => sendResponse({ account: null }));
        return true;

      case 'probeProfileDom':
        requestMainHandshake();
        setTimeout(() => {
          sendResponse(readProfileCountsFromPage(message.username));
        }, 250);
        return true;

      case 'runGuidedScan':
        if (state.running) {
          sendResponse({ ok: false, status: 'busy' });
          return false;
        }
        void runGuidedScan(message.config || {});
        sendResponse({ ok: true, status: 'started' });
        return false;

      case 'pauseScan':
        if (state.running) {
          state.paused = true;
          globalThis.__XTrackerHud?.updateHud({
            tone: 'paused',
            pauseLabel: 'Resume',
            status: 'Paused from Side Panel'
          });
        }
        sendResponse({ ok: true });
        return false;

      case 'resumeScan':
        if (state.running) {
          state.paused = false;
          globalThis.__XTrackerHud?.updateHud({
            tone: 'scanning',
            pauseLabel: 'Pause',
            status: 'Resumed...'
          });
        }
        sendResponse({ ok: true });
        return false;

      case 'stopScan':
        if (state.running) {
          state.shouldStop = true;
          state.paused = false;
          state.stopMode = 'save';
        }
        sendResponse({ ok: true });
        return false;

      case 'setPassiveCapture':
        state.passiveScopes = new Set(Array.isArray(message.scopes) ? message.scopes : []);
        syncMainConfig();
        if (state.passiveScopes.size > 0) {
          requestMainHandshake();
        }
        sendResponse({ ok: true, scopes: Array.from(state.passiveScopes) });
        return false;

      case 'showProfileBadge':
        if (message.badgeText) {
          globalThis.__XTrackerHud?.showProfilePill(message);
        } else {
          globalThis.__XTrackerHud?.removeProfilePill();
        }
        sendResponse({ ok: true });
        return false;

      default:
        return false;
    }
  });
})();
