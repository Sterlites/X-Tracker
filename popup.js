/**
 * X-Unfollow Tracker - Popup UI Script
 * Handles all UI interactions, data display, and user actions
 */

// ================== State Variables ==================
let currentView = 'dashboard';
let currentUser = null;
let userList = [];
let monitoringInterval = null;
let filterState = {
  following: 'all'
};
let searchState = {};
let autoScanState = {
  autoScanEnabled: false,
  autoScanIntervalMinutes: 120
};

// ================== Initialization ==================

/**
 * Initialize popup when DOM is ready
 */
document.addEventListener('DOMContentLoaded', () => {
  loadUserData();
  setupEventListeners();
});

/**
 * Load user data from storage
 */
async function loadUserData() {
  const data = await getFromStorage(['users', 'currentUser', 'userList', 'scanStatus', '_scanStartTime']);
  
  currentUser = data.currentUser;
  userList = data.userList || [];
  
  // Initialize userList if empty but we have a currentUser
  if (!userList.length && currentUser) {
    userList = [currentUser];
  }
  
  // Ensure currentUser is in userList
  if (currentUser && !userList.includes(currentUser)) {
    userList.unshift(currentUser);
  }
  
  // Save updated userList
  await chrome.storage.local.set({ userList: userList });
  
  // Update UI
  updateUserDropdown();
  await loadAutoScanSettings();
  loadStats();
  
  // Check for stuck scans
  if (data.scanStatus === 'scanning') {
    const scanAge = Date.now() - (data._scanStartTime || 0);
    
    if (scanAge > 300000) { // 5 minutes
      // Auto-clear very old scans
      await chrome.storage.local.set({ scanStatus: 'idle' });
      showNotification('Stuck scan detected and cleared', 'warning');
      resetUIState();
    } else if (scanAge > 120000) { // 2 minutes
      // Show force stop button for potentially stuck scans
      const forceStopBtn = document.getElementById('forceStopBtn');
      if (forceStopBtn) {
        forceStopBtn.style.display = 'block';
      }
      const stopBtn = document.getElementById('stopScanBtn');
      if (stopBtn) {
        stopBtn.style.display = 'none';
      }
      startMonitoring();
    } else {
      // Normal ongoing scan
      startMonitoring();
    }
  }
}

async function loadAutoScanSettings() {
  try {
    const settings = await sendMessage({ action: 'getAutoScanSettings' });
    autoScanState = {
      ...autoScanState,
      ...settings
    };
    renderAutoScanControls();
  } catch (error) {
    console.error('Failed to load auto-scan settings:', error);
  }
}

function renderAutoScanControls() {
  const enabledEl = document.getElementById('autoScanEnabled');
  const intervalEl = document.getElementById('autoScanInterval');
  const statusEl = document.getElementById('autoScanStatus');
  if (!enabledEl || !intervalEl || !statusEl) {
    return;
  }

  enabledEl.checked = !!autoScanState.autoScanEnabled;
  intervalEl.value = String(autoScanState.autoScanIntervalMinutes || 120);

  if (!autoScanState.autoScanEnabled) {
    statusEl.textContent = 'Auto scan is off.';
    return;
  }

  const cooldownUntil = autoScanState.autoScanCooldownUntil || 0;
  const nextRunAt = autoScanState.autoScanNextRunAt || 0;
  if (cooldownUntil > Date.now()) {
    statusEl.textContent = `Cooldown until ${formatDateTime(cooldownUntil)}.`;
  } else if (nextRunAt) {
    statusEl.textContent = `Next check ${formatDateTime(nextRunAt)}.`;
  } else {
    statusEl.textContent = 'Auto scan is on.';
  }
}

async function saveAutoScanSettings() {
  const enabledEl = document.getElementById('autoScanEnabled');
  const intervalEl = document.getElementById('autoScanInterval');
  if (!enabledEl || !intervalEl) {
    return;
  }

  const settings = {
    autoScanEnabled: enabledEl.checked,
    autoScanIntervalMinutes: Number(intervalEl.value) || 120
  };

  const result = await sendMessage({ action: 'setAutoScanSettings', settings });
  if (result?.status === 'ok') {
    autoScanState = { ...autoScanState, ...result };
    renderAutoScanControls();
    showQuickToast('Auto scan settings updated', 'success');
  } else {
    showNotification(result?.message || 'Failed to update auto scan settings', 'error');
  }
}

async function runAutoScanNow() {
  const response = await sendMessage({ action: 'runAutoScanNow' });
  if (response?.status === 'scanning') {
    showNotification('Auto scan started', 'info');
    startMonitoring();
  } else if (response?.status === 'probe_only') {
    showNotification('No follower count change detected', 'info');
    await loadUserData();
  } else if (response?.status === 'skipped') {
    showNotification(`Auto check skipped: ${response.reason}`, 'warning');
  } else if (response?.status === 'error') {
    showNotification(response.message || 'Auto scan failed', 'error');
  }
}

// ================== User Management ==================

/**
 * Update user dropdown display
 */
function updateUserDropdown() {
  const displayElement = document.getElementById('currentUserDisplay');
  const menuItemsElement = document.getElementById('userMenuItems');
  
  if (displayElement) {
    displayElement.textContent = currentUser ? `@${currentUser}` : 'Select account';
  }
  
  if (menuItemsElement) {
    menuItemsElement.innerHTML = '';
    
    chrome.storage.local.get(['users'], (result) => {
      const users = result.users || {};
      
      userList.forEach(username => {
        const userData = users[username] || {};
        const followersCount = userData.followers?.length || 0;
        const followingCount = userData.following?.length || 0;
        
        // Build stats text
        let statsText = '';
        if (followersCount > 0) {
          statsText += `${followersCount} followers`;
        }
        if (followingCount > 0) {
          if (statsText) statsText += ' • ';
          statsText += `${followingCount} following`;
        }
        if (!statsText) {
          statsText = 'Not scanned';
        }
        
        // Create menu item
        const menuItem = document.createElement('div');
        menuItem.className = 'user-menu-item' + (username === currentUser ? ' active' : '');
        menuItem.innerHTML = `
          <div class="user-menu-item-content">
            <span>@${username}</span>
            <span class="user-stats">${statsText}</span>
          </div>
          <button class="remove-user-btn" data-username="${username}" onclick="event.stopPropagation()">
            Remove
          </button>
        `;
        
        // Add click handler for switching users
        menuItem.addEventListener('click', (e) => {
          if (!e.target.classList.contains('remove-user-btn')) {
            switchUser(username);
          }
        });
        
        // Add remove button handler
        menuItem.querySelector('.remove-user-btn').addEventListener('click', () => {
          removeUser(username);
        });
        
        menuItemsElement.appendChild(menuItem);
      });
    });
  }
}

