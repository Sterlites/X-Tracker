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

const SYNC_BACKUP_MANIFEST_KEY = 'xTrackerBackupManifest';
const SYNC_BACKUP_CHUNK_PREFIX = 'xTrackerBackupChunk_';
const SYNC_BACKUP_MAX_BYTES = 98000;
const SYNC_BACKUP_CHUNK_BYTES = 7000;

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
  await loadSyncBackupStatus();
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

async function loadSyncBackupStatus() {
  const statusEl = document.getElementById('syncBackupStatus');
  if (!statusEl) {
    return;
  }

  if (!chrome.storage?.sync) {
    statusEl.textContent = 'Chrome sync storage is unavailable in this browser profile.';
    return;
  }

  try {
    const result = await getFromSync([SYNC_BACKUP_MANIFEST_KEY]);
    const manifest = result[SYNC_BACKUP_MANIFEST_KEY];
    if (!manifest) {
      statusEl.textContent = `No Chrome profile backup yet. Extension ID: ${chrome.runtime.id}`;
      return;
    }

    statusEl.textContent = `Last backup ${formatDateTime(manifest.createdAt)} (${formatBytes(manifest.bytes)}). Extension ID: ${manifest.extensionId || chrome.runtime.id}`;
  } catch (error) {
    statusEl.textContent = `Sync status unavailable: ${error.message}`;
  }
}

async function backupToChromeSync() {
  const statusEl = document.getElementById('syncBackupStatus');
  const backupBtn = document.getElementById('syncBackupBtn');
  const restoreBtn = document.getElementById('syncRestoreBtn');
  setBackupControlsDisabled(true);
  if (statusEl) {
    statusEl.textContent = 'Preparing compact Chrome profile backup...';
  }

  try {
    const localData = await getFromStorage([
      'users',
      'currentUser',
      'userList',
      'autoScanEnabled',
      'autoScanIntervalMinutes',
      'autoScanNextRunAt',
      'autoScanCooldownUntil',
      'autoScanLastRunAt',
      'autoScanLastCountProbeAt',
      'autoScanLastProfileFollowerCount',
      'autoScanLastError'
    ]);
    const payload = createSyncBackupPayload(localData);
    const json = JSON.stringify(payload);
    const bytes = byteLength(json);

    if (bytes > SYNC_BACKUP_MAX_BYTES) {
      throw new Error(`Compact backup is ${formatBytes(bytes)}, above Chrome sync's practical ${formatBytes(SYNC_BACKUP_MAX_BYTES)} limit. Use Export for this full dataset.`);
    }

    const chunks = chunkStringByBytes(json, SYNC_BACKUP_CHUNK_BYTES);
    await clearChromeSyncBackup();

    const manifest = {
      schemaVersion: 1,
      createdAt: Date.now(),
      bytes,
      chunkCount: chunks.length,
      extensionId: chrome.runtime.id,
      mode: 'compact-restorable'
    };
    const syncPayload = {
      [SYNC_BACKUP_MANIFEST_KEY]: manifest
    };
    chunks.forEach((chunk, index) => {
      syncPayload[`${SYNC_BACKUP_CHUNK_PREFIX}${index}`] = chunk;
    });

    await setToSync(syncPayload);
    if (statusEl) {
      statusEl.textContent = `Backed up ${formatBytes(bytes)} to Chrome profile sync at ${formatDateTime(manifest.createdAt)}.`;
    }
    showQuickToast('Chrome profile backup saved', 'success');
  } catch (error) {
    if (statusEl) {
      statusEl.textContent = error.message || 'Chrome profile backup failed.';
    }
    showNotification(error.message || 'Chrome profile backup failed', 'error');
  } finally {
    if (backupBtn || restoreBtn) {
      setBackupControlsDisabled(false);
    }
  }
}

