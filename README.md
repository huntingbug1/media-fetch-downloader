# Media Fetch — Premium Downloader Suite

A powerful, high-performance media downloader extension and local backend suite for YouTube, Instagram, TikTok, Twitter/X, and more. Integrates directly into your browser with cookie pass-through to bypass bot-detection, parallel IDM-style downloads (via `aria2c`), and automatic HD video merging (via `ffmpeg`).

---

## 🚀 Quick Start

### 1. Start the Backend
The backend runs locally on port `8000`. Run the automatic setup & start script for your system:

#### macOS / Linux
```bash
# Run one-click setup & start script
./setup.sh
```

#### Windows
Double-click `setup.bat` or run:
```cmd
setup.bat
```

### 2. Install the Browser Extension
1. Open Chrome and navigate to `chrome://extensions`.
2. Enable **Developer Mode** (top-right toggle).
3. Click **Load unpacked** (top-left button).
4. Select the `extension/` folder in this project directory.
5. The Media Fetch button `▼` will appear in your extensions list. Pin it!

### 3. Access the Web Dashboard (Optional)
If you prefer a web-based downloader interface, open your browser and navigate to:
`http://localhost:8000/`

The Web Dashboard allows you to analyze links, download video/audio files, package playlists into ZIP files, and monitor download history. Completed files are automatically saved to your local `Downloads/MediaFetch/[Platform]/` folder.

---

## 🎨 Features & Architecture

```
User visits Video Page (e.g. YouTube)
   ├── Extension reads active session cookies
   ├── Sends POST request to Local Backend (http://localhost:8000)
   │     ├── Backend writes cookies to temporary file
   │     ├── Backend starts yt-dlp with parallel downloader (aria2c)
   │     ├── Real-time progress updates are sent back to extension
   └── Completed media is downloaded directly via Chrome downloads
```

### Supported Platforms & Capabilities

| Platform | Features | Parallel Connections | Audio Extracting |
| :--- | :--- | :---: | :---: |
| **YouTube** | up to 4K / 8K, HDR, playlists | Yes (16x via `aria2c`) | Yes (MP3) |
| **TikTok** | No-watermark CDN links | Yes | Yes |
| **Instagram** | Reels, stories, posts | Yes | Yes |
| **Twitter/X** | High quality video links | Yes | Yes |

---

## 🛠️ Advanced Settings & Customisation

Click the gear icon in the extension popup to open **Settings**:
- **Backend URL**: Change the API port if running on a custom host/port (defaults to `http://localhost:8000`).
- **Download Folder**: Save files to `Downloads/[folder]/` instead of root Downloads.
- **Auto-create platform subfolders**: Automatically organizes downloads into `Downloads/[folder]/[platform]/[title].mp4`.

---

## 🎛️ Windows Auto-Start (Silent Background Run)

To keep the backend server running continuously in the background on Windows without keeping a command console window open, you can use the silent Visual Basic script:
1. Double-click **`run_background.vbs`** to launch the backend server invisibly.
2. To make it start automatically when Windows reboots:
   - Press **`Win + R`**, type **`shell:startup`**, and click **OK** to open the Windows Startup folder.
   - Right-click **`run_background.vbs`**, select **Copy**, then right-click inside the Startup folder and select **Paste shortcut**.

---

## 🔌 Connection Ping & Health Check

A zero-dependency verification utility **`ping_backend.py`** is included to test your setup:
```bash
python ping_backend.py
```
This pings active local ports (`8000-8005`) to report:
* Server connection status.
* Port number in use.
* Active API version.
* GitHub update details.

---

## 💾 SQLite Metadata Caching (12-Hour Reset)

To speed up formatting lookups in both the Extension popup and the Web Dashboard, a temporary SQLite database cache is maintained:
* Location: `backend/temp_downloads/media_fetch_cache.db` (auto-ignored by Git).
* Lifetime: Cache entries automatically expire and are pruned **after 12 hours** on lookup or startup.

---

## 🔍 Troubleshooting

| Issue | Cause | Fix |
| :--- | :--- | :--- |
| **"Backend Offline" in Extension** | The Python server is not running or blocked by firewall. | Make sure `setup.sh`/`setup.bat` is running. Check if port `8000` is occupied by another app. |
| **YouTube Throttling / HTTP 403** | YouTube is throttling anonymous CLI requests. | The extension automatically passes session cookies. Make sure you are logged in to YouTube in Chrome. |
| **Slow Downloads** | `aria2c` is not installed on the system. | Install `aria2`: <br>• macOS: `brew install aria2`<br>• Linux: `sudo apt install aria2`<br>• Windows: `winget install aria2` |