/**
 * Switch to a different user account
 * @param {string} username - Username to switch to
 */
function switchUser(username) {
  if (username === currentUser) {
    return closeMenu();
  }
  
  currentUser = username;
  chrome.storage.local.set({ currentUser: username });
  
  updateUserDropdown();
  closeMenu();
  loadStats();
  
  showNotification(`Switched to @${username}`, 'success');
}

/**
 * Remove a user from tracking
 * @param {string} username - Username to remove
 */
async function removeUser(username) {
  if (userList.length === 1) {
    showNotification('Cannot remove last account', 'warning');
    return;
  }
  
  if (!confirm(`Remove @${username}? This will delete all tracking data for this account.`)) {
    return;
  }
  
  // Remove from userList
  userList = userList.filter(u => u !== username);
  
  // Remove from storage
  const data = await getFromStorage(['users']);
  const users = data.users || {};
  delete users[username];
  
  await chrome.storage.local.set({
    users: users,
    userList: userList
  });
  
  // Switch to another user if we removed the current one
  if (currentUser === username) {
    currentUser = userList[0];
    await chrome.storage.local.set({ currentUser: currentUser });
  }
  
  updateUserDropdown();
  loadStats();
  
  showNotification(`Removed @${username}`, 'success');
}

/**
 * Prompt user to add new account
 */
async function promptAddUser() {
  const username = prompt('Enter X username (without @ symbol):');
  
  if (!username) {
    return;
  }
  
  // Clean and validate username
  const cleanUsername = username.replace('@', '').trim();
  
  if (!cleanUsername || !/^[a-zA-Z0-9_]{1,15}$/.test(cleanUsername)) {
    showNotification('Invalid username. Must be 1-15 characters, letters, numbers, and underscores only.', 'error');
    return;
  }
  
  // Check if already tracking
  if (userList.includes(cleanUsername)) {
    showNotification('Already tracking this account', 'warning');
    switchUser(cleanUsername);
    return;
  }
  
  // Add to userList
  userList.push(cleanUsername);
  await chrome.storage.local.set({
    userList: userList,
    currentUser: cleanUsername
  });
  
  currentUser = cleanUsername;
  
  updateUserDropdown();
  closeMenu();
  loadStats();
  
  showNotification(`Added @${cleanUsername}`, 'success');
}

// ================== Menu Toggle ==================

/**
 * Toggle user menu open/closed
 */
function toggleMenu() {
  const menu = document.getElementById('userMenu');
  const dropdown = document.getElementById('userDropdown');
  
  if (menu && dropdown) {
    if (!menu.classList.contains('open')) {
      updateUserDropdown(); // Refresh before opening
    }
    menu.classList.toggle('open');
    dropdown.classList.toggle('open');
  }
}

/**
 * Close user menu
 */
function closeMenu() {
  const menu = document.getElementById('userMenu');
  const dropdown = document.getElementById('userDropdown');
  
  if (menu && dropdown) {
    menu.classList.remove('open');
    dropdown.classList.remove('open');
  }
}

// ================== Scanning ==================

/**
 * Start a scan (followers or following)
 * @param {string} scanType - 'followers' or 'following'
 */
async function startScan(scanType) {
  if (!currentUser) {
    showNotification('Please add an account first', 'warning');
    return;
  }
  
  // Check if already scanning
  const status = await getFromStorage(['scanStatus']);
  if (status.scanStatus === 'scanning') {
    showNotification('Scan already in progress', 'warning');
    return;
  }
  
  // Update button state
  const buttonId = scanType === 'followers' ? 'scanFollowersBtn' : 'scanFollowingBtn';
  const button = document.getElementById(buttonId);
  const stopButton = document.getElementById('stopScanBtn');
  
  if (button) {
    button.disabled = true;
    button.innerHTML = '<span>⏳</span><span>Opening...</span>';
  }
  
  if (stopButton) {
    stopButton.style.display = 'block';
  }
  
  // Update status display
  const statusDot = document.getElementById('scanStatusDot');
  const statusText = document.getElementById('scanStatusText');
  if (statusDot && statusText) {
    statusDot.classList.add('scanning');
    statusText.textContent = `Scanning ${scanType}...`;
  }
  
  // Show progress bar
  const progressBar = document.getElementById('scanProgress');
  const progressFill = document.getElementById('scanProgressFill');
  if (progressBar && progressFill) {
    progressBar.style.display = 'block';
    progressFill.style.width = '0%';
  }
  
  // Set scan status
  chrome.storage.local.set({
    currentUser: currentUser,
    scanStatus: 'scanning',
    currentScanType: scanType
  });
  
  try {
    // Send message to background script to start scan
    const response = await sendMessage({
      action: 'startScan',
      username: currentUser,
      scanType: scanType
    });
    
    if (response?.status === 'scanning') {
      startMonitoring();
    } else {
      throw new Error(response?.message || 'Failed to start scan');
    }
  } catch (error) {
    showNotification(error.message || 'Failed to start scan', 'error');
    resetUIState();
  }
}

/**
 * Stop ongoing scan
 */
async function stopScan() {
  const stopButton = document.getElementById('stopScanBtn');
  if (stopButton) {
    stopButton.disabled = true;
    stopButton.textContent = 'Stopping...';
  }
  
  showNotification('Stopping scan...', 'warning');
  
  try {
    // Try to set global stop flag in content script
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          window.xScannerShouldStop = true;
          window.xScannerStopReason = 'manual';
        }
      });
    }
  } catch (error) {
    console.error('Error setting stop flag:', error);
  }
  
  try {
    // Send force stop message
    await chrome.runtime.sendMessage({ action: 'forceStopScan' });
    await chrome.storage.local.set({ scanStatus: 'idle' });
  } catch (error) {
    console.error('Error force stopping:', error);
  }
  
  // Clear monitoring
  if (monitoringInterval) {
    clearInterval(monitoringInterval);
    monitoringInterval = null;
  }
  
  // Reset UI after a delay
  setTimeout(() => {
    resetUIState();
  }, 1000);
}

