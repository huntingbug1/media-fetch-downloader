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
for /f "tokens=2" %%v in ('python --version 2^>^&1') do echo OK Python %%v

if not exist "backend\venv" (
    echo Creating virtual environment...
    python -m venv backend\venv
)

set PY=backend\venv\Scripts\python.exe
set PIP=backend\venv\Scripts\pip.exe

echo Installing packages...
%PIP% install -q --upgrade pip
%PIP% install -q fastapi "uvicorn[standard]" yt-dlp aiohttp aiofiles imageio-ffmpeg python-multipart pydantic
echo OK Python packages ready

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
