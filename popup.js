// Popup interface with multi-user support and profile actions
let currentView = 'dashboard', currentUser = 'rohit_dwivedi', userList = [], nextScanInterval = null;

document.addEventListener('DOMContentLoaded', () => {
  loadUserData();
  setupEventListeners();
  startNextScanCountdown();
});

async function loadUserData() {
  const data = await getStorageData(['users', 'currentUser', 'userList', 'autoScan', 'scanInterval', 'scanStatus', 'nextScanTime']);
  
  currentUser = data.currentUser || 'rohit_dwivedi';
  userList = data.userList || [];
  
  if (!userList.length && currentUser) {
    userList = [currentUser];
    await chrome.storage.local.set({ userList });
  }
  
  if (!userList.includes(currentUser)) {
    userList.unshift(currentUser);
    await chrome.storage.local.set({ userList });
  }
  
  updateUserDropdown();
  loadStats();
  
  const toggle = document.getElementById('autoScanToggle');
  const check = document.getElementById('autoScanCheck');
  if (toggle && check) {
    check.checked = data.autoScan || false;
    toggle.classList.toggle('active', check.checked);
  }
  
  const interval = document.getElementById('scanInterval');
  if (interval) interval.value = data.scanInterval || 3600;
  
  if (data.autoScan && data.nextScanTime) updateNextScanDisplay(data.nextScanTime);
  if (data.scanStatus === 'scanning') startScanMonitoring();
}

function updateUserDropdown() {
  const dropdown = document.getElementById('currentUserDisplay');
  const menuItems = document.getElementById('userMenuItems');
  
  if (dropdown) dropdown.textContent = `@${currentUser}`;
  
  if (menuItems) {
    menuItems.innerHTML = '';
    chrome.storage.local.get(['users'], (result) => {
      const users = result.users || {};
      userList.forEach(username => {
        const userData = users[username] || {};
        const followerCount = userData.followers?.length || 0;
        const scanCount = userData.scanCount || 0;
        let statsText = `${followerCount} followers`;
        if (scanCount > 0) statsText += ` • ${scanCount} scans`;
        if (userData.lastCheck) statsText += ` • ${formatTimeAgo(userData.lastCheck)}`;
        
        const item = document.createElement('div');
        item.className = 'user-menu-item' + (username === currentUser ? ' active' : '');
        item.innerHTML = `<span>@${username}</span><span class="user-stats">${statsText}</span>`;
        item.addEventListener('click', () => switchUser(username));
        menuItems.appendChild(item);
      });
    });
  }
}

function switchUser(username) {
  if (username === currentUser) return closeUserMenu();
  currentUser = username;
  chrome.storage.local.set({ currentUser: username });
  updateUserDropdown();
  closeUserMenu();
  loadStats();
  showNotification(`Switched to @${username}`, 'success');
}

function setupEventListeners() {
  const scanBtn = document.getElementById('scanBtn');
  if (scanBtn) scanBtn.addEventListener('click', startScan);
  
  const userDropdown = document.getElementById('userDropdown');
  if (userDropdown) userDropdown.addEventListener('click', (e) => { e.stopPropagation(); toggleUserMenu(); });
  
  document.addEventListener('click', closeUserMenu);
  
  const addUserBtn = document.getElementById('addUserBtn');
  if (addUserBtn) addUserBtn.addEventListener('click', (e) => { e.stopPropagation(); promptAddUser(); });
  
  const toggle = document.getElementById('autoScanToggle');
  const check = document.getElementById('autoScanCheck');
  if (toggle && check) toggle.addEventListener('click', () => { check.checked = !check.checked; toggle.classList.toggle('active', check.checked); updateAutoScan(); });
  
  const interval = document.getElementById('scanInterval');
  if (interval) interval.addEventListener('change', updateAutoScan);
  
  document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', (e) => switchView(e.target.dataset.view)));

  // Handle profile action buttons
  const content = document.querySelector('.content');
  if (content) {
    content.addEventListener('click', async (e) => {
      const target = e.target.closest('[data-username]');
      if (!target) return;
      
      e.preventDefault();
      e.stopPropagation();
      
      const username = target.dataset.username;
      const url = `https://x.com/${username}`;
      
      if (target.classList.contains('action-btn-current')) {
        // Open in current tab without closing popup
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id) {
          chrome.tabs.update(tab.id, { url });
          showQuickToast('Opening in current tab...', 'info');
        }
      } else if (target.classList.contains('action-btn-new')) {
        // Open in new tab
        chrome.tabs.create({ url, active: true });
        showQuickToast('Opening in new tab...', 'info');
      }
    });
  }
}

