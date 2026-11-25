/**
 * X Tracker - Side Panel Application Controller
 * Pure ES module using IndexedDB + reactive chrome.storage.onChanged,
 * zero raw innerHTML interpolation, container-responsive layout,
 * chunked list rendering, and ARIA/keyboard-compliant tabs & popovers.
 */

import { SCAN_SCOPES, STORAGE_KEYS } from '../shared/constants.js';
import {
  appendAppLog,
  buildDiagnosticReport,
  clearAppLogs,
  deleteAccount,
  deleteCheckpoint,
  getSettings,
  listAccounts,
  listAppLogs,
  loadAccountDataset,
  migrateLegacyStorageIfNeeded,
  saveSettings,
  toggleWhitelist,
  upsertAccount
} from '../shared/db.js';
import {
  formatBytes,
  formatDateTime,
  formatRelativeTime,
  formatSignedNumber,
  normalizeHandle,
  sanitizeAvatarUrl
} from '../shared/utils.js';
import { buildActivityBarsSvg, buildLineChartSvg } from './charts.js';
import { initDialogs, openAddAccountDialog, showConfirmDialog } from './dialogs.js';
import {
  exportDiagnosticsReport,
  exportJsonArchive,
  exportMarkdownAudit,
  exportViewCsv,
  importJsonFile
} from './exports.js';

const appState = {
  currentUser: null,
  accounts: [],
  dataset: null,
  settings: null,
  activeView: 'overview',
  passiveCaptureActive: false,
  logFilter: 'all',
  viewFilters: {
    followers: { query: '', verified: 'all', sort: 'default' },
    unfollowers: { query: '', verified: 'all', reason: 'all', sort: 'recent' },
    new: { query: '', verified: 'all', sort: 'recent' },
    fans: { query: '', verified: 'all', sort: 'followers' },
    notfollowback: { query: '', verified: 'all', hideWhitelisted: true, sort: 'followers' },
    following: { query: '', verified: 'all', relation: 'all', sort: 'mutual' }
  },
  currentDisplayedItems: []
};

let searchDebounceTimer = null;
let renderGeneration = 0;

// ================== Chrome Runtime & Yield Helpers ==================

const HAS_EXTENSION_API =
  typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id && chrome.storage?.local);

async function sendMsg(payload) {
  if (!HAS_EXTENSION_API) {
    return { status: 'error', message: 'Extension runtime unavailable outside Chrome extension context.' };
  }
  return chrome.runtime.sendMessage(payload);
}

async function getLocalStorage(keys) {
  if (!HAS_EXTENSION_API) return {};
  return chrome.storage.local.get(keys);
}

async function setLocalStorage(patch) {
  if (!HAS_EXTENSION_API) return;
  return chrome.storage.local.set(patch);
}

async function yieldToMain() {
  if (typeof globalThis.scheduler?.yield === 'function') {
    return globalThis.scheduler.yield();
  }
  return new Promise((r) => setTimeout(r, 0));
}

function announceScreenReader(text) {
  if (typeof document.ariaNotify === 'function') {
    try {
      document.ariaNotify(text);
      return;
    } catch {
      // Fallback to live region
    }
  }
  const region = document.getElementById('ariaLiveRegion');
  if (region) {
    region.textContent = text;
  }
}

function showToast(message, tone = 'info', durationMs = 3600) {
  const stack = document.getElementById('toastStack');
  if (!stack) return;

  const item = document.createElement('div');
  item.className = 'toast-item';
  item.dataset.tone = tone;

  const textSpan = document.createElement('span');
  textSpan.textContent = message;

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'icon-btn';
  closeBtn.setAttribute('aria-label', 'Dismiss notification');
  closeBtn.textContent = '×';
  closeBtn.style.minInlineSize = '24px';
  closeBtn.style.minBlockSize = '24px';
  closeBtn.style.padding = '0 4px';

  const dismiss = () => {
    item.remove();
    if (!stack.children.length && stack.matches(':popover-open')) {
      try {
        stack.hidePopover();
      } catch {
        // Ignore
      }
    }
  };

  closeBtn.addEventListener('click', dismiss);
  item.append(textSpan, closeBtn);
  stack.appendChild(item);

  if (!stack.matches(':popover-open')) {
    try {
      stack.showPopover();
    } catch {
      // Popover fallback if unsupported
    }
  }

  announceScreenReader(message);

  let timer = setTimeout(dismiss, durationMs);
  item.addEventListener('focusin', () => clearTimeout(timer));
  item.addEventListener('focusout', () => {
    timer = setTimeout(dismiss, durationMs);
  });
}

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'dark' || theme === 'light') {
    root.dataset.theme = theme;
  } else {
    delete root.dataset.theme;
  }
}

// ================== Popover Tether Positioning (for Chrome < 157) ==================

function setupPopoverAnchors() {
  const pairs = [
    ['accountMenuPopover', 'accountSwitcherBtn'],
    ['scanScopesPopover', 'moreScansBtn'],
    ['exportMenuPopover', 'exportMenuBtn']
  ];

  for (const [popId, btnId] of pairs) {
    const pop = document.getElementById(popId);
    const btn = document.getElementById(btnId);
    if (!pop || !btn) continue;

    pop.addEventListener('toggle', (event) => {
      if (event.newState !== 'open') return;
      const rect = btn.getBoundingClientRect();
      const popWidth = Math.max(220, rect.width);
      const maxLeft = Math.max(8, window.innerWidth - popWidth - 8);
      const left = Math.min(maxLeft, Math.max(8, rect.left));
      pop.style.position = 'fixed';
      pop.style.inset = 'auto';
      pop.style.top = `${Math.round(rect.bottom + 4)}px`;
      pop.style.left = `${Math.round(left)}px`;
      pop.style.minWidth = `${Math.round(Math.min(popWidth, window.innerWidth - 16))}px`;
    });
  }
}

// ================== Tabs, Scroll Fades & Keyboard Navigation ==================

function setupTabs() {
  const tablist = document.getElementById('mainTablist');
  if (!tablist) return;

  const tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      switchView(tab.dataset.view);
    });

    tab.addEventListener('keydown', (e) => {
      const idx = tabs.indexOf(tab);
      let nextIdx = null;
      if (e.key === 'ArrowRight') nextIdx = (idx + 1) % tabs.length;
      else if (e.key === 'ArrowLeft') nextIdx = (idx - 1 + tabs.length) % tabs.length;
      else if (e.key === 'Home') nextIdx = 0;
      else if (e.key === 'End') nextIdx = tabs.length - 1;

      if (nextIdx !== null) {
        e.preventDefault();
        tabs[nextIdx].focus();
        switchView(tabs[nextIdx].dataset.view);
      }
    });
  });

  // Sync tab state if native find-in-page reveals a hidden="until-found" panel
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.addEventListener('beforematch', () => {
      const view = panel.id.replace('panel-', '');
      switchView(view);
    });
  });

  // Scroll fade IntersectionObserver fallback for browsers without scroll-driven animation
  if (!CSS.supports('animation-timeline', 'scroll()')) {
    const first = tabs[0];
    const last = tabs[tabs.length - 1];
    if (first && last) {
      const io = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.target === first) {
              tablist.classList.toggle('more-start', entry.intersectionRatio < 1);
            } else if (entry.target === last) {
              tablist.classList.toggle('more-end', entry.intersectionRatio < 1);
            }
          }
        },
        { root: tablist, threshold: 1, rootMargin: '1px' }
      );
      io.observe(first);
      io.observe(last);
    }
  }
}

