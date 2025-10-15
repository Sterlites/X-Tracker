// ============================================
// FILE: popup.js (COMPLETE MULTI-USER VERSION)
// ============================================
// Popup interface with full multi-user support

let currentView = 'dashboard';
let currentUser = 'rohit_dwivedi';
let userList = [];
let nextScanInterval = null;

// Initialize popup
document.addEventListener('DOMContentLoaded', () => {
  loadUserData();
  setupEventListeners();
  startNextScanCountdown();
});

async function loadUserData() {
  const data = await getStorageData(['users', 'currentUser', 'userList', 'autoScan', 'scanInterval', 'scanStatus', 'nextScanTime']);
  
  currentUser = data.currentUser || 'rohit_dwivedi';
  userList = data.userList || [];
  
  // Add default user if list is empty
  if (userList.length === 0 && currentUser) {
    userList = [currentUser];
    await chrome.storage.local.set({ userList: userList });
  }
  
  // Ensure current user is in the list
  if (!userList.includes(currentUser)) {
    userList.unshift(currentUser);
    await chrome.storage.local.set({ userList: userList });
  }
  
  // Update UI
  updateUserDropdown();
  loadStats();
  
  // Setup auto-scan toggle
  const toggle = document.getElementById('autoScanToggle');
  const check = document.getElementById('autoScanCheck');
  if (toggle && check) {
    check.checked = data.autoScan || false;
    toggle.classList.toggle('active', check.checked);
  }
  
  // Set scan interval
  const interval = document.getElementById('scanInterval');
  if (interval) {
    interval.value = data.scanInterval || 3600;
  }
  
  // Update next scan time
  if (data.autoScan && data.nextScanTime) {
    updateNextScanDisplay(data.nextScanTime);
  }
  
  // Check for pending scan status
  if (data.scanStatus === 'scanning') {
    startScanMonitoring();
  }
}

function updateUserDropdown() {
  const dropdown = document.getElementById('currentUserDisplay');
  const menuItems = document.getElementById('userMenuItems');
  
  if (dropdown) {
    dropdown.textContent = `@${currentUser}`;
  }
  
  if (menuItems) {
    menuItems.innerHTML = '';
    
    // Load user data to show stats
    chrome.storage.local.get(['users'], (result) => {
      const users = result.users || {};
      
      userList.forEach(username => {
        const userData = users[username] || {};
        const followerCount = userData.followers?.length || 0;
        const lastCheck = userData.lastCheck;
        const scanCount = userData.scanCount || 0;
        
        const item = document.createElement('div');
        item.className = 'user-menu-item' + (username === currentUser ? ' active' : '');
        
        let statsText = `${followerCount} followers`;
        if (scanCount > 0) {
          statsText += ` • ${scanCount} scans`;
        }
        if (lastCheck) {
          statsText += ` • ${formatTimeAgo(lastCheck)}`;
        }
        
        item.innerHTML = `
          <span>@${username}</span>
          <span class="user-stats">${statsText}</span>
        `;
        
        item.addEventListener('click', () => switchUser(username));
        menuItems.appendChild(item);
      });
    });
  }
}

function switchUser(username) {
  if (username === currentUser) {
    closeUserMenu();
    return;
  }
  
  currentUser = username;
  chrome.storage.local.set({ currentUser: username });
  
  // Update UI
  updateUserDropdown();
  closeUserMenu();
  loadStats();
  
  showNotification(`Switched to @${username}`, 'success');
}

function setupEventListeners() {
  // Scan button
  const scanBtn = document.getElementById('scanBtn');
  if (scanBtn) scanBtn.addEventListener('click', startScan);
  
  // User dropdown
  const userDropdown = document.getElementById('userDropdown');
  if (userDropdown) {
    userDropdown.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleUserMenu();
    });
  }
  
  // Close dropdown when clicking outside
  document.addEventListener('click', () => {
    closeUserMenu();
  });
  
  // Add user button
  const addUserBtn = document.getElementById('addUserBtn');
  if (addUserBtn) {
    addUserBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      promptAddUser();
    });
  }
  
  // Auto-scan toggle
  const toggle = document.getElementById('autoScanToggle');
  const check = document.getElementById('autoScanCheck');
  if (toggle && check) {
    toggle.addEventListener('click', () => {
      check.checked = !check.checked;
      toggle.classList.toggle('active', check.checked);
      updateAutoScan();
    });
  }
  
  // Scan interval
  const interval = document.getElementById('scanInterval');
  if (interval) {
    interval.addEventListener('change', () => {
      updateAutoScan();
    });
  }
  
  // Tab switching
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', (e) => {
      switchView(e.target.dataset.view);
    });
  });

  // Delegate clicks for profile links
  const content = document.querySelector('.content');
  if (content) {
    content.addEventListener('click', async (e) => {
      const tgt = e.target;
      const username = tgt.dataset?.username;
      if (!username) return;

      e.preventDefault();

      if (tgt.classList.contains('open-bg')) {
        chrome.tabs.create({ url: `https://x.com/${username}`, active: false });
      } else if (tgt.classList.contains('profile-link') || tgt.classList.contains('open-fg')) {
        chrome.tabs.create({ url: `https://x.com/${username}`, active: true });
      }
    });
  }
}

