// ============================================
// FILE: popup.js
// ============================================
// Popup interface logic

let currentView = 'dashboard';

// Initialize popup
document.addEventListener('DOMContentLoaded', () => {
  loadStats();
  setupEventListeners();
  
  // Load saved username and scan settings
  chrome.storage.local.get(['username', 'autoScan', 'scanInterval'], (res) => {
    const username = res.username || 'rohit_dwivedi';
    const el = document.getElementById('usernameInput');
    if (el) el.value = username;
    
    // Setup auto-scan toggle
    const toggle = document.getElementById('autoScanToggle');
    const check = document.getElementById('autoScanCheck');
    if (toggle && check) {
      check.checked = res.autoScan || false;
      toggle.classList.toggle('active', check.checked);
    }
    
    // Set scan interval
    const interval = document.getElementById('scanInterval');
    if (interval) {
      interval.value = res.scanInterval || '3600';
    }
    
    // Start auto-scan if enabled
    if (res.autoScan) {
      scheduleNextScan();
    }
  });
});

// Schedule next auto-scan
function scheduleNextScan() {
  const interval = document.getElementById('scanInterval')?.value || '3600';
  const nextScan = Date.now() + (parseInt(interval) * 1000);
  
  chrome.storage.local.set({ nextScanTime: nextScan });
  
  // Check every minute if it's time to scan
  setTimeout(checkAutoScan, 60000);
}

// Check if it's time for auto-scan
function checkAutoScan() {
  chrome.storage.local.get(['autoScan', 'nextScanTime'], (res) => {
    if (res.autoScan && res.nextScanTime && Date.now() >= res.nextScanTime) {
      startScan();
    } else if (res.autoScan) {
      // Check again in a minute
      setTimeout(checkAutoScan, 60000);
    }
  });
}

