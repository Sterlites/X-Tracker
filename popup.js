// ============================================
// FILE: popup.js
// ============================================
// Popup interface logic

let currentView = 'dashboard';

// Initialize popup
document.addEventListener('DOMContentLoaded', () => {
  loadStats();
  setupEventListeners();
  // Load saved username
  chrome.storage.local.get(['username'], (res) => {
    if (res.username) {
      const el = document.getElementById('usernameInput');
      if (el) el.value = res.username;
    }
  });
});

function setupEventListeners() {
  // Scan button
  const scanBtn = document.getElementById('scanBtn');
  if (scanBtn) scanBtn.addEventListener('click', startScan);
  const usernameInput = document.getElementById('usernameInput');
  if (usernameInput) {
    usernameInput.addEventListener('change', (e) => {
      chrome.storage.local.set({ username: e.target.value });
    });
  }
  
  // Tab switching
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', (e) => {
      switchView(e.target.dataset.view);
    });
  });
}

function switchView(view) {
  currentView = view;
  
  // Update tabs
  document.querySelectorAll('.tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.view === view);
  });
  
  // Update views
  document.getElementById('dashboardView').style.display = view === 'dashboard' ? 'block' : 'none';
  document.getElementById('unfollowersView').style.display = view === 'unfollowers' ? 'block' : 'none';
  document.getElementById('newFollowersView').style.display = view === 'new' ? 'block' : 'none';
  
  if (view !== 'dashboard') {
    loadStats();
  }
}

