/**
 * X-Unfollow Tracker - Popup UI Script
 * Premium dashboard with trend charts, event timelines, health scores, and settings
 */

// ================== Access Data Module ==================
const {
  getDefaultSettings,
  normalizeUsername,
  getFollowerTrend,
  getFollowingTrend,
  getRecentEvents,
  getAccountHealth,
  getDailyChanges,
  DEFAULT_SCAN_INTERVAL_HOURS,
  MIN_SCAN_INTERVAL_HOURS,
  MAX_SCAN_INTERVAL_HOURS
} = self.DataModule;

// ================== State ==================
let currentView = 'dashboard';
let currentUser = null;
let userList = [];
let monitoringInterval = null;
let chartPeriod = 14;
let filterState = { following: 'all', events: 'all' };
let searchState = {};

// ================== Init ==================
document.addEventListener('DOMContentLoaded', () => {
  loadUserData();
  setupEventListeners();
});

async function loadUserData() {
  const data = await getFromStorage(['users', 'currentUser', 'userList', 'scanStatus', 'lastScanTime', 'settings']);

  currentUser = data.currentUser;
  userList = data.userList || [];

  if (!userList.length && currentUser) userList = [currentUser];
  if (currentUser && !userList.includes(currentUser)) userList.unshift(currentUser);

  await chrome.storage.local.set({ userList });

  updateUserDropdown();
  updateStatusBar();
  renderCurrentView();

  // Start monitoring if scanning
  if (data.scanStatus === 'scanning') {
    startMonitoring();
  }
}

// ================== Storage Helpers ==================
function getFromStorage(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}

function sendMessage(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, resp => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(resp);
    });
  });
}

// ================== User Management ==================
function updateUserDropdown() {
  const display = document.getElementById('currentUserDisplay');
  const menuItems = document.getElementById('userMenuItems');

  if (display) display.textContent = currentUser ? `@${currentUser}` : 'Select account';
  if (!menuItems) return;

  menuItems.innerHTML = '';

  chrome.storage.local.get(['users'], result => {
    const users = result.users || {};

    userList.forEach(username => {
      const ud = users[username] || {};
      const fc = (ud.followers || []).length;
      const fgc = (ud.following || []).length;
      let stats = '';
      if (fc > 0) stats += `${fc.toLocaleString()} followers`;
      if (fgc > 0) stats += (stats ? ' · ' : '') + `${fgc.toLocaleString()} following`;
      if (!stats) stats = 'Not scanned';

      const item = document.createElement('div');
      item.className = 'user-menu-item' + (username === currentUser ? ' active' : '');
      item.innerHTML = `
        <div class="user-menu-item-content">
          <span>@${esc(username)}</span>
          <span class="user-menu-stats">${stats}</span>
        </div>
        <button class="remove-user-btn" data-username="${esc(username)}" onclick="event.stopPropagation()">✕</button>
      `;

      item.addEventListener('click', e => {
        if (!e.target.classList.contains('remove-user-btn')) switchUser(username);
      });
      item.querySelector('.remove-user-btn').addEventListener('click', () => removeUser(username));

      menuItems.appendChild(item);
    });
  });
}

function switchUser(username) {
  if (username === currentUser) return closeMenu();
  currentUser = username;
  chrome.storage.local.set({ currentUser: username });
  updateUserDropdown();
  closeMenu();
  renderCurrentView();
  showToast(`Switched to @${username}`, 'success');
}

async function removeUser(username) {
  if (userList.length === 1) return showToast('Cannot remove last account', 'warning');
  if (!confirm(`Remove @${username}? All data will be deleted.`)) return;

  userList = userList.filter(u => u !== username);
  const data = await getFromStorage(['users']);
  const users = data.users || {};
  delete users[username];

  await chrome.storage.local.set({ users, userList });

  if (currentUser === username) {
    currentUser = userList[0];
    await chrome.storage.local.set({ currentUser });
  }

  updateUserDropdown();
  renderCurrentView();
  showToast(`Removed @${username}`, 'success');
}

async function promptAddUser() {
  const username = prompt('Enter X username (without @):');
  if (!username) return;

  const clean = username.replace('@', '').trim().toLowerCase();
  if (!clean || !/^[a-zA-Z0-9_]{1,15}$/.test(clean)) {
    return showToast('Invalid username', 'error');
  }

  if (userList.includes(clean)) {
    showToast('Already tracking', 'warning');
    return switchUser(clean);
  }

  userList.push(clean);
  currentUser = clean;
  await chrome.storage.local.set({ userList, currentUser: clean });

  updateUserDropdown();
  closeMenu();
  renderCurrentView();
  showToast(`Added @${clean}`, 'success');
}

function toggleMenu() {
  const menu = document.getElementById('userMenu');
  const dropdown = document.getElementById('userDropdown');
  if (menu && dropdown) {
    if (!menu.classList.contains('open')) updateUserDropdown();
    menu.classList.toggle('open');
    dropdown.classList.toggle('open');
  }
}