function setupEventListeners() {
  // Scan button
  const scanBtn = document.getElementById('scanBtn');
  if (scanBtn) scanBtn.addEventListener('click', startScan);
  
  // Username input
  const usernameInput = document.getElementById('usernameInput');
  if (usernameInput) {
    usernameInput.value = usernameInput.value || 'rohit_dwivedi';
    usernameInput.addEventListener('change', (e) => {
      chrome.storage.local.set({ username: e.target.value });
    });
  }
  
  // Auto-scan toggle
  const toggle = document.getElementById('autoScanToggle');
  const check = document.getElementById('autoScanCheck');
  if (toggle && check) {
    toggle.addEventListener('click', () => {
      check.checked = !check.checked;
      toggle.classList.toggle('active', check.checked);
      chrome.storage.local.set({ autoScan: check.checked });
      
      if (check.checked) {
        scheduleNextScan();
      }
    });
  }
  
  // Scan interval
  const interval = document.getElementById('scanInterval');
  if (interval) {
    interval.addEventListener('change', (e) => {
      chrome.storage.local.set({ scanInterval: e.target.value });
      if (check.checked) {
        scheduleNextScan();
      }
    });
  }
  
  // Tab switching
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', (e) => {
      switchView(e.target.dataset.view);
    });
  });

  // Delegate clicks inside the content area for profile actions
  const content = document.querySelector('.content');
  if (content) {
    content.addEventListener('click', async (e) => {
      const tgt = e.target;
      const username = tgt.dataset?.username;
      if (!username) return;

      e.preventDefault();

      // Open in background tab
      if (tgt.classList.contains('open-bg')) {
        chrome.tabs.create({ url: `https://x.com/${username}`, active: false });
        return;
      }

      // Try to use current tab if it's on x.com
      if (tgt.classList.contains('profile-link')) {
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab?.url?.includes('x.com') || tab?.url?.includes('twitter.com')) {
            // Update URL in current tab
            chrome.tabs.update(tab.id, { url: `https://x.com/${username}` });
          } else {
            // Create new tab if not on X
            chrome.tabs.create({ url: `https://x.com/${username}`, active: true });
          }
        } catch (e) {
          // Fallback to new tab if query fails
          chrome.tabs.create({ url: `https://x.com/${username}`, active: true });
        }
        return;
      }
    });
  }
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

  const username = (document.getElementById('usernameInput') && document.getElementById('usernameInput').value) || 'rohit_dwivedi';
  if (!username) {
    alert('Please enter your X username (without @) before scanning.');
    return;
  }

  // Update UI for scanning state
  btn.disabled = true;
  btn.innerHTML = '<span>⏳</span><span>Scanning...</span>';
  
  const statusDot = document.getElementById('scanStatusDot');
  const statusText = document.getElementById('scanStatusText');
  if (statusDot && statusText) {
    statusDot.classList.add('scanning');
    statusText.textContent = 'Scanning...';
  }

  // Save username and last scan attempt time
  chrome.storage.local.set({ 
    username,
    lastScanAttempt: Date.now()
  });

  // Send message to background script to start scan
  chrome.runtime.sendMessage({ action: 'startScan', username }, (response) => {
    if (response?.status === 'scanning') {
      // Scan started successfully - keep button disabled until scanComplete message
      if (document.getElementById('autoScanCheck')?.checked) {
        scheduleNextScan();
      }
    } else {
      // Reset UI on error
      btn.disabled = false;
      btn.innerHTML = '<span>🔄</span><span>Scan Now</span>';
      if (statusDot && statusText) {
        statusDot.classList.remove('scanning');
        statusText.textContent = 'Error';
      }
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
  
  // Show up to 3 recent changes (by username)
  const recent = [...unfollowers.slice(0, 2), ...newFollowers.slice(0, 1)];
  const unfollowUsernames = new Set(unfollowers.map(u => u.username));
  const newUserUsernames = new Set(newFollowers.map(u => u.username));

  recent.forEach(user => {
    const isUnfollow = unfollowUsernames.has(user.username);
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
            <div class="user-username">
              <a href="#" class="profile-link" data-username="${user.username}">@${user.username}</a>
              <button class="open-fg" data-username="${user.username}" style="margin-left:8px;padding:4px;border-radius:4px;font-size:11px;">Open</button>
              <button class="open-bg" data-username="${user.username}" style="margin-left:4px;padding:4px;border-radius:4px;font-size:11px;">BG</button>
            </div>
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
            <div class="user-username">
              <a href="#" class="profile-link" data-username="${user.username}">@${user.username}</a>
              <button class="open-fg" data-username="${user.username}" style="margin-left:8px;padding:4px;border-radius:4px;font-size:11px;">Open</button>
              <button class="open-bg" data-username="${user.username}" style="margin-left:4px;padding:4px;border-radius:4px;font-size:11px;">BG</button>
            </div>
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
            <div class="user-username">
              <a href="#" class="profile-link" data-username="${user.username}">@${user.username}</a>
              <button class="open-fg" data-username="${user.username}" style="margin-left:8px;padding:4px;border-radius:4px;font-size:11px;">Open</button>
              <button class="open-bg" data-username="${user.username}" style="margin-left:4px;padding:4px;border-radius:4px;font-size:11px;">BG</button>
            </div>
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

// Listen for scan completion and errors
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'scanComplete') {
    loadStats();
    
    // Reset scan button
    const btn = document.getElementById('scanBtn');
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<span>🔄</span><span>Scan Now</span>';
    }
    
    // Update status indicators
    const statusDot = document.getElementById('scanStatusDot');
    const statusText = document.getElementById('scanStatusText');
    if (statusDot && statusText) {
      statusDot.classList.remove('scanning');
      statusText.textContent = 'Ready';
    }
    
    // Schedule next scan if auto-scan is enabled
    if (document.getElementById('autoScanCheck')?.checked) {
      scheduleNextScan();
    }
  }
  
  if (request.action === 'scanError') {
    // Show error
    alert('Scan error: ' + request.error);
    
    // Reset UI
    const btn = document.getElementById('scanBtn');
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<span>🔄</span><span>Scan Now</span>';
    }
    
    // Update status
    const statusDot = document.getElementById('scanStatusDot');
    const statusText = document.getElementById('scanStatusText');
    if (statusDot && statusText) {
      statusDot.classList.remove('scanning');
      statusText.textContent = 'Error';
    }
  }
});