export function switchView(view) {
  appState.activeView = view;

  const tablist = document.getElementById('mainTablist');
  const tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));
  for (const tab of tabs) {
    const isActive = tab.dataset.view === view;
    tab.setAttribute('aria-selected', String(isActive));
    if (isActive) {
      tab.setAttribute('focusgroupstart', '');
      tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } else {
      tab.removeAttribute('focusgroupstart');
    }
  }

  document.querySelectorAll('.tab-panel').forEach((panel) => {
    const isMatch = panel.id === `panel-${view}`;
    if (isMatch) {
      panel.removeAttribute('hidden');
    } else {
      panel.setAttribute('hidden', 'until-found');
    }
  });

  renderActiveView();
}

// ================== Data Loading & Reactive Sync ==================

async function refreshAllData() {
  await migrateLegacyStorageIfNeeded();
  appState.settings = await getSettings();
  applyTheme(appState.settings.theme);

  appState.accounts = await listAccounts();
  const stored = await getLocalStorage([STORAGE_KEYS.currentUser, STORAGE_KEYS.scanState]);

  let current = normalizeHandle(stored[STORAGE_KEYS.currentUser]);
  if (!current || !appState.accounts.some((a) => a.accountKey === current)) {
    current = appState.accounts[0]?.accountKey || null;
    if (current) {
      await setLocalStorage({ [STORAGE_KEYS.currentUser]: current });
    }
  }

  appState.currentUser = current;
  appState.dataset = current ? await loadAccountDataset(current) : null;

  renderHeaderAccountState();
  renderLiveScanState(stored[STORAGE_KEYS.scanState] || null);
  renderCheckpointBanner();
  renderActiveView();
  updateStorageEstimate();
}

async function updateStorageEstimate() {
  const el = document.getElementById('footerStorageStat');
  if (!el || !navigator.storage?.estimate) return;
  try {
    const est = await navigator.storage.estimate();
    el.textContent = est.usage ? `Used: ${formatBytes(est.usage)}` : '';
  } catch {
    el.textContent = '';
  }
}

function renderHeaderAccountState() {
  const display = document.getElementById('currentUserDisplay');
  const menuList = document.getElementById('accountMenuList');
  const lastCheckEl = document.getElementById('lastCheckLabel');

  if (display) {
    display.textContent = appState.currentUser ? `@${appState.currentUser}` : 'Select or add X account';
  }

  if (lastCheckEl) {
    const acc = appState.dataset?.account;
    const latest = Math.max(acc?.lastFollowersCheck || 0, acc?.lastFollowingCheck || 0);
    lastCheckEl.textContent = latest > 0 ? `Synced ${formatRelativeTime(latest)}` : 'Not scanned yet';
  }

  if (!menuList) return;
  const items = appState.accounts.map((acc) => {
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.alignItems = 'center';
    row.style.gap = '4px';

    const switchBtn = document.createElement('button');
    switchBtn.type = 'button';
    switchBtn.className = 'menu-item-btn';
    if (acc.accountKey === appState.currentUser) {
      switchBtn.setAttribute('aria-current', 'true');
    }

    const nameSpan = document.createElement('span');
    nameSpan.textContent = `@${acc.accountKey}`;

    const countSpan = document.createElement('span');
    countSpan.style.fontSize = '0.75rem';
    countSpan.style.color = 'var(--text-muted)';
    countSpan.textContent = `${(acc.followerIds?.length || 0).toLocaleString()} / ${(acc.followingIds?.length || 0).toLocaleString()}`;

    switchBtn.append(nameSpan, countSpan);
    switchBtn.addEventListener('click', async () => {
      document.getElementById('accountMenuPopover')?.hidePopover();
      await switchAccount(acc.accountKey);
    });

    row.appendChild(switchBtn);

    if (appState.accounts.length > 1) {
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'icon-btn';
      delBtn.setAttribute('aria-label', `Remove @${acc.accountKey}`);
      delBtn.textContent = '×';
      delBtn.style.minInlineSize = '28px';
      delBtn.style.minBlockSize = '28px';
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        document.getElementById('accountMenuPopover')?.hidePopover();
        const ok = await showConfirmDialog({
          title: 'Remove Account',
          message: `Delete all local follower history and snapshots for @${acc.accountKey}?`,
          confirmLabel: 'Remove Account'
        });
        if (ok) {
          await deleteAccount(acc.accountKey);
          showToast(`Removed @${acc.accountKey}`, 'success');
          await refreshAllData();
        }
      });
      row.appendChild(delBtn);
    }

    return row;
  });

  menuList.replaceChildren(...items);
}

async function switchAccount(accountKey) {
  const clean = normalizeHandle(accountKey);
  if (!clean || clean === appState.currentUser) return;
  await setLocalStorage({ [STORAGE_KEYS.currentUser]: clean });
  await refreshAllData();
  showToast(`Switched to @${clean}`, 'info');
}

function renderLiveScanState(live) {
  const dot = document.getElementById('scanStatusDot');
  const statusText = document.getElementById('scanStatusText');
  const drawer = document.getElementById('liveScanDrawer');
  const progressEl = document.getElementById('scanProgressEl');
  const pauseBtn = document.getElementById('pauseResumeScanBtn');
  const followersBtn = document.getElementById('scanFollowersBtn');
  const followingBtn = document.getElementById('scanFollowingBtn');

  const status = live?.status || 'idle';
  const phase = live?.phase || 'idle';
  const isScanning = status === 'scanning';
  const isPaused = phase === 'paused' || phase === 'rate_limited';

  if (followersBtn) followersBtn.disabled = isScanning;
  if (followingBtn) followingBtn.disabled = isScanning;

  if (dot) {
    dot.dataset.state = isPaused ? 'paused' : status;
  }

  if (drawer) {
    drawer.hidden = !isScanning;
  }

  if (progressEl && Number.isFinite(live?.progress)) {
    progressEl.value = live.progress;
  }

  if (pauseBtn) {
    pauseBtn.textContent = isPaused ? 'Resume' : 'Pause';
  }

  if (statusText) {
    if (status === 'scanning') {
      const countText = Number.isFinite(live?.count)
        ? (Number.isFinite(live?.expected)
            ? `${live.count.toLocaleString()}/${live.expected.toLocaleString()}`
            : `${live.count.toLocaleString()} found`)
        : '';
      if (phase === 'profile') statusText.textContent = 'Reading profile…';
      else if (phase === 'loading') statusText.textContent = 'Loading list…';
      else if (phase === 'rate_limited') statusText.textContent = `Rate limited (${countText})`;
      else if (phase === 'paused') statusText.textContent = `Paused (${countText})`;
      else statusText.textContent = `Scanning ${countText}`.trim();
    } else if (status === 'error') {
      statusText.textContent = 'Interrupted';
    } else if (status === 'complete') {
      statusText.textContent = 'Synced';
    } else {
      statusText.textContent = 'Ready';
    }
  }
}

function renderCheckpointBanner() {
  const banner = document.getElementById('checkpointBanner');
  const label = document.getElementById('checkpointLabel');
  if (!banner || !label) return;

  const latestCp = appState.dataset?.checkpoints?.[0] || null;
  if (!latestCp || !latestCp.users?.length) {
    banner.hidden = true;
    return;
  }

  label.textContent = `Saved ${latestCp.scanType} checkpoint (${latestCp.users.length.toLocaleString()} users)`;
  banner.hidden = false;
}

