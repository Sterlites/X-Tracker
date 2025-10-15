// ============================================
// FILE: scraper.js (FIXED VERSION)
// ============================================
// Content script that scrapes X follower data

(async function() {
  console.log('[X Unfollow Tracker] Scraper started');

  // Prevent multiple instances
  if (window.xUnfollowTrackerRunning) {
    console.log('[X Unfollow Tracker] Already running, skipping');
    return;
  }
  window.xUnfollowTrackerRunning = true;

  try {
    // Show visual indicator
    showScanningIndicator();

    // Get username from URL
    const urlPath = window.location.pathname;
    const usernameMatch = urlPath.match(/^\/([^/]+)\/(?:verified_)?followers/);
    
    if (!usernameMatch) {
      throw new Error('Not on a followers page. URL should be: x.com/username/followers');
    }

    const username = usernameMatch[1];
    console.log(`[X Unfollow Tracker] Scanning followers for @${username}`);

    // Wait for initial followers to load
    await waitForFollowers();

    // Scroll and collect all followers
    const followers = await collectAllFollowers();
    
    console.log(`[X Unfollow Tracker] Collected ${followers.length} followers`);

    if (followers.length === 0) {
      throw new Error('No followers found. Make sure the page loaded correctly.');
    }

    // Compare with previous scan and save
    await processAndSaveResults(followers, username);

    // Success!
    showSuccessMessage(followers.length);
    
    // Report completion
    chrome.runtime.sendMessage({
      action: 'scanComplete',
      username: username,
      stats: { totalFollowers: followers.length }
    });

    // Close the scanning indicator
    setTimeout(() => {
      removeScanningIndicator();
      window.xUnfollowTrackerRunning = false;
    }, 2000);

  } catch (error) {
    console.error('[X Unfollow Tracker] Error:', error);
    showErrorMessage(error.message);
    
    chrome.runtime.sendMessage({
      action: 'scanError',
      error: error.message
    });

    setTimeout(() => {
      removeScanningIndicator();
      window.xUnfollowTrackerRunning = false;
    }, 3000);
  }
})();

// Wait for follower elements to appear
async function waitForFollowers() {
  const maxAttempts = 40; // 20 seconds
  let attempts = 0;

  return new Promise((resolve, reject) => {
    const checkInterval = setInterval(() => {
      attempts++;
      
      // Look for the main timeline/scroll container first
      const timelineExists = document.querySelector('[aria-label*="Timeline"]') || 
                            document.querySelector('[data-testid="primaryColumn"]');
      
      if (timelineExists) {
        const followerCells = getValidFollowerCells();
        
        if (followerCells.length > 0) {
          clearInterval(checkInterval);
          console.log(`[X Unfollow Tracker] Found ${followerCells.length} initial followers`);
          resolve();
          return;
        }
      }

      if (attempts >= maxAttempts) {
        clearInterval(checkInterval);
        reject(new Error('Timeout: Follower list did not load. Make sure you are logged in.'));
      }
    }, 500);
  });
}

// Get valid follower cells (excluding "Who to follow" section)
function getValidFollowerCells() {
  const allCells = document.querySelectorAll('[data-testid="UserCell"]');
  const validCells = [];

  allCells.forEach(cell => {
    // CRITICAL FIX: Exclude cells that are in "Who to follow" section
    // These are typically in an aside element or have specific parent structure
    let parent = cell.parentElement;
    let isInSidebar = false;
    let depth = 0;

    // Traverse up to check if this cell is in a recommendation section
    while (parent && depth < 10) {
      const ariaLabel = parent.getAttribute('aria-label');
      const role = parent.getAttribute('role');
      
      // Check for "Who to follow" indicators
      if (ariaLabel && (
          ariaLabel.includes('Who to follow') ||
          ariaLabel.includes('Relevant people') ||
          ariaLabel.includes('You might like')
        )) {
        isInSidebar = true;
        break;
      }

      // Check if parent is aside (sidebar) element
      if (parent.tagName === 'ASIDE' || 
          parent.getAttribute('data-testid') === 'sidebarColumn') {
        isInSidebar = true;
        break;
      }

      // Check if we're in the main timeline (good)
      if (role === 'region' && ariaLabel && ariaLabel.includes('Timeline')) {
        break;
      }

      parent = parent.parentElement;
      depth++;
    }

    // Only include cells that are NOT in sidebar/recommendations
    if (!isInSidebar) {
      // Additional validation: must have follow/following button
      const hasFollowButton = cell.querySelector('[data-testid*="follow"]') || 
                             cell.querySelector('[role="button"]');
      if (hasFollowButton) {
        validCells.push(cell);
      }
    }
  });

  return validCells;
}