function startScan() {
  const btn = document.getElementById('scanBtn');
  if (!btn) return;

  const username = (document.getElementById('usernameInput') && document.getElementById('usernameInput').value) || '';
  if (!username) {
    alert('Please enter your X username (without @) before scanning.');
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<span>⏳</span><span>Scanning...</span>';

  // Save username
  chrome.storage.local.set({ username });

  // Send message to background script to start scan and include username
  chrome.runtime.sendMessage({ action: 'startScan', username }, (response) => {
    if (response?.status === 'scanning') {
      // Scan started successfully - keep button disabled until scanComplete message
    } else {
      btn.disabled = false;
      btn.innerHTML = '<span>🔄</span><span>Scan Now</span>';
      alert('Error starting scan. Make sure you are logged into X and the username is correct.');
    }
  });
}

function loadStats() {
  chrome.storage.local.get([
    'followers',
    'unfollowers',
    'newFollowers',
    'lastCheck'
  ], (result) => {
    const totalFollowers = result.followers?.length || 0;
    const unfollowers = result.unfollowers || [];
    const newFollowers = result.newFollowers || [];
    const lastCheck = result.lastCheck;
    
    // Update dashboard stats
    document.getElementById('totalFollowers').textContent = totalFollowers.toLocaleString();
    document.getElementById('newFollowersCount').textContent = '+' + newFollowers.length;
    document.getElementById('unfollowersCount').textContent = unfollowers.length;
    document.getElementById('netGrowth').textContent = '+' + (newFollowers.length - unfollowers.length);
    
    // Update last check time
    if (lastCheck) {
      const timeAgo = formatTimeAgo(lastCheck);
      document.getElementById('lastCheck').textContent = `Last checked: ${timeAgo}`;
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
  
  let html = '<h3 style="font-size: 13px; margin-bottom: 12px; color: rgba(255,255,255,0.7);">Recent Activity</h3>';
  html += '<div class="user-list">';
  
  // Show up to 3 recent changes
  const recent = [...unfollowers.slice(0, 2), ...newFollowers.slice(0, 1)];
  
  recent.forEach(user => {
    const isUnfollow = unfollowers.includes(user);
    const bgColor = isUnfollow ? 'rgba(239, 68, 68, 0.2)' : 'rgba(16, 185, 129, 0.2)';
    const avatarColor = isUnfollow ? 'linear-gradient(135deg, #ef4444, #dc2626)' : 'linear-gradient(135deg, #10b981, #059669)';
    const status = isUnfollow ? 'Unfollowed' : 'New Follower';
    const statusColor = isUnfollow ? '#ef4444' : '#10b981';
    
    html += `
      <div class="user-card" style="background: ${bgColor};">
        <div class="user-info">
          <div class="user-avatar" style="background: ${avatarColor};">
            ${user.name.charAt(0).toUpperCase()}
          </div>
          <div class="user-details">
            <div class="user-name">${user.name}</div>
            <div class="user-username">@${user.username}</div>
          </div>
        </div>
        <div class="user-time">
          <div class="user-status" style="color: ${statusColor};">${status}</div>
          <div class="time-ago">${formatTimeAgo(user.unfollowedAt || user.timestamp)}</div>
        </div>
      </div>
    `;
  });
  
  html += '</div>';
  container.innerHTML = html;
}

function renderUnfollowersList(unfollowers) {
  const container = document.getElementById('unfollowersList');
  
  if (unfollowers.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; padding: 40px 20px; color: rgba(255,255,255,0.5);">
        <div style="font-size: 48px; margin-bottom: 16px;">✅</div>
        <div style="font-size: 14px; margin-bottom: 8px;">No unfollowers detected</div>
        <div style="font-size: 12px;">Great job maintaining your audience!</div>
      </div>
    `;
    return;
  }
  
  let html = `<div style="margin-bottom: 12px; font-size: 13px; color: rgba(255,255,255,0.7);">Unfollowers (${unfollowers.length})</div>`;
  html += '<div class="user-list">';
  
  unfollowers.forEach(user => {
    html += `
      <div class="user-card" style="background: rgba(239, 68, 68, 0.1); border-color: rgba(239, 68, 68, 0.3);">
        <div class="user-info">
          <div class="user-avatar" style="background: linear-gradient(135deg, #ef4444, #dc2626);">
            ${user.name.charAt(0).toUpperCase()}
          </div>
          <div class="user-details">
            <div class="user-name">${user.name}</div>
            <div class="user-username">@${user.username}</div>
          </div>
        </div>
        <div class="user-time">
          <div class="user-status" style="color: #ef4444;">Unfollowed</div>
          <div class="time-ago">${formatTimeAgo(user.unfollowedAt || user.timestamp)}</div>
        </div>
      </div>
    `;
  });
  
  html += '</div>';
  container.innerHTML = html;
}

function renderNewFollowersList(newFollowers) {
  const container = document.getElementById('newFollowersList');
  
  if (newFollowers.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; padding: 40px 20px; color: rgba(255,255,255,0.5);">
        <div style="font-size: 48px; margin-bottom: 16px;">👀</div>
        <div style="font-size: 14px;">No new followers yet</div>
      </div>
    `;
    return;
  }
  
  let html = `<div style="margin-bottom: 12px; font-size: 13px; color: rgba(255,255,255,0.7);">New Followers (${newFollowers.length})</div>`;
  html += '<div class="user-list">';
  
  newFollowers.forEach(user => {
    html += `
      <div class="user-card" style="background: rgba(16, 185, 129, 0.1); border-color: rgba(16, 185, 129, 0.3);">
        <div class="user-info">
          <div class="user-avatar" style="background: linear-gradient(135deg, #10b981, #059669);">
            ${user.name.charAt(0).toUpperCase()}
          </div>
          <div class="user-details">
            <div class="user-name">${user.name}</div>
            <div class="user-username">@${user.username}</div>
          </div>
        </div>
        <div class="user-time">
          <div class="user-status" style="color: #10b981;">New Follower</div>
          <div class="time-ago">${formatTimeAgo(user.timestamp)}</div>
        </div>
      </div>
    `;
  });
  
  html += '</div>';
  container.innerHTML = html;
}

function formatTimeAgo(timestamp) {
  const now = Date.now();
  const diff = now - timestamp;
  
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'Just now';
}

// Listen for scan completion
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'scanComplete') {
    loadStats();
    const btn = document.getElementById('scanBtn');
    btn.disabled = false;
    btn.innerHTML = '<span>🔄</span><span>Scan Now</span>';
  }
  
  if (request.action === 'scanError') {
    alert('Scan error: ' + request.error);
    const btn = document.getElementById('scanBtn');
    btn.disabled = false;
    btn.innerHTML = '<span>🔄</span><span>Scan Now</span>';
  }
});