// ================== View Rendering ==================

function renderActiveView() {
  const ds = appState.dataset;

  // Update KPI values regardless of active tab
  document.getElementById('kpiFollowers').textContent = (ds?.followers.length || 0).toLocaleString();
  document.getElementById('kpiFollowing').textContent = (ds?.following.length || 0).toLocaleString();
  document.getElementById('kpiUnfollowers').textContent = (ds?.unfollowers.length || 0).toLocaleString();
  document.getElementById('kpiNewFollowers').textContent = `+${(ds?.newFollowers.length || 0).toLocaleString()}`;
  document.getElementById('kpiFans').textContent = (ds?.fans.length || 0).toLocaleString();
  document.getElementById('kpiNotFollowBack').textContent = (ds?.notFollowingBack.length || 0).toLocaleString();

  const view = appState.activeView;
  if (view === 'overview') {
    renderOverview(ds);
    return;
  }
  if (view === 'diagnostics') {
    renderDiagnostics(ds);
    return;
  }

  const listMap = {
    followers: ds?.followers || [],
    unfollowers: ds?.unfollowers || [],
    new: ds?.newFollowers || [],
    fans: ds?.fans || [],
    notfollowback: ds?.notFollowingBack || [],
    following: ds?.following || []
  };

  renderListView(view, listMap[view] || []);
}

function renderOverview(ds) {
  const analyticsWrap = document.getElementById('overviewAnalytics');
  const recentWrap = document.getElementById('overviewRecentEvents');
  if (!analyticsWrap || !recentWrap) return;

  if (!ds) {
    const empty = createEmptyState(
      'No X account selected',
      'Click Add above to detect your active X login or enter a handle to begin local tracking.'
    );
    analyticsWrap.replaceChildren(empty);
    recentWrap.replaceChildren();
    return;
  }

  const realScans = (ds.snapshots || []).filter((s) => s.type !== 'followers_probe' && s.status !== 'failed');
  const events30 = (ds.events || []).filter((e) => e.at >= Date.now() - 30 * 86400_000);
  const gained30 = events30.filter((e) => e.type === 'followed' || e.type === 'refollowed').length;
  const lost30 = events30.filter((e) => e.type === 'unfollowed' || e.type === 'reunfollowed').length;
  const refollowed30 = events30.filter((e) => e.type === 'refollowed').length;
  const renamed30 = events30.filter((e) => e.type === 'renamed').length;
  const net30 = gained30 - lost30;

  // Build follower/following time series cleanly from snapshots
  let lastF = ds.followers.length;
  let lastIng = ds.following.length;
  const followerSeries = [];
  const followingSeries = [];
  for (const snap of realScans) {
    if (Number.isFinite(snap.followersCount)) lastF = snap.followersCount;
    if (Number.isFinite(snap.followingCount)) lastIng = snap.followingCount;
    followerSeries.push({ at: snap.timestamp, value: lastF });
    followingSeries.push({ at: snap.timestamp, value: lastIng });
  }

  const followerDelta = followerSeries.length >= 2
    ? followerSeries[followerSeries.length - 1].value - followerSeries[0].value
    : 0;
  const followingDelta = followingSeries.length >= 2
    ? followingSeries[followingSeries.length - 1].value - followingSeries[0].value
    : 0;

  // History card
  const historyCard = document.createElement('section');
  historyCard.className = 'section-card';

  const hHeader = document.createElement('div');
  hHeader.className = 'section-header';
  const hTitle = document.createElement('h2');
  hTitle.className = 'section-title';
  hTitle.textContent = 'Follower Trajectory';
  const hMeta = document.createElement('span');
  hMeta.className = 'section-meta tabular';
  hMeta.textContent = `${realScans.length} scan${realScans.length === 1 ? '' : 's'}`;
  hHeader.append(hTitle, hMeta);

  const metricStrip = document.createElement('div');
  metricStrip.className = 'metric-strip';
  metricStrip.append(
    buildMetricCell('Net 30d', formatSignedNumber(net30), net30 >= 0 ? 'positive' : 'negative'),
    buildMetricCell('Refollowed', refollowed30.toLocaleString(), refollowed30 > 0 ? 'positive' : ''),
    buildMetricCell('Renames Caught', renamed30.toLocaleString(), '')
  );

  const chartGrid = document.createElement('div');
  chartGrid.className = 'chart-grid';

  const fChartBox = document.createElement('div');
  const fLabel = document.createElement('div');
  fLabel.className = 'chart-label';
  fLabel.append(textNode('span', 'Followers'), textNode('span', formatSignedNumber(followerDelta), 'tabular'));
  fChartBox.append(fLabel, buildLineChartSvg(followerSeries, 'var(--chart-followers)', 'Follower count history'));

  const ingChartBox = document.createElement('div');
  const ingLabel = document.createElement('div');
  ingLabel.className = 'chart-label';
  ingLabel.append(textNode('span', 'Following'), textNode('span', formatSignedNumber(followingDelta), 'tabular'));
  ingChartBox.append(ingLabel, buildLineChartSvg(followingSeries, 'var(--chart-following)', 'Following count history'));

  chartGrid.append(fChartBox, ingChartBox);

  const activityBox = document.createElement('div');
  const actLabel = document.createElement('div');
  actLabel.className = 'chart-label';
  actLabel.append(textNode('span', 'Daily follow / unfollow events'), textNode('span', '30d', 'tabular'));
  activityBox.append(actLabel, buildActivityBarsSvg(ds.events, 30));

  historyCard.append(hHeader, metricStrip, chartGrid, activityBox);

  // Health & Quality Card
  const healthCard = document.createElement('section');
  healthCard.className = 'section-card';
  const hlHeader = document.createElement('div');
  hlHeader.className = 'section-header';
  const hlTitle = document.createElement('h2');
  hlTitle.className = 'section-title';
  hlTitle.textContent = 'Relationship Health';
  const qualityPill = document.createElement('span');
  qualityPill.className = 'pill';
  const latestQuality = ds.account.lastFollowersQuality;
  if (latestQuality === 'verified_complete' || latestQuality === 'complete') {
    qualityPill.dataset.tone = 'good';
    qualityPill.textContent = 'Verified data';
  } else if (latestQuality === 'ghost_adjusted') {
    qualityPill.dataset.tone = 'info';
    qualityPill.textContent = 'Ghost-adjusted';
  } else if (latestQuality === 'partial') {
    qualityPill.dataset.tone = 'watch';
    qualityPill.textContent = 'Partial scan';
  } else {
    qualityPill.textContent = 'Baseline pending';
  }
  hlHeader.append(hlTitle, qualityPill);

  const reciprocity = ds.following.length
    ? `${Math.round(((ds.following.length - ds.notFollowingBack.length) / ds.following.length) * 100)}%`
    : 'N/A';
  const fanShare = ds.followers.length
    ? `${Math.round((ds.fans.length / ds.followers.length) * 100)}%`
    : 'N/A';
  const verifiedShare = ds.followers.length
    ? `${Math.round((ds.followers.filter((u) => u.verified || u.isBlueVerified).length / ds.followers.length) * 100)}%`
    : 'N/A';
  const churn = ds.followers.length
    ? `${((lost30 / Math.max(1, ds.followers.length)) * 100).toFixed(1)}%`
    : 'N/A';

  const healthGrid = document.createElement('div');
  healthGrid.className = 'health-grid';
  healthGrid.append(
    buildHealthRow('Reciprocity', reciprocity),
    buildHealthRow('Fan ratio', fanShare),
    buildHealthRow('Verified followers', verifiedShare),
    buildHealthRow('30d churn', churn),
    buildHealthRow('30d gained', gained30.toLocaleString()),
    buildHealthRow('30d lost', lost30.toLocaleString())
  );
  healthCard.append(hlHeader, healthGrid);

  analyticsWrap.replaceChildren(historyCard, healthCard);

  // Clean Recent Activity (real social events only — probes live in Captures & Logs!)
  const recentSocial = [
    ...ds.unfollowers.map((u) => ({ ...u, _cardMode: 'unfollowers', _at: u.unfollowedAt || 0 })),
    ...ds.newFollowers.map((u) => ({ ...u, _cardMode: 'new', _at: u.followedAt || 0 }))
  ]
    .sort((a, b) => b._at - a._at)
    .slice(0, 6);

  if (!recentSocial.length) {
    recentWrap.replaceChildren(
      createEmptyState(
        'No relationship changes yet',
        'Run two follower scans over time to detect unfollowers, new followers, and handle renames.'
      )
    );
    return;
  }

  const recentCard = document.createElement('section');
  recentCard.className = 'section-card';
  const recHeader = document.createElement('div');
  recHeader.className = 'section-header';
  const recTitle = document.createElement('h2');
  recTitle.className = 'section-title';
  recTitle.textContent = 'Recent Changes';
  recHeader.append(recTitle, textNode('span', `Latest ${recentSocial.length}`, 'section-meta'));

  const list = document.createElement('div');
  list.className = 'user-list';
  for (const item of recentSocial) {
    list.appendChild(createUserCardElement(item, item._cardMode));
  }
  recentCard.append(recHeader, list);
  recentWrap.replaceChildren(recentCard);
}