/**
 * Force stop a stuck scan
 */
async function forceStopScan() {
  showNotification('Force stopping scan...', 'warning');
  
  try {
    await chrome.storage.local.set({ scanStatus: 'idle' });
    await chrome.runtime.sendMessage({ action: 'forceStopScan' });
    resetUIState();
    showNotification('Scan forcibly stopped', 'success');
  } catch (error) {
    console.error('Force stop error:', error);
    showNotification('Force stop failed', 'error');
  }
}

/**
 * Start monitoring scan progress
 */
function startMonitoring() {
  let elapsedTime = 0;
  
  // Clear any existing interval
  if (monitoringInterval) {
    clearInterval(monitoringInterval);
  }
  
  monitoringInterval = setInterval(() => {
    elapsedTime++;
    
    // Timeout after 10 minutes (600 seconds)
    if (elapsedTime >= 600) {
      clearInterval(monitoringInterval);
      monitoringInterval = null;
      chrome.storage.local.set({ scanStatus: 'error' });
      resetUIState();
      showNotification('Scan timeout - taking too long', 'error');
      return;
    }
    
    // Check scan status
    chrome.storage.local.get(['scanStatus', 'scanProgress', 'currentScanType'], (result) => {
      const statusText = document.getElementById('scanStatusText');
      const progressFill = document.getElementById('scanProgressFill');
      
      // Update progress display
      if (result.scanProgress) {
        const scanType = result.currentScanType || 'users';
        if (statusText) {
          statusText.textContent = `Scanning ${scanType}... ${result.scanProgress}%`;
        }
        if (progressFill) {
          progressFill.style.width = `${result.scanProgress}%`;
        }
      }
      
      // Check if complete
      if (result.scanStatus === 'complete') {
        clearInterval(monitoringInterval);
        monitoringInterval = null;
        loadStats();
        resetUIState(true);
        showNotification('Scan completed!', 'success');
      } else if (result.scanStatus === 'error' || result.scanStatus === 'idle') {
        clearInterval(monitoringInterval);
        monitoringInterval = null;
        resetUIState();
        if (result.scanStatus === 'error') {
          showNotification('Scan failed', 'error');
        }
      }
    });
  }, 1000); // Check every second
}

/**
 * Reset UI to idle state
 * @param {boolean} success - Whether scan completed successfully
 */
function resetUIState(success = false) {
  // Reset buttons
  const followersButton = document.getElementById('scanFollowersBtn');
  const followingButton = document.getElementById('scanFollowingBtn');
  const stopButton = document.getElementById('stopScanBtn');
  const forceStopButton = document.getElementById('forceStopBtn');
  
  if (followersButton) {
    followersButton.disabled = false;
    followersButton.innerHTML = '<span>👥</span><span>Scan Followers</span>';
  }
  
  if (followingButton) {
    followingButton.disabled = false;
    followingButton.innerHTML = '<span>🔗</span><span>Scan Following</span>';
  }
  
  if (stopButton) {
    stopButton.style.display = 'none';
    stopButton.disabled = false;
    stopButton.textContent = 'Stop Scan';
  }
  
  if (forceStopButton) {
    forceStopButton.style.display = 'none';
  }
  
  // Reset status display
  const statusDot = document.getElementById('scanStatusDot');
  const statusText = document.getElementById('scanStatusText');
  if (statusDot && statusText) {
    statusDot.classList.remove('scanning');
    statusText.textContent = success ? 'Complete' : 'Ready';
  }
  
  // Hide progress bar after a delay
  const progressBar = document.getElementById('scanProgress');
  if (progressBar) {
    setTimeout(() => {
      progressBar.style.display = 'none';
    }, 2000);
  }
}

// ================== Stats Loading ==================

/**
 * Load and display statistics
 */
function loadStats() {
  if (!currentUser) {
    // Reset all counts if no user
    document.getElementById('totalFollowers').textContent = '0';
    document.getElementById('totalFollowing').textContent = '0';
    document.getElementById('newFollowersCount').textContent = '0';
    document.getElementById('unfollowersCount').textContent = '0';
    document.getElementById('fansCount').textContent = '0';
    document.getElementById('notFollowingBackCount').textContent = '0';
    document.getElementById('lastCheck').textContent = 'No account selected';
    return;
  }
  
  chrome.storage.local.get(['users'], (result) => {
    const users = result.users || {};
    window.__xUsersCache = users;
    const userData = users[currentUser] || {};
    
    // Extract data with null safety
    const followers = (userData.followers || []).filter(f => f && f.username);
    const following = (userData.following || []).filter(f => f && f.username);
    const unfollowers = (userData.unfollowers || []).filter(f => f && f.username);
    const newFollowers = (userData.newFollowers || []).filter(f => f && f.username);
    const fans = (userData.fansList || []).filter(f => f && f.username);
    const notFollowingBack = (userData.notFollowingBack || []).filter(f => f && f.username);
    
    // Update counts
    document.getElementById('totalFollowers').textContent = followers.length.toLocaleString();
    document.getElementById('totalFollowing').textContent = following.length.toLocaleString();
    document.getElementById('newFollowersCount').textContent = '+' + newFollowers.length;
    document.getElementById('unfollowersCount').textContent = unfollowers.length;
    document.getElementById('fansCount').textContent = fans.length;
    document.getElementById('notFollowingBackCount').textContent = notFollowingBack.length;
    
    // Update last check time
    const lastFollowersCheck = userData.lastFollowersCheck;
    const lastFollowingCheck = userData.lastFollowingCheck;
    
    let lastCheckText = 'Never scanned';
    if (lastFollowersCheck && lastFollowingCheck) {
      lastCheckText = `Last: ${formatTime(Math.max(lastFollowersCheck, lastFollowingCheck))}`;
    } else if (lastFollowersCheck) {
      lastCheckText = `Followers: ${formatTime(lastFollowersCheck)}`;
    } else if (lastFollowingCheck) {
      lastCheckText = `Following: ${formatTime(lastFollowingCheck)}`;
    }
    
    document.getElementById('lastCheck').textContent = lastCheckText;
    
    // Render appropriate view
    if (currentView === 'dashboard') {
      renderRecentActivity(unfollowers, newFollowers);
    } else if (currentView === 'unfollowers') {
      renderUnfollowers(unfollowers);
    } else if (currentView === 'new') {
      renderNewFollowers(newFollowers);
    } else if (currentView === 'fans') {
      renderFans(fans);
    } else if (currentView === 'notfollowback') {
      renderNotFollowingBack(notFollowingBack);
    } else if (currentView === 'following') {
      renderFollowing(following);
    } else if (currentView === 'insights') {
      renderInsights(userData);
    }
  });
}

