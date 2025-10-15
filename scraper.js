
// ============================================
// FILE: scraper.js (Content Script)
// ============================================
// This script runs on the X followers page and scrapes follower data

(async function() {
  console.log('X Follower Scraper started');

  let followers = new Map(); // key: username -> { username, name, timestamp }
  let scrollAttempts = 0;
  const maxScrollAttempts = 100; // Allow more attempts for large lists
  const idleRetryLimit = 5;

  // Function to extract followers from current view
  function extractFollowers() {
    // X's HTML structure (as of 2024/2025 - may change!)
    // Followers are in divs with data-testid="UserCell"
    const userCells = document.querySelectorAll('[data-testid="UserCell"]');

    userCells.forEach(cell => {
      try {
        const usernameLink = cell.querySelector('a[href^="/"]');
        if (!usernameLink) return;
        const href = usernameLink.getAttribute('href');
        const parts = href.split('/').filter(Boolean);
        const username = (parts[0] || parts[1] || '').replace(/^@/, '');
        if (!username) return;

        // Basic validation: username should be 2-30 chars and only contain letters, numbers, underscores
        if (!/^[A-Za-z0-9_]{2,30}$/.test(username)) return;

        // Heuristic: ensure this link is inside a user cell and not a navigation or media link
        const parentRole = usernameLink.getAttribute('role') || usernameLink.closest('[role]')?.getAttribute('role');
        if (parentRole && ['link', 'button', 'article', 'listitem', 'presentation'].indexOf(parentRole) === -1) {
          // Not a standard role we expect for user links — still continue but be conservative
        }

        // Extract display name
        const nameElement = cell.querySelector('[dir="ltr"] span');
        const displayName = nameElement ? nameElement.textContent.trim() : username;

        if (username && username !== 'i' && username !== 'home') {
          if (!followers.has(username)) {
            followers.set(username, { username, name: displayName, timestamp: Date.now() });
          }
        }
      } catch (e) {
        console.error('Error extracting follower:', e);
      }
    });
  }

  // Function to scroll and load more followers
  function scrollToLoad() {
    return new Promise((resolve) => {
      const previousSize = followers.size;

      // Smooth scroll a bit to trigger lazy-loading
      window.scrollBy({ top: window.innerHeight * 2, left: 0, behavior: 'smooth' });

      // Wait for new content to load
      setTimeout(() => {
        extractFollowers();

        if (followers.size === previousSize) {
          scrollAttempts++;
          if (scrollAttempts >= idleRetryLimit) {
            resolve(true);
            return;
          }
        } else {
          scrollAttempts = 0; // Reset if we found new followers
        }

        resolve(false);
      }, 1500); // Wait 1.5 seconds for content to load
    });
  }

  // Main scanning loop
  async function scanAllFollowers() {
    let isDone = false;
    let iterations = 0;
    
    // Initial extraction
    extractFollowers();

    // Observe DOM changes to capture dynamically added user cells faster
    const observer = new MutationObserver((mutations) => {
      extractFollowers();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // Keep scrolling until no more followers or max attempts reached
    while (!isDone && iterations < maxScrollAttempts) {
      isDone = await scrollToLoad();
      iterations++;
      console.log(`Scanned ${followers.size} followers... (iter ${iterations})`);
    }

    observer.disconnect();
    return Array.from(followers.values());
  }

  // Start the scan
  try {
    const scannedFollowers = await scanAllFollowers();

    console.log(`Scan complete! Found ${scannedFollowers.length} followers`);

    // Compare with previous scan
    chrome.storage.local.get(['followers', 'unfollowers', '_currentScanTabId'], (result) => {
      const previousFollowers = result.followers || [];
      const previousUsernames = new Set(previousFollowers.map(f => f.username));
      const currentUsernames = new Set(scannedFollowers.map(f => f.username));

      // Find unfollowers (in previous but not in current)
      const newUnfollowers = previousFollowers.filter(
        f => !currentUsernames.has(f.username)
      ).map(f => ({...f, unfollowedAt: Date.now()}));

      // Find new followers (in current but not in previous)
      const newFollowers = scannedFollowers.filter(
        f => !previousUsernames.has(f.username)
      );

      // Merge unfollower history with existing unfollowers (keep uniq by username)
      const existingUnfollowers = result.unfollowers || [];
      const mergedUnfollowersMap = new Map();
      existingUnfollowers.concat(newUnfollowers).forEach(u => mergedUnfollowersMap.set(u.username, u));
      const mergedUnfollowers = Array.from(mergedUnfollowersMap.values());

      // Persist updated lists
      chrome.storage.local.set({
        followers: scannedFollowers,
        unfollowers: mergedUnfollowers,
        newFollowers: newFollowers,
        lastCheck: Date.now()
      }, () => {
        // Notify user
        if (newUnfollowers.length > 0) {
          try {
            chrome.notifications?.create?.({
              type: 'basic',
              iconUrl: 'icons/icon48.png',
              title: 'X Unfollow Tracker',
              message: `${newUnfollowers.length} user(s) unfollowed you`
            });
          } catch (e) { console.warn('Notification failed', e); }
        }

        // Send completion message including the scan tab id if available
        const tabId = result._currentScanTabId || null;
        chrome.runtime.sendMessage({
          action: 'scanComplete',
          tabId: tabId,
          stats: {
            total: scannedFollowers.length,
            unfollowers: newUnfollowers.length,
            newFollowers: newFollowers.length
          }
        });

        // Close the window (tab)
        try { window.close(); } catch (e) { /* ignore */ }
      });
    });
    
  } catch (error) {
    console.error('Scan error:', error);
    chrome.runtime.sendMessage({
      action: 'scanError',
      error: error.message
    });
  }
})();