// ================== List Views (Followers, Unfollowers, New, Fans, Not Back, Following) ==================

function filterAndSortItems(view, items) {
  const f = appState.viewFilters[view] || { query: '', verified: 'all', sort: 'default' };
  const q = (f.query || '').trim().toLowerCase();

  let list = (items || []).filter((user) => {
    if (q) {
      const hay = `${user.name || ''} ${user.username || ''} ${user.bio || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (f.verified === 'verified' && !user.verified && !user.isBlueVerified) return false;
    if (f.verified === 'unverified' && (user.verified || user.isBlueVerified)) return false;
    if (view === 'following') {
      if (f.relation === 'mutual' && !user.followsBack) return false;
      if (f.relation === 'notback' && user.followsBack) return false;
    }
    if (view === 'notfollowback' && f.hideWhitelisted && user.whitelisted) return false;
    if (view === 'unfollowers' && f.reason && f.reason !== 'all') {
      if ((user.unfollowReason || 'unfollowed') !== f.reason) return false;
    }
    return true;
  });

  if (f.sort === 'name') {
    list = list.toSorted((a, b) => (a.name || a.username || '').localeCompare(b.name || b.username || ''));
  } else if (f.sort === 'followers') {
    list = list.toSorted((a, b) => (b.followersCount || 0) - (a.followersCount || 0));
  } else if (f.sort === 'recent') {
    list = list.toSorted((a, b) => (b.unfollowedAt || b.followedAt || b.lastSeenAt || 0) - (a.unfollowedAt || a.followedAt || a.lastSeenAt || 0));
  } else if (f.sort === 'mutual') {
    list = list.toSorted((a, b) => Number(Boolean(b.followsBack)) - Number(Boolean(a.followsBack)));
  }

  return list;
}

async function renderListView(view, rawItems) {
  const panel = document.getElementById(`panel-${view}`);
  if (!panel) return;
  const gen = ++renderGeneration;
  const filterCfg = appState.viewFilters[view] || {};

  // Build search + filter toolbar once per render or reuse existing search input focus
  const existingSearch = panel.querySelector('.search-input');
  const hadFocus = existingSearch && document.activeElement === existingSearch;
  const selectionStart = existingSearch?.selectionStart ?? null;

  const toolbar = document.createElement('div');
  toolbar.className = 'list-toolbar';

  const searchLandmark = document.createElement('search');
  const searchLabel = document.createElement('label');
  searchLabel.className = 'visually-hidden';
  searchLabel.htmlFor = `search-${view}`;
  searchLabel.textContent = `Search ${view}`;

  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.id = `search-${view}`;
  searchInput.className = 'search-input';
  searchInput.placeholder = `Search @handle, name, or bio…`;
  searchInput.value = filterCfg.query || '';
  searchInput.addEventListener('input', (e) => {
    filterCfg.query = e.target.value;
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      renderListResultsOnly(view, rawItems, panel);
    }, 120);
  });

  searchLandmark.append(searchLabel, searchInput);

  const controlsRow = document.createElement('div');
  controlsRow.className = 'toolbar-controls';

  const chips = document.createElement('div');
  chips.className = 'chip-group';

  const addToggleChip = (label, pressed, onClick) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip-btn';
    btn.setAttribute('aria-pressed', String(pressed));
    btn.textContent = label;
    btn.addEventListener('click', () => {
      onClick();
      renderListView(view, rawItems);
    });
    chips.appendChild(btn);
  };

  addToggleChip('Verified', filterCfg.verified === 'verified', () => {
    filterCfg.verified = filterCfg.verified === 'verified' ? 'all' : 'verified';
  });

  if (view === 'following') {
    addToggleChip('Mutual', filterCfg.relation === 'mutual', () => {
      filterCfg.relation = filterCfg.relation === 'mutual' ? 'all' : 'mutual';
    });
    addToggleChip('Not back', filterCfg.relation === 'notback', () => {
      filterCfg.relation = filterCfg.relation === 'notback' ? 'all' : 'notback';
    });
  }

  if (view === 'notfollowback') {
    addToggleChip('Hide Kept', Boolean(filterCfg.hideWhitelisted), () => {
      filterCfg.hideWhitelisted = !filterCfg.hideWhitelisted;
    });
  }

  if (view === 'unfollowers' && rawItems.length > 0) {
    const checkReasonsBtn = document.createElement('button');
    checkReasonsBtn.type = 'button';
    checkReasonsBtn.className = 'chip-btn';
    checkReasonsBtn.textContent = 'Check Reasons (Top 10)';
    checkReasonsBtn.addEventListener('click', async () => {
      checkReasonsBtn.disabled = true;
      checkReasonsBtn.textContent = 'Checking…';
      try {
        const res = await sendMsg({
          action: 'checkUnfollowerReasons',
          accountKey: appState.currentUser,
          handles: appState.currentDisplayedItems.slice(0, 10)
        });
        showToast(`Checked ${res?.checked || 0} profiles for deactivation/suspension.`, 'success');
        await refreshAllData();
      } catch (err) {
        showToast(err?.message || 'Reason check failed.', 'error');
      }
    });
    chips.appendChild(checkReasonsBtn);
  }

  const sortSelect = document.createElement('select');
  sortSelect.className = 'compact-select';
  sortSelect.setAttribute('aria-label', 'Sort order');
  for (const [val, label] of [
    ['default', 'Default order'],
    ['recent', 'Most recent'],
    ['followers', 'Follower count'],
    ['name', 'Display name']
  ]) {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = label;
    if (filterCfg.sort === val) opt.selected = true;
    sortSelect.appendChild(opt);
  }
  sortSelect.addEventListener('change', (e) => {
    filterCfg.sort = e.target.value;
    renderListResultsOnly(view, rawItems, panel);
  });

  controlsRow.append(chips, sortSelect);
  toolbar.append(searchLandmark, controlsRow);

  const resultsSlot = document.createElement('div');
  resultsSlot.dataset.resultsSlot = view;

  panel.replaceChildren(toolbar, resultsSlot);
  if (hadFocus) {
    searchInput.focus();
    if (selectionStart !== null) {
      searchInput.setSelectionRange(selectionStart, selectionStart);
    }
  }

  await renderListResultsOnly(view, rawItems, panel, gen);
}

async function renderListResultsOnly(view, rawItems, panel, gen = ++renderGeneration) {
  const slot = panel.querySelector(`[data-results-slot="${view}"]`);
  if (!slot) return;

  const filtered = filterAndSortItems(view, rawItems);
  appState.currentDisplayedItems = filtered;

  if (!filtered.length) {
    slot.replaceChildren(
      createEmptyState(
        rawItems.length ? 'No matching accounts' : `No ${view} recorded yet`,
        rawItems.length
          ? 'Adjust your search query or filter chips.'
          : 'Run a scan from the command header to populate this list.'
      )
    );
    return;
  }

  const summary = document.createElement('div');
  summary.className = 'list-summary-bar';
  const countLabel = document.createElement('span');
  countLabel.className = 'tabular';
  countLabel.textContent =
    filtered.length === rawItems.length
      ? `${filtered.length.toLocaleString()} accounts`
      : `${filtered.length.toLocaleString()} of ${rawItems.length.toLocaleString()} accounts`;
  summary.appendChild(countLabel);

  const listEl = document.createElement('div');
  listEl.className = 'user-list';
  slot.replaceChildren(summary, listEl);

  // Chunked non-blocking rendering for huge lists (INP < 50ms!)
  const CHUNK = 60;
  for (let i = 0; i < filtered.length; i += CHUNK) {
    if (gen !== renderGeneration) return;
    const frag = document.createDocumentFragment();
    const slice = filtered.slice(i, i + CHUNK);
    for (const user of slice) {
      frag.appendChild(createUserCardElement(user, view));
    }
    listEl.appendChild(frag);
    if (i + CHUNK < filtered.length) {
      await yieldToMain();
    }
  }
}

function createUserCardElement(user, viewMode) {
  const tpl = document.getElementById('userCardTemplate');
  const node = tpl.content.firstElementChild.cloneNode(true);

  const displayName = user.name || user.username || 'Unknown';
  const handle = user.username || 'unknown';

  const avatarWrap = node.querySelector('.avatar-wrap');
  const fallbackEl = node.querySelector('.avatar-fallback');
  fallbackEl.textContent = displayName.charAt(0).toUpperCase();

  const safeAvatar = sanitizeAvatarUrl(user.avatar);
  if (safeAvatar && avatarWrap) {
    const imgEl = document.createElement('img');
    imgEl.className = 'avatar-img';
    imgEl.alt = '';
    imgEl.width = 40;
    imgEl.height = 40;
    imgEl.loading = 'lazy';
    imgEl.src = safeAvatar;
    fallbackEl.hidden = true;
    imgEl.addEventListener('error', () => {
      imgEl.remove();
      fallbackEl.hidden = false;
    });
    avatarWrap.appendChild(imgEl);
  }

  node.querySelector('.user-display-name').textContent = displayName;
  const handleEl = node.querySelector('.user-handle');
  handleEl.textContent = user.previousHandles?.length
    ? `@${handle} (was @${user.previousHandles[user.previousHandles.length - 1]})`
    : `@${handle}`;

  const verifiedPill = node.querySelector('[data-slot="verified"]');
  if (user.verified || user.isBlueVerified) {
    verifiedPill.hidden = false;
    verifiedPill.textContent = user.verifiedType || 'Verified';
  }

  const mutualPill = node.querySelector('[data-slot="mutual"]');
  if (user.followsBack && user.youFollow) {
    mutualPill.hidden = false;
  }

  const whitelistPill = node.querySelector('[data-slot="whitelist"]');
  if (user.whitelisted) {
    whitelistPill.hidden = false;
  }

  const flagPill = node.querySelector('[data-slot="flag"]');
  if (user.filterFlag) {
    flagPill.hidden = false;
    flagPill.textContent = user.filterFlag.replaceAll('_', ' ');
  }

  const bioEl = node.querySelector('.user-bio');
  if (user.bio) {
    bioEl.textContent = user.bio;
    bioEl.hidden = false;
  }

  const timelineEl = node.querySelector('.user-timeline');
  const recentEvents = (user.events || []).slice(-3);
  if (recentEvents.length) {
    timelineEl.hidden = false;
    for (const ev of recentEvents) {
      const evPill = document.createElement('span');
      evPill.className = 'pill';
      if (ev.type === 'followed' || ev.type === 'refollowed') evPill.dataset.tone = 'gain';
      else if (ev.type === 'unfollowed' || ev.type === 'reunfollowed' || ev.type === 'suspended') evPill.dataset.tone = 'loss';
      else if (ev.type === 'renamed') evPill.dataset.tone = 'info';
      evPill.textContent = `${ev.type.replaceAll('_', ' ')} ${formatRelativeTime(ev.at)}`;
      evPill.title = formatDateTime(ev.at);
      timelineEl.appendChild(evPill);
    }
  }

  const statusPill = node.querySelector('[data-slot="status"]');
  if (viewMode === 'unfollowers') {
    statusPill.hidden = false;
    statusPill.dataset.tone = 'loss';
    const r = user.unfollowReason || (user.repeatUnfollow ? 're-unfollowed' : 'unfollowed');
    statusPill.textContent = r.charAt(0).toUpperCase() + r.slice(1);
  } else if (viewMode === 'new') {
    statusPill.hidden = false;
    statusPill.dataset.tone = 'gain';
    statusPill.textContent = user.refollowed ? 'Refollowed' : 'New';
  } else if (Number.isFinite(user.followersCount)) {
    statusPill.hidden = false;
    statusPill.textContent = `${user.followersCount.toLocaleString()} flw`;
  }

  const timeEl = node.querySelector('[data-slot="time"]');
  const ts = user.unfollowedAt || user.followedAt || user.refollowedAt || user.lastSeenAt;
  if (ts) {
    timeEl.hidden = false;
    timeEl.textContent = formatRelativeTime(ts);
    timeEl.title = formatDateTime(ts);
  }

  const keepBtn = node.querySelector('[data-action="whitelist"]');
  keepBtn.textContent = user.whitelisted ? 'Kept' : 'Keep';
  keepBtn.setAttribute('aria-pressed', String(Boolean(user.whitelisted)));
  keepBtn.addEventListener('click', async () => {
    if (!appState.currentUser) return;
    await toggleWhitelist(appState.currentUser, user.id);
    await refreshAllData();
  });

  const openBtn = node.querySelector('[data-action="open"]');
  openBtn.addEventListener('click', async () => {
    const url = `https://x.com/${encodeURIComponent(handle)}`;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      await chrome.tabs.update(tab.id, { url });
      showToast(`Opened @${handle}`, 'info', 1800);
    }
  });

  return node;
}