function toggleUserMenu() {
  const menu = document.getElementById('userMenu');
  const dropdown = document.getElementById('userDropdown');
  if (menu && dropdown) {
    if (!menu.classList.contains('open')) updateUserDropdown();
    menu.classList.toggle('open');
    dropdown.classList.toggle('open');
  }
}

function closeUserMenu() {
  const menu = document.getElementById('userMenu');
  const dropdown = document.getElementById('userDropdown');
  if (menu && dropdown) {
    menu.classList.remove('open');
    dropdown.classList.remove('open');
  }
}

async function promptAddUser() {
  const username = prompt('Enter X username to track (without @):');
  if (!username) return;
  
  const cleanUsername = username.replace('@', '').trim();
  if (!cleanUsername || !/^[a-zA-Z0-9_]{1,15}$/.test(cleanUsername)) return showNotification('Invalid username format', 'error');
  if (userList.includes(cleanUsername)) { showNotification('User already tracked', 'warning'); return switchUser(cleanUsername); }
  
  userList.push(cleanUsername);
  await chrome.storage.local.set({ userList, currentUser: cleanUsername });
  currentUser = cleanUsername;
  updateUserDropdown();
  closeUserMenu();
  loadStats();
  showNotification(`Added @${cleanUsername}. Click "Scan Now" to start tracking!`, 'success');
}

function updateAutoScan() {
  const check = document.getElementById('autoScanCheck');
  const interval = document.getElementById('scanInterval');
  const enabled = check?.checked || false;
  const intervalSeconds = parseInt(interval?.value || 3600);
  
  chrome.storage.local.set({ autoScan: enabled, scanInterval: intervalSeconds });
  
  if (enabled) {
    const nextScan = Date.now() + (intervalSeconds * 1000);
    chrome.storage.local.set({ nextScanTime: nextScan });
    updateNextScanDisplay(nextScan);
    showNotification('Auto-scan enabled', 'success');
  } else {
    const nextScanEl = document.getElementById('nextScan');
    if (nextScanEl) nextScanEl.textContent = '';
    showNotification('Auto-scan disabled', 'info');
  }
}

function updateNextScanDisplay(nextScanTime) {
  const nextScanEl = document.getElementById('nextScan');
  if (!nextScanEl) return;
  
  const updateDisplay = () => {
    const remaining = nextScanTime - Date.now();
    if (remaining <= 0) return nextScanEl.textContent = '';
    const minutes = Math.floor(remaining / 60000);
    const hours = Math.floor(minutes / 60);
    nextScanEl.textContent = hours > 0 ? `Next scan in ${hours}h ${minutes % 60}m` : `Next scan in ${minutes}m`;
  };
  
  updateDisplay();
  if (nextScanInterval) clearInterval(nextScanInterval);
  nextScanInterval = setInterval(updateDisplay, 30000);
}

function startNextScanCountdown() {
  chrome.storage.local.get(['autoScan', 'nextScanTime'], (result) => {
    if (result.autoScan && result.nextScanTime) updateNextScanDisplay(result.nextScanTime);
  });
}

function switchView(view) {
  currentView = view;
  document.querySelectorAll('.tab').forEach(tab => tab.classList.toggle('active', tab.dataset.view === view));
  document.getElementById('dashboardView').style.display = view === 'dashboard' ? 'block' : 'none';
  document.getElementById('unfollowersView').style.display = view === 'unfollowers' ? 'block' : 'none';
  document.getElementById('newFollowersView').style.display = view === 'new' ? 'block' : 'none';
  if (view !== 'dashboard') loadStats();
}

