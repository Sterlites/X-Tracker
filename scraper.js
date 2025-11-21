/**
 * X-Unfollow Tracker - Content Script (Scraper)
 * Runs on X follower/following pages to collect user data
 */

// Immediately Invoked Async Function Expression (IIFE)
(async function() {
  // Prevent multiple instances from running simultaneously
  if (window.xUnfollowTrackerRunning) {
    console.log('Scanner already running - aborting duplicate instance');
    return;
  }

  // Set running flag
  window.xUnfollowTrackerRunning = true;
  window.xScannerShouldStop = false;

  // ================== Constants ==================
  const SCAN_START_TIME = Date.now();
  const MAX_SCAN_TIME_MS = 600000; // 10 minutes maximum (increased from 5)
  const SCROLL_DELAY_MS = 800; // Initial delay between scrolls
  const LONG_SCROLL_DELAY_MS = 1500; // Delay after window scroll
  const PAUSE_EVERY_N_SCROLLS = 20; // Pause every N scrolls
  const PAUSE_DURATION_MS = 2000; // Duration of pause
  const MAX_SCROLLS = 300; // Maximum number of scroll attempts
  const STABILITY_THRESHOLD = 10; // Number of no-change scrolls before considering complete
  const MIN_USERS_FOUND = 5; // Minimum users required for valid scan
  const MIN_SCAN_DURATION_MS = 5000; // Minimum scan duration (5 seconds)

  // ================== Utility Functions ==================
  
  /**
   * Sleep for specified milliseconds
   * @param {number} ms - Milliseconds to sleep
   * @returns {Promise<void>}
   */
  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Wait for page to be ready with timeline loaded
   * @returns {Promise<void>}
   */
  async function waitForPageReady() {
    const MAX_WAIT_ATTEMPTS = 50;
    let attempts = 0;

    return new Promise((resolve, reject) => {
      const checkInterval = setInterval(() => {
        // Check if user stopped scan
        if (window.xScannerShouldStop) {
          clearInterval(checkInterval);
          reject(new Error('Stopped by user'));
          return;
        }

        attempts++;

        // Look for timeline container
        const timeline = document.querySelector('[aria-label*="Timeline"]') ||
                        document.querySelector('[data-testid="primaryColumn"]');

        // Check if we have user cells loaded
        const userCells = getUserCells();

        if (timeline && userCells.length > 0) {
          console.log(`Page ready - found ${userCells.length} initial users`);
          clearInterval(checkInterval);
          resolve();
          return;
        }

        // Timeout if page doesn't load
        if (attempts >= MAX_WAIT_ATTEMPTS) {
          clearInterval(checkInterval);
          reject(new Error('Timeout waiting for page to load. Try refreshing the page.'));
        }
      }, 500);
    });
  }

  /**
   * Get valid user cells (excluding sidebar suggestions)
   * @returns {Array<Element>} Array of user cell elements
   */
  function getUserCells() {
    const allCells = document.querySelectorAll('[data-testid="UserCell"]');
    const validCells = [];

    allCells.forEach(cell => {
      let parent = cell.parentElement;
      let isSidebar = false;
      let depth = 0;
      const MAX_DEPTH = 10;

      // Traverse up the DOM to check if cell is in sidebar
      while (parent && depth < MAX_DEPTH) {
        const ariaLabel = parent.getAttribute('aria-label');
        
        // Check for sidebar indicators
        if (
          ariaLabel && (
            ariaLabel.includes('Who to follow') ||
            ariaLabel.includes('Relevant people') ||
            ariaLabel.includes('You might like') ||
            ariaLabel.includes('Similar accounts')
          )
        ) {
          isSidebar = true;
          break;
        }

        // Check for sidebar by tag or data attribute
        if (
          parent.tagName === 'ASIDE' ||
          parent.getAttribute('data-testid') === 'sidebarColumn'
        ) {
          isSidebar = true;
          break;
        }

        parent = parent.parentElement;
        depth++;
      }

      // Only include if not in sidebar
      if (!isSidebar) {
        validCells.push(cell);
      }
    });

    return validCells;
  }

  /**
   * Collect all users by scrolling through the list
   * @returns {Promise<Array<Object>>} Array of user objects
   */
  async function collectAllUsers() {
    const foundUsers = new Map(); // Use Map to prevent duplicates by username
    let lastCount = 0;
    let stabilityCounter = 0;
    let scrollCount = 0;

    updateIndicator('Starting scan...');

    while (stabilityCounter < STABILITY_THRESHOLD && scrollCount < MAX_SCROLLS) {
      // Check if user stopped scan
      if (window.xScannerShouldStop) {
        updateIndicator('Stopping...');
        break;
      }

      scrollCount++;

      // Get current user cells
      const cells = getUserCells();
      let newUsersThisScroll = 0;

      // Extract data from each cell
      cells.forEach(cell => {
        const user = extractUserFromCell(cell);
        
        // Add to map if valid and not duplicate
        if (user && user.username && !foundUsers.has(user.username)) {
          newUsersThisScroll++;
          foundUsers.set(user.username, user);
        }
      });

      const currentCount = foundUsers.size;
      
      // Calculate progress (estimate)
      const progress = Math.min(95, Math.round((scrollCount / MAX_SCROLLS) * 100));
      
      // Update UI
      updateIndicator(`Found ${currentCount} users... (${progress}%)`);
      
      // Send progress to extension
      chrome.runtime.sendMessage({
        action: 'scanProgress',
        progress: progress,
        count: currentCount
      });

      // Check if we found new users
      if (currentCount === lastCount || newUsersThisScroll === 0) {
        stabilityCounter++;
      } else {
        stabilityCounter = 0;
        lastCount = currentCount;
      }

      // Scroll the page
      await scrollPage(scrollCount);

      // Pause periodically to avoid rate limiting
      if (scrollCount % PAUSE_EVERY_N_SCROLLS === 0) {
        console.log(`Pausing briefly to avoid rate limiting (scroll ${scrollCount})`);
        await sleep(PAUSE_DURATION_MS);
      }
    }

    // Final progress update
    updateIndicator(`Scan complete! Found ${foundUsers.size} users`);
    chrome.runtime.sendMessage({
      action: 'scanProgress',
      progress: 100,
      count: foundUsers.size
    });

    console.log(`Scan completed: ${foundUsers.size} users found in ${scrollCount} scrolls`);
    
    return Array.from(foundUsers.values());
  }

  /**
   * Scroll the page to load more users
   * @param {number} scrollCount - Current scroll count
   * @returns {Promise<void>}
   */
  async function scrollPage(scrollCount) {
    // Scroll the main timeline container
    const scrollElement = document.querySelector('[data-testid="primaryColumn"]') ||
                         document.documentElement;
    
    scrollElement.scrollTo({
      top: scrollElement.scrollHeight,
      behavior: 'smooth'
    });

    await sleep(SCROLL_DELAY_MS);

    // Also scroll window to ensure all content loads
    window.scrollTo(0, document.documentElement.scrollHeight);

    await sleep(LONG_SCROLL_DELAY_MS);
  }

  /**
   * Extract user data from a UserCell element
   * @param {Element} cell - UserCell DOM element
   * @returns {Object|null} User object or null if extraction failed
   */
  function extractUserFromCell(cell) {
    try {
      // Find username link
      const links = cell.querySelectorAll('a[href^="/"]');
      let userLink = null;
      let username = null;

      // Find the most likely username link
      for (const link of links) {
        const href = link.getAttribute('href');
        if (!href) continue;

        const pathParts = href.split('/').filter(p => p);
        if (pathParts.length === 0) continue;

        const potentialUsername = pathParts[0].split('?')[0].replace(/^@/, '');

        // Validate username format and exclude system paths
        if (
          potentialUsername &&
          potentialUsername !== 'i' &&
          potentialUsername !== 'home' &&
          potentialUsername !== 'search' &&
          potentialUsername !== 'hashtag' &&
          potentialUsername !== 'explore' &&
          potentialUsername !== 'notifications' &&
          potentialUsername !== 'messages' &&
          potentialUsername !== 'settings' &&
          potentialUsername !== 'compose' &&
          /^[a-zA-Z0-9_]{1,15}$/.test(potentialUsername)
        ) {
          const linkText = link.textContent || '';
          
          // Skip if it's a "Follow" button
          if (!linkText.toLowerCase().includes('follow')) {
            username = potentialUsername;
            userLink = link;
            break;
          }
        }
      }

      // Return null if no valid username found
      if (!userLink || !username) {
        return null;
      }

      // Extract display name and bio
      const spans = cell.querySelectorAll('span');
      let displayName = username;
      let bio = '';
      let verified = false;

      for (const span of spans) {
        const text = span.textContent.trim();
        
        // Look for display name (bold text)
        if (
          text &&
          text !== username &&
          !text.startsWith('@') &&
          text.length > 1 &&
          text.length < 100 &&
          !text.toLowerCase().includes('follow') &&
          !text.includes('·') &&
          !/^\d+$/.test(text) // Not just numbers
        ) {
          const parent = span.parentElement;
          if (parent) {
            const style = window.getComputedStyle(parent);
            const fontWeight = style.fontWeight;
            
            // Bold text is likely the display name
            if (fontWeight === '700' || fontWeight === 'bold' || parseInt(fontWeight) >= 600) {
              displayName = text;
            } else if (text.length > 10 && !bio) {
              // Longer text that's not bold is likely bio
              bio = text.substring(0, 100);
            }
          }
        }
      }

      // Check for verified badge
      const verifiedBadge = cell.querySelector('[aria-label*="Verified"]') ||
                            cell.querySelector('svg[aria-label*="Verified"]');
      if (verifiedBadge) {
        verified = true;
      }

      // Extract avatar image
      const avatarImg = cell.querySelector('img[src*="profile"]');
      const avatar = avatarImg ? avatarImg.src : '';

      return {
        username: username,
        name: displayName,
        bio: bio,
        avatar: avatar,
        verified: verified,
        timestamp: Date.now()
      };

    } catch (error) {
      console.warn('Error extracting user from cell:', error);
      return null;
    }
  }

  /**
   * Validate scan results
   * @param {Array<Object>} currentUsers - Users found in current scan
   * @param {string} username - Username being scanned
   * @param {string} scanType - Type of scan
   * @returns {Promise<Object>} Validation result object
   */
  async function validateScan(currentUsers, username, scanType) {
    return new Promise((resolve) => {
      chrome.storage.local.get(['users', '_scanStartTime'], (result) => {
        const users = result.users || {};
        const userData = users[username] || {};
        const previousUsers = scanType === 'following' 
          ? (userData.following || []) 
          : (userData.followers || []);
        
        const scanDuration = Date.now() - (result._scanStartTime || Date.now());

        // Check 1: Minimum users found
        if (currentUsers.length < MIN_USERS_FOUND) {
          resolve({
            isValid: false,
            reason: `Too few users found (${currentUsers.length}). Expected at least ${MIN_USERS_FOUND}.`
          });
          return;
        }

        // Check 2: Suspiciously low count compared to previous scan
        // Only apply if we have a substantial previous count
        if (previousUsers.length > 100 && currentUsers.length < previousUsers.length * 0.3) {
          resolve({
            isValid: false,
            reason: `Suspiciously low count (${currentUsers.length} vs ${previousUsers.length} previously). Page may not have loaded properly.`
          });
          return;
        }

        // Check 3: Minimum scan duration
        if (scanDuration < MIN_SCAN_DURATION_MS) {
          resolve({
            isValid: false,
            reason: `Scan too fast (${Math.round(scanDuration / 1000)}s). Page may not have loaded properly.`
          });
          return;
        }

        // All checks passed
        resolve({ isValid: true });
      });
    });
  }

  /**
   * Save collected data to storage
   * @param {Array<Object>} currentUsers - Users collected in current scan
   * @param {string} username - Username being scanned
   * @param {string} scanType - Type of scan
   * @returns {Promise<void>}
   */
  async function saveData(currentUsers, username, scanType) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(['users'], (result) => {
        const users = result.users || {};
        
        // Get or initialize user data
        const userData = users[username] || {
          followers: [],
          following: [],
          unfollowers: [],
          newFollowers: [],
          fansList: [],
          notFollowingBack: [],
          scanCount: 0,
          lastFollowersCheck: null,
          lastFollowingCheck: null,
          scanHistory: []
        };

        const now = Date.now();

        if (scanType === 'following') {
          // Update following data
          const previousFollowing = userData.following || [];
          userData.following = currentUsers;
          userData.lastFollowingCheck = now;
          userData.lastFollowingCount = currentUsers.length;

          // Mark which following users follow back
          const followerSet = new Set((userData.followers || []).map(f => f.username));
          userData.following.forEach(user => {
            user.followsBack = followerSet.has(user.username);
          });

          // Calculate "not following back" list
          userData.notFollowingBack = currentUsers
            .filter(f => !f.followsBack)
            .sort((a, b) => a.name.localeCompare(b.name));

        } else {
          // Update followers data
          const previousFollowers = userData.followers || [];
          const hadPreviousScan = previousFollowers.length > 0 && userData.lastFollowersCheck;

          userData.followers = currentUsers;
          userData.lastFollowersCheck = now;
          userData.lastFollowersCount = currentUsers.length;

          // Detect unfollowers and new followers
          if (hadPreviousScan) {
            const currentSet = new Set(currentUsers.map(f => f.username));
            const previousSet = new Set(previousFollowers.map(f => f.username));

            // Unfollowers: users who were in previous but not in current
            const unfollowers = previousFollowers.filter(
              f => !currentSet.has(f.username) && f.username
            );

            // New followers: users who are in current but not in previous
            const newFollowers = currentUsers.filter(
              f => !previousSet.has(f.username) && f.username
            );

            // Merge with existing unfollowers/new followers (preserve timestamps)
            const existingUnfollowersMap = new Map(
              (userData.unfollowers || []).map(x => [x.username, x])
            );
            const existingNewFollowersMap = new Map(
              (userData.newFollowers || []).map(x => [x.username, x])
            );

            // Add new unfollowers with timestamp
            unfollowers.forEach(f => {
              if (!existingUnfollowersMap.has(f.username)) {
                existingUnfollowersMap.set(f.username, {
                  ...f,
                  unfollowedAt: now
                });
              }
            });

            // Add new followers with timestamp
            newFollowers.forEach(f => {
              if (!existingNewFollowersMap.has(f.username)) {
                existingNewFollowersMap.set(f.username, {
                  ...f,
                  timestamp: now
                });
              }
            });

            // Remove refollowers from unfollowers list
            const refollowerSet = new Set(newFollowers.map(f => f.username));
            userData.unfollowers = Array.from(existingUnfollowersMap.values())
              .filter(x => x.username && !refollowerSet.has(x.username))
              .sort((a, b) => (b.unfollowedAt || 0) - (a.unfollowedAt || 0))
              .slice(0, 500); // Keep last 500

            userData.newFollowers = Array.from(existingNewFollowersMap.values())
              .filter(x => x.username)
              .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
              .slice(0, 500); // Keep last 500
          }

          // Mark which followers follow back
          const followingSet = new Set((userData.following || []).map(f => f.username));
          userData.followers.forEach(user => {
            user.followsBack = followingSet.has(user.username);
          });

          // Calculate fans list (followers you don't follow back)
          userData.fansList = userData.followers
            .filter(f => !followingSet.has(f.username))
            .sort((a, b) => a.name.localeCompare(b.name));
        }

        // Update scan metadata
        userData.scanCount = (userData.scanCount || 0) + 1;
        userData.lastSuccessfulScan = now;

        // Add to scan history
        userData.scanHistory = userData.scanHistory || [];
        userData.scanHistory.push({
          type: scanType,
          count: currentUsers.length,
          timestamp: now,
          verified: currentUsers.filter(f => f.verified).length
        });

        // Keep only last 20 scan history entries
        if (userData.scanHistory.length > 20) {
          userData.scanHistory = userData.scanHistory.slice(-20);
        }

        // Save to storage
        users[username] = userData;
        chrome.storage.local.set(
          {
            users: users,
            currentUser: username,
            scanStatus: 'complete'
          },
          () => {
            if (chrome.runtime.lastError) {
              reject(chrome.runtime.lastError);
            } else {
              console.log('Data saved successfully');
              resolve();
            }
          }
        );
      });
    });
  }

  /**
   * Show scanning indicator overlay
   */
  function showIndicator() {
    removeIndicator(); // Remove any existing indicator

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
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 14px;
      font-weight: 500;
      border: 2px solid rgba(59, 130, 246, 0.5);
      min-width: 280px;
      backdrop-filter: blur(10px);
    `;

    indicator.innerHTML = `
      <div style="display: flex; align-items: center; gap: 12px">
        <div style="width: 12px; height: 12px; background: #3b82f6; border-radius: 50%; animation: pulse 2s infinite"></div>
        <div style="flex: 1">
          <div style="font-weight: 600; margin-bottom: 4px">X Unfollow Tracker</div>
          <div id="xUnfollowTrackerStatus" style="font-size: 12px; color: rgba(255, 255, 255, 0.7)">Starting...</div>
        </div>
        <button id="xStopScanBtn" style="background: rgba(239, 68, 68, 0.2); border: 1px solid rgba(239, 68, 68, 0.5); color: #ef4444; padding: 6px 12px; border-radius: 6px; font-size: 11px; font-weight: 600; cursor: pointer; transition: all 0.2s">Stop</button>
      </div>
      <style>
        @keyframes pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.4; transform: scale(1.1); }
        }
        #xStopScanBtn:hover {
          background: rgba(239, 68, 68, 0.4);
          border-color: #ef4444;
        }
      </style>
    `;

    document.body.appendChild(indicator);

    // Add stop button listener
    const stopButton = document.getElementById('xStopScanBtn');
    if (stopButton) {
      stopButton.addEventListener('click', () => {
        window.xScannerShouldStop = true;
        stopButton.disabled = true;
        stopButton.textContent = 'Stopping...';
        updateIndicator('Stopping scan...');
      });
    }
  }

  /**
   * Update indicator status text
   * @param {string} text - Status text to display
   */
  function updateIndicator(text) {
    const statusElement = document.getElementById('xUnfollowTrackerStatus');
    if (statusElement) {
      statusElement.textContent = text;
    }
  }

  /**
   * Show success state on indicator
   * @param {number} count - Number of users found
   */
  function showSuccess(count) {
    updateIndicator(`✓ Complete! Found ${count} users`);
    
    const indicator = document.getElementById('xUnfollowTrackerIndicator');
    if (indicator) {
      indicator.style.borderColor = 'rgba(16, 185, 129, 0.5)';
      indicator.style.background = 'linear-gradient(135deg, #064e3b 0%, #065f46 100%)';
      
      const stopButton = document.getElementById('xStopScanBtn');
      if (stopButton) {
        stopButton.style.display = 'none';
      }
    }
  }

  /**
   * Show error state on indicator
   * @param {string} errorMessage - Error message to display
   */
  function showError(errorMessage) {
    const indicator = document.getElementById('xUnfollowTrackerIndicator');
    if (indicator) {
      indicator.style.borderColor = 'rgba(239, 68, 68, 0.5)';
      indicator.style.background = 'linear-gradient(135deg, #7f1d1d 0%, #991b1b 100%)';
      indicator.innerHTML = `
        <div style="display: flex; align-items: center; gap: 12px">
          <div style="width: 12px; height: 12px; background: #ef4444; border-radius: 50%"></div>
          <div>
            <div style="font-weight: 600; margin-bottom: 4px">Scan Failed</div>
            <div style="font-size: 12px; color: rgba(255, 255, 255, 0.7); line-height: 1.4">${errorMessage}</div>
          </div>
        </div>
      `;
    }
  }

  /**
   * Remove indicator from page
   */
  function removeIndicator() {
    const indicator = document.getElementById('xUnfollowTrackerIndicator');
    if (indicator) {
      indicator.style.transition = 'opacity 0.3s, transform 0.3s';
      indicator.style.opacity = '0';
      indicator.style.transform = 'translateX(20px)';
      setTimeout(() => indicator.remove(), 300);
    }
  }

  // ================== Main Execution ==================

  // Set up timeout to stop scan if it runs too long
  const scanTimeout = setTimeout(() => {
    if (!window.xScannerShouldStop) {
      window.xScannerShouldStop = true;
      console.log('Scan timeout reached - stopping');
    }
  }, MAX_SCAN_TIME_MS);

  try {
    // Show scanning indicator to user
    showIndicator();

    // Extract username from URL
    const urlMatch = window.location.pathname.match(/^\/([^/]+)\/(?:verified_)?(?:followers|following)/);
    if (!urlMatch) {
      throw new Error('Not on followers/following page. Please navigate to the correct page.');
    }

    const username = urlMatch[1];
    const scanType = window.location.pathname.includes('following') ? 'following' : 'followers';
    
    console.log(`Starting ${scanType} scan for @${username}`);

    // Wait for page to be ready
    await waitForPageReady();

    // Collect all users by scrolling
    const users = await collectAllUsers();

    // Check if scan was manually stopped
    if (window.xScannerShouldStop) {
      throw new Error('Scan stopped by user');
    }

    // Validate results
    if (!users.length) {
      throw new Error('No users found. The page may not have loaded properly.');
    }

    // Validate scan quality
    const validationResult = await validateScan(users, username, scanType);
    if (!validationResult.isValid) {
      throw new Error(`Incomplete scan: ${validationResult.reason}. Please retry.`);
    }

    // Save data to storage
    await saveData(users, username, scanType);

    // Show success message
    showSuccess(users.length);

    // Notify background script
    chrome.runtime.sendMessage({
      action: 'scanComplete',
      username: username,
      scanType: scanType,
      stats: {
        total: users.length
      }
    });

    // Auto-close indicator after a delay
    setTimeout(() => {
      removeIndicator();
      window.xUnfollowTrackerRunning = false;
      window.xScannerShouldStop = false;
    }, 2000);

  } catch (error) {
    console.error('Scan error:', error);
    showError(error.message);

    // Notify background script of error
    chrome.runtime.sendMessage({
      action: 'scanError',
      error: error.message
    });

    // Clean up after error
    setTimeout(() => {
      removeIndicator();
      window.xUnfollowTrackerRunning = false;
      window.xScannerShouldStop = false;
    }, 3000);
  } finally {
    // Clear the timeout
    clearTimeout(scanTimeout);
  }
})();