// ================== Diagnostics, Telemetry Logs & Passive Captures View ==================

function getLogLevelTone(level) {
  if (level === 'error') return 'loss';
  if (level === 'warn') return 'watch';
  if (level === 'info') return 'gain';
  return '';
}

async function refreshLogsCard(logListEl) {
  if (!logListEl) return;
  const filterVal = appState.logFilter || 'all';
  const logs = await listAppLogs({
    limit: 250,
    level: filterVal === 'warn_error' || filterVal === 'error' ? filterVal : 'all',
    source: filterVal === 'main' ? 'main' : 'all'
  });

  if (!logs.length) {
    logListEl.replaceChildren(
      createEmptyState('No logs recorded yet', 'Scan lifecycle, GraphQL endpoints, and errors are logged here automatically.')
    );
    return;
  }

  const rows = logs.map((entry) => {
    const row = document.createElement('div');
    row.className = 'log-row';

    const head = document.createElement('div');
    head.className = 'log-row-head';

    const title = document.createElement('span');
    title.className = 'log-row-title';
    const timeStr = new Date(entry.at).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    title.textContent = `[${timeStr}] ${entry.event} · ${entry.message}`;

    const pills = document.createElement('div');
    pills.style.display = 'flex';
    pills.style.gap = '4px';
    const srcPill = textNode('span', entry.source, 'pill');
    const lvlPill = textNode('span', entry.level.toUpperCase(), 'pill');
    const tone = getLogLevelTone(entry.level);
    if (tone) lvlPill.dataset.tone = tone;
    pills.append(srcPill, lvlPill);

    head.append(title, pills);
    row.appendChild(head);

    if (entry.meta || entry.accountKey) {
      const metaText = [];
      if (entry.accountKey) metaText.push(`@${entry.accountKey}`);
      if (entry.scanId) metaText.push(entry.scanId);
      if (entry.meta) metaText.push(JSON.stringify(entry.meta));
      row.appendChild(textNode('div', metaText.join(' · '), 'log-row-meta'));
    }

    return row;
  });

  logListEl.replaceChildren(...rows);
}