async function restoreFromChromeSync() {
  if (!confirm('Restore Chrome profile backup? This will replace local tracker data in this extension profile.')) {
    return;
  }

  const statusEl = document.getElementById('syncBackupStatus');
  setBackupControlsDisabled(true);
  if (statusEl) {
    statusEl.textContent = 'Restoring Chrome profile backup...';
  }

  try {
    const manifestResult = await getFromSync([SYNC_BACKUP_MANIFEST_KEY]);
    const manifest = manifestResult[SYNC_BACKUP_MANIFEST_KEY];
    if (!manifest?.chunkCount) {
      throw new Error('No Chrome profile backup found for this extension ID.');
    }

    const chunkKeys = Array.from({ length: manifest.chunkCount }, (_, index) => `${SYNC_BACKUP_CHUNK_PREFIX}${index}`);
    const chunkResult = await getFromSync(chunkKeys);
    const json = chunkKeys.map(key => chunkResult[key] || '').join('');
    const payload = JSON.parse(json);
    if (payload.schemaVersion !== 1 || !payload.data) {
      throw new Error('Backup schema is not supported.');
    }

    await setLocalStorage({
      users: payload.data.users || {},
      userList: payload.data.userList || [],
      currentUser: payload.data.currentUser || null,
      autoScanEnabled: !!payload.data.autoScanEnabled,
      autoScanIntervalMinutes: payload.data.autoScanIntervalMinutes || 120,
      autoScanNextRunAt: payload.data.autoScanNextRunAt || null,
      autoScanCooldownUntil: payload.data.autoScanCooldownUntil || null,
      autoScanLastRunAt: payload.data.autoScanLastRunAt || null,
      autoScanLastCountProbeAt: payload.data.autoScanLastCountProbeAt || null,
      autoScanLastProfileFollowerCount: Number.isFinite(payload.data.autoScanLastProfileFollowerCount)
        ? payload.data.autoScanLastProfileFollowerCount
        : null,
      autoScanLastError: payload.data.autoScanLastError || null
    });

    await loadUserData();
    if (statusEl) {
      statusEl.textContent = `Restored backup from ${formatDateTime(manifest.createdAt)} (${formatBytes(manifest.bytes)}).`;
    }
    showNotification('Chrome profile backup restored', 'success');
  } catch (error) {
    if (statusEl) {
      statusEl.textContent = error.message || 'Restore failed.';
    }
    showNotification(error.message || 'Restore failed', 'error');
  } finally {
    setBackupControlsDisabled(false);
  }
}

function createSyncBackupPayload(localData) {
  return {
    schemaVersion: 1,
    createdAt: Date.now(),
    extensionId: chrome.runtime.id,
    data: {
      users: compactUsersForBackup(localData.users || {}),
      userList: localData.userList || [],
      currentUser: localData.currentUser || null,
      autoScanEnabled: !!localData.autoScanEnabled,
      autoScanIntervalMinutes: localData.autoScanIntervalMinutes || 120,
      autoScanNextRunAt: localData.autoScanNextRunAt || null,
      autoScanCooldownUntil: localData.autoScanCooldownUntil || null,
      autoScanLastRunAt: localData.autoScanLastRunAt || null,
      autoScanLastCountProbeAt: localData.autoScanLastCountProbeAt || null,
      autoScanLastProfileFollowerCount: Number.isFinite(localData.autoScanLastProfileFollowerCount)
        ? localData.autoScanLastProfileFollowerCount
        : null,
      autoScanLastError: localData.autoScanLastError || null
    }
  };
}

function compactUsersForBackup(users) {
  return Object.fromEntries(Object.entries(users).map(([key, rawUserData]) => {
    const userData = rawUserData || {};
    return [
      key,
      {
        followers: compactUserList(userData.followers),
        following: compactUserList(userData.following),
        unfollowers: compactUserList(userData.unfollowers),
        newFollowers: compactUserList(userData.newFollowers),
        refollowers: compactUserList(userData.refollowers),
        fansList: compactUserList(userData.fansList),
        notFollowingBack: compactUserList(userData.notFollowingBack),
        scanCount: userData.scanCount || 0,
        lastFollowersCheck: userData.lastFollowersCheck || null,
        lastFollowingCheck: userData.lastFollowingCheck || null,
        lastSuccessfulScan: userData.lastSuccessfulScan || null,
        lastFollowersCount: userData.lastFollowersCount || null,
        lastFollowingCount: userData.lastFollowingCount || null,
        lastFollowersExpected: userData.lastFollowersExpected || null,
        lastFollowingExpected: userData.lastFollowingExpected || null,
        lastFollowersCoverage: userData.lastFollowersCoverage || null,
        lastFollowingCoverage: userData.lastFollowingCoverage || null,
        scanHistory: compactScanHistory(userData.scanHistory),
        snapshots: compactScanHistory(userData.snapshots),
        relationshipsByHandle: compactRelationships(userData.relationshipsByHandle),
        relationshipModelVersion: userData.relationshipModelVersion || 2
      }
    ];
  }));
}

function compactUserList(list) {
  return (list || []).filter(user => user?.username).map(user => ({
    username: user.username,
    name: user.name || user.username,
    bio: truncateText(user.bio || '', 120),
    verified: !!user.verified,
    profileUrl: user.profileUrl || `https://x.com/${user.username}`,
    followsBack: !!user.followsBack,
    firstSeenAt: user.firstSeenAt || null,
    lastSeenAt: user.lastSeenAt || null,
    timestamp: user.timestamp || null,
    unfollowedAt: user.unfollowedAt || null,
    refollowedAt: user.refollowedAt || null,
    scanId: user.scanId || null,
    refollowed: !!user.refollowed,
    repeatUnfollow: !!user.repeatUnfollow
  }));
}