// ================== View Switching ==================

/**
 * Switch between different views
 * @param {string} view - View to switch to
 */
function switchView(view) {
  currentView = view;
  
  // Update tab active states
  document.querySelectorAll('.tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.view === view);
  });
  
  // Show/hide views
  document.getElementById('dashboardView').style.display = view === 'dashboard' ? 'block' : 'none';
  document.getElementById('unfollowersView').style.display = view === 'unfollowers' ? 'block' : 'none';
  document.getElementById('newFollowersView').style.display = view === 'new' ? 'block' : 'none';
  document.getElementById('fansView').style.display = view === 'fans' ? 'block' : 'none';
  document.getElementById('notFollowingBackView').style.display = view === 'notfollowback' ? 'block' : 'none';
  document.getElementById('followingView').style.display = view === 'following' ? 'block' : 'none';
  document.getElementById('insightsView').style.display = view === 'insights' ? 'block' : 'none';
  
  // Load stats for non-dashboard views
  if (view !== 'dashboard') {
    loadStats();
  }
}

// ================== Search & Filter ==================

/**
 * Handle search input
 * @param {string} type - Type of list being searched
 * @param {string} query - Search query
 */
function handleSearch(type, query) {
  searchState[type] = query.toLowerCase();
  loadStats(); // Reload to apply search
}

/**
 * Apply search filter to a list
 * @param {Array} list - List of users
 * @param {string} type - Type of list
 * @returns {Array} Filtered list
 */
function applySearch(list, type) {
  const query = searchState[type];
  if (!query) {
    return list;
  }
  
  return list.filter(user =>
    (user.name || '').toLowerCase().includes(query) ||
    (user.username || '').toLowerCase().includes(query) ||
    (user.bio || '').toLowerCase().includes(query)
  );
}

// ================== Rendering Functions ==================

/**
 * Render recent activity on dashboard
 */
function renderRecentActivity(unfollowers, newFollowers) {
  const container = document.getElementById('recentActivity');
  const probeEvents = getProbeEventsForCurrentUser();

  if (!unfollowers.length && !newFollowers.length && !probeEvents.length) {
    container.innerHTML = '<div class="info-box">No recent activity. Click scan buttons to check for changes.</div>';
    return;
  }
  
  // Combine and sort by timestamp
  const recentActivity = [
    ...unfollowers.map(u => ({ ...u, type: 'unfollow' })),
    ...newFollowers.map(u => ({ ...u, type: 'new' })),
    ...probeEvents.map((event) => ({
      username: currentUser,
      name: `@${currentUser}`,
      timestamp: event.timestamp,
      type: 'probe',
      probeCount: event.probeCount
    }))
  ]
    .sort((a, b) => (b.unfollowedAt || b.timestamp || 0) - (a.unfollowedAt || a.timestamp || 0))
    .slice(0, 8);
  
  let html = '<h3 style="font-size: 13px; margin: 16px 0 12px 0; color: rgba(255,255,255,0.7)">Recent Activity</h3>';
  html += '<div class="user-list">';
  
  recentActivity.forEach(user => {
    html += renderUserCard(user, user.type);
  });
  
  html += '</div>';
  container.innerHTML = html;
}

/**
 * Render unfollowers list
 */
function renderUnfollowers(unfollowers) {
  const container = document.getElementById('unfollowersList');
  const filtered = applySearch(unfollowers, 'unfollowers');
  
  if (!filtered.length) {
    const emptyMessage = !unfollowers.length 
      ? 'Great job! No one has unfollowed you recently.' 
      : 'No results found. Try a different search.';
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">✅</div>
        <div class="empty-state-title">No unfollowers found</div>
        <div class="empty-state-text">${emptyMessage}</div>
      </div>
    `;
    return;
  }
  
  // Sort by unfollow time
  const sorted = [...filtered].sort((a, b) => (b.unfollowedAt || 0) - (a.unfollowedAt || 0));
  
  let html = `<div style="margin-bottom: 12px; font-size: 13px; color: rgba(255,255,255,0.7)">`;
  html += `Unfollowers (${filtered.length}`;
  if (unfollowers.length !== filtered.length) {
    html += ` of ${unfollowers.length}`;
  }
  html += `)</div><div class="user-list">`;
  
  sorted.forEach(user => {
    html += renderUserCard(user, 'unfollow');
  });
  
  html += '</div>';
  container.innerHTML = html;
}

/**
 * Render new followers list
 */
function renderNewFollowers(newFollowers) {
  const container = document.getElementById('newFollowersList');
  const filtered = applySearch(newFollowers, 'new');
  
  if (!filtered.length) {
    const emptyMessage = !newFollowers.length
      ? 'No new followers yet. Keep creating great content!'
      : 'No results found. Try a different search.';
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">👀</div>
        <div class="empty-state-title">No new followers found</div>
        <div class="empty-state-text">${emptyMessage}</div>
      </div>
    `;
    return;
  }
  
  // Sort by timestamp
  const sorted = [...filtered].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  
  let html = `<div style="margin-bottom: 12px; font-size: 13px; color: rgba(255,255,255,0.7)">`;
  html += `New Followers (${filtered.length}`;
  if (newFollowers.length !== filtered.length) {
    html += ` of ${newFollowers.length}`;
  }
  html += `)</div><div class="user-list">`;
  
  sorted.forEach(user => {
    html += renderUserCard(user, 'new');
  });
  
  html += '</div>';
  container.innerHTML = html;
}

/**
 * Render fans list
 */