async function renderDiagnostics(ds) {
  const panel = document.getElementById('panel-diagnostics');
  if (!panel) return;

  // App & Scan Runtime Logs Card (available even before selecting/adding an account!)
  const runtimeCard = document.createElement('section');
  runtimeCard.className = 'section-card';

  const runtimeHeader = document.createElement('div');
  runtimeHeader.className = 'section-header';
  runtimeHeader.append(
    textNode('h2', 'App & Scan Runtime Logs', 'section-title'),
    textNode('span', 'IndexedDB telemetry', 'section-meta')
  );

  const runtimeHint = document.createElement('p');
  runtimeHint.className = 'field-hint';
  runtimeHint.textContent =
    'Captures scan phases, observed X GraphQL operations, timeouts, and errors locally. Export or copy the bundle to diagnose edge cases.';

  const toolbar = document.createElement('div');
  toolbar.className = 'log-toolbar';

  const filterSelect = document.createElement('select');
  filterSelect.className = 'compact-select';
  filterSelect.setAttribute('aria-label', 'Filter runtime logs');
  [
    ['all', 'All events'],
    ['warn_error', 'Warnings & Errors'],
    ['error', 'Errors only'],
    ['main', 'Network / X Ops']
  ].forEach(([val, lbl]) => {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = lbl;
    filterSelect.appendChild(opt);
  });
  filterSelect.value = appState.logFilter || 'all';

  const logListEl = document.createElement('div');
  logListEl.className = 'log-list';
  logListEl.id = 'runtimeLogsList';

  filterSelect.addEventListener('change', () => {
    appState.logFilter = filterSelect.value;
    void refreshLogsCard(logListEl);
  });

  const copyBtn = textNode('button', 'Copy Bundle', 'btn-subtle');
  copyBtn.type = 'button';
  copyBtn.style.minBlockSize = '30px';
  copyBtn.style.padding = '0.25rem 0.625rem';
  copyBtn.addEventListener('click', async () => {
    try {
      const rt = await sendMsg({ action: 'getRuntimeDiagnostics' }).catch(() => ({}));
      const bundle = await buildDiagnosticReport({
        accountKey: appState.currentUser,
        runtime: rt?.runtime || null
      });
      await navigator.clipboard.writeText(JSON.stringify(bundle, null, 2));
      showToast('Diagnostic log bundle copied to clipboard.', 'success');
    } catch (err) {
      showToast(err?.message || 'Clipboard write failed — try Download instead.', 'warn');
    }
  });

  const downloadBtn = textNode('button', 'Download JSON', 'btn-subtle');
  downloadBtn.type = 'button';
  downloadBtn.style.minBlockSize = '30px';
  downloadBtn.style.padding = '0.25rem 0.625rem';
  downloadBtn.addEventListener('click', async () => {
    const rt = await sendMsg({ action: 'getRuntimeDiagnostics' }).catch(() => ({}));
    await exportDiagnosticsReport({
      accountKey: appState.currentUser,
      runtime: rt?.runtime || null
    });
    showToast('Diagnostics JSON downloaded.', 'success');
  });

  const clearBtn = textNode('button', 'Clear', 'btn-subtle');
  clearBtn.type = 'button';
  clearBtn.style.minBlockSize = '30px';
  clearBtn.style.padding = '0.25rem 0.625rem';
  clearBtn.addEventListener('click', async () => {
    await sendMsg({ action: 'clearAppLogs' }).catch(() => clearAppLogs());
    await refreshLogsCard(logListEl);
    showToast('Runtime logs cleared.', 'info');
  });

  toolbar.append(filterSelect, copyBtn, downloadBtn, clearBtn);
  runtimeCard.append(runtimeHeader, runtimeHint, toolbar, logListEl);

  const cards = [runtimeCard];

  if (ds) {
    // Passive Capture Card
    const capCard = document.createElement('section');
    capCard.className = 'section-card';
    const capHeader = document.createElement('div');
    capHeader.className = 'section-header';
    capHeader.append(
      textNode('h2', 'Passive Session Captures', 'section-title'),
      textNode('span', `${ds.captures.length} saved`, 'section-meta tabular')
    );

    const capHint = document.createElement('p');
    capHint.className = 'field-hint';
    capHint.textContent =
      'Click Capture in the header while browsing Threads, Search, Bookmarks, or Feeds on X to record matching authors/posts locally.';

    const capList = document.createElement('div');
    capList.className = 'user-list';
    for (const item of ds.captures.slice(0, 20)) {
      const row = document.createElement('div');
      row.className = 'health-row';
      const left = document.createElement('span');
      left.textContent = `[${item.scope}] @${item.author?.username || 'unknown'}: ${(item.text || '').slice(0, 80)}`;
      const right = document.createElement('span');
      right.className = 'section-meta tabular';
      right.textContent = formatRelativeTime(item.capturedAt);
      row.append(left, right);
      capList.appendChild(row);
    }
    capCard.append(capHeader, capHint, capList);

    // Scan History & Probe Diagnostics Card
    const logCard = document.createElement('section');
    logCard.className = 'section-card';
    const logHeader = document.createElement('div');
    logHeader.className = 'section-header';
    logHeader.append(
      textNode('h2', 'Scan & Probe History', 'section-title'),
      textNode('span', `${ds.snapshots.length} entries`, 'section-meta tabular')
    );

    const logList = document.createElement('div');
    logList.className = 'user-list';
    for (const snap of ds.snapshots.slice(-15).reverse()) {
      const row = document.createElement('div');
      row.className = 'health-row';

      const left = document.createElement('span');
      const expectedText = Number.isFinite(snap.expected) ? `/${snap.expected.toLocaleString()}` : '';
      const countText = Number.isFinite(snap.count) ? `${snap.count.toLocaleString()}${expectedText}` : 'n/a';
      left.textContent = `${snap.type} (${snap.source || 'manual'}) · ${countText}${snap.reason ? ` — ${snap.reason}` : ''}`;

      const badge = document.createElement('span');
      badge.className = 'pill';
      badge.textContent = snap.status || 'complete';
      if (snap.status === 'failed') badge.dataset.tone = 'loss';
      else if (snap.status === 'verified_complete') badge.dataset.tone = 'gain';
      else if (snap.status === 'partial') badge.dataset.tone = 'watch';

      row.append(left, badge);
      logList.appendChild(row);
    }
    logCard.append(logHeader, logList);
    cards.push(capCard, logCard);
  }

  panel.replaceChildren(...cards);
  await refreshLogsCard(logListEl);
}