function compactScanHistory(history) {
  return (history || []).slice(-200).map(item => ({
    scanId: item.scanId || null,
    type: item.type || null,
    source: item.source || null,
    count: Number.isFinite(item.count) ? item.count : null,
    expected: Number.isFinite(item.expected) ? item.expected : null,
    coverage: Number.isFinite(item.coverage) ? item.coverage : null,
    timestamp: item.timestamp || null,
    verified: Number.isFinite(item.verified) ? item.verified : null,
    status: item.status || null,
    countMatchesExpected: typeof item.countMatchesExpected === 'boolean' ? item.countMatchesExpected : null,
    followersCount: Number.isFinite(item.followersCount) ? item.followersCount : null,
    followingCount: Number.isFinite(item.followingCount) ? item.followingCount : null,
    unfollowersCount: Number.isFinite(item.unfollowersCount) ? item.unfollowersCount : null,
    newFollowersCount: Number.isFinite(item.newFollowersCount) ? item.newFollowersCount : null,
    refollowersCount: Number.isFinite(item.refollowersCount) ? item.refollowersCount : null,
    fansCount: Number.isFinite(item.fansCount) ? item.fansCount : null,
    notFollowingBackCount: Number.isFinite(item.notFollowingBackCount) ? item.notFollowingBackCount : null,
    delta: compactDelta(item.delta)
  }));
}

function compactDelta(delta = {}) {
  return {
    gained: (delta.gained || []).slice(-100),
    lost: (delta.lost || []).slice(-100),
    refollowed: (delta.refollowed || []).slice(-100),
    relost: (delta.relost || []).slice(-100),
    followingAdded: (delta.followingAdded || []).slice(-100),
    followingRemoved: (delta.followingRemoved || []).slice(-100)
  };
}

function compactRelationships(relationships = {}) {
  return Object.fromEntries(Object.entries(relationships).map(([handle, record]) => [
    handle,
    {
      username: record.username || handle,
      name: record.name || handle,
      verified: !!record.verified,
      profileUrl: record.profileUrl || `https://x.com/${handle}`,
      firstSeenAt: record.firstSeenAt || null,
      lastSeenAt: record.lastSeenAt || null,
      current: {
        followsYou: !!record.current?.followsYou,
        youFollow: !!record.current?.youFollow
      },
      events: (record.events || []).slice(-40).map(event => ({
        type: event.type,
        at: event.at,
        scanId: event.scanId || null,
        scanType: event.scanType || null,
        source: event.source || null
      }))
    }
  ]));
}

