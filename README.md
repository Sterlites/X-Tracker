// ============================================
// FILE: README.md
// ============================================
# X Unfollow Tracker - Browser Extension

Track who unfollows you on X (formerly Twitter) without using the API.

## ⚠️ Important Disclaimers

**Legal Warning:**
- This extension scrapes X's website, which may violate their Terms of Service
- Your account could be suspended if detected
- Use at your own risk for personal use only
- We are not responsible for any consequences

**Technical Limitations:**
- Requires manual "Scan Now" clicks (cannot run automatically)
- You must be logged into X in your browser
- Large follower counts (10k+) may take several minutes to scan
- X's HTML structure may change, breaking the scraper
- Rate limits may apply if you scan too frequently

## 🚀 Installation

1. Download all the extension files
2. Create a folder structure:
   ```
   x-unfollow-tracker/
   ├── manifest.json
   ├── background.js
   ├── scraper.js
   ├── popup.html
   ├── popup.js
   └── icons/
       ├── icon16.png
       ├── icon48.png
       └── icon128.png
   ```

3. Create simple icon files (or use placeholders):
   - 16x16px, 48x48px, and 128x128px PNG images
   - Can be a simple blue circle or X logo

4. Load the extension in Chrome:
   - Open `chrome://extensions/`
   - Enable "Developer mode" (top right)
   - Click "Load unpacked"
   - Select the `x-unfollow-tracker` folder

5. **IMPORTANT:** Edit `background.js` line 43:
   - Change `YOUR_USERNAME` to your actual X username
   - Example: `https://x.com/elonmusk/followers`

## 📖 How to Use

1. Make sure you're logged into X (twitter.com or x.com)
2. Click the extension icon in your browser toolbar
3. Click "Scan Now" button
4. Wait while it opens your followers page and scans
5. The tab will close automatically when done
6. View your stats in the popup

## 🔍 How It Works

1. **First Scan:** Creates a baseline snapshot of all your followers
2. **Subsequent Scans:** Compares new snapshot with previous one
3. **Detection:** 
   - Users in old list but not new = Unfollowers
   - Users in new list but not old = New Followers
4. **Storage:** All data stored locally in your browser (no cloud/server)

## 📊 Features

- **Dashboard:** Overview of total followers, unfollowers, new followers, and net growth
- **Unfollowers List:** See who unfollowed you with timestamps
- **New Followers List:** See who recently followed you
- **Local Storage:** All data stays on your device
- **No API Required:** Works by scraping the website

## 🛠️ Troubleshooting

**Extension not working:**
- Make sure you're logged into X
- Update YOUR_USERNAME in background.js
- Check browser console for errors (F12 → Console tab)

**Scan takes too long:**
- Normal for large follower counts (1000+ can take 5-10 minutes)
- X loads followers in batches as you scroll
- Don't close the scanning tab manually

**Missing followers:**
- X may not load all followers if you have too many
- Try scanning at different times
- Private/protected accounts may not appear

**Data not saving:**
- Check if browser has storage permissions
- Try reloading the extension

## 🔒 Privacy & Security

- ✅ All data stored locally in your browser
- ✅ No external servers or cloud storage
- ✅ No data sent to third parties
- ✅ Open source - you can audit the code
- ⚠️ Data is not encrypted in browser storage
- ⚠️ Anyone with access to your computer can see the data

## ⚡ Performance Tips

- Don't scan more than once per hour (respect X's servers)
- For 1000+ followers, allow 5-10 minutes per scan
- Close other X tabs before scanning
- Use a stable internet connection

## 🐛 Known Issues

- May miss some followers if X doesn't load them all
- Scanning large accounts (50k+ followers) may timeout
- X's HTML structure changes can break the scraper
- Protected/private accounts may not be detected correctly

## 🔧 Updating the Scraper

If X changes their HTML structure and the scraper breaks:

1. Open `scraper.js`
2. Update the CSS selectors in `extractFollowers()` function:
   - Look for `data-testid="UserCell"` - this is the follower container
   - Find the username link selector
   - Find the display name selector
3. Test with small account first

## 📝 License

MIT License - Use at your own risk

## ⚖️ Disclaimer

This tool is for educational purposes. The developers are not responsible for:
- Account suspensions or bans
- Data loss or inaccuracy
- Violations of X's Terms of Service
- Any other consequences of using this extension

Use responsibly and at your own risk.>
      <button id="scanBtn" class="scan-btn">
        <span>🔄</span>
        <span>Scan Now</span>
      </button>
    </div