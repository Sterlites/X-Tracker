
// ============================================
// FILE: scraper.js (Content Script)
// ============================================
// This script runs on the X followers page and scrapes follower data

(async function() {
  console.log('X Follower Scraper started');

  let followers = new Set();
  let scrollAttempts = 0;
  const maxScrollAttempts = 50; // Adjust based on follower count

  // Function to extract followers from current view
  function extractFollowers() {
    // X's HTML structure (as of 2024/2025 - may change!)
    // Followers are in divs with data-testid="UserCell"
    const userCells = document.querySelectorAll('[data-testid="UserCell"]');
    
    userCells.forEach(cell => {
      try {
        // Extract username - typically in a link element
        const usernameLink = cell.querySelector('a[href^="/"]');
        if (usernameLink) {
          const href = usernameLink.getAttribute('href');
          const username = href.split('/')[1].split('?')[0];
          
          // Extract display name
          const nameElement = cell.querySelector('[dir="ltr"] span');
          const displayName = nameElement ? nameElement.textContent : username;
          
          if (username && username !== 'i' && username !== 'home') {
            followers.add(JSON.stringify({
              username: username,
              name: displayName,
              timestamp: Date.now()
            }));
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
      
      // Scroll to bottom
      window.scrollTo(0, document.body.scrollHeight);
      
      // Wait for new content to load
      setTimeout(() => {
        extractFollowers();
        
        // Check if new followers were loaded
        if (followers.size === previousSize) {
          scrollAttempts++;
          if (scrollAttempts >= 3) {
            // No new followers after 3 attempts, we're done
            resolve(true);
            return;
          }
        } else {
          scrollAttempts = 0; // Reset if we found new followers
        }
        
        resolve(false);
      }, 2000); // Wait 2 seconds for content to load
    });
  }

  // Main scanning loop
  async function scanAllFollowers() {
    let isDone = false;
    let iterations = 0;
    
    // Initial extraction
    extractFollowers();
    
    // Keep scrolling until no more followers or max attempts reached
    while (!isDone && iterations < maxScrollAttempts) {
      isDone = await scrollToLoad();
      iterations++;
      
      // Update user on progress
      console.log(`Scanned ${followers.size} followers...`);
    }
    
    return Array.from(followers).map(f => JSON.parse(f));
  }

  // Start the scan
  try {
    const scannedFollowers = await scanAllFollowers();
    
    console.log(`Scan complete! Found ${scannedFollowers.length} followers`);
    
    // Compare with previous scan
    chrome.storage.local.get(['followers'], (result) => {
      const previousFollowers = result.followers || [];
      const previousUsernames = new Set(previousFollowers.map(f => f.username));
      const currentUsernames = new Set(scannedFollowers.map(f => f.username));
      
      // Find unfollowers (in previous but not in current)
      const unfollowers = previousFollowers.filter(
        f => !currentUsernames.has(f.username)
      ).map(f => ({...f, unfollowedAt: Date.now()}));
      
      // Find new followers (in current but not in previous)
      const newFollowers = scannedFollowers.filter(
        f => !previousUsernames.has(f.username)
      );
      
      // Update storage
      chrome.storage.local.set({
        followers: scannedFollowers,
        unfollowers: unfollowers,
        newFollowers: newFollowers,
        lastCheck: Date.now()
      }, () => {
        // Notify user
        if (unfollowers.length > 0) {
          chrome.notifications?.create({
            type: 'basic',
            iconUrl: 'icons/icon48.png',
            title: 'X Unfollow Tracker',
            message: `${unfollowers.length} user(s) unfollowed you`
          });
        }
        
        // Close the tab
        chrome.runtime.sendMessage({
          action: 'scanComplete',
          stats: {
            total: scannedFollowers.length,
            unfollowers: unfollowers.length,
            newFollowers: newFollowers.length
          }
        });
        
        window.close();
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