function closeMenu() {
  document.getElementById('userMenu')?.classList.remove('open');
  document.getElementById('userDropdown')?.classList.remove('open');
}

// ================== Status Bar ==================
async function updateStatusBar() {
  try {
    const resp = await sendMessage({ action: 'getStatus' });
    const dot = document.getElementById('statusDot');
    const text = document.getElementById('statusText');
    const lastScan = document.getElementById('lastScanText');

    if (dot) {
      dot.className = 'status-dot';
      if (resp.scanStatus === 'scanning') dot.classList.add('scanning');
      else if (resp.scanStatus === 'paused') dot.classList.add('paused');
      else if (resp.scanStatus === 'error') dot.classList.add('error');
    }

    if (text) {
      if (resp.scanStatus === 'scanning') text.textContent = 'Scanning...';
      else if (resp.scanStatus === 'paused') text.textContent = 'Paused — login required';
      else if (resp.scanStatus === 'error') text.textContent = 'Error';
      else if (resp.scanStatus === 'complete') text.textContent = 'Complete';
      else text.textContent = resp.isLoggedIn ? 'Ready' : 'Not logged in';
    }

    if (lastScan) {
      if (resp.lastScanTime) {
        lastScan.textContent = `Last: ${formatTime(resp.lastScanTime)}`;
        if (resp.nextScanTime) {
          const nextIn = Math.max(0, Math.round((resp.nextScanTime - Date.now()) / 60000));
          lastScan.textContent += ` · Next: ${nextIn}m`;
        }
      } else {
        lastScan.textContent = 'Never scanned';
      }
    }

    // Progress bar
    if (resp.scanStatus === 'scanning' && resp.scanProgress) {
      showProgress(resp.scanProgress);
    }
  } catch (e) {
    // Service worker may not be ready yet
  }
}

function showProgress(pct) {
  const bar = document.getElementById('progressBar');
  const fill = document.getElementById('progressFill');
  if (bar) bar.style.display = 'block';
  if (fill) fill.style.width = `${pct}%`;
}

function hideProgress() {
  const bar = document.getElementById('progressBar');
  if (bar) setTimeout(() => { bar.style.display = 'none'; }, 1000);
}

// ================== Scanning ==================
async function scanNow() {
  if (!currentUser) return showToast('Add an account first', 'warning');

  const btn = document.getElementById('scanNowBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Scanning...'; }

  try {
    const resp = await sendMessage({ action: 'manualScan', username: currentUser, scanType: 'both' });
    if (resp?.status === 'scanning') {
      startMonitoring();
      showToast('Scan started', 'info');
    } else if (resp?.status === 'error') {
      showToast(resp.message || 'Scan failed', 'error');
      resetScanBtn();
    }
  } catch (e) {
    showToast(e.message || 'Failed to start scan', 'error');
    resetScanBtn();
  }
}

function resetScanBtn() {
  const btn = document.getElementById('scanNowBtn');
  if (btn) { btn.disabled = false; btn.textContent = '⚡ Scan Now'; }
}

function startMonitoring() {
  if (monitoringInterval) clearInterval(monitoringInterval);
  let elapsed = 0;

  monitoringInterval = setInterval(async () => {
    elapsed++;
    if (elapsed >= 600) {
      clearInterval(monitoringInterval);
      monitoringInterval = null;
      resetScanBtn();
      hideProgress();
      return;
    }

    const data = await getFromStorage(['scanStatus', 'scanProgress']);

    if (data.scanProgress) showProgress(data.scanProgress);

    if (data.scanStatus === 'complete') {
      clearInterval(monitoringInterval);
      monitoringInterval = null;
      resetScanBtn();
      hideProgress();
      await loadUserData();
      showToast('Scan complete!', 'success');
    } else if (data.scanStatus === 'error' || data.scanStatus === 'idle') {
      clearInterval(monitoringInterval);
      monitoringInterval = null;
      resetScanBtn();
      hideProgress();
      if (data.scanStatus === 'error') showToast('Scan failed', 'error');
    }

    updateStatusBar();
  }, 2000);
}

// ================== View Management ==================
function switchView(view) {
  currentView = view;

  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));

  const views = ['dashboardView', 'eventsView', 'unfollowersView', 'newFollowersView', 'fansView', 'notFollowingBackView', 'followingView', 'settingsView'];
  const viewMap = {
    dashboard: 'dashboardView', events: 'eventsView', unfollowers: 'unfollowersView',
    new: 'newFollowersView', fans: 'fansView', notfollowback: 'notFollowingBackView',
    following: 'followingView', settings: 'settingsView'
  };

  views.forEach(v => {
    const el = document.getElementById(v);
    if (el) el.style.display = v === viewMap[view] ? 'block' : 'none';
  });

  renderCurrentView();
}