async function startScan() {
  const btn = document.getElementById('scanBtn');
  if (!btn) return;

  const username = currentUser;
  if (!username || username.includes('@')) return showNotification('Please enter a valid X username (without @)', 'error');

  const status = await getStorageData(['scanStatus']);
  if (status.scanStatus === 'scanning') return showNotification('Scan already in progress', 'warning');

  btn.disabled = true;
  btn.innerHTML = '<span>⏳</span><span>Opening page...</span>';
  
  const statusDot = document.getElementById('scanStatusDot');
  const statusText = document.getElementById('scanStatusText');
  if (statusDot && statusText) {
    statusDot.classList.add('scanning');
    statusText.textContent = 'Starting...';
  }

  const progressBar = document.getElementById('scanProgress');
  const progressFill = document.getElementById('scanProgressFill');
  if (progressBar && progressFill) {
    progressBar.style.display = 'block';
    progressFill.style.width = '0%';
  }

  chrome.storage.local.set({ currentUser: username, scanStatus: 'scanning', lastScanAttempt: Date.now() });

  try {
    const response = await sendMessage({ action: 'startScan', username });
    if (response?.status === 'scanning') {
      startScanMonitoring();
      if (statusText) statusText.textContent = 'Scanning...';
    } else throw new Error(response?.message || 'Failed to start scan');
  } catch (error) {
    console.error('Scan start error:', error);
    showNotification(error.message || 'Failed to start scan', 'error');
    resetScanUI();
  }
}

function startScanMonitoring() {
  let attempts = 0;
  const maxAttempts = 600;
  
  const checkInterval = setInterval(() => {
    attempts++;
    if (attempts >= maxAttempts) {
      clearInterval(checkInterval);
      chrome.storage.local.set({ scanStatus: 'error', lastError: 'Scan timeout' });
      resetScanUI();
      showNotification('Scan timed out. Please try again.', 'error');
      return;
    }
    
    chrome.storage.local.get(['scanStatus', 'scanProgress', 'lastError', '_currentScanUsername'], (result) => {
      const statusText = document.getElementById('scanStatusText');
      const progressFill = document.getElementById('scanProgressFill');
      
      if (result.scanProgress) {
        if (statusText) statusText.textContent = `Scanning... ${result.scanProgress}%`;
        if (progressFill) progressFill.style.width = `${result.scanProgress}%`;
      }
      
      if (result.scanStatus === 'complete') {
        clearInterval(checkInterval);
        const scannedUser = result._currentScanUsername || currentUser;
        if (scannedUser && !userList.includes(scannedUser)) {
          userList.push(scannedUser);
          chrome.storage.local.set({ userList });
        }
        if (scannedUser && scannedUser !== currentUser) {
          currentUser = scannedUser;
          chrome.storage.local.set({ currentUser: scannedUser });
          updateUserDropdown();
        }
        loadStats();
        resetScanUI(true);
        showNotification(`Scan completed for @${scannedUser}!`, 'success');
      } else if (result.scanStatus === 'error') {
        clearInterval(checkInterval);
        resetScanUI();
        showNotification(result.lastError || 'Scan failed', 'error');
      }
    });
  }, 1000);
}

function resetScanUI(success = false) {
  const btn = document.getElementById('scanBtn');
  if (btn) {
    btn.disabled = false;
    btn.innerHTML = '<span>🔄</span><span>Scan Now</span>';
  }

  const statusDot = document.getElementById('scanStatusDot');
  const statusText = document.getElementById('scanStatusText');
  if (statusDot && statusText) {
    statusDot.classList.remove('scanning');
    statusText.textContent = success ? 'Complete' : 'Ready';
  }

  const progressBar = document.getElementById('scanProgress');
  if (progressBar) setTimeout(() => progressBar.style.display = 'none', 2000);
}

function loadStats() {
  chrome.storage.local.get(['users'], (result) => {
    const users = result.users || {};
    const userData = users[currentUser] || {};
    
    const totalFollowers = userData.followers?.length || 0;
    const unfollowers = userData.unfollowers || [];
    const newFollowers = userData.newFollowers || [];
    
    document.getElementById('totalFollowers').textContent = totalFollowers.toLocaleString();
    document.getElementById('newFollowersCount').textContent = '+' + newFollowers.length;
    document.getElementById('unfollowersCount').textContent = unfollowers.length;
    
    const netGrowth = newFollowers.length - unfollowers.length;
    const netGrowthEl = document.getElementById('netGrowth');
    netGrowthEl.textContent = (netGrowth >= 0 ? '+' : '') + netGrowth;
    netGrowthEl.style.color = netGrowth >= 0 ? '#10b981' : '#ef4444';
    
    document.getElementById('lastCheck').textContent = userData.lastCheck ? `Last: ${formatTimeAgo(userData.lastCheck)}` : 'Never scanned';
    
    if (currentView === 'dashboard') renderRecentActivity(unfollowers, newFollowers);
    else if (currentView === 'unfollowers') renderUnfollowersList(unfollowers);
    else if (currentView === 'new') renderNewFollowersList(newFollowers);
  });
}

