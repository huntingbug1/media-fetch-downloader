# Media Fetch — Chrome Extension + Backend

Download videos from YouTube, Instagram, TikTok, Twitter/X directly from your browser.

## Quick Setup

### 1. Backend (Python API)

**Requirements:** Python 3.10+, ffmpeg

```bash
cd backend
python3 -m venv venv
source venv/bin/activate          # Mac/Linux
# venv\Scripts\activate           # Windows

pip install fastapi uvicorn aiohttp yt-dlp
uvicorn main:app --reload --port 8080
```

**Install ffmpeg:**
- Mac: `brew install ffmpeg`
- Windows: `choco install ffmpeg` or download from https://ffmpeg.org
- Linux: `sudo apt install ffmpeg`

### 2. Chrome Extension

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `extension/` folder
5. Done! Navigate to any video page and click the extension icon

### Settings (in extension popup)

- ⚙ **Backend URL**: `http://localhost:8080` (default)
- 📁 **Download Folder**: `MediaFetch` (saves to Downloads/MediaFetch/)
- ✅ **Platform Subfolders**: auto-creates YouTube/, TikTok/, Instagram/ subfolders

### Supported Platforms

| Platform | Formats |
|----------|---------|
| YouTube | 4K, 1080p, 720p, 480p, 360p, Audio |
| TikTok | 1080p No Watermark, 720p, Audio |
| Instagram | Reels, Posts |
| Twitter/X | Videos |