function truncateText(value, maxLength) {
  const text = String(value || '');
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

function setBackupControlsDisabled(disabled) {
  const backupBtn = document.getElementById('syncBackupBtn');
  const restoreBtn = document.getElementById('syncRestoreBtn');
  if (backupBtn) backupBtn.disabled = disabled;
  if (restoreBtn) restoreBtn.disabled = disabled;
}

async function clearChromeSyncBackup() {
  const existing = await getFromSync(null);
  const keys = Object.keys(existing).filter(key =>
    key === SYNC_BACKUP_MANIFEST_KEY || key.startsWith(SYNC_BACKUP_CHUNK_PREFIX)
  );
  if (keys.length) {
    await removeFromSync(keys);
  }
}

function chunkStringByBytes(text, maxBytes) {
  const chunks = [];
  let chunk = '';
  let chunkBytes = 0;

  for (const char of text) {
    const charBytes = byteLength(char);
    if (chunk && chunkBytes + charBytes > maxBytes) {
      chunks.push(chunk);
      chunk = '';
      chunkBytes = 0;
    }
    chunk += char;
    chunkBytes += charBytes;
  }

  if (chunk) {
    chunks.push(chunk);
  }
  return chunks;
}

function byteLength(text) {
  return new TextEncoder().encode(String(text)).length;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return 'unknown size';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function isActivationKey(event) {
  return event.key === 'Enter' || event.key === ' ';
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
    statusText.textContent = 'Reading profile counts...';
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
    currentScanType: scanType,
    scanProgress: 0,
    scanProgressPhase: 'profile',
    scanProgressCount: 0,
    scanProgressExpected: null,
    scanProgressExpectedSource: 'profile'
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

function formatScanProgressText(scanType, progressState) {
  const progress = Number.isFinite(progressState.scanProgress)
    ? Math.max(0, Math.min(100, Math.round(progressState.scanProgress)))
    : 0;
  const phase = progressState.scanProgressPhase || 'scanning';
  const count = progressState.scanProgressCount;
  const expected = progressState.scanProgressExpected;
  const label = scanType || 'users';

  if (phase === 'profile') {
    return `Reading profile counts... ${progress}%`;
  }
  if (phase === 'loading') {
    return `Opening ${label} list... ${progress}%`;
  }
  if (phase === 'validating') {
    const countLabel = Number.isFinite(count) && Number.isFinite(expected)
      ? ` (${count.toLocaleString()}/${expected.toLocaleString()})`
      : '';
    return `Validating ${label}... ${progress}%${countLabel}`;
  }
  if (phase === 'complete') {
    return Number.isFinite(count)
      ? `Scan complete (${count.toLocaleString()} found)`
      : 'Scan complete';
  }
  if (phase === 'error') {
    return 'Scan failed';
  }

  const countLabel = Number.isFinite(count) && Number.isFinite(expected)
    ? ` (${count.toLocaleString()}/${expected.toLocaleString()})`
    : (Number.isFinite(count) ? ` (${count.toLocaleString()} found)` : '');
  return `Scanning ${label}... ${progress}%${countLabel}`;
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
    chrome.storage.local.get(
      [
        'scanStatus',
        'scanProgress',
        'scanProgressPhase',
        'scanProgressCount',
        'scanProgressExpected',
        'scanProgressExpectedSource',
        'currentScanType'
      ],
      (result) => {
        const statusText = document.getElementById('scanStatusText');
        const progressFill = document.getElementById('scanProgressFill');
        
        // Update progress display
        if (Number.isFinite(result.scanProgress)) {
          const scanType = result.currentScanType || 'users';
          if (statusText) {
            statusText.textContent = formatScanProgressText(scanType, result);
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
      }
    );
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
    const dashboardAnalytics = document.getElementById('dashboardAnalytics');
    const recentActivity = document.getElementById('recentActivity');
    if (dashboardAnalytics) dashboardAnalytics.innerHTML = '';
    if (recentActivity) recentActivity.innerHTML = '<div class="info-box">Add an account to start tracking follower history.</div>';
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
      renderDashboard(userData, {
        followers,
        following,
        unfollowers,
        newFollowers,
        fans,
        notFollowingBack
      });
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
    const isActive = tab.dataset.view === view;
    tab.classList.toggle('active', isActive);
    tab.setAttribute('aria-selected', String(isActive));
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

function renderDashboard(userData, lists) {
  const container = document.getElementById('dashboardAnalytics');
  if (!container) {
    return;
  }

  const snapshots = getTrendSnapshots(userData, lists);
  const relationshipEvents = getRelationshipEvents(userData);
  const followerSeries = getSeries(snapshots, 'followersCount');
  const followingSeries = getSeries(snapshots, 'followingCount');
  const recentEvents = relationshipEvents.filter(event => event.at >= Date.now() - 30 * 24 * 60 * 60 * 1000);
  const gained30 = countEventTypes(recentEvents, ['followed', 'refollowed']);
  const lost30 = countEventTypes(recentEvents, ['unfollowed', 'reunfollowed']);
  const refollowed30 = countEventTypes(recentEvents, ['refollowed']);
  const relost30 = countEventTypes(recentEvents, ['reunfollowed']);
  const net30 = gained30 - lost30;
  const latestSnapshot = snapshots[snapshots.length - 1] || null;
  const firstSnapshot = snapshots[0] || null;
  const followerDelta = latestSnapshot && firstSnapshot
    ? (latestSnapshot.followersCount || 0) - (firstSnapshot.followersCount || 0)
    : 0;
  const followingDelta = latestSnapshot && firstSnapshot
    ? (latestSnapshot.followingCount || 0) - (firstSnapshot.followingCount || 0)
    : 0;
  const reciprocity = lists.following.length
    ? Math.round(((lists.following.length - lists.notFollowingBack.length) / lists.following.length) * 100)
    : null;
  const fanRatio = lists.followers.length
    ? Math.round((lists.fans.length / lists.followers.length) * 100)
    : null;
  const verifiedShare = lists.followers.length
    ? Math.round((lists.followers.filter(user => user.verified).length / lists.followers.length) * 100)
    : null;
  const quality = getScanQuality(userData);
  const volatileHandles = getVolatileHandles(userData).slice(0, 4);

  container.innerHTML = `
    <div class="analytics-panel">
      <div class="analytics-header">
        <div class="analytics-title">Follower History</div>
        <div class="analytics-subtitle">${snapshots.length} scan${snapshots.length === 1 ? '' : 's'}</div>
      </div>
      <div class="metric-row">
        ${renderMetricChip('Net 30d', formatSignedNumber(net30), net30 >= 0 ? 'positive' : 'negative')}
        ${renderMetricChip('Refollowed', refollowed30.toLocaleString(), refollowed30 ? 'positive' : '')}
        ${renderMetricChip('Re-unfollowed', relost30.toLocaleString(), relost30 ? 'negative' : '')}
      </div>
      <div class="chart-grid">
        <div class="chart-card">
          <div class="chart-label"><span>Followers</span><span>${formatSignedNumber(followerDelta)}</span></div>
          ${renderLineChart(followerSeries, '#34d399')}
        </div>
        <div class="chart-card">
          <div class="chart-label"><span>Following</span><span>${formatSignedNumber(followingDelta)}</span></div>
          ${renderLineChart(followingSeries, '#93c5fd')}
        </div>
      </div>
      <div style="margin-top: 10px">
        <div class="chart-label"><span>Daily follow/unfollow events</span><span>30d</span></div>
        ${renderActivityBars(relationshipEvents, 30)}
      </div>
    </div>

    <div class="analytics-panel">
      <div class="analytics-header">
        <div class="analytics-title">Relationship Health</div>
        <span class="status-pill ${quality.className}">${quality.label}</span>
      </div>
      <div class="insight-grid">
        ${renderInsightRow('Reciprocity', reciprocity === null ? 'N/A' : `${reciprocity}%`)}
        ${renderInsightRow('Fans', fanRatio === null ? 'N/A' : `${fanRatio}%`)}
        ${renderInsightRow('Verified followers', verifiedShare === null ? 'N/A' : `${verifiedShare}%`)}
        ${renderInsightRow('30d churn', lists.followers.length ? `${((lost30 / Math.max(1, lists.followers.length)) * 100).toFixed(1)}%` : 'N/A')}
        ${renderInsightRow('New handles', gained30.toLocaleString())}
        ${renderInsightRow('Lost handles', lost30.toLocaleString())}
      </div>
      ${renderVolatileHandles(volatileHandles)}
    </div>
  `;
}

function renderMetricChip(label, value, tone = '') {
  return `
    <div class="metric-chip">
      <div class="metric-chip-label">${escapeHtml(label)}</div>
      <div class="metric-chip-value ${tone}">${escapeHtml(value)}</div>
    </div>
  `;
}

function renderInsightRow(label, value) {
  return `
    <div class="insight-row">
      <span class="insight-label">${escapeHtml(label)}</span>
      <span class="insight-value">${escapeHtml(value)}</span>
    </div>
  `;
}

function getTrendSnapshots(userData, lists) {
  const snapshots = Array.isArray(userData.snapshots) ? userData.snapshots : [];
  const normalized = snapshots
    .map(snapshot => ({
      timestamp: Number(snapshot.timestamp),
      followersCount: Number.isFinite(snapshot.followersCount)
        ? snapshot.followersCount
        : (snapshot.type === 'followers' && Number.isFinite(snapshot.count) ? snapshot.count : null),
      followingCount: Number.isFinite(snapshot.followingCount)
        ? snapshot.followingCount
        : (snapshot.type === 'following' && Number.isFinite(snapshot.count) ? snapshot.count : null),
      coverage: Number.isFinite(snapshot.coverage) ? snapshot.coverage : null,
      status: snapshot.status || 'complete'
    }))
    .filter(snapshot => Number.isFinite(snapshot.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp);

  if (normalized.length) {
    let lastFollowers = lists.followers.length;
    let lastFollowing = lists.following.length;
    normalized.forEach(snapshot => {
      if (Number.isFinite(snapshot.followersCount)) {
        lastFollowers = snapshot.followersCount;
      } else {
        snapshot.followersCount = lastFollowers;
      }
      if (Number.isFinite(snapshot.followingCount)) {
        lastFollowing = snapshot.followingCount;
      } else {
        snapshot.followingCount = lastFollowing;
      }
    });
    return normalized.filter(snapshot =>
      Number.isFinite(snapshot.followersCount) || Number.isFinite(snapshot.followingCount)
    );
  }

  const fallback = [];
  if (userData.lastFollowersCheck || userData.lastFollowingCheck) {
    fallback.push({
      timestamp: Math.max(userData.lastFollowersCheck || 0, userData.lastFollowingCheck || 0),
      followersCount: lists.followers.length,
      followingCount: lists.following.length,
      coverage: userData.lastFollowersCoverage || userData.lastFollowingCoverage || null,
      status: 'complete'
    });
  }
  return fallback;
}

function getSeries(snapshots, key) {
  return snapshots
    .filter(snapshot => Number.isFinite(snapshot[key]))
    .map(snapshot => ({
      at: snapshot.timestamp,
      value: snapshot[key]
    }));
}

function renderLineChart(series, color) {
  const width = 220;
  const height = 72;
  const padding = 8;
  if (series.length < 2) {
    return `<svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Not enough trend data"><text x="50%" y="52%" text-anchor="middle" fill="rgba(255,255,255,0.45)" font-size="10">Need 2+ scans</text></svg>`;
  }

  const values = series.map(point => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(1, max - min);
  const step = (width - padding * 2) / Math.max(1, series.length - 1);
  const points = series.map((point, index) => {
    const x = padding + step * index;
    const y = height - padding - ((point.value - min) / range) * (height - padding * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const area = `${padding},${height - padding} ${points.join(' ')} ${width - padding},${height - padding}`;

  return `
    <svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Trend chart">
      <polyline points="${area}" fill="${color}" opacity="0.12"></polyline>
      <polyline points="${points.join(' ')}" fill="none" stroke="${color}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"></polyline>
      <circle cx="${points[points.length - 1].split(',')[0]}" cy="${points[points.length - 1].split(',')[1]}" r="3" fill="${color}"></circle>
    </svg>
  `;
}

function renderActivityBars(events, days) {
  const width = 430;
  const height = 72;
  const padding = 8;
  const now = new Date();
  const buckets = [];
  for (let index = days - 1; index >= 0; index--) {
    const date = new Date(now);
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - index);
    buckets.push({
      day: date.getTime(),
      gain: 0,
      loss: 0
    });
  }

  const firstDay = buckets[0]?.day || 0;
  events.forEach(event => {
    if (!Number.isFinite(event.at) || event.at < firstDay) {
      return;
    }
    const date = new Date(event.at);
    date.setHours(0, 0, 0, 0);
    const bucket = buckets.find(item => item.day === date.getTime());
    if (!bucket) {
      return;
    }
    if (event.type === 'followed' || event.type === 'refollowed') {
      bucket.gain++;
    } else if (event.type === 'unfollowed' || event.type === 'reunfollowed') {
      bucket.loss++;
    }
  });

  const maxValue = Math.max(1, ...buckets.map(bucket => Math.max(bucket.gain, bucket.loss)));
  const barWidth = Math.max(3, (width - padding * 2) / days - 2);
  const mid = Math.round(height / 2);
  const bars = buckets.map((bucket, index) => {
    const x = padding + index * ((width - padding * 2) / days);
    const gainHeight = Math.round((bucket.gain / maxValue) * (mid - padding));
    const lossHeight = Math.round((bucket.loss / maxValue) * (mid - padding));
    return `
      <rect x="${x.toFixed(1)}" y="${mid - gainHeight}" width="${barWidth}" height="${gainHeight}" rx="1.5" fill="#34d399"></rect>
      <rect x="${x.toFixed(1)}" y="${mid}" width="${barWidth}" height="${lossHeight}" rx="1.5" fill="#fb7185"></rect>
    `;
  }).join('');

  return `
    <svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Daily follow and unfollow events">
      <line x1="${padding}" y1="${mid}" x2="${width - padding}" y2="${mid}" stroke="rgba(255,255,255,0.18)" stroke-width="1"></line>
      ${bars}
    </svg>
  `;
}

function getRelationshipEvents(userData) {
  const relationships = userData.relationshipsByHandle || {};
  return Object.values(relationships).flatMap(record =>
    (record.events || []).map(event => ({
      ...event,
      username: record.username,
      name: record.name
    }))
  ).filter(event => Number.isFinite(event.at));
}

function countEventTypes(events, types) {
  const wanted = new Set(types);
  return events.filter(event => wanted.has(event.type)).length;
}

function getScanQuality(userData) {
  const snapshots = Array.isArray(userData.snapshots) ? userData.snapshots : [];
  const recent = snapshots.slice(-5);
  const coverages = recent
    .map(snapshot => Number(snapshot.coverage))
    .filter(value => Number.isFinite(value));
  const averageCoverage = coverages.length
    ? coverages.reduce((sum, value) => sum + value, 0) / coverages.length
    : null;
  const failed = (userData.scanHistory || []).slice(-5).some(scan => scan.status === 'failed');

  if (failed || (averageCoverage !== null && averageCoverage < 0.75)) {
    return { label: 'Scan quality risk', className: 'risk' };
  }
  if (averageCoverage !== null && averageCoverage < 0.92) {
    return { label: 'Coverage watch', className: 'watch' };
  }
  if (recent.length) {
    return { label: 'Healthy data', className: 'good' };
  }
  return { label: 'No trend baseline', className: '' };
}

function getVolatileHandles(userData) {
  const relationships = userData.relationshipsByHandle || {};
  return Object.values(relationships)
    .map(record => {
      const followerEvents = (record.events || []).filter(event =>
        event.type === 'followed' ||
        event.type === 'refollowed' ||
        event.type === 'unfollowed' ||
        event.type === 'reunfollowed'
      );
      return {
        username: record.username,
        name: record.name || record.username,
        events: followerEvents,
        score: followerEvents.length,
        losses: followerEvents.filter(event => event.type === 'unfollowed' || event.type === 'reunfollowed').length
      };
    })
    .filter(item => item.score > 1)
    .sort((a, b) => b.score - a.score || b.losses - a.losses);
}

function renderVolatileHandles(handles) {
  if (!handles.length) {
    return `
      <div class="volatile-list">
        <div class="volatile-item">
          <span>No repeat follow/unfollow handles yet</span>
          <span class="status-pill">stable</span>
        </div>
      </div>
    `;
  }

  return `
    <div class="volatile-list">
      ${handles.map(handle => `
        <div class="volatile-item">
          <span>@${escapeHtml(handle.username)}</span>
          <span class="status-pill ${handle.losses > 1 ? 'risk' : 'watch'}">${handle.score} events</span>
        </div>
      `).join('')}
    </div>
  `;
}

function formatSignedNumber(value) {
  if (!Number.isFinite(value)) {
    return 'N/A';
  }
  if (value > 0) {
    return `+${value.toLocaleString()}`;
  }
  return value.toLocaleString();
}

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
        const statusLabel = scan.status === 'verified_complete'
          ? 'verified'
          : (scan.status === 'failed' ? 'failed' : 'complete');
        const expectedLabel = Number.isFinite(scan.expected)
          ? `/${scan.expected.toLocaleString()}`
          : '';
        const countLabel = Number.isFinite(scan.count) ? scan.count.toLocaleString() : 'unknown';
        html += `<div class="insights-item">${formatTime(scan.timestamp)}: ${scan.type} scan (${sourceLabel}, ${statusLabel}) - ${countLabel}${expectedLabel} users`;
        if (scan.verified) {
          html += ` (${scan.verified} verified)`;
        }
        if (scan.reason) {
          html += ` - ${escapeHtml(scan.reason)}`;
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

function getRelationshipForUser(username) {
  if (!currentUser || !username) {
    return null;
  }

  const usersRoot = window.__xUsersCache || {};
  const currentKey = Object.keys(usersRoot).find(
    key => normalizeHandle(key) === normalizeHandle(currentUser)
  ) || currentUser;
  const userData = usersRoot[currentKey] || {};
  const relationships = userData.relationshipsByHandle || {};
  const handle = normalizeHandle(username);
  return relationships[handle] || buildLegacyRelationship(userData, handle);
}

function buildLegacyRelationship(userData, handle) {
  const events = [];
  const legacyLists = [
    { list: userData.newFollowers || [], timeKey: 'timestamp', type: user => user.refollowed ? 'refollowed' : 'followed' },
    { list: userData.refollowers || [], timeKey: 'refollowedAt', type: () => 'refollowed' },
    { list: userData.unfollowers || [], timeKey: 'unfollowedAt', type: user => user.repeatUnfollow ? 'reunfollowed' : 'unfollowed' }
  ];

  legacyLists.forEach(({ list, timeKey, type }) => {
    const match = list.find(user => normalizeHandle(user.username) === handle);
    const at = Number(match?.[timeKey] || match?.timestamp);
    if (match && Number.isFinite(at)) {
      events.push({
        type: type(match),
        at,
        source: 'legacy'
      });
    }
  });

  if (!events.length) {
    return null;
  }

  return {
    username: handle,
    events: events.sort((a, b) => a.at - b.at)
  };
}

function normalizeHandle(value) {
  return (value || '').replace(/^@/, '').trim().toLowerCase();
}

function getLatestFollowerEvent(relationship) {
  const events = (relationship?.events || []).filter(event =>
    event.type === 'followed' ||
    event.type === 'refollowed' ||
    event.type === 'unfollowed' ||
    event.type === 'reunfollowed'
  );
  return events.length ? events[events.length - 1] : null;
}

function renderUserHistoryTimeline(user) {
  const relationship = getRelationshipForUser(user.username);
  const events = (relationship?.events || [])
    .filter(event => Number.isFinite(event.at))
    .sort((a, b) => a.at - b.at)
    .slice(-4);

  if (!events.length) {
    return '';
  }

  return `
    <div class="history-timeline" aria-label="Relationship history">
      ${events.map(event => `
        <span class="history-event ${getHistoryEventClass(event.type)}" title="${formatDateTime(event.at)}">
          ${escapeHtml(getHistoryEventLabel(event.type))} ${escapeHtml(formatTime(event.at))}
        </span>
      `).join('')}
    </div>
  `;
}

function getHistoryEventClass(type) {
  if (type === 'followed' || type === 'refollowed') {
    return 'gain';
  }
  if (type === 'unfollowed' || type === 'reunfollowed') {
    return 'loss';
  }
  if (type === 'you_followed' || type === 'you_unfollowed') {
    return 'following';
  }
  return '';
}

function getHistoryEventLabel(type) {
  const labels = {
    followed: 'followed',
    refollowed: 'refollowed',
    unfollowed: 'unfollowed',
    reunfollowed: 're-unfollowed',
    you_followed: 'you followed',
    you_unfollowed: 'you unfollowed'
  };
  return labels[type] || type;
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
  const relationship = getRelationshipForUser(user.username);
  const latestFollowerEvent = getLatestFollowerEvent(relationship);
  
  // Determine card styling
  let backgroundColor, borderColor, statusText, statusColor, avatarStyle;
  
  if (isUnfollow) {
    backgroundColor = 'rgba(239, 68, 68, 0.1)';
    borderColor = 'rgba(239, 68, 68, 0.3)';
    statusText = user.repeatUnfollow || latestFollowerEvent?.type === 'reunfollowed'
      ? 'Re-unfollowed'
      : 'Unfollowed';
    statusColor = '#ef4444';
  } else if (isNew) {
    backgroundColor = 'rgba(16, 185, 129, 0.1)';
    borderColor = 'rgba(16, 185, 129, 0.3)';
    statusText = user.refollowed || latestFollowerEvent?.type === 'refollowed'
      ? 'Refollowed'
      : 'New Follower';
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
  const eventTimestamp = user.unfollowedAt || user.refollowedAt || user.timestamp || latestFollowerEvent?.at;
  const timestamp = eventTimestamp
    ? `<div style="font-size: 11px; color: rgba(255,255,255,0.5)">${formatTime(eventTimestamp)}</div>`
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
          ${isUnfollow && user.firstSeenAt ? `<div style="font-size: 10px; color: rgba(255,255,255,0.4); margin-top: 2px">Following since ${new Date(user.firstSeenAt).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}</div>` : ''}
          ${bio}
          ${renderUserHistoryTimeline(user)}
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
  
  if (Math.abs(diff) < 60000) return 'Just now';
  
  // Show relative time for less than 1 hour
  if (hours < 1) {
    if (minutes > 0) return `${minutes}m ago`;
    return 'Just now';
  }
  
  // Show absolute date for 24 hours or more
  const date = new Date(timestamp);
  const now = new Date();
  const options = { month: 'short', day: 'numeric' };
  
  // Add year if not current year
  if (date.getFullYear() !== now.getFullYear()) {
    options.year = 'numeric';
  }
  
  return date.toLocaleDateString([], options);
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

function setLocalStorage(value) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(value, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
}

function getFromSync(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.sync.get(keys, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result || {});
      }
    });
  });
}

function setToSync(value) {
  return new Promise((resolve, reject) => {
    chrome.storage.sync.set(value, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
}

function removeFromSync(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.sync.remove(keys, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
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
      refollowers: userData.refollowers || [],
      fans: userData.fansList || [],
      notFollowingBack: userData.notFollowingBack || [],
      snapshots: userData.snapshots || [],
      relationshipsByHandle: userData.relationshipsByHandle || {},
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
    userDropdown.addEventListener('keydown', (e) => {
      if (isActivationKey(e)) {
        e.preventDefault();
        e.stopPropagation();
        toggleMenu();
      }
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
    addUserBtn.addEventListener('keydown', (e) => {
      if (isActivationKey(e)) {
        e.preventDefault();
        e.stopPropagation();
        promptAddUser();
      }
    });
  }
  
  // Export button
  const exportBtn = document.getElementById('exportBtn');
  if (exportBtn) {
    exportBtn.addEventListener('click', exportData);
  }

  const syncBackupBtn = document.getElementById('syncBackupBtn');
  if (syncBackupBtn) {
    syncBackupBtn.addEventListener('click', backupToChromeSync);
  }

  const syncRestoreBtn = document.getElementById('syncRestoreBtn');
  if (syncRestoreBtn) {
    syncRestoreBtn.addEventListener('click', restoreFromChromeSync);
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
    tab.addEventListener('keydown', (e) => {
      if (isActivationKey(e)) {
        e.preventDefault();
        switchView(e.currentTarget.dataset.view);
      }
    });
  });
  
  // Stat cards (click to switch view)
  document.querySelectorAll('.stat-card[data-view]').forEach(card => {
    card.addEventListener('click', (e) => {
      switchView(e.currentTarget.dataset.view);
    });
    card.addEventListener('keydown', (e) => {
      if (isActivationKey(e)) {
        e.preventDefault();
        switchView(e.currentTarget.dataset.view);
      }
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
    
    if (statusText && Number.isFinite(request.progress)) {
      chrome.storage.local.get(['currentScanType'], (result) => {
        const scanType = result.currentScanType || 'users';
        statusText.textContent = formatScanProgressText(scanType, {
          scanProgress: request.progress,
          scanProgressPhase: request.phase || 'scanning',
          scanProgressCount: Number.isFinite(request.count) ? request.count : null,
          scanProgressExpected: Number.isFinite(request.expected) ? request.expected : null,
          scanProgressExpectedSource: request.expectedSource || null
        });
      });
    }
    
    if (progressFill && Number.isFinite(request.progress)) {
      progressFill.style.width = `${request.progress}%`;
    }
  }
});