function renderCurrentView() {
  if (!currentUser) {
    renderEmptyAccount();
    return;
  }

  chrome.storage.local.get(['users', 'settings'], result => {
    const users = result.users || {};
    const userData = users[currentUser] || {};
    const settings = result.settings || getDefaultSettings();

    switch (currentView) {
      case 'dashboard': renderDashboard(userData); break;
      case 'events': renderEvents(userData); break;
      case 'unfollowers': renderUnfollowers(userData); break;
      case 'new': renderNewFollowers(userData); break;
      case 'fans': renderFans(userData); break;
      case 'notfollowback': renderNotFollowingBack(userData); break;
      case 'following': renderFollowing(userData); break;
      case 'settings': renderSettings(settings); break;
    }
  });
}

function renderEmptyAccount() {
  const container = document.getElementById('dashboardView');
  if (container) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🔍</div>
        <div class="empty-title">No Account Selected</div>
        <div class="empty-text">Click the dropdown above to add your X username and start tracking.</div>
      </div>
    `;
  }
}

// ================== Dashboard ==================
function renderDashboard(userData) {
  const container = document.getElementById('dashboardView');
  if (!container) return;

  const followers = (userData.followers || []).filter(f => f && f.username);
  const following = (userData.following || []).filter(f => f && f.username);
  const unfollowers = (userData.unfollowers || []).filter(f => f && f.username);
  const newFollowers = (userData.newFollowers || []).filter(f => f && f.username);
  const fans = (userData.fansList || []).filter(f => f && f.username);
  const notBack = (userData.notFollowingBack || []).filter(f => f && f.username);

  const health = getAccountHealth(userData);
  const trend = getFollowerTrend(userData, chartPeriod);
  const events = getRecentEvents(userData, 8);

  let html = '';

  // Stats Grid
  html += `
    <div class="stats-grid">
      <div class="stat-card blue" data-view="dashboard">
        <div class="stat-label">👥 Followers</div>
        <div class="stat-value">${followers.length.toLocaleString()}</div>
        ${renderSparkline(trend.map(t => t.count), '#3b82f6')}
      </div>
      <div class="stat-card purple" data-view="following">
        <div class="stat-label">🔗 Following</div>
        <div class="stat-value">${following.length.toLocaleString()}</div>
      </div>
      <div class="stat-card red" data-view="unfollowers">
        <div class="stat-label">➖ Lost</div>
        <div class="stat-value" style="color:var(--accent-red)">${unfollowers.length}</div>
      </div>
      <div class="stat-card green" data-view="new">
        <div class="stat-label">➕ New</div>
        <div class="stat-value" style="color:var(--accent-green)">+${newFollowers.length}</div>
      </div>
      <div class="stat-card amber" data-view="fans">
        <div class="stat-label">⭐ Fans</div>
        <div class="stat-value" style="color:var(--accent-amber)">${fans.length}</div>
      </div>
      <div class="stat-card cyan" data-view="notfollowback">
        <div class="stat-label">❌ No Back</div>
        <div class="stat-value" style="color:var(--accent-cyan)">${notBack.length}</div>
      </div>
    </div>
  `;

  // Health Score
  html += renderHealthSection(health);

  // Trend Chart
  if (trend.length > 1) {
    html += `
      <div class="chart-container">
        <div class="chart-header">
          <div class="chart-title">Follower Trend</div>
          <div class="chart-period">
            <button class="chart-period-btn ${chartPeriod === 7 ? 'active' : ''}" data-period="7">7d</button>
            <button class="chart-period-btn ${chartPeriod === 14 ? 'active' : ''}" data-period="14">14d</button>
            <button class="chart-period-btn ${chartPeriod === 30 ? 'active' : ''}" data-period="30">30d</button>
          </div>
        </div>
        <canvas id="trendChart" class="chart-canvas" width="440" height="120"></canvas>
      </div>
    `;
  }

  // Recent Events
  html += renderRecentTimeline(events);

  container.innerHTML = html;

  // Draw chart after DOM update
  if (trend.length > 1) {
    requestAnimationFrame(() => drawTrendChart('trendChart', trend));
  }

  // Attach stat card click handlers
  container.querySelectorAll('.stat-card[data-view]').forEach(card => {
    card.addEventListener('click', () => switchView(card.dataset.view));
  });

  // Chart period buttons
  container.querySelectorAll('.chart-period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      chartPeriod = parseInt(btn.dataset.period);
      renderCurrentView();
    });
  });
}

// ================== Sparkline ==================
function renderSparkline(values, color) {
  if (!values || values.length < 2) return '';
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const h = 24;
  const w = 80;
  const step = w / (values.length - 1);

  let path = '';
  values.forEach((v, i) => {
    const x = i * step;
    const y = h - ((v - min) / range) * (h - 4) - 2;
    path += (i === 0 ? `M${x},${y}` : ` L${x},${y}`);
  });

  return `
    <svg class="stat-sparkline" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      <path d="${path}" fill="none" stroke="${color}" stroke-width="1.5" opacity="0.6"/>
    </svg>
  `;
}

// ================== Health Section ==================
function renderHealthSection(health) {
  const score = health.score;
  const circumference = 2 * Math.PI * 34;
  const dashOffset = circumference - (score / 100) * circumference;

  let color = 'var(--accent-green)';
  if (score < 40) color = 'var(--accent-red)';
  else if (score < 60) color = 'var(--accent-amber)';
  else if (score < 80) color = 'var(--accent-blue)';

  const b = health.breakdown;

  return `
    <div class="health-section">
      <div class="health-gauge">
        <div class="gauge-circle">
          <svg width="80" height="80" viewBox="0 0 80 80">
            <circle class="gauge-bg" cx="40" cy="40" r="34"/>
            <circle class="gauge-fill" cx="40" cy="40" r="34"
              stroke="${color}" stroke-dasharray="${circumference}" stroke-dashoffset="${dashOffset}"/>
          </svg>
          <div class="gauge-value" style="color:${color}">${score}</div>
        </div>
        <div class="gauge-label">Health</div>
      </div>
      <div class="health-breakdown">
        ${renderBreakdownItem('Ratio', b.ratio, 'var(--accent-blue)')}
        ${renderBreakdownItem('Churn', b.churn, 'var(--accent-green)')}
        ${renderBreakdownItem('Growth', b.growth, 'var(--accent-purple)')}
        ${renderBreakdownItem('Engage', b.engagement, 'var(--accent-amber)')}
      </div>
    </div>
  `;
}

function renderBreakdownItem(label, value, color) {
  return `
    <div class="breakdown-item">
      <span class="breakdown-label">${label}</span>
      <div class="breakdown-bar">
        <div class="breakdown-bar-fill" style="width:${value}%;background:${color}"></div>
      </div>
      <span class="breakdown-value">${value}</span>
    </div>
  `;
}

// ================== Trend Chart (Canvas) ==================
function drawTrendChart(canvasId, data) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !data.length) return;

  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;

  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.scale(dpr, dpr);

  const values = data.map(d => d.count);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const padding = { top: 10, right: 10, bottom: 20, left: 40 };
  const chartW = w - padding.left - padding.right;
  const chartH = h - padding.top - padding.bottom;
  const step = chartW / Math.max(1, values.length - 1);

  // Grid lines
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 4; i++) {
    const y = padding.top + (chartH / 3) * i;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(w - padding.right, y);
    ctx.stroke();

    // Labels
    const val = Math.round(max - (range / 3) * i);
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.font = '9px Inter, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(val.toLocaleString(), padding.left - 6, y + 3);
  }

  // X-axis labels
  ctx.fillStyle = 'rgba(255,255,255,0.2)';
  ctx.font = '9px Inter, sans-serif';
  ctx.textAlign = 'center';
  const labelStep = Math.max(1, Math.floor(data.length / 5));
  data.forEach((d, i) => {
    if (i % labelStep === 0 || i === data.length - 1) {
      const x = padding.left + i * step;
      const parts = d.date.split('-');
      ctx.fillText(`${parts[1]}/${parts[2]}`, x, h - 4);
    }
  });

  if (values.length < 2) return;

  // Build path points
  const points = values.map((v, i) => ({
    x: padding.left + i * step,
    y: padding.top + chartH - ((v - min) / range) * chartH
  }));

  // Gradient fill
  const gradient = ctx.createLinearGradient(0, padding.top, 0, h - padding.bottom);
  gradient.addColorStop(0, 'rgba(59, 130, 246, 0.15)');
  gradient.addColorStop(1, 'rgba(59, 130, 246, 0)');

  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    const cp1x = (points[i - 1].x + points[i].x) / 2;
    const cp1y = points[i - 1].y;
    const cp2x = cp1x;
    const cp2y = points[i].y;
    ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, points[i].x, points[i].y);
  }
  ctx.lineTo(points[points.length - 1].x, h - padding.bottom);
  ctx.lineTo(points[0].x, h - padding.bottom);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  // Line
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    const cp1x = (points[i - 1].x + points[i].x) / 2;
    const cp1y = points[i - 1].y;
    const cp2x = cp1x;
    const cp2y = points[i].y;
    ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, points[i].x, points[i].y);
  }
  ctx.strokeStyle = '#3b82f6';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Dots
  const last = points[points.length - 1];
  ctx.beginPath();
  ctx.arc(last.x, last.y, 3, 0, Math.PI * 2);
  ctx.fillStyle = '#3b82f6';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(last.x, last.y, 6, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(59, 130, 246, 0.3)';
  ctx.lineWidth = 2;
  ctx.stroke();
}

// ================== Recent Timeline ==================
function renderRecentTimeline(events) {
  if (!events.length) {
    return `
      <div class="timeline-section">
        <div class="section-header"><div class="section-title">Recent Activity</div></div>
        <div class="info-box">No activity yet. Background scans will track changes automatically.</div>
      </div>
    `;
  }

  let html = `
    <div class="timeline-section">
      <div class="section-header">
        <div class="section-title">Recent Activity</div>
        <button class="filter-btn" style="font-size:10px;padding:3px 8px" onclick="switchView('events')">View All →</button>
      </div>
      <div class="timeline">
  `;

  events.forEach(e => {
    const isFollow = e.type === 'follow';
    const avatarStyle = e.avatar ? `background-image:url(${esc(e.avatar)})` : `background:var(--bg-glass)`;

    html += `
      <div class="timeline-item" data-username="${esc(e.username)}">
        <div class="timeline-icon ${e.type}">${isFollow ? '＋' : '−'}</div>
        <div class="timeline-avatar" style="${avatarStyle}"></div>
        <div class="timeline-content">
          <div class="timeline-user">${esc(e.displayName || e.username)}${e.verified ? ' <span class="verified-badge">✓</span>' : ''}</div>
          <div class="timeline-action">${isFollow ? 'started following' : 'unfollowed'} @${esc(currentUser)}</div>
        </div>
        <div class="timeline-time">${formatTime(e.timestamp)}</div>
      </div>
    `;
  });

  html += '</div></div>';
  return html;
}

// ================== Events View ==================
function renderEvents(userData) {
  const container = document.getElementById('eventsView');
  if (!container) return;

  const allEvents = getRecentEvents(userData, 200, filterState.events === 'all' ? null : filterState.events);

  let html = `
    <div class="filter-bar">
      <button class="filter-btn ${filterState.events === 'all' ? 'active' : ''}" data-filter="all">All</button>
      <button class="filter-btn ${filterState.events === 'follow' ? 'active' : ''}" data-filter="follow">Follows</button>
      <button class="filter-btn ${filterState.events === 'unfollow' ? 'active' : ''}" data-filter="unfollow">Unfollows</button>
    </div>
  `;

  if (!allEvents.length) {
    html += `<div class="empty-state"><div class="empty-icon">📅</div><div class="empty-title">No Events Yet</div><div class="empty-text">Events will appear after background scans detect changes.</div></div>`;
  } else {
    html += `<div class="list-header">Events <span class="list-count">${allEvents.length}</span></div>`;
    html += '<div class="timeline">';
    allEvents.forEach(e => {
      const isFollow = e.type === 'follow';
      const avatarStyle = e.avatar ? `background-image:url(${esc(e.avatar)})` : '';

      html += `
        <div class="timeline-item" data-username="${esc(e.username)}">
          <div class="timeline-icon ${e.type}">${isFollow ? '＋' : '−'}</div>
          <div class="timeline-avatar" style="${avatarStyle}"></div>
          <div class="timeline-content">
            <div class="timeline-user">${esc(e.displayName || e.username)}</div>
            <div class="timeline-action">@${esc(e.username)} · ${isFollow ? 'followed' : 'unfollowed'}</div>
          </div>
          <div class="timeline-time">${formatTime(e.timestamp)}</div>
        </div>
      `;
    });
    html += '</div>';
  }

  container.innerHTML = html;

  container.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      filterState.events = btn.dataset.filter;
      renderEvents(userData);
    });
  });

  attachProfileLinks(container);
}

// ================== User List Views ==================
function renderUnfollowers(userData) {
  const container = document.getElementById('unfollowersView');
  if (!container) return;
  const list = applySearch((userData.unfollowers || []).filter(f => f && f.username), 'unfollowers');
  const sorted = [...list].sort((a, b) => (b.unfollowedAt || 0) - (a.unfollowedAt || 0));

  let html = `<input type="text" class="search-box" id="unfollowersSearch" placeholder="🔍 Search unfollowers..." value="${esc(searchState.unfollowers || '')}">`;

  if (!sorted.length) {
    html += `<div class="empty-state"><div class="empty-icon">✅</div><div class="empty-title">No Unfollowers</div><div class="empty-text">${list.length === 0 && !(userData.unfollowers||[]).length ? 'No one has unfollowed you!' : 'No results match your search.'}</div></div>`;
  } else {
    html += `<div class="list-header">Unfollowers <span class="list-count">${sorted.length}</span></div>`;
    html += '<div class="user-list">';
    sorted.forEach(u => { html += renderUserCard(u, 'unfollow'); });
    html += '</div>';
  }

  container.innerHTML = html;
  attachSearch(container, 'unfollowers', 'unfollowersSearch');
  attachProfileLinks(container);
}

function renderNewFollowers(userData) {
  const container = document.getElementById('newFollowersView');
  if (!container) return;
  const list = applySearch((userData.newFollowers || []).filter(f => f && f.username), 'new');
  const sorted = [...list].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  let html = `<input type="text" class="search-box" id="newSearch" placeholder="🔍 Search new followers..." value="${esc(searchState.new || '')}">`;

  if (!sorted.length) {
    html += `<div class="empty-state"><div class="empty-icon">👀</div><div class="empty-title">No New Followers</div><div class="empty-text">${!(userData.newFollowers||[]).length ? 'Keep creating great content!' : 'No results match.'}</div></div>`;
  } else {
    html += `<div class="list-header">New Followers <span class="list-count">${sorted.length}</span></div>`;
    html += '<div class="user-list">';
    sorted.forEach(u => { html += renderUserCard(u, 'follow'); });
    html += '</div>';
  }

  container.innerHTML = html;
  attachSearch(container, 'new', 'newSearch');
  attachProfileLinks(container);
}

function renderFans(userData) {
  const container = document.getElementById('fansView');
  if (!container) return;
  const list = applySearch((userData.fansList || []).filter(f => f && f.username), 'fans');

  let html = `<input type="text" class="search-box" id="fansSearch" placeholder="🔍 Search fans..." value="${esc(searchState.fans || '')}">`;
  html += '<div class="info-box">Fans are followers you don\'t follow back.</div>';

  if (!list.length) {
    html += `<div class="empty-state"><div class="empty-icon">⭐</div><div class="empty-title">No Fans</div><div class="empty-text">Scan followers & following to discover fans.</div></div>`;
  } else {
    html += `<div class="list-header">Fans <span class="list-count">${list.length}</span></div>`;
    html += '<div class="user-list">';
    list.forEach(u => { html += renderUserCard(u, 'fan'); });
    html += '</div>';
  }

  container.innerHTML = html;
  attachSearch(container, 'fans', 'fansSearch');
  attachProfileLinks(container);
}

function renderNotFollowingBack(userData) {
  const container = document.getElementById('notFollowingBackView');
  if (!container) return;
  const list = applySearch((userData.notFollowingBack || []).filter(f => f && f.username), 'notfollowback');

  let html = `<input type="text" class="search-box" id="notFollowBackSearch" placeholder="🔍 Search..." value="${esc(searchState.notfollowback || '')}">`;
  html += '<div class="info-box">These accounts don\'t follow you back.</div>';

  if (!list.length) {
    html += `<div class="empty-state"><div class="empty-icon">🎉</div><div class="empty-title">Everyone Follows Back</div><div class="empty-text">Perfect follow-back ratio!</div></div>`;
  } else {
    html += `<div class="list-header">Not Following Back <span class="list-count">${list.length}</span></div>`;
    html += '<div class="user-list">';
    list.forEach(u => { html += renderUserCard(u, 'notback'); });
    html += '</div>';
  }

  container.innerHTML = html;
  attachSearch(container, 'notfollowback', 'notFollowBackSearch');
  attachProfileLinks(container);
}

function renderFollowing(userData) {
  const container = document.getElementById('followingView');
  if (!container) return;
  let list = applySearch((userData.following || []).filter(f => f && f.username), 'following');

  const filter = filterState.following;
  if (filter === 'mutual') list = list.filter(u => u.followsBack);
  else if (filter === 'notback') list = list.filter(u => !u.followsBack);
  else if (filter === 'verified') list = list.filter(u => u.verified);

  const mutualCount = list.filter(u => u.followsBack).length;

  let html = `<input type="text" class="search-box" id="followingSearch" placeholder="🔍 Search following..." value="${esc(searchState.following || '')}">`;
  html += `
    <div class="filter-bar">
      <button class="filter-btn ${filter === 'all' ? 'active' : ''}" data-filter="all">All</button>
      <button class="filter-btn ${filter === 'mutual' ? 'active' : ''}" data-filter="mutual">Mutual</button>
      <button class="filter-btn ${filter === 'notback' ? 'active' : ''}" data-filter="notback">Not Back</button>
      <button class="filter-btn ${filter === 'verified' ? 'active' : ''}" data-filter="verified">Verified</button>
    </div>
  `;

  if (!list.length) {
    html += `<div class="empty-state"><div class="empty-icon">🔗</div><div class="empty-title">No Data</div><div class="empty-text">Scan following to see this list.</div></div>`;
  } else {
    html += `<div class="list-header">Following <span class="list-count">${list.length}</span> · <span style="color:var(--accent-purple)">${mutualCount} mutual</span></div>`;
    html += '<div class="user-list">';
    list.sort((a, b) => (a.followsBack === b.followsBack ? 0 : a.followsBack ? -1 : 1));
    list.forEach(u => { html += renderUserCard(u, u.followsBack ? 'mutual' : 'notback'); });
    html += '</div>';
  }

  container.innerHTML = html;

  container.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      filterState.following = btn.dataset.filter;
      renderFollowing(userData);
    });
  });

  attachSearch(container, 'following', 'followingSearch');
  attachProfileLinks(container);
}

// ================== Settings ==================
function renderSettings(settings) {
  const container = document.getElementById('settingsView');
  if (!container) return;

  container.innerHTML = `
    <div class="settings-group">
      <div class="settings-group-title">Background Scanning</div>
      <div class="setting-item">
        <div>
          <div class="setting-label">Auto Scan</div>
          <div class="setting-desc">Periodically check for follower changes</div>
        </div>
        <button class="toggle ${settings.backgroundScanEnabled ? 'active' : ''}" id="toggleAutoScan"></button>
      </div>
      <div class="setting-item">
        <div>
          <div class="setting-label">Scan Interval</div>
          <div class="setting-desc">How often to check (${MIN_SCAN_INTERVAL_HOURS}h - ${MAX_SCAN_INTERVAL_HOURS}h)</div>
        </div>
        <div class="range-control">
          <input type="range" class="range-slider" id="intervalSlider"
            min="${MIN_SCAN_INTERVAL_HOURS}" max="${MAX_SCAN_INTERVAL_HOURS}" step="1"
            value="${settings.scanIntervalHours || DEFAULT_SCAN_INTERVAL_HOURS}">
          <span class="range-value" id="intervalValue">${settings.scanIntervalHours || DEFAULT_SCAN_INTERVAL_HOURS}h</span>
        </div>
      </div>
    </div>

    <div class="settings-group">
      <div class="settings-group-title">Notifications</div>
      <div class="setting-item">
        <div>
          <div class="setting-label">Enable Notifications</div>
          <div class="setting-desc">Get alerts for follower changes</div>
        </div>
        <button class="toggle ${settings.notificationsEnabled ? 'active' : ''}" id="toggleNotifications"></button>
      </div>
      <div class="setting-item">
        <div><div class="setting-label">Unfollow Alerts</div></div>
        <button class="toggle ${settings.notifyOnUnfollow ? 'active' : ''}" id="toggleUnfollowAlert"></button>
      </div>
      <div class="setting-item">
        <div><div class="setting-label">New Follower Alerts</div></div>
        <button class="toggle ${settings.notifyOnNewFollower ? 'active' : ''}" id="toggleFollowAlert"></button>
      </div>
      <div class="setting-item">
        <div><div class="setting-label">Session Expiry Alert</div></div>
        <button class="toggle ${settings.notifyOnSessionExpired ? 'active' : ''}" id="toggleSessionAlert"></button>
      </div>
    </div>

    <div class="settings-group">
      <div class="settings-group-title">Data</div>
      <div class="action-row">
        <button class="settings-btn btn-export" id="exportBtn">📊 Export JSON</button>
        <button class="settings-btn btn-danger" id="clearDataBtn">🗑 Clear Data</button>
      </div>
    </div>

    <div class="info-box" style="margin-top:12px;text-align:center;color:var(--text-muted)">
      X Tracker v3.0 · Privacy-first local storage
    </div>
  `;

  // Toggle handlers
  const toggleMap = {
    toggleAutoScan: 'backgroundScanEnabled',
    toggleNotifications: 'notificationsEnabled',
    toggleUnfollowAlert: 'notifyOnUnfollow',
    toggleFollowAlert: 'notifyOnNewFollower',
    toggleSessionAlert: 'notifyOnSessionExpired'
  };

  Object.entries(toggleMap).forEach(([id, key]) => {
    document.getElementById(id)?.addEventListener('click', async function () {
      this.classList.toggle('active');
      const newSettings = { [key]: this.classList.contains('active') };
      await sendMessage({ action: 'updateSettings', settings: newSettings });
      showToast('Settings saved', 'success');
    });
  });

  // Interval slider
  const slider = document.getElementById('intervalSlider');
  const valDisplay = document.getElementById('intervalValue');
  slider?.addEventListener('input', () => { valDisplay.textContent = `${slider.value}h`; });
  slider?.addEventListener('change', async () => {
    await sendMessage({ action: 'updateSettings', settings: { scanIntervalHours: parseInt(slider.value) } });
    showToast('Interval updated', 'success');
  });

  // Export
  document.getElementById('exportBtn')?.addEventListener('click', exportData);

  // Clear
  document.getElementById('clearDataBtn')?.addEventListener('click', async () => {
    if (!currentUser) return;
    if (!confirm(`Clear all data for @${currentUser}?`)) return;

    const data = await getFromStorage(['users']);
    const users = data.users || {};
    delete users[currentUser];
    await chrome.storage.local.set({ users });
    renderCurrentView();
    showToast('Data cleared', 'success');
  });
}

// ================== User Card Renderer ==================
function renderUserCard(user, type) {
  const avatarStyle = user.avatar
    ? `background-image:url(${esc(user.avatar)})`
    : `background:linear-gradient(135deg, var(--accent-purple), var(--accent-blue))`;

  const avatarContent = user.avatar ? '' : esc((user.name || user.username || '?').charAt(0).toUpperCase());
  const verified = user.verified ? '<span class="verified-badge">✓</span>' : '';
  const time = user.unfollowedAt || user.timestamp ? formatTime(user.unfollowedAt || user.timestamp) : '';

  const badgeMap = {
    unfollow: '<span class="badge unfollow">Unfollowed</span>',
    follow: '<span class="badge follow">New</span>',
    fan: '<span class="badge fan">Fan</span>',
    mutual: '<span class="badge mutual">Mutual</span>',
    notback: '<span class="badge notback">No Back</span>'
  };

  return `
    <div class="user-card" data-username="${esc(user.username)}">
      <div class="user-info">
        <div class="user-avatar" style="${avatarStyle}">${avatarContent}</div>
        <div class="user-details">
          <div class="user-name">${esc(user.name || user.username || 'Unknown')} ${verified}</div>
          <div class="user-username">@${esc(user.username || 'unknown')}</div>
          ${user.bio ? `<div class="user-bio">${esc(user.bio)}</div>` : ''}
        </div>
      </div>
      <div class="user-meta">
        ${badgeMap[type] || ''}
        ${time ? `<span class="user-time">${time}</span>` : ''}
      </div>
    </div>
  `;
}

// ================== Search ==================
function handleSearch(type, query) {
  searchState[type] = query.toLowerCase();
  renderCurrentView();
}

function applySearch(list, type) {
  const q = searchState[type];
  if (!q) return list;
  return list.filter(u =>
    (u.name || '').toLowerCase().includes(q) ||
    (u.username || '').toLowerCase().includes(q) ||
    (u.bio || '').toLowerCase().includes(q)
  );
}

function attachSearch(container, type, id) {
  const el = document.getElementById(id);
  if (el) {
    el.addEventListener('input', (e) => handleSearch(type, e.target.value));
  }
}

function attachProfileLinks(container) {
  container.querySelectorAll('[data-username]').forEach(el => {
    el.addEventListener('click', () => {
      const username = el.dataset.username;
      if (username) chrome.tabs.create({ url: `https://x.com/${username}` });
    });
  });
}