function renderFans(fans) {
  const container = document.getElementById('fansList');
  const filtered = applySearch(fans, 'fans');
  
  if (!filtered.length) {
    const emptyMessage = !fans.length
      ? 'No fans yet. Follow more people back to build connections!'
      : 'No results found. Try a different search.';
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">⭐</div>
        <div class="empty-state-title">No fans found</div>
        <div class="empty-state-text">${emptyMessage}</div>
      </div>
    `;
    return;
  }
  
  let html = `<div class="info-box" style="margin-bottom: 12px">Fans are followers you don't follow back. Consider following them to build your community!</div>`;
  html += `<div style="margin-bottom: 12px; font-size: 13px; color: rgba(255,255,255,0.7)">`;
  html += `Fans (${filtered.length}`;
  if (fans.length !== filtered.length) {
    html += ` of ${fans.length}`;
  }
  html += `)</div><div class="user-list">`;
  
  filtered.forEach(user => {
    html += renderUserCard(user, 'fans');
  });
  
  html += '</div>';
  container.innerHTML = html;
}

/**
 * Render not following back list
 */
function renderNotFollowingBack(notFollowingBack) {
  const container = document.getElementById('notFollowingBackList');
  const filtered = applySearch(notFollowingBack, 'notfollowback');
  
  if (!filtered.length) {
    const emptyMessage = !notFollowingBack.length
      ? 'Everyone you follow follows you back! Perfect!'
      : 'No results found. Try a different search.';
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🎉</div>
        <div class="empty-state-title">Everyone follows you back!</div>
        <div class="empty-state-text">${emptyMessage}</div>
      </div>
    `;
    return;
  }
  
  let html = `<div class="info-box" style="margin-bottom: 12px">These accounts don't follow you back. Consider unfollowing if you want to improve your follower ratio.</div>`;
  html += `<div style="margin-bottom: 12px; font-size: 13px; color: rgba(255,255,255,0.7)">`;
  html += `Not Following Back (${filtered.length}`;
  if (notFollowingBack.length !== filtered.length) {
    html += ` of ${notFollowingBack.length}`;
  }
  html += `)</div><div class="user-list">`;
  
  filtered.forEach(user => {
    html += renderUserCard(user, 'notfollowback');
  });
  
  html += '</div>';
  container.innerHTML = html;
}

/**
 * Render following list with filters
 */
function renderFollowing(following) {
  const container = document.getElementById('followingList');
  let filtered = applySearch(following, 'following');
  
  // Apply filters
  const filter = filterState.following;
  if (filter === 'mutual') {
    filtered = filtered.filter(u => u.followsBack);
  } else if (filter === 'notback') {
    filtered = filtered.filter(u => !u.followsBack);
  } else if (filter === 'verified') {
    filtered = filtered.filter(u => u.verified);
  }
  
  if (!filtered.length) {
    const emptyMessage = !following.length
      ? 'No following data. Click "Scan Following" button.'
      : 'No results found. Try different filter or search.';
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🔗</div>
        <div class="empty-state-title">No following data</div>
        <div class="empty-state-text">${emptyMessage}</div>
      </div>
    `;
    return;
  }
  
  // Count mutual vs not following back
  const mutualCount = filtered.filter(u => u.followsBack).length;
  const notBackCount = filtered.length - mutualCount;
  
  let html = `<div style="margin-bottom: 12px; font-size: 13px; color: rgba(255,255,255,0.7)">`;
  html += `Following (${filtered.length}`;
  if (following.length !== filtered.length) {
    html += ` of ${following.length}`;
  }
  html += `) • <span style="color: #a78bfa">${mutualCount} mutual</span>`;
  html += ` • <span style="color: rgba(255,255,255,0.5)">${notBackCount} not back</span>`;
  html += `</div><div class="user-list">`;
  
  // Sort: mutual first
  const sorted = [...filtered].sort((a, b) => {
    if (a.followsBack === b.followsBack) return 0;
    return a.followsBack ? -1 : 1;
  });
  
  sorted.forEach(user => {
    html += renderUserCard(user, 'following');
  });
  
  html += '</div>';
  container.innerHTML = html;
}

/**
 * Render insights view
 */
function renderInsights(userData) {
  const container = document.getElementById('insightsContent');
  
  if (!userData.followers || !userData.followers.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📊</div>
        <div class="empty-state-title">No insights yet</div>
        <div class="empty-state-text">Scan followers and following first to see insights</div>
      </div>
    `;
    return;
  }
  
  const followers = userData.followers || [];
  const following = userData.following || [];
  const unfollowers = userData.unfollowers || [];
  const newFollowers = userData.newFollowers || [];
  const fans = userData.fansList || [];
  const notFollowingBack = userData.notFollowingBack || [];
  
  // Calculate metrics
  const verifiedFollowers = followers.filter(f => f.verified).length;
  const verifiedFollowing = following.filter(f => f.verified).length;
  
  const ratio = following.length 
    ? ((followers.length / following.length) * 100).toFixed(1)
    : 'N/A';
  
  const engagement = followers.length
    ? (((followers.length - fans.length) / followers.length) * 100).toFixed(1)
    : 'N/A';
  
  const churn = userData.lastFollowersCount && userData.scanCount > 1
    ? ((unfollowers.length / userData.lastFollowersCount) * 100).toFixed(2)
    : 'N/A';
  
  const growth = userData.scanHistory && userData.scanHistory.length > 1
    ? calculateGrowthTrend(userData.scanHistory)
    : 'N/A';
  
  // Build HTML
  let html = '<div class="insights-card">';
  html += '<div class="insights-title">📊 Account Insights</div>';
  html += `<div class="insights-item">👥 Follower/Following Ratio: <strong>${ratio}${ratio !== 'N/A' ? '%' : ''}</strong></div>`;
  html += `<div class="insights-item">💫 Engagement Rate: <strong>${engagement}%</strong> ${getEngagementLabel(engagement)}</div>`;
  html += `<div class="insights-item">📉 Churn Rate: <strong>${churn}${churn !== 'N/A' ? '%' : ''}</strong> ${getChurnLabel(churn)}</div>`;
  html += `<div class="insights-item">📈 Growth Trend: <strong>${growth}</strong></div>`;
  html += `<div class="insights-item">✓ Verified Followers: <strong>${verifiedFollowers}</strong> (${((verifiedFollowers / followers.length) * 100).toFixed(1)}%)</div>`;
  html += `<div class="insights-item">✓ Verified Following: <strong>${verifiedFollowing}</strong></div>`;
  html += '</div>';
  
  // Recommendations
  html += '<div class="insights-card">';
  html += '<div class="insights-title">🎯 Recommendations</div>';
  
  let hasRecommendations = false;
  
  if (notFollowingBack.length > 50) {
    html += `<div class="insights-item">• Consider unfollowing ${notFollowingBack.length} accounts not following back</div>`;
    hasRecommendations = true;
  }
  
  if (fans.length > 20) {
    html += `<div class="insights-item">• You have ${fans.length} fans - consider following them back!</div>`;
    hasRecommendations = true;
  }
  
  if (parseFloat(ratio) < 50 && ratio !== 'N/A') {
    html += `<div class="insights-item">• Low follower ratio. Focus on content quality and engagement!</div>`;
    hasRecommendations = true;
  }
  
  if (unfollowers.length > newFollowers.length && unfollowers.length > 10) {
    html += `<div class="insights-item">• More unfollows than new followers. Review your content strategy</div>`;
    hasRecommendations = true;
  }
  
  if (parseFloat(engagement) > 80) {
    html += `<div class="insights-item">• Great engagement! Keep up the good work 🔥</div>`;
    hasRecommendations = true;
  }
  
  if (!hasRecommendations) {
    html += `<div class="insights-item">• Everything looks good! Keep growing 🚀</div>`;
  }
  
  html += '</div>';
  
  // Scan history
  if (userData.scanHistory && userData.scanHistory.length > 1) {
    html += '<div class="insights-card">';
    html += '<div class="insights-title">📅 Scan History</div>';
    
    userData.scanHistory.slice(-5).reverse().forEach(scan => {
      const sourceLabel = scan.source === 'auto' ? 'auto' : 'manual';
      if (scan.type === 'followers_probe') {
        html += `<div class="insights-item">${formatTime(scan.timestamp)}: followers count probe (${sourceLabel}) - ${Number.isFinite(scan.probeCount) ? scan.probeCount : 'unknown'} shown</div>`;
      } else {
        html += `<div class="insights-item">${formatTime(scan.timestamp)}: ${scan.type} scan (${sourceLabel}) - ${scan.count} users`;
        if (scan.verified) {
          html += ` (${scan.verified} verified)`;
        }
        html += `</div>`;
      }
    });
    
    html += '</div>';
  }
  
  container.innerHTML = html;
}

/**
 * Calculate growth trend from scan history
 */
function calculateGrowthTrend(scanHistory) {
  const followerScans = scanHistory.filter(s => s.type === 'followers');
  if (followerScans.length < 2) {
    return 'N/A';
  }
  
  const recent = followerScans.slice(-3);
  const oldCount = recent[0].count;
  const newCount = recent[recent.length - 1].count;
  const difference = newCount - oldCount;
  
  if (difference > 0) {
    return `+${difference} (Growing 📈)`;
  } else if (difference < 0) {
    return `${difference} (Declining 📉)`;
  } else {
    return 'Stable';
  }
}

/**
 * Get engagement label
 */
function getEngagementLabel(engagement) {
  if (engagement === 'N/A') return '';
  const value = parseFloat(engagement);
  if (value > 80) return '🔥 Excellent';
  if (value > 60) return '✨ Good';
  if (value > 40) return '👍 Average';
  return '⚠️ Low';
}

/**
 * Get churn label
 */
function getChurnLabel(churn) {
  if (churn === 'N/A') return '';
  const value = parseFloat(churn);
  if (value < 2) return '✅ Great';
  if (value < 5) return '👍 Good';
  if (value < 10) return '⚠️ Watch';
  return '🚨 High';
}

/**
 * Render a user card
 * @param {Object} user - User object
 * @param {string} type - Card type
 * @returns {string} HTML string
 */
function renderUserCard(user, type) {
  const isUnfollow = type === 'unfollow';
  const isNew = type === 'new';
  const isFollowing = type === 'following';
  const isFan = type === 'fans';
  const isNotFollowBack = type === 'notfollowback';
  const isProbe = type === 'probe';
  
  // Determine card styling
  let backgroundColor, borderColor, statusText, statusColor, avatarStyle;
  
  if (isUnfollow) {
    backgroundColor = 'rgba(239, 68, 68, 0.1)';
    borderColor = 'rgba(239, 68, 68, 0.3)';
    statusText = 'Unfollowed';
    statusColor = '#ef4444';
  } else if (isNew) {
    backgroundColor = 'rgba(16, 185, 129, 0.1)';
    borderColor = 'rgba(16, 185, 129, 0.3)';
    statusText = 'New Follower';
    statusColor = '#10b981';
  } else if (isFan) {
    backgroundColor = 'rgba(245, 158, 11, 0.1)';
    borderColor = 'rgba(245, 158, 11, 0.3)';
    statusText = 'Fan';
    statusColor = '#f59e0b';
  } else if (isNotFollowBack) {
    backgroundColor = 'rgba(139, 92, 246, 0.1)';
    borderColor = 'rgba(139, 92, 246, 0.3)';
    statusText = 'Not Following Back';
    statusColor = '#a78bfa';
  } else if (isFollowing) {
    if (user.followsBack) {
      backgroundColor = 'rgba(139, 92, 246, 0.1)';
      borderColor = 'rgba(139, 92, 246, 0.3)';
      statusText = 'Mutual';
      statusColor = '#a78bfa';
    } else {
      backgroundColor = 'rgba(255, 255, 255, 0.05)';
      borderColor = 'rgba(255, 255, 255, 0.1)';
      statusText = 'Not following back';
      statusColor = 'rgba(255, 255, 255, 0.5)';
    }
  } else if (isProbe) {
    backgroundColor = 'rgba(59, 130, 246, 0.12)';
    borderColor = 'rgba(59, 130, 246, 0.35)';
    statusText = `Count probe${Number.isFinite(user.probeCount) ? `: ${user.probeCount}` : ''}`;
    statusColor = '#60a5fa';
  } else {
    backgroundColor = 'rgba(255, 255, 255, 0.05)';
    borderColor = 'rgba(255, 255, 255, 0.1)';
    statusText = '';
    statusColor = '#60a5fa';
  }
  
  // Avatar styling
  const avatarBackground = user.avatar
    ? `background-image: url(${user.avatar})`
    : `background: linear-gradient(135deg, ${statusColor}, ${statusColor}); color: white`;
  
  const avatarContent = user.avatar
    ? ''
    : escapeHtml((user.name || user.username || '?').charAt(0).toUpperCase());
  
  // Verified badge
  const verifiedBadge = user.verified
    ? '<span class="verified-badge" title="Verified">✓</span>'
    : '';
  
  // Follows back badge
  const followsBackBadge = isFollowing && user.followsBack
    ? '<span class="follows-back-badge">⟷ Mutual</span>'
    : '';
  
  // Timestamp
  const timestamp = user.unfollowedAt || user.timestamp
    ? `<div style="font-size: 11px; color: rgba(255,255,255,0.5)">${formatTime(user.unfollowedAt || user.timestamp)}</div>`
    : '';
  
  // Bio
  const bio = user.bio
    ? `<div class="user-bio">${escapeHtml(user.bio)}</div>`
    : '';
  
  return `
    <div class="user-card" style="background: ${backgroundColor}; border-color: ${borderColor}">
      <div class="user-info">
        <div class="user-avatar" style="${avatarBackground}">${avatarContent}</div>
        <div class="user-details">
          <div class="user-name">
            ${escapeHtml(user.name || user.username || 'Unknown')}
            ${verifiedBadge}
            ${followsBackBadge}
          </div>
          <div class="user-username">@${escapeHtml(user.username || 'unknown')}</div>
          ${bio}
        </div>
      </div>
      <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 6px">
        ${statusText ? `<div style="font-size: 11px; font-weight: 500; color: ${statusColor}">${statusText}</div>` : ''}
        ${timestamp}
        <button class="action-btn" data-username="${user.username}" title="Open profile">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
            <polyline points="15 3 21 3 21 9"/>
            <line x1="10" y1="14" x2="21" y2="3"/>
          </svg>
        </button>
      </div>
    </div>
  `;
}

// ================== Utility Functions ==================

/**
 * Format timestamp to human-readable text
 * @param {number} timestamp - Unix timestamp in milliseconds
 * @returns {string} Formatted time string
 */
function formatTime(timestamp) {
  if (!timestamp) return 'Unknown';
  
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);
  
  if (Math.abs(diff) < 120000) return 'Just now';
  if (months > 0) return `${months}mo ago`;
  if (weeks > 0) return `${weeks}w ago`;
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return diff >= 0 ? 'Just now' : 'soon';
}

function getProbeEventsForCurrentUser() {
  if (!currentUser) {
    return [];
  }
  const usersRoot = window.__xUsersCache || {};
  const target = (currentUser || '').toLowerCase();
  const key = Object.keys(usersRoot).find((item) => (item || '').toLowerCase() === target) || currentUser;
  const userData = usersRoot[key] || {};
  const scanHistory = userData.scanHistory || [];
  return scanHistory.filter((entry) => entry.type === 'followers_probe').slice(-5);
}

function formatDateTime(timestamp) {
  if (!timestamp) return 'unknown';
  return new Date(timestamp).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

/**
 * Escape HTML to prevent XSS
 * @param {string} text - Text to escape
 * @returns {string} Escaped text
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Get data from chrome storage
 * @param {Array<string>} keys - Keys to retrieve
 * @returns {Promise<Object>} Storage data
 */
function getFromStorage(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, resolve);
  });
}