function toggleUserMenu() {
  const menu = document.getElementById('userMenu');
  const dropdown = document.getElementById('userDropdown');
  
  if (menu && dropdown) {
    const isOpen = menu.classList.contains('open');
    
    if (!isOpen) {
      // Refresh dropdown content before opening
      updateUserDropdown();
    }
    
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
  
  if (!cleanUsername || !/^[a-zA-Z0-9_]{1,15}$/.test(cleanUsername)) {
    showNotification('Invalid username format', 'error');
    return;
  }
  
  if (userList.includes(cleanUsername)) {
    showNotification('User already tracked', 'warning');
    switchUser(cleanUsername);
    return;
  }
  
  // Add to list
  userList.push(cleanUsername);
  await chrome.storage.local.set({ userList: userList, currentUser: cleanUsername });
  
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
  
  chrome.storage.local.set({
    autoScan: enabled,
    scanInterval: intervalSeconds
  });
  
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
    const now = Date.now();
    const remaining = nextScanTime - now;
    
    if (remaining <= 0) {
      nextScanEl.textContent = '';
      return;
    }
    
    const minutes = Math.floor(remaining / 60000);
    const hours = Math.floor(minutes / 60);
    
    if (hours > 0) {
      nextScanEl.textContent = `Next scan in ${hours}h ${minutes % 60}m`;
    } else {
      nextScanEl.textContent = `Next scan in ${minutes}m`;
    }
  };
  
  updateDisplay();
  
  if (nextScanInterval) clearInterval(nextScanInterval);
  nextScanInterval = setInterval(updateDisplay, 30000);
}

function startNextScanCountdown() {
  chrome.storage.local.get(['autoScan', 'nextScanTime'], (result) => {
    if (result.autoScan && result.nextScanTime) {
      updateNextScanDisplay(result.nextScanTime);
    }
  });
}

function switchView(view) {
  currentView = view;
  
  document.querySelectorAll('.tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.view === view);
  });
  
  document.getElementById('dashboardView').style.display = view === 'dashboard' ? 'block' : 'none';
  document.getElementById('unfollowersView').style.display = view === 'unfollowers' ? 'block' : 'none';
  document.getElementById('newFollowersView').style.display = view === 'new' ? 'block' : 'none';
  
  if (view !== 'dashboard') {
    loadStats();
  }
}

async function startScan() {
  const btn = document.getElementById('scanBtn');
  if (!btn) return;

  const username = currentUser;
  
  // Validate username
  if (!username || username.includes('@')) {
    showNotification('Please enter a valid X username (without @)', 'error');
    return;
  }

  // Check if already scanning
  const status = await getStorageData(['scanStatus']);
  if (status.scanStatus === 'scanning') {
    showNotification('Scan already in progress', 'warning');
    return;
  }

  // Update UI for scanning state
  btn.disabled = true;
  btn.innerHTML = '<span>⏳</span><span>Opening page...</span>';
  
  const statusDot = document.getElementById('scanStatusDot');
  const statusText = document.getElementById('scanStatusText');
  if (statusDot && statusText) {
    statusDot.classList.add('scanning');
    statusText.textContent = 'Starting...';
  }

  // Show progress bar
  const progressBar = document.getElementById('scanProgress');
  const progressFill = document.getElementById('scanProgressFill');
  if (progressBar && progressFill) {
    progressBar.style.display = 'block';
    progressFill.style.width = '0%';
  }

  // Save username and set scan status
  chrome.storage.local.set({ 
    currentUser: username,
    scanStatus: 'scanning',
    lastScanAttempt: Date.now()
  });

  try {
    // Send message to background script
    const response = await sendMessage({ action: 'startScan', username });
    
    if (response?.status === 'scanning') {
      // Start monitoring
      startScanMonitoring();
      
      // Update UI
      if (statusText) statusText.textContent = 'Scanning...';
    } else {
      throw new Error(response?.message || 'Failed to start scan');
    }
  } catch (error) {
    console.error('Scan start error:', error);
    showNotification(error.message || 'Failed to start scan', 'error');
    resetScanUI();
  }
}

