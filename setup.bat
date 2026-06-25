@echo off
cd /d "%~dp0"
echo.
echo ==========================================
echo     Media Fetch -- Setup and Start
echo ==========================================
echo.

where python >nul 2>&1 || (
    echo ERROR: Python not found. Download from https://python.org
    pause & exit /b 1
)
python -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>&1
if errorlevel 1 (
    echo ERROR: Python 3.10 or newer is required.
    echo Your current Python version is too old.
    echo Download the latest Python from: https://www.python.org/downloads/
    echo IMPORTANT: Make sure to check "Add Python to PATH" during installation.
    pause & exit /b 1
)
for /f "tokens=2" %%v in ('python --version 2^>^&1') do echo OK Python %%v

if exist "backend\venv" (
    backend\venv\Scripts\python.exe -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>&1
    if errorlevel 1 (
        echo WARNING: Existing virtual environment is using an old Python version. Rebuilding...
        rmdir /s /q "backend\venv"
    )
)

if not exist "backend\venv" (
    echo Creating virtual environment...
    python -m venv backend\venv
)

set PY=backend\venv\Scripts\python.exe
set PIP=backend\venv\Scripts\pip.exe

echo Installing packages...
%PIP% install -q --upgrade pip
%PIP% install -q fastapi "uvicorn[standard]" yt-dlp aiohttp aiofiles imageio-ffmpeg python-multipart pydantic certifi
echo OK Python packages ready

echo Checking yt-dlp version...
set YTDLP_VER=0.0.0
for /f "delims=" %%a in ('%PY% -m yt_dlp --version 2^>nul') do set YTDLP_VER=%%a
for /f "delims=." %%a in ("%YTDLP_VER%") do set YTDLP_YEAR=%%a
if %YTDLP_YEAR% lss 2026 (
    echo WARNING: yt-dlp version %YTDLP_VER% is outdated (minimum 2026.x).
    echo Force-upgrading yt-dlp...
    %PIP% install -q --upgrade --force-reinstall yt-dlp
) else (
    echo OK yt-dlp version %YTDLP_VER% is up to date
)

:: ffmpeg check
where ffmpeg >nul 2>&1 && (
    echo OK ffmpeg found
) || (
    if exist "backend\ffmpeg.exe" (
        echo OK Bundled ffmpeg.exe found
    ) else (
        echo Downloading ffmpeg via imageio-ffmpeg...
        %PY% -c "import imageio_ffmpeg, shutil; shutil.copy(imageio_ffmpeg.get_ffmpeg_exe(), 'backend\\ffmpeg.exe')"
        echo OK ffmpeg installed
    )
)

:: aria2c check
where aria2c >nul 2>&1 && (
    echo OK aria2c found - parallel downloads enabled
) || (
    echo WARNING: aria2c not found - downloads will be slower
    echo    Install: winget install aria2 --or-- choco install aria2
)

echo.
echo ==========================================
echo  Setup complete! Starting backend...
echo  Backend:  http://localhost:8000
echo.
echo  To load the Chrome extension:
echo   1. Open chrome://extensions
echo   2. Enable Developer Mode
echo   3. Load unpacked -> select 'extension' folder
echo ==========================================
echo.

set PATH=%CD%\backend\venv\Scripts;%PATH%
%PY% start.py
pause