/**
 * Send message to background script
 * @param {Object} message - Message to send
 * @returns {Promise<any>} Response from background
 */
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

/**
 * Show notification toast
 * @param {string} message - Message to display
 * @param {string} type - Type of notification ('success', 'error', 'warning', 'info')
 */
function showNotification(message, type = 'info') {
  // Remove existing notification
  const existing = document.getElementById('notificationToast');
  if (existing) {
    existing.remove();
  }
  
  // Color schemes
  const colors = {
    success: { bg: '#10b981', border: '#059669' },
    error: { bg: '#ef4444', border: '#dc2626' },
    warning: { bg: '#f59e0b', border: '#d97706' },
    info: { bg: '#3b82f6', border: '#2563eb' }
  };
  
  const color = colors[type] || colors.info;
  
  // Create toast
  const toast = document.createElement('div');
  toast.id = 'notificationToast';
  toast.style.cssText = `
    position: fixed;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    background: ${color.bg};
    color: white;
    padding: 12px 20px;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
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

/**
 * Show quick toast (shorter duration, top-right position)
 * @param {string} message - Message to display
 * @param {string} type - Type of notification
 */
function showQuickToast(message, type = 'info') {
  const existing = document.getElementById('quickToast');
  if (existing) {
    existing.remove();
  }
  
  const colors = {
    success: { bg: 'rgba(16, 185, 129, 0.95)', icon: '✓' },
    error: { bg: 'rgba(239, 68, 68, 0.95)', icon: '✕' },
    warning: { bg: 'rgba(245, 158, 11, 0.95)', icon: '⚠' },
    info: { bg: 'rgba(59, 130, 246, 0.95)', icon: '↗' }
  };
  
  const color = colors[type] || colors.info;
  
  const toast = document.createElement('div');
  toast.id = 'quickToast';
  toast.style.cssText = `
    position: fixed;
    top: 70px;
    right: 20px;
    background: ${color.bg};
    color: white;
    padding: 8px 14px;
    border-radius: 6px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
    z-index: 999999;
    font-size: 12px;
    font-weight: 500;
    animation: slideInRight 0.2s ease;
    display: flex;
    align-items: center;
    gap: 6px;
    backdrop-filter: blur(10px);
  `;
  toast.innerHTML = `<span style="font-size: 14px">${color.icon}</span><span>${message}</span>`;
  
  const style = document.createElement('style');
  style.textContent = `
    @keyframes slideInRight {
      from {
        opacity: 0;
        transform: translateX(20px);
      }
      to {
        opacity: 1;
        transform: translateX(0);
      }
    }
  `;
  document.head.appendChild(style);
  
  document.body.appendChild(toast);
  
  setTimeout(() => {
    toast.style.transition = 'opacity 0.2s, transform 0.2s';
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(20px)';
    setTimeout(() => toast.remove(), 200);
  }, 1500);
}

/**
 * Show unfollow guide
 */
function showUnfollowGuide() {
  showNotification('Opening X following page...', 'info');
  
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]?.id) {
      const url = `https://x.com/${currentUser}/following`;
      chrome.tabs.update(tabs[0].id, { url });
      setTimeout(() => {
        showNotification('Manually unfollow users from this list', 'info');
      }, 1000);
    }
  });
}