function renderRecentActivity(unfollowers, newFollowers) {
  const container = document.getElementById('recentActivity');
  if (!unfollowers.length && !newFollowers.length) {
    container.innerHTML = '<div class="info-box">No recent activity. Click "Scan Now" to check for changes.</div>';
    return;
  }
  
  const recentActivity = [
    ...unfollowers.map(u => ({ ...u, type: 'unfollow' })),
    ...newFollowers.map(u => ({ ...u, type: 'new' }))
  ].sort((a, b) => (b.unfollowedAt || b.timestamp || 0) - (a.unfollowedAt || a.timestamp || 0)).slice(0, 5);

  let html = '<h3 style="font-size: 13px; margin: 16px 0 12px 0; color: rgba(255,255,255,0.7);">Recent Activity</h3><div class="user-list">';
  recentActivity.forEach(user => html += renderUserCard(user, user.type));
  html += '</div>';
  container.innerHTML = html;
}

function renderUnfollowersList(unfollowers) {
  const container = document.getElementById('unfollowersList');
  if (!unfollowers.length) {
    container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">✅</div><div class="empty-state-title">No unfollowers detected</div><div class="empty-state-text">Great job maintaining your audience!</div></div>';
    return;
  }
  
  const sorted = [...unfollowers].sort((a, b) => (b.unfollowedAt || 0) - (a.unfollowedAt || 0));
  let html = `<div style="margin-bottom: 12px; font-size: 13px; color: rgba(255,255,255,0.7);">Unfollowers (${unfollowers.length})</div><div class="user-list">`;
  sorted.forEach(user => html += renderUserCard(user, 'unfollow'));
  html += '</div>';
  container.innerHTML = html;
}

function renderNewFollowersList(newFollowers) {
  const container = document.getElementById('newFollowersList');
  if (!newFollowers.length) {
    container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">👀</div><div class="empty-state-title">No new followers yet</div><div class="empty-state-text">Keep creating great content!</div></div>';
    return;
  }
  
  const sorted = [...newFollowers].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  let html = `<div style="margin-bottom: 12px; font-size: 13px; color: rgba(255,255,255,0.7);">New Followers (${newFollowers.length})</div><div class="user-list">`;
  sorted.forEach(user => html += renderUserCard(user, 'new'));
  html += '</div>';
  container.innerHTML = html;
}

function renderUserCard(user, type) {
  const isUnfollow = type === 'unfollow';
  const bgColor = isUnfollow ? 'rgba(239, 68, 68, 0.1)' : 'rgba(16, 185, 129, 0.1)';
  const borderColor = isUnfollow ? 'rgba(239, 68, 68, 0.3)' : 'rgba(16, 185, 129, 0.3)';
  const avatarColor = isUnfollow ? 'linear-gradient(135deg, #ef4444, #dc2626)' : 'linear-gradient(135deg, #10b981, #059669)';
  const status = isUnfollow ? 'Unfollowed' : 'New Follower';
  const statusColor = isUnfollow ? '#ef4444' : '#10b981';
  
  return `
    <div class="user-card" style="background: ${bgColor}; border-color: ${borderColor};">
      <div class="user-info">
        <div class="user-avatar" style="background: ${avatarColor};">${user.name.charAt(0).toUpperCase()}</div>
        <div class="user-details">
          <div class="user-name">${escapeHtml(user.name)}</div>
          <div class="user-username"><span style="color: rgba(255,255,255,0.6);">@${escapeHtml(user.username)}</span></div>
        </div>
      </div>
      <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 6px;">
        <div style="font-size: 11px; font-weight: 500; color: ${statusColor};">${status}</div>
        <div style="font-size: 11px; color: rgba(255,255,255,0.5);">${formatTimeAgo(user.unfollowedAt || user.timestamp)}</div>
        <div style="display: flex; gap: 4px;">
          <button class="action-btn action-btn-current" data-username="${user.username}" title="Open in current tab" style="padding: 4px 6px; border: none; background: rgba(255,255,255,0.1); color: white; border-radius: 4px; font-size: 11px; cursor: pointer; transition: all 0.2s;">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18M15 3v18"/></svg>
          </button>
          <button class="action-btn action-btn-new" data-username="${user.username}" title="Open in new tab" style="padding: 4px 6px; border: none; background: rgba(59, 130, 246, 0.3); color: white; border-radius: 4px; font-size: 11px; cursor: pointer; transition: all 0.2s;">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
          </button>
        </div>
      </div>
    </div>
  `;
}