// ================== Export ==================
function exportData() {
  if (!currentUser) return showToast('No account selected', 'warning');

  chrome.storage.local.get(['users'], result => {
    const userData = (result.users || {})[currentUser] || {};

    const exportObj = {
      username: currentUser,
      exportDate: new Date().toISOString(),
      followers: userData.followers || [],
      following: userData.following || [],
      unfollowers: userData.unfollowers || [],
      newFollowers: userData.newFollowers || [],
      events: userData.events || [],
      snapshots: userData.snapshots || [],
      stats: {
        totalFollowers: (userData.followers || []).length,
        totalFollowing: (userData.following || []).length,
        lastCheck: userData.lastFollowersCheck || userData.lastFollowingCheck
      }
    };

    const blob = new Blob([JSON.stringify(exportObj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `x-tracker-${currentUser}-${Date.now()}.json`;
    link.click();
    URL.revokeObjectURL(url);

    showToast('Data exported!', 'success');
  });
}

// ================== Utility ==================
function formatTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const s = Math.floor(diff / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  const w = Math.floor(d / 7);
  const mo = Math.floor(d / 30);

  if (mo > 0) return `${mo}mo ago`;
  if (w > 0) return `${w}w ago`;
  if (d > 0) return `${d}d ago`;
  if (h > 0) return `${h}h ago`;
  if (m > 0) return `${m}m ago`;
  return 'Just now';
}

function esc(text) {
  const d = document.createElement('div');
  d.textContent = text || '';
  return d.innerHTML;
}

function showToast(message, type = 'info') {
  document.getElementById('notificationToast')?.remove();

  const toast = document.createElement('div');
  toast.id = 'notificationToast';
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.transition = 'opacity 0.3s, transform 0.3s';
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(-50%) translateY(10px)';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ================== Event Listeners ==================
function setupEventListeners() {
  // Scan button
  document.getElementById('scanNowBtn')?.addEventListener('click', scanNow);

  // User dropdown
  document.getElementById('userDropdown')?.addEventListener('click', e => { e.stopPropagation(); toggleMenu(); });
  document.addEventListener('click', closeMenu);
  document.getElementById('addUserBtn')?.addEventListener('click', e => { e.stopPropagation(); promptAddUser(); });

  // Settings button (switches to settings tab)
  document.getElementById('settingsBtn')?.addEventListener('click', () => switchView('settings'));

  // Tabs
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => switchView(tab.dataset.view));
  });
}

// ================== Message Listener ==================
chrome.runtime.onMessage.addListener(request => {
  if (request.action === 'scanComplete') {
    loadUserData().then(() => {
      renderCurrentView();
      showToast('Scan complete!', 'success');
    });
  }
  if (request.action === 'scanError') {
    showToast(request.error || 'Scan failed', 'error');
    resetScanBtn();
  }
});

// Periodic status refresh
setInterval(updateStatusBar, 30000);