// ================== DOM Utility Constructors ==================

function textNode(tag, content, className = '') {
  const el = document.createElement(tag);
  if (className) el.className = className;
  el.textContent = content;
  return el;
}

function buildMetricCell(label, value, tone = '') {
  const cell = document.createElement('div');
  cell.className = 'metric-cell';
  const lbl = textNode('div', label, 'metric-cell-label');
  const val = textNode('div', value, 'metric-cell-value tabular');
  if (tone) val.dataset.tone = tone;
  cell.append(lbl, val);
  return cell;
}

function buildHealthRow(label, value) {
  const row = document.createElement('div');
  row.className = 'health-row';
  row.append(textNode('span', label, 'health-label'), textNode('span', value, 'health-value tabular'));
  return row;
}

function createEmptyState(title, message) {
  const wrap = document.createElement('div');
  wrap.className = 'empty-state';
  wrap.append(textNode('div', title, 'empty-state-title'), textNode('p', message, 'empty-state-text'));
  return wrap;
}

// ================== Actions & Settings ==================

async function triggerScan(scanType, resumeScanId = null) {
  if (!appState.currentUser) {
    showToast('Add an X account first.', 'warn');
    await handleAddAccountFlow();
    return;
  }

  const res = await sendMsg({
    action: 'startScan',
    username: appState.currentUser,
    scanType,
    scanSource: 'manual',
    resumeScanId
  });

  if (res?.status === 'error') {
    showToast(res.message || 'Could not start scan.', 'error');
  } else {
    showToast(`Started ${SCAN_SCOPES[scanType]?.label || scanType} scan for @${appState.currentUser}`, 'info');
  }
}

async function handleAddAccountFlow() {
  const handle = await openAddAccountDialog(async () => {
    const res = await sendMsg({ action: 'detectActiveXAccount' });
    return res?.account || null;
  });

  if (!handle) return;
  await upsertAccount(handle);
  await setLocalStorage({ [STORAGE_KEYS.currentUser]: handle });
  await refreshAllData();
  showToast(`Added @${handle}`, 'success');
}

async function openSettingsModal() {
  const dlg = document.getElementById('settingsDialog');
  const form = document.getElementById('settingsForm');
  const s = await getSettings();
  const autoMeta = await sendMsg({ action: 'getAutoScanSettings' }).catch(() => ({}));

  document.getElementById('settingTheme').value = s.theme || 'system';
  document.getElementById('settingScanTabMode').value = s.scanTabMode || 'dedicated';
  document.getElementById('settingAutoScanEnabled').checked = Boolean(s.autoScanEnabled);
  document.getElementById('settingAutoScanInterval').value = String(s.autoScanIntervalMinutes || 120);
  document.getElementById('settingNotifications').checked = Boolean(s.notificationsEnabled);
  document.getElementById('settingInPageBadge').checked = Boolean(s.inPageBadgeEnabled);
  document.getElementById('filterVerifiedMode').value = s.preSaveFilters?.verifiedMode || 'all';
  document.getElementById('filterExcludeDefaultAvatar').checked = Boolean(s.preSaveFilters?.excludeDefaultAvatar);
  document.getElementById('filterMinFollowers').value = String(s.preSaveFilters?.minFollowers || 0);
  document.getElementById('filterBioKeywords').value = (s.preSaveFilters?.excludeBioKeywords || []).join(', ');

  const metaEl = document.getElementById('settingsAutoScanMeta');
  if (metaEl) {
    if (!s.autoScanEnabled) metaEl.textContent = 'Auto-scan is off';
    else if (autoMeta?.autoScanCooldownUntil > Date.now()) {
      metaEl.textContent = `Cooldown until ${formatDateTime(autoMeta.autoScanCooldownUntil)}`;
    } else if (autoMeta?.autoScanNextRunAt) {
      metaEl.textContent = `Next check ${formatDateTime(autoMeta.autoScanNextRunAt)}`;
    } else {
      metaEl.textContent = 'Auto-scan scheduled';
    }
  }

  const onSubmit = async () => {
    const nextSettings = {
      theme: document.getElementById('settingTheme').value,
      scanTabMode: document.getElementById('settingScanTabMode').value,
      notificationsEnabled: document.getElementById('settingNotifications').checked,
      inPageBadgeEnabled: document.getElementById('settingInPageBadge').checked,
      preSaveFilters: {
        verifiedMode: document.getElementById('filterVerifiedMode').value,
        excludeDefaultAvatar: document.getElementById('filterExcludeDefaultAvatar').checked,
        minFollowers: Math.max(0, Number(document.getElementById('filterMinFollowers').value) || 0),
        excludeBioKeywords: document
          .getElementById('filterBioKeywords')
          .value.split(',')
          .map((k) => k.trim())
          .filter(Boolean)
      }
    };

    await saveSettings(nextSettings);
    await sendMsg({
      action: 'setAutoScanSettings',
      settings: {
        autoScanEnabled: document.getElementById('settingAutoScanEnabled').checked,
        autoScanIntervalMinutes: Number(document.getElementById('settingAutoScanInterval').value) || 120
      }
    });

    applyTheme(nextSettings.theme);
    appState.settings = await getSettings();
    showToast('Settings saved', 'success');
  };

  form.addEventListener('submit', onSubmit, { once: true });
  dlg.showModal();
}