/**
 * Export user data to JSON file
 */
function exportData() {
  if (!currentUser) {
    showNotification('No account selected', 'warning');
    return;
  }
  
  chrome.storage.local.get(['users'], (result) => {
    const users = result.users || {};
    const userData = users[currentUser] || {};
    
    const exportData = {
      username: currentUser,
      exportDate: new Date().toISOString(),
      followers: userData.followers || [],
      following: userData.following || [],
      unfollowers: userData.unfollowers || [],
      newFollowers: userData.newFollowers || [],
      fans: userData.fansList || [],
      notFollowingBack: userData.notFollowingBack || [],
      stats: {
        totalFollowers: userData.followers?.length || 0,
        totalFollowing: userData.following?.length || 0,
        lastCheck: userData.lastFollowersCheck || userData.lastFollowingCheck
      }
    };
    
    // Create and download file
    const blob = new Blob([JSON.stringify(exportData, null, 2)], {
      type: 'application/json'
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `x-tracker-${currentUser}-${Date.now()}.json`;
    link.click();
    URL.revokeObjectURL(url);
    
    showNotification('Data exported successfully!', 'success');
  });
}

// ================== Event Listeners Setup ==================

/**
 * Set up all event listeners
 */
function setupEventListeners() {
  // Scan buttons
  const scanFollowersBtn = document.getElementById('scanFollowersBtn');
  if (scanFollowersBtn) {
    scanFollowersBtn.addEventListener('click', () => startScan('followers'));
  }
  
  const scanFollowingBtn = document.getElementById('scanFollowingBtn');
  if (scanFollowingBtn) {
    scanFollowingBtn.addEventListener('click', () => startScan('following'));
  }
  
  // Stop buttons
  const stopScanBtn = document.getElementById('stopScanBtn');
  if (stopScanBtn) {
    stopScanBtn.addEventListener('click', stopScan);
  }
  
  const forceStopBtn = document.getElementById('forceStopBtn');
  if (forceStopBtn) {
    forceStopBtn.addEventListener('click', forceStopScan);
  }
  
  // User dropdown
  const userDropdown = document.getElementById('userDropdown');
  if (userDropdown) {
    userDropdown.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleMenu();
    });
  }
  
  // Close menu when clicking outside
  document.addEventListener('click', closeMenu);
  
  // Add user button
  const addUserBtn = document.getElementById('addUserBtn');
  if (addUserBtn) {
    addUserBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      promptAddUser();
    });
  }
  
  // Export button
  const exportBtn = document.getElementById('exportBtn');
  if (exportBtn) {
    exportBtn.addEventListener('click', exportData);
  }

  const autoScanEnabled = document.getElementById('autoScanEnabled');
  if (autoScanEnabled) {
    autoScanEnabled.addEventListener('change', () => {
      saveAutoScanSettings().catch((error) => {
        console.error('Auto scan toggle failed:', error);
        showNotification('Failed to update auto scan settings', 'error');
      });
    });
  }

  const autoScanInterval = document.getElementById('autoScanInterval');
  if (autoScanInterval) {
    autoScanInterval.addEventListener('change', () => {
      saveAutoScanSettings().catch((error) => {
        console.error('Auto scan interval update failed:', error);
        showNotification('Failed to update auto scan settings', 'error');
      });
    });
  }

  const runAutoScanNowBtn = document.getElementById('runAutoScanNowBtn');
  if (runAutoScanNowBtn) {
    runAutoScanNowBtn.addEventListener('click', () => {
      runAutoScanNow().catch((error) => {
        console.error('Run auto scan now failed:', error);
        showNotification(error.message || 'Auto scan failed', 'error');
      });
    });
  }
  
  // Tab buttons
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', (e) => {
      switchView(e.target.dataset.view);
    });
  });
  
  // Stat cards (click to switch view)
  document.querySelectorAll('.stat-card[data-view]').forEach(card => {
    card.addEventListener('click', (e) => {
      switchView(e.currentTarget.dataset.view);
    });
  });
  
  // User profile links
  const content = document.querySelector('.content');
  if (content) {
    content.addEventListener('click', async (e) => {
      const target = e.target.closest('[data-username]');
      if (!target) return;
      
      e.preventDefault();
      e.stopPropagation();
      
      const username = target.dataset.username;
      const url = `https://x.com/${username}`;
      
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) {
        chrome.tabs.update(tab.id, { url });
        showQuickToast('Opening profile...', 'info');
      }
    });
  }
  
  // Search boxes
  const searchBoxes = [
    'unfollowersSearch',
    'newSearch',
    'fansSearch',
    'notFollowBackSearch',
    'followingSearch'
  ];
  
  searchBoxes.forEach(id => {
    const element = document.getElementById(id);
    if (element) {
      element.addEventListener('input', (e) => {
        const type = id.replace('Search', '').replace('notFollowBack', 'notfollowback');
        handleSearch(type, e.target.value);
      });
    }
  });
  
  // Filter buttons
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const filter = e.target.dataset.filter;
      
      // Update active state
      document.querySelectorAll('.filter-btn').forEach(b => {
        b.classList.remove('active');
      });
      e.target.classList.add('active');
      
      // Update filter state
      filterState.following = filter;
      
      // Reload stats to apply filter
      loadStats();
    });
  });
  
  // Unfollow guide button
  const unfollowAllBtn = document.getElementById('unfollowAllBtn');
  if (unfollowAllBtn) {
    unfollowAllBtn.addEventListener('click', showUnfollowGuide);
  }
}

// ================== Message Listener ==================

/**
 * Listen for messages from background script
 */
chrome.runtime.onMessage.addListener((request) => {
  if (request.action === 'scanComplete') {
    // Reload data and reset UI
    loadUserData().then(() => {
      loadStats();
      resetUIState(true);
      showNotification('Scan completed!', 'success');
    });
  }
  
  if (request.action === 'scanError') {
    showNotification(request.error || 'Scan failed', 'error');
    resetUIState();
  }
  
  if (request.action === 'scanProgress') {
    const statusText = document.getElementById('scanStatusText');
    const progressFill = document.getElementById('scanProgressFill');
    
    if (statusText && request.progress) {
      chrome.storage.local.get(['currentScanType'], (result) => {
        const scanType = result.currentScanType || 'users';
        statusText.textContent = `Scanning ${scanType}... ${request.progress}%`;
      });
    }
    
    if (progressFill && request.progress) {
      progressFill.style.width = `${request.progress}%`;
    }
  }
});