// Keep checking scan status to update UI
function startScanMonitoring() {
  let attempts = 0;
  const maxAttempts = 600; // 10 minutes maximum
  
  const checkInterval = setInterval(() => {
    attempts++;
    
    // Safety timeout
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
      
      // Update progress
      if (result.scanProgress) {
        if (statusText) {
          statusText.textContent = `Scanning... ${result.scanProgress}%`;
        }
        if (progressFill) {
          progressFill.style.width = `${result.scanProgress}%`;
        }
      }
      
      if (result.scanStatus === 'complete') {
        clearInterval(checkInterval);
        
        // Check if scan was for current user
        const scannedUser = result._currentScanUsername || currentUser;
        
        // If user was added during scan, update the list
        if (scannedUser && !userList.includes(scannedUser)) {
          userList.push(scannedUser);
          chrome.storage.local.set({ userList: userList });
        }
        
        // Switch to scanned user if different
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
        const errorMsg = result.lastError || 'Scan failed';
        showNotification(errorMsg, 'error');
      }
    });
  }, 1000);
}

// Reset scan button and status UI
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

  // Hide progress bar
  const progressBar = document.getElementById('scanProgress');
  if (progressBar) {
    setTimeout(() => {
      progressBar.style.display = 'none';
    }, 2000);
  }
}

function loadStats() {
  chrome.storage.local.get(['users'], (result) => {
    const users = result.users || {};
    const userData = users[currentUser] || {};
    
    const totalFollowers = userData.followers?.length || 0;
    const unfollowers = userData.unfollowers || [];
    const newFollowers = userData.newFollowers || [];
    const lastCheck = userData.lastCheck;
    
    // Update dashboard stats
    document.getElementById('totalFollowers').textContent = totalFollowers.toLocaleString();
    document.getElementById('newFollowersCount').textContent = '+' + newFollowers.length;
    document.getElementById('unfollowersCount').textContent = unfollowers.length;
    
    const netGrowth = newFollowers.length - unfollowers.length;
    const netGrowthEl = document.getElementById('netGrowth');
    netGrowthEl.textContent = (netGrowth >= 0 ? '+' : '') + netGrowth;
    netGrowthEl.style.color = netGrowth >= 0 ? '#10b981' : '#ef4444';
    
    // Update last check time
    if (lastCheck) {
      const timeAgo = formatTimeAgo(lastCheck);
      document.getElementById('lastCheck').textContent = `Last: ${timeAgo}`;
    } else {
      document.getElementById('lastCheck').textContent = 'Never scanned';
    }
    
    // Update views based on current view
    if (currentView === 'dashboard') {
      renderRecentActivity(unfollowers, newFollowers);
    } else if (currentView === 'unfollowers') {
      renderUnfollowersList(unfollowers);
    } else if (currentView === 'new') {
      renderNewFollowersList(newFollowers);
    }
  });
}

function renderRecentActivity(unfollowers, newFollowers) {
  const container = document.getElementById('recentActivity');
  
  if (unfollowers.length === 0 && newFollowers.length === 0) {
    container.innerHTML = '<div class="info-box">No recent activity. Click "Scan Now" to check for changes.</div>';
    return;
  }
  
  let html = '<h3 style="font-size: 13px; margin: 16px 0 12px 0; color: rgba(255,255,255,0.7);">Recent Activity</h3>';
  html += '<div class="user-list">';
  
  // Combine and sort by timestamp
  const recentActivity = [
    ...unfollowers.map(u => ({ ...u, type: 'unfollow' })),
    ...newFollowers.map(u => ({ ...u, type: 'new' }))
  ].sort((a, b) => {
    const timeA = a.unfollowedAt || a.timestamp || 0;
    const timeB = b.unfollowedAt || b.timestamp || 0;
    return timeB - timeA;
  }).slice(0, 5);

  recentActivity.forEach(user => {
    html += renderUserCard(user, user.type);
  });
  
  html += '</div>';
  container.innerHTML = html;
}

