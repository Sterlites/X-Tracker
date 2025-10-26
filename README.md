# X Tracker - Unfollow & Social Media Monitoring Extension 🔍

<div align="center">

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4?style=flat&logo=google-chrome&logoColor=white)](https://chrome.google.com/webstore)
[![X (Twitter)](https://img.shields.io/badge/X_(Twitter)-1DA1F2?style=flat&logo=twitter&logoColor=white)](https://x.com)
[![Status](https://img.shields.io/badge/Status-Active-brightgreen)](https://github.com)
[![Free](https://img.shields.io/badge/Price-Free-brightgreen)](https://github.com)

</div>

> **Free X tracker for small X accounts - Track who unfollows you on X (formerly Twitter) without using the API. Monitor your followers, following, and social media engagement in real-time.**

<div align="center">
  <img src="https://upload.wikimedia.org/wikipedia/commons/3/3c/X_logo_2023_Variant_1.svg" alt="X Icon" width="80" height="80">
  <h2>X Tracker</h2>
  <p><em>Never miss who's unfollowed you again | Free for Small Accounts</em></p>
</div>

---

## 🌟 Features

<div align="center">
<table>
  <tr>
    <td align="center" width="50%">
      <img src="https://cdn-icons-png.flaticon.com/128/733/733579.png" alt="Followers Tracking" width="48" height="48">
      <h3>Followers Tracking</h3>
      <p>Monitor who follows and unfollows you</p>
    </td>
    <td align="center" width="50%">
      <img src="https://cdn-icons-png.flaticon.com/128/25/25634.png" alt="Multi-Account" width="48" height="48">
      <h3>Multi-Account</h3>
      <p>Track multiple X accounts simultaneously</p>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="https://cdn-icons-png.flaticon.com/128/1642/1642513.png" alt="Statistics" width="48" height="48">
      <h3>Statistics</h3>
      <p>Detailed analytics and insights</p>
    </td>
    <td align="center" width="50%">
      <img src="https://cdn-icons-png.flaticon.com/128/3076/3076083.png" alt="Privacy" width="48" height="48">
      <h3>Privacy First</h3>
      <p>All data stored locally, never leaves your device</p>
    </td>
  </tr>
</table>
</div>

---

## 📸 Screenshots

<div align="center">
  
### Dashboard View
<img src="https://github.com/user-attachments/assets/55441a6a-962a-480d-87a3-75006219504d" alt="Dashboard View" width="450">

### Unfollowers View
<img src="https://github.com/user-attachments/assets/18c8b561-1029-42a2-987f-019f5209442d" alt="Unfollowers View" width="450">

### Multi-Account Support
<img src="https://github.com/user-attachments/assets/0e507063-8362-4483-9c38-01504a761102" alt="Multi-Account View" width="450">

</div>

---

## 🚀 Installation

### Method 1: Manual Installation (Recommended)

1. **Clone or Download**
   ```bash
   git clone https://github.com/Sterlites/X-Tracker.git
   ```
   Or [download as ZIP](https://github.com/Sterlites/X-Tracker/archive/main.zip)

2. **Open Chrome Extensions**
   - Go to `chrome://extensions/`
   - Toggle "Developer mode" ON (top right)

3. **Load the Extension**
   - Click "Load unpacked"
   - Select the folder where you extracted the files

<div align="center">
  <img src="https://github.com/user-attachments/assets/7561a863-43e1-49c5-a9a4-14f0939b0e30" alt="Installation Steps" width="600">
</div>

### Method 2: Package Installation

1. Clone the repository
2. Navigate to the extension directory
3. Zip all files (without the parent folder)
4. Go to `chrome://extensions/`
5. Enable "Developer mode"
6. Click "Pack extension" and select the unzipped folder
7. Install the generated `.crx` file

---

## 📋 Requirements

- [Google Chrome](https://www.google.com/chrome/) or Chromium-based browser (Brave, Edge, Opera)
- Active X (Twitter) account
- Minimum Chrome version: 88+
- Stable internet connection

---

## 🎯 How to Use

### Initial Setup
1. **Login to X**: Ensure you're logged into X in your browser
2. **Click Extension Icon**: Click the extension icon in your toolbar
3. **Add Account**: Use the "+" button to add the account you want to track
4. **Enter Username**: Type your X username (without @ symbol)

### Scanning Process
1. **Select Account**: Choose the account from the dropdown
2. **Start Scanning**: Click either:
   - 🧑‍🤝‍🧑 **"Scan Followers"** - Track who follows you
   - 🔗 **"Scan Following"** - Track who you follow
3. **Wait**: A new tab will open and scan automatically
4. **Results**: View your dashboard after scanning completes

<div align="center">
  <img src="https://github.com/user-attachments/assets/7def2596-3303-44e3-949d-7965b5d5c4c5" alt="How to Use" width="600">
</div>

---

## 📊 Dashboard Features

### Main Dashboard
<div align="center">
<table>
  <tr>
    <td align="center"><img src="https://cdn-icons-png.flaticon.com/128/929/929404.png" alt="Followers" width="32" height="32"> Followers</td>
    <td align="center"><img src="https://cdn-icons-png.flaticon.com/128/219/219975.png" alt="Following" width="32" height="32"> Following</td>
    <td align="center"><img src="https://cdn-icons-png.flaticon.com/128/686/686267.png" alt="Unfollowers" width="32" height="32"> Unfollowers</td>
    <td align="center"><img src="https://cdn-icons-png.flaticon.com/128/686/686362.png" alt="New" width="32" height="32"> New</td>
  </tr>
  <tr>
    <td align="center"><code>Current follower count</code></td>
    <td align="center"><code>Accounts you follow</code></td>
    <td align="center"><code>Recent unfollowers</code></td>
    <td align="center"><code>New followers</code></td>
  </tr>
</table>
</div>

### Navigation Tabs
- **Dashboard**: Overview of all metrics
- **Unfollowers**: List of accounts that recently unfollowed you
- **New**: Recently acquired followers
- **Following**: Accounts you currently follow

---

## ⚡ Performance Guidelines

| Follower Count | Estimated Scan Time | Notes |
|----------------|-------------------|-------|
| < 1,000        | 1-5 minutes       | ✅ Smooth performance |
| 1,000 - 5,000  | 5-15 minutes      | ⏳ Be patient |
| 5,000 - 10,000 | 15-30 minutes     | ⏱️ May take time |
| 10,000+        | 30+ minutes       | ⚠️ Large accounts may timeout |

> 💡 **Pro Tip**: For best performance, scan during off-peak hours and ensure a stable internet connection.

---

## 🔧 Advanced Features

### Multi-Account Management
- Add and manage multiple X accounts
- Switch between accounts instantly
- Independent tracking for each account
- Dedicated statistics for each profile

### Tracking Capabilities
- **Followers Monitoring**: Track who follows you
- **Following Monitoring**: Monitor accounts you follow
- **Historical Data**: View changes over time
- **Real-time Updates**: Get the latest information

### Privacy Controls
- **Local Storage Only**: No data leaves your device
- **Complete Privacy**: No external servers involved
- **Easy Cleanup**: Remove stored data with one click
- **Secure Storage**: Data stored securely in browser

---

## ⚠️ Important Disclaimers

### Usage Warning
> ⚠️ **CRITICAL**: This extension scrapes X's website, which may violate their Terms of Service. Your account could be suspended if detected. Use at your own risk for personal use only.

### Technical Limitations
- **Scraping-Based**: Uses web scraping instead of official API
- **Rate Limiting**: X may apply rate limits to prevent scraping
- **HTML Changes**: X's interface changes may break functionality
- **Large Accounts**: Very large accounts may experience timeouts
- **Network Issues**: Poor connection may interrupt scans

### Recommended Usage
- **Frequency**: Limit scans to once per hour
- **Active Session**: Must be logged into X in browser
- **Stability**: Use during stable network conditions
- **Account Size**: Best for accounts under 100k followers

---

## 🔒 Privacy & Security

### Data Handling
<div align="center">
<table>
  <tr>
    <th>Aspect</th>
    <th>Details</th>
  </tr>
  <tr>
    <td>Storage Location</td>
    <td>Local browser storage only</td>
  </tr>
  <tr>
    <td>Data Transmission</td>
    <td>No external communication</td>
  </tr>
  <tr>
    <td>Encryption</td>
    <td>Browser's standard encryption</td>
  </tr>
    <tr>
    <td>Access</td>
    <td>Extension only access</td>
  </tr>
</table>
</div>

### Security Features
- ✅ **No External Servers**: All data stays on your device
- ✅ **No Data Sharing**: Never sends data to third parties
- ✅ **Open Source**: Code available for review
- ⚠️ **Local Access**: Anyone with computer access can view data
- ❌ **No Encryption**: Browser storage is standard (not encrypted)

---

## 🛠️ Troubleshooting

### Common Issues

#### Extension Not Working
**Problem**: The extension doesn't respond or shows errors
**Solution**:
- Check if you're logged into X in your browser
- Verify your username is correctly added to the extension
- Open browser console (F12 → Console) to check for errors
- Reload the extension from chrome://extensions/

#### Scan Takes Too Long
**Problem**: Scanning process seems stuck or very slow
**Solution**:
- This is normal for large follower counts (1000+ can take 5-20 minutes)
- X loads followers in batches as it scrolls down the page
- Don't close the scanning tab manually - it will close automatically
- Try scanning during off-peak hours when X's servers are less busy

#### Missing Followers
**Problem**: Some followers don't appear in the results
**Solution**:
- X may not load all followers for very large accounts
- Try scanning at different times of day
- Private/protected accounts may not appear in public follower lists
- Some accounts might be temporarily invisible due to X's systems

#### Data Not Saving
**Problem**: Stats reset after browser restart
**Solution**:
- Check if browser has storage permissions enabled
- Try reloading the extension from chrome://extensions/
- Clear browser cache if storage quota is exceeded
- Check for browser storage errors in console (F12)

### Error Messages
- **"No active tab"**: Check that you have an active browser tab open
- **"Scan failed"**: Network issue or X server problem occurred
- **"Timeout"**: Account has too many followers or network is slow
- **"Permission denied"**: Extension may need updated permissions

---

## 📦 File Structure

```
X-Tracker/
├── manifest.json          # Extension configuration and metadata
├── background.js          # Background service for scanning operations
├── popup.html             # User interface for the extension popup
├── popup.js               # Frontend logic and UI interactions
├── scraper.js             # Core scraping functionality
├── README.md              # This documentation file
├── icons/
│   ├── icon16.png         # Small icon for browser extensions
│   ├── icon48.png         # Medium icon for browser extensions
│   └── icon128.png        # Large icon for browser extensions
└── screenshots/
    └── preview.png        # Extension preview image
```

---

## 🤝 Contributing

We welcome contributions! Here's how you can help:

### Development Setup
1. Fork the repository from [Sterlites GitHub](https://github.com/Sterlites)
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Commit your changes (`git commit -m 'Add some amazing feature'`)
5. Push to the branch (`git push origin feature/amazing-feature`)
6. Open a Pull Request

### Areas for Improvement
- [ ] Better error handling and user feedback
- [ ] Support for dark/light mode preferences
- [ ] Notification system for new unfollowers
- [ ] Export functionality for data analytics
- [ ] Support for other browsers (Firefox, Safari)

---

## 📞 Support

### Need Help?
- 🐛 **Bug Reports**: Open an issue on [GitHub Issues](https://github.com/Sterlites/X-Tracker/issues)
- 💡 **Feature Requests**: Create a feature request in the issues section
- 📚 **Documentation**: Check this README for detailed instructions
- 💬 **Community**: Join discussions for help from other users

### Contact
- 🌐 Website: [www.sterlites.com](https://www.sterlites.com)
- 📧 Email: [contact@sterlites.com](mailto:contact@sterlites.com)
- 🐣 X (Twitter): [@Rohit_Dwivedi](https://x.com/Rohit_Dwivedi)
- 💬 GitHub: [Sterlites Organization](https://github.com/Sterlites)

---

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

```
MIT License

Copyright (c) 2025 Sterlites

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 🙏 Acknowledgments

- **X (Twitter)** for providing the platform that inspired this tool
- **Chrome Extension APIs** for enabling powerful browser extensions
- **Open Source Community** for inspiration and best practices
- **Beta Testers** for invaluable feedback and testing
- **Flaticon** for the amazing icons used in this project
- **[Sterlites](https://www.sterlites.com)** for the development and maintenance of this project
- **[@Rohit_Dwivedi](https://x.com/Rohit_Dwivedi)** for the initiative and continued support
- **All Contributors** who have helped make this project better

---

<div align="center">

### 💖 Like this extension?

If you find X Tracker helpful, please give it a star! ⭐

[![GitHub stars](https://img.shields.io/github/stars/Sterlites/X-Tracker?style=social)](https://github.com/Sterlites/X-Tracker/stargazers)

</div>

<div align="center">
  <h3><b>Free X Tracker for Small Accounts</b></h3>
  <p>Made with ❤️ by <a href="https://www.sterlites.com">Sterlites</a> | Follow us: <a href="https://x.com/Rohit_Dwivedi">@Rohit_Dwivedi</a> | For X (Twitter) users everywhere</p>
</div>

<div align="center">

### 🐛 Issues?
[![GitHub issues](https://img.shields.io/github/issues/Sterlites/X-Tracker)](https://github.com/Sterlites/X-Tracker/issues)
[![GitHub issues closed](https://img.shields.io/github/issues-closed/Sterlites/X-Tracker)](https://github.com/Sterlites/X-Tracker/issues)

</div>