// Collect all followers by scrolling
async function collectAllFollowers() {
  const followers = new Map(); // Use Map to deduplicate by username
  let lastCount = 0;
  let stableCount = 0;
  const maxStableChecks = 8; // Stop after 8 checks with no new followers
  let scrollAttempts = 0;
  const maxScrollAttempts = 200; // Prevent infinite scrolling
  
  updateScanningIndicator('Scrolling to load followers...');

  while (stableCount < maxStableChecks && scrollAttempts < maxScrollAttempts) {
    scrollAttempts++;
    
    // Extract current followers (using fixed function)
    const followerCells = getValidFollowerCells();
    
    let newFollowersFound = 0;
    followerCells.forEach(cell => {
      const follower = extractFollowerData(cell);
      if (follower && follower.username) {
        if (!followers.has(follower.username)) {
          newFollowersFound++;
        }
        followers.set(follower.username, follower);
      }
    });

    const currentCount = followers.size;
    console.log(`[X Unfollow Tracker] Currently have ${currentCount} unique followers (+${newFollowersFound} new)`);
    
    // Update progress with percentage estimate
    const estimatedTotal = Math.max(currentCount * 1.2, currentCount + 100);
    const progress = Math.min(95, Math.round((currentCount / estimatedTotal) * 100));
    updateScanningIndicator(`Found ${currentCount} followers... (${progress}%)`);
    
    // Report progress to popup
    chrome.runtime.sendMessage({
      action: 'scanProgress',
      progress: progress,
      count: currentCount
    });
    
    // Check if we found new followers
    if (currentCount === lastCount || newFollowersFound === 0) {
      stableCount++;
    } else {
      stableCount = 0; // Reset if we found new followers
      lastCount = currentCount;
    }

    // Scroll down to load more - use multiple scroll methods
    const scrollableElement = document.querySelector('[data-testid="primaryColumn"]') || 
                              document.documentElement;
    
    // Smooth scroll first
    scrollableElement.scrollTo({
      top: scrollableElement.scrollHeight,
      behavior: 'smooth'
    });
    
    await sleep(600);
    
    // Then jump scroll to ensure we hit bottom
    window.scrollTo(0, document.documentElement.scrollHeight);
    
    // Wait for new content to load
    await sleep(1200);
  }

  console.log(`[X Unfollow Tracker] Scan complete. Total scroll attempts: ${scrollAttempts}`);
  
  // Convert Map to array
  return Array.from(followers.values());
}

// Extract follower data from a cell element
function extractFollowerData(cell) {
  try {
    // Find username link (in format /username)
    // More specific selector to avoid picking up other links
    const usernameLinks = cell.querySelectorAll('a[href^="/"]');
    let usernameLink = null;
    let username = null;

    // Find the actual profile link (not /i/ or other paths)
    for (const link of usernameLinks) {
      const href = link.getAttribute('href');
      const testUsername = href.replace('/', '').split('/')[0].split('?')[0];
      
      // Validate username format
      if (testUsername && 
          !testUsername.includes('/') && 
          testUsername !== 'i' && 
          testUsername !== 'home' &&
          testUsername !== 'explore' &&
          !testUsername.startsWith('search') &&
          /^[a-zA-Z0-9_]{1,15}$/.test(testUsername)) {
        username = testUsername;
        usernameLink = link;
        break;
      }
    }

    if (!usernameLink || !username) return null;

    // Find display name - look for dir="ltr" within the cell
    const nameElements = cell.querySelectorAll('[dir="ltr"]');
    let displayName = username;

    // Find the actual name (usually the first substantial text)
    for (const elem of nameElements) {
      const text = elem.textContent.trim();
      if (text && text !== username && !text.startsWith('@') && text.length > 1) {
        displayName = text;
        break;
      }
    }

    return {
      username: username,
      name: displayName,
      timestamp: Date.now()
    };
  } catch (error) {
    console.warn('[X Unfollow Tracker] Error extracting follower:', error);
    return null;
  }
}