function renderUnfollowersList(unfollowers) {
  const container = document.getElementById('unfollowersList');
  
  if (unfollowers.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">✅</div>
        <div class="empty-state-title">No unfollowers detected</div>
        <div class="empty-state-text">Great job maintaining your audience!</div>
      </div>
    `;
    return;
  }
  
  // Sort by most recent
  const sorted = [...unfollowers].sort((a, b) => {
    return (b.unfollowedAt || 0) - (a.unfollowedAt || 0);
  });
  
  let html = `<div style="margin-bottom: 12px; font-size: 13px; color: rgba(255,255,255,0.7);">Unfollowers (${unfollowers.length})</div>`;
  html += '<div class="user-list">';
  
  sorted.forEach(user => {
    html += renderUserCard(user, 'unfollow');
  });
  
  html += '</div>';
  container.innerHTML = html;
}

function renderNewFollowersList(newFollowers) {
  const container = document.getElementById('newFollowersList');
  
  if (newFollowers.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">👀</div>
        <div class="empty-state-title">No new followers yet</div>
        <div class="empty-state-text">Keep creating great content!</div>
      </div>
    `;
    return;
  }
  
  // Sort by most recent
  const sorted = [...newFollowers].sort((a, b) => {
    return (b.timestamp || 0) - (a.timestamp || 0);
  });
  
  let html = `<div style="margin-bottom: 12px; font-size: 13px; color: rgba(255,255,255,0.7);">New Followers (${newFollowers.length})</div>`;
  html += '<div class="user-list">';
  
  sorted.forEach(user => {
    html += renderUserCard(user, 'new');
  });
  
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
  const timestamp = user.unfollowedAt || user.timestamp;
  
  return `
    <div class="user-card" style="background: ${bgColor}; border-color: ${borderColor};">
      <div class="user-info">
        <div class="user-avatar" style="background: ${avatarColor};">
          ${user.name.charAt(0).toUpperCase()}
        </div>
        <div class="user-details">
          <div class="user-name">${escapeHtml(user.name)}</div>
          <div class="user-username">
            <a href="#" class="profile-link" data-username="${user.username}">@${escapeHtml(user.username)}</a>
          </div>
        </div>
      </div>
      <div class="user-time">
        <div class="user-status" style="color: ${statusColor};">${status}</div>
        <div class="time-ago">${formatTimeAgo(timestamp)}</div>
      </div>
    </div>
  `;
}

function formatTimeAgo(timestamp) {
  if (!timestamp) return 'Unknown';
  
  const now = Date.now();
  const diff = now - timestamp;
  
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

// Helper: Escape HTML to prevent XSS
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Helper: Get storage data as promise
function getStorageData(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, resolve);
  });
}

// Helper: Send message as promise
function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

// Show notification toast
function showNotification(message, type = 'info') {
  // Remove existing notification
  const existing = document.getElementById('notificationToast');
  if (existing) existing.remove();
  
  const toast = document.createElement('div');
  toast.id = 'notificationToast';
  
  const colors = {
    success: { bg: '#10b981', border: '#059669' },
    error: { bg: '#ef4444', border: '#dc2626' },
    warning: { bg: '#f59e0b', border: '#d97706' },
    info: { bg: '#3b82f6', border: '#2563eb' }
  };
  
  const color = colors[type] || colors.info;
  
  toast.style.cssText = `
    position: fixed;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    background: ${color.bg};
    color: white;
    padding: 12px 20px;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    z-index: 999999;
    font-size: 13px;
    font-weight: 500;
    border: 2px solid ${color.border};
    animation: slideUp 0.3s ease;
    max-width: 320px;
    text-align: center;
  `;
  
  toast.textContent = message;
  
  // Add animation
  const style = document.createElement('style');
  style.textContent = `
    @keyframes slideUp {
      from { 
        opacity: 0;
        transform: translateX(-50%) translateY(20px);
      }
      to { 
        opacity: 1;
        transform: translateX(-50%) translateY(0);
      }
    }
  `;
  document.head.appendChild(style);
  
  document.body.appendChild(toast);
  
  // Auto-remove after 4 seconds
  setTimeout(() => {
    toast.style.transition = 'opacity 0.3s';
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// Listen for messages from background/content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'scanComplete') {
    // Refresh user list and switch to scanned user
    loadUserData().then(() => {
      loadStats();
      resetScanUI(true);
      const scannedUser = request.username || currentUser;
      showNotification(`Scan completed for @${scannedUser}!`, 'success');
    });
  }
  
  if (request.action === 'scanError') {
    showNotification(request.error || 'Scan failed', 'error');
    resetScanUI();
  }
  
  if (request.action === 'scanProgress') {
    const statusText = document.getElementById('scanStatusText');
    const progressFill = document.getElementById('scanProgressFill');
    
    if (statusText && request.progress) {
      statusText.textContent = `Scanning... ${request.progress}%`;
    }
    if (progressFill && request.progress) {
      progressFill.style.width = `${request.progress}%`;
    }
  }
});