function formatTimeAgo(timestamp) {
  if (!timestamp) return 'Unknown';
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);
  
  if (months > 0) return `${months}mo ago`;
  if (weeks > 0) return `${weeks}w ago`;
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'Just now';
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function getStorageData(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, response => {
      chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(response);
    });
  });
}

function showNotification(message, type = 'info') {
  const existing = document.getElementById('notificationToast');
  if (existing) existing.remove();
  
  const colors = {
    success: { bg: '#10b981', border: '#059669' },
    error: { bg: '#ef4444', border: '#dc2626' },
    warning: { bg: '#f59e0b', border: '#d97706' },
    info: { bg: '#3b82f6', border: '#2563eb' }
  };
  const color = colors[type] || colors.info;
  
  const toast = document.createElement('div');
  toast.id = 'notificationToast';
  toast.style.cssText = `position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: ${color.bg}; color: white; padding: 12px 20px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); z-index: 999999; font-size: 13px; font-weight: 500; border: 2px solid ${color.border}; animation: slideUp 0.3s ease; max-width: 320px; text-align: center;`;
  toast.textContent = message;
  
  const style = document.createElement('style');
  style.textContent = '@keyframes slideUp { from { opacity: 0; transform: translateX(-50%) translateY(20px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }';
  document.head.appendChild(style);
  document.body.appendChild(toast);
  
  setTimeout(() => {
    toast.style.transition = 'opacity 0.3s';
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

function showQuickToast(message, type = 'info') {
  const existing = document.getElementById('quickToast');
  if (existing) existing.remove();
  
  const colors = { success: { bg: 'rgba(16, 185, 129, 0.95)', icon: '✓' }, error: { bg: 'rgba(239, 68, 68, 0.95)', icon: '✕' }, warning: { bg: 'rgba(245, 158, 11, 0.95)', icon: '⚠' }, info: { bg: 'rgba(59, 130, 246, 0.95)', icon: '↗' } };
  const color = colors[type] || colors.info;
  
  const toast = document.createElement('div');
  toast.id = 'quickToast';
  toast.style.cssText = `position: fixed; top: 70px; right: 20px; background: ${color.bg}; color: white; padding: 8px 14px; border-radius: 6px; box-shadow: 0 2px 8px rgba(0,0,0,0.2); z-index: 999999; font-size: 12px; font-weight: 500; animation: slideInRight 0.2s ease; display: flex; align-items: center; gap: 6px; backdrop-filter: blur(10px);`;
  toast.innerHTML = `<span style="font-size: 14px;">${color.icon}</span><span>${message}</span>`;
  
  const style = document.createElement('style');
  style.textContent = '@keyframes slideInRight { from { opacity: 0; transform: translateX(20px); } to { opacity: 1; transform: translateX(0); } }';
  document.head.appendChild(style);
  document.body.appendChild(toast);
  
  setTimeout(() => {
    toast.style.transition = 'opacity 0.2s, transform 0.2s';
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(20px)';
    setTimeout(() => toast.remove(), 200);
  }, 1500);
}

chrome.runtime.onMessage.addListener((request) => {
  if (request.action === 'scanComplete') {
    loadUserData().then(() => {
      loadStats();
      resetScanUI(true);
      showNotification(`Scan completed for @${request.username || currentUser}!`, 'success');
    });
  }
  if (request.action === 'scanError') {
    showNotification(request.error || 'Scan failed', 'error');
    resetScanUI();
  }
  if (request.action === 'scanProgress') {
    const statusText = document.getElementById('scanStatusText');
    const progressFill = document.getElementById('scanProgressFill');
    if (statusText && request.progress) statusText.textContent = `Scanning... ${request.progress}%`;
    if (progressFill && request.progress) progressFill.style.width = `${request.progress}%`;
  }
});