// Process results and save to storage
async function processAndSaveResults(currentFollowers, username) {
  return new Promise((resolve, reject) => {
    // Get data for THIS specific user
    chrome.storage.local.get(['users', 'currentUser'], (result) => {
      const users = result.users || {};
      const userData = users[username] || { followers: [], unfollowers: [], newFollowers: [] };
      
      const previousFollowers = userData.followers || [];
      const currentUsernames = new Set(currentFollowers.map(f => f.username));
      const previousUsernames = new Set(previousFollowers.map(f => f.username));

      // Find unfollowers (in previous but not current)
      const unfollowers = previousFollowers.filter(f => !currentUsernames.has(f.username))
        .map(f => ({
          ...f,
          unfollowedAt: Date.now()
        }));

      // Find new followers (in current but not previous)
      const newFollowers = currentFollowers.filter(f => !previousUsernames.has(f.username))
        .map(f => ({
          ...f,
          timestamp: Date.now()
        }));

      // Merge with existing unfollowers/new followers (keep history)
      const allUnfollowers = [...(userData.unfollowers || []), ...unfollowers];
      const allNewFollowers = [...(userData.newFollowers || []), ...newFollowers];

      // Remove duplicates (keep most recent)
      const uniqueUnfollowers = Array.from(
        new Map(allUnfollowers.map(u => [u.username, u])).values()
      ).sort((a, b) => (b.unfollowedAt || 0) - (a.unfollowedAt || 0)).slice(0, 200);

      const uniqueNewFollowers = Array.from(
        new Map(allNewFollowers.map(u => [u.username, u])).values()
      ).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, 200);

      console.log(`[X Unfollow Tracker] New unfollowers: ${unfollowers.length}`);
      console.log(`[X Unfollow Tracker] New followers: ${newFollowers.length}`);

      // Update user data
      users[username] = {
        followers: currentFollowers,
        unfollowers: uniqueUnfollowers,
        newFollowers: uniqueNewFollowers,
        lastCheck: Date.now(),
        scanCount: (userData.scanCount || 0) + 1
      };

      // Save to storage
      chrome.storage.local.set({
        users: users,
        currentUser: username,
        scanStatus: 'complete'
      }, () => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          resolve();
        }
      });
    });
  });
}

// Helper: Sleep function
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Visual feedback: Show scanning indicator
function showScanningIndicator() {
  // Remove existing indicator if present
  removeScanningIndicator();
  
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
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 14px;
    font-weight: 500;
    border: 2px solid rgba(59, 130, 246, 0.5);
    min-width: 280px;
    backdrop-filter: blur(10px);
  `;
  
  indicator.innerHTML = `
    <div style="display: flex; align-items: center; gap: 12px;">
      <div style="
        width: 12px;
        height: 12px;
        background: #3b82f6;
        border-radius: 50%;
        animation: pulse 2s infinite;
      "></div>
      <div style="flex: 1;">
        <div style="font-weight: 600; margin-bottom: 4px;">X Unfollow Tracker</div>
        <div id="xUnfollowTrackerStatus" style="font-size: 12px; color: rgba(255,255,255,0.7);">
          Starting scan...
        </div>
      </div>
    </div>
    <style>
      @keyframes pulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.4; transform: scale(1.1); }
      }
    </style>
  `;
  
  document.body.appendChild(indicator);
}

// Update scanning indicator text
function updateScanningIndicator(text) {
  const status = document.getElementById('xUnfollowTrackerStatus');
  if (status) {
    status.textContent = text;
  }
}

// Show success message
function showSuccessMessage(count) {
  updateScanningIndicator(`✓ Scan complete! Found ${count} followers`);
  
  const indicator = document.getElementById('xUnfollowTrackerIndicator');
  if (indicator) {
    indicator.style.borderColor = 'rgba(16, 185, 129, 0.5)';
    indicator.style.background = 'linear-gradient(135deg, #064e3b 0%, #065f46 100%)';
  }
}

// Show error message
function showErrorMessage(error) {
  const indicator = document.getElementById('xUnfollowTrackerIndicator');
  if (indicator) {
    indicator.style.borderColor = 'rgba(239, 68, 68, 0.5)';
    indicator.style.background = 'linear-gradient(135deg, #7f1d1d 0%, #991b1b 100%)';
    indicator.innerHTML = `
      <div style="display: flex; align-items: center; gap: 12px;">
        <div style="
          width: 12px;
          height: 12px;
          background: #ef4444;
          border-radius: 50%;
        "></div>
        <div>
          <div style="font-weight: 600; margin-bottom: 4px;">Scan Failed</div>
          <div style="font-size: 12px; color: rgba(255,255,255,0.7); line-height: 1.4;">
            ${error}
          </div>
        </div>
      </div>
    `;
  }
}

// Remove scanning indicator
function removeScanningIndicator() {
  const indicator = document.getElementById('xUnfollowTrackerIndicator');
  if (indicator) {
    indicator.style.transition = 'opacity 0.3s, transform 0.3s';
    indicator.style.opacity = '0';
    indicator.style.transform = 'translateX(20px)';
    setTimeout(() => indicator.remove(), 300);
  }
}