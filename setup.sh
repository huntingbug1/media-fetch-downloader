#!/bin/bash
set -e
cd "$(dirname "$0")"

# Export standard macOS Homebrew paths so we can find brew, python3, aria2c, etc.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

echo ""
echo "╔══════════════════════════════════════╗"
echo "║     Media Fetch — Setup & Start      ║"
echo "╚══════════════════════════════════════╝"
echo ""

# 1. Python check
if ! command -v python3 &>/dev/null; then
    echo "❌  Python 3 not found."
    echo "    macOS:  brew install python3"
    echo "    Linux:  sudo apt install python3 python3-pip"
    exit 1
fi
PY=$(python3 --version | awk '{print $2}')
echo "✓  Python $PY"

# 2. Create venv
if [ ! -d "backend/venv" ]; then
    echo "→  Creating virtual environment..."
    python3 -m venv backend/venv
fi

PY_EXE="backend/venv/bin/python3"
PIP_EXE="backend/venv/bin/pip"

# 3. Install Python deps
echo "→  Installing Python packages..."
$PIP_EXE install -q --upgrade pip
$PIP_EXE install -q --upgrade fastapi "uvicorn[standard]" yt-dlp aiohttp aiofiles \
    imageio-ffmpeg python-multipart pydantic
echo "✓  Python packages ready"

# 4. ffmpeg
if command -v ffmpeg &>/dev/null; then
    echo "✓  ffmpeg found ($(ffmpeg -version 2>&1 | head -1 | awk '{print $3}'))"
elif [ -f "backend/ffmpeg" ]; then
    echo "✓  Bundled ffmpeg found"
else
    echo "→  Downloading ffmpeg via imageio-ffmpeg..."
    FFP=$($PY_EXE -c "import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())")
    cp "$FFP" backend/ffmpeg
    chmod +x backend/ffmpeg
    echo "✓  ffmpeg installed to backend/ffmpeg"
fi

# 5. aria2c (optional but highly recommended)
if command -v aria2c &>/dev/null; then
    echo "✓  aria2c found — parallel downloads enabled"
else
    echo "⚠  aria2c not found — downloads will be slower"
    echo "   macOS:  brew install aria2"
    echo "   Linux:  sudo apt install aria2"
fi

# 6. Start
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅  Setup complete! Starting backend..."
echo "   Backend:  http://localhost:8000"
echo ""
echo "   To load the extension:"
echo "   1. Open Chrome → chrome://extensions"
echo "   2. Enable Developer Mode"
echo "   3. Click 'Load unpacked' → select 'extension/' folder"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

export PATH="backend/venv/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
$PY_EXE start.py