function setupEventHandlers() {
  initDialogs();
  setupPopoverAnchors();
  setupTabs();

  document.getElementById('openAddAccountBtn')?.addEventListener('click', handleAddAccountFlow);
  document.getElementById('menuAddAccountBtn')?.addEventListener('click', () => {
    document.getElementById('accountMenuPopover')?.hidePopover();
    handleAddAccountFlow();
  });

  document.getElementById('menuDetectAccountBtn')?.addEventListener('click', async () => {
    document.getElementById('accountMenuPopover')?.hidePopover();
    const res = await sendMsg({ action: 'detectActiveXAccount' });
    if (res?.account?.username) {
      await upsertAccount(res.account.username, res.account);
      await setLocalStorage({ [STORAGE_KEYS.currentUser]: res.account.username });
      await refreshAllData();
      showToast(`Detected @${res.account.username}`, 'success');
    } else if (res?.reason === 'not_logged_in') {
      showToast('X tab is signed out. Log in to x.com first.', 'warn');
    } else {
      showToast(res?.message || 'No logged-in X session detected.', 'warn');
    }
  });

  document.getElementById('scanFollowersBtn')?.addEventListener('click', () => triggerScan('followers'));
  document.getElementById('scanFollowingBtn')?.addEventListener('click', () => triggerScan('following'));

  document.querySelectorAll('[data-scan-scope]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.getElementById('scanScopesPopover')?.hidePopover();
      triggerScan(btn.getAttribute('data-scan-scope'));
    });
  });

  document.getElementById('scanSyncBothBtn')?.addEventListener('click', async () => {
    document.getElementById('scanScopesPopover')?.hidePopover();
    await triggerScan('followers');
    showToast('Followers scan started. Run Following next once complete.', 'info');
  });

  document.getElementById('pauseResumeScanBtn')?.addEventListener('click', async (e) => {
    const isResume = e.currentTarget.textContent === 'Resume';
    await sendMsg({ action: isResume ? 'resumeScan' : 'pauseScan' });
  });

  document.getElementById('stopScanBtn')?.addEventListener('click', async () => {
    await sendMsg({ action: 'stopScan' });
  });

  document.getElementById('forceResetScanBtn')?.addEventListener('click', async () => {
    await sendMsg({ action: 'forceResetScan' });
    showToast('Scan state reset.', 'info');
  });

  document.getElementById('resumeCheckpointBtn')?.addEventListener('click', async () => {
    const cp = appState.dataset?.checkpoints?.[0];
    if (cp) await triggerScan(cp.scanType, cp.scanId);
  });

  document.getElementById('discardCheckpointBtn')?.addEventListener('click', async () => {
    const cp = appState.dataset?.checkpoints?.[0];
    if (cp) {
      await deleteCheckpoint(cp.scanId);
      await refreshAllData();
      showToast('Checkpoint discarded.', 'info');
    }
  });

  document.getElementById('openSettingsBtn')?.addEventListener('click', openSettingsModal);

  document.getElementById('runAutoScanNowBtn')?.addEventListener('click', async () => {
    const res = await sendMsg({ action: 'runAutoScanNow' });
    if (res?.status === 'probe_only') {
      showToast('Profile follower count unchanged — full scroll skipped.', 'info');
      await refreshAllData();
    } else if (res?.status === 'scanning') {
      document.getElementById('settingsDialog')?.close('');
      showToast('Scheduled follower scan started.', 'success');
    } else {
      showToast(res?.message || `Auto check: ${res?.reason || res?.status}`, 'warn');
    }
  });

  document.getElementById('themeToggleBtn')?.addEventListener('click', async () => {
    const order = ['system', 'dark', 'light'];
    const cur = appState.settings?.theme || 'system';
    const next = order[(order.indexOf(cur) + 1) % order.length];
    appState.settings = await saveSettings({ theme: next });
    applyTheme(next);
    showToast(`Theme: ${next}`, 'info', 1600);
  });

  document.getElementById('passiveCaptureBtn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const nextActive = !appState.passiveCaptureActive;
    const scopes = nextActive ? ['profile', 'thread', 'search', 'bookmarks', 'feed'] : [];
    const res = await sendMsg({ action: 'togglePassiveCapture', scopes });
    if (res?.status === 'ok') {
      appState.passiveCaptureActive = nextActive;
      btn.setAttribute('aria-pressed', String(nextActive));
      showToast(
        nextActive ? 'Passive capture enabled on active X tab.' : 'Passive capture stopped.',
        nextActive ? 'success' : 'info'
      );
    } else {
      showToast(res?.message || 'Open an x.com tab first.', 'warn');
    }
  });

  // KPI cards jump cleanly to matching views (including Followers!)
  document.querySelectorAll('[data-jump-view]').forEach((card) => {
    card.addEventListener('click', () => {
      switchView(card.getAttribute('data-jump-view'));
    });
  });

  // Export & Import actions
  document.querySelectorAll('[data-export-format]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      document.getElementById('exportMenuPopover')?.hidePopover();
      const fmt = btn.getAttribute('data-export-format');
      if (fmt === 'csv-current') {
        const view = appState.activeView;
        const items = appState.currentDisplayedItems.length
          ? appState.currentDisplayedItems
          : (appState.dataset?.followers || []);
        exportViewCsv({ accountHandle: appState.currentUser, viewName: view, items });
        showToast('CSV exported', 'success');
      } else if (fmt === 'markdown') {
        exportMarkdownAudit(appState.dataset);
        showToast('Markdown audit report exported', 'success');
      } else if (fmt === 'json-account') {
        if (!appState.currentUser) return showToast('Select an account first.', 'warn');
        await exportJsonArchive(appState.currentUser);
        showToast('Account backup exported', 'success');
      } else if (fmt === 'json-all') {
        await exportJsonArchive(null);
        showToast('Full archive backup exported', 'success');
      }
    });
  });

  const fileInput = document.getElementById('importJsonInput');
  document.getElementById('openImportBtn')?.addEventListener('click', () => {
    document.getElementById('exportMenuPopover')?.hidePopover();
    fileInput?.click();
  });

  fileInput?.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;

    const replace = await showConfirmDialog({
      title: 'Restore Backup Archive',
      message: 'Replace existing local data with this backup? Click Cancel to abort, or Confirm to restore.',
      confirmLabel: 'Restore Backup'
    });
    if (!replace) return;

    try {
      const summary = await importJsonFile(file, { replace: true });
      await refreshAllData();
      showToast(
        `Restored ${summary.accountsImported} account(s) and ${summary.profilesImported} profiles.`,
        'success'
      );
    } catch (err) {
      showToast(err?.message || 'Backup import failed.', 'error');
    }
  });

  // Capture unexpected UI errors into local diagnostic logs
  window.addEventListener('error', (event) => {
    appendAppLog({
      source: 'ui',
      level: 'error',
      event: 'ui.error',
      accountKey: appState.currentUser || null,
      message: event?.message || 'Unexpected Side Panel error',
      meta: { filename: event?.filename || null, lineno: event?.lineno || null }
    }).catch(() => {});
  });

  window.addEventListener('unhandledrejection', (event) => {
    const err = event?.reason;
    appendAppLog({
      source: 'ui',
      level: 'error',
      event: 'ui.unhandled_rejection',
      accountKey: appState.currentUser || null,
      message: err?.message || String(err || 'Unhandled promise rejection')
    }).catch(() => {});
  });

  // Reactive storage updates (eliminates 1-second polling!)
  if (HAS_EXTENSION_API) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return;
      if (changes[STORAGE_KEYS.scanState]) {
        renderLiveScanState(changes[STORAGE_KEYS.scanState].newValue);
        const next = changes[STORAGE_KEYS.scanState].newValue;
        if (next?.status === 'error' && next?.error) {
          showToast(next.error, 'error', 4500);
        } else if (next?.status === 'complete') {
          showToast('Scan completed and saved locally.', 'success');
        }
      }
      if (changes[STORAGE_KEYS.lastDbMutationAt] || changes[STORAGE_KEYS.currentUser]) {
        refreshAllData();
      } else if (changes[STORAGE_KEYS.lastLogMutationAt] && appState.activeView === 'diagnostics') {
        const logListEl = document.getElementById('runtimeLogsList');
        if (logListEl) {
          void refreshLogsCard(logListEl);
        }
      }
    });
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  setupEventHandlers();
  await refreshAllData();
});
