#!/bin/bash
set -e
cd "$(dirname "$0")"

# Export standard macOS Homebrew paths so we can find brew, python3, aria2c, etc.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# On macOS, fix SSL certificate verification errors common in official Python.org installers
if [ "$(uname)" = "Darwin" ]; then
    echo "→  Configuring SSL Certificates (macOS)..."
    PY_VERSION=$(python3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
    CERT_CMD="/Applications/Python ${PY_VERSION}/Install Certificates.command"
    if [ -f "$CERT_CMD" ]; then
        "$CERT_CMD" &>/dev/null || true
        echo "✓  SSL Certificates configured"
    fi
fi

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

if ! python3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" &>/dev/null; then
    PY_VER=$(python3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}')")
    echo "❌  Python $PY_VER is too old (minimum: 3.10)"
    echo "    yt-dlp 2026.x requires Python 3.10 or newer."
    echo ""
    if [ "$(uname)" = "Darwin" ]; then
        echo "    Fix — choose one:"
        echo "      Homebrew:   brew install python@3.13"
        echo "      python.org: https://www.python.org/downloads/"
    else
        echo "    Fix — choose one:"
        echo "      Ubuntu/Debian:  sudo apt install python3.12 python3.12-venv"
        echo "      Fedora/RHEL:    sudo dnf install python3.12"
        echo "      Any Linux:      https://github.com/pyenv/pyenv  (pyenv install 3.13)"
    fi
    echo ""
    echo "    After installing Python 3.10+, run this script again."
    exit 1
fi

PY=$(python3 --version | awk '{print $2}')
echo "✓  Python $PY"

# 2. Create venv
if [ -d "backend/venv" ]; then
    if ! backend/venv/bin/python3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" &>/dev/null; then
        echo "⚠  Existing virtual environment is using an old Python version. Rebuilding..."
        rm -rf backend/venv
    fi
fi

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
    imageio-ffmpeg python-multipart pydantic certifi
echo "✓  Python packages ready"

# Verify yt-dlp version
echo "→  Verifying yt-dlp version..."
YTDLP_VER=$($PY_EXE -m yt_dlp --version 2>/dev/null || echo "0.0.0")
YTDLP_YEAR=$(echo "$YTDLP_VER" | cut -d'.' -f1)
if [[ ! "$YTDLP_YEAR" =~ ^[0-9]+$ ]] || [ "$YTDLP_YEAR" -lt 2026 ]; then
    echo "⚠  yt-dlp version $YTDLP_VER is outdated (minimum: 2026.x)"
    echo "→  Force-reinstalling latest yt-dlp..."
    $PIP_EXE install -q --upgrade --force-reinstall yt-dlp
    YTDLP_VER_NEW=$($PY_EXE -m yt_dlp --version 2>/dev/null || echo "0.0.0")
    echo "✓  yt-dlp upgraded to $YTDLP_VER_NEW"
else
    echo "✓  yt-dlp version $YTDLP_VER is up to date"
fi

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
