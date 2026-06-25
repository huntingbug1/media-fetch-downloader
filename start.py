#!/usr/bin/env python3
"""
Media Fetch — Universal Installer & Starter
Starts the Python backend (port 8000) AND the website frontend (port 3000).
"""
import os
import sys
import subprocess
import venv
import shutil
import platform
import threading
import time

def cprint(color, symbol, msg):
    colors = {'cyan': '\033[1;36m', 'green': '\033[1;32m', 'red': '\033[1;31m', 'yellow': '\033[1;33m'}
    reset = '\033[0m'
    print(f"{colors.get(color,'')}{symbol}{reset} {msg}")

def print_step(msg): print(f"\n\033[1;36m==>\033[0m \033[1m{msg}\033[0m")
def print_ok(msg):   cprint('green',  '  ✓', msg)
def print_err(msg):  cprint('red',    '  ✗', msg); sys.exit(1)
def print_info(msg): cprint('yellow', '  •', msg)

def run_cmd(cmd, env=None, cwd=None):
    try:
        subprocess.run(cmd, env=env, cwd=cwd, check=True, capture_output=True)
    except subprocess.CalledProcessError as e:
        print_err(f"Command failed: {' '.join(str(c) for c in cmd)}\n{e.stderr.decode('utf-8', errors='replace')}")

def find_free_port(start_port=8000):
    import socket
    port = start_port
    while True:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("0.0.0.0", port))
                return port
            except OSError:
                port += 1

def get_local_ip():
    import socket
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"

def main():
    print("\n🚀  Media Fetch — Universal Installer & Starter\n")

    root_dir    = os.path.dirname(os.path.abspath(__file__))
    backend_dir = os.path.join(root_dir, "backend")
    venv_dir    = os.path.join(backend_dir, "venv")
    is_windows  = platform.system() == "Windows"

    if not os.path.exists(backend_dir):
        print_err(f"Backend directory not found at {backend_dir}")

    # ── 1. Virtual environment ────────────────────────────────────────────────
    print_step("Checking Python virtual environment...")
    if not os.path.exists(venv_dir):
        print("  Creating virtual environment...")
        venv.create(venv_dir, with_pip=True)
    print_ok("Virtual environment ready")

    if is_windows:
        py_exe  = os.path.join(venv_dir, "Scripts", "python.exe")
        pip_exe = os.path.join(venv_dir, "Scripts", "pip.exe")
        bin_dir = os.path.join(venv_dir, "Scripts")
    else:
        py_exe  = os.path.join(venv_dir, "bin", "python3")
        pip_exe = os.path.join(venv_dir, "bin", "pip")
        bin_dir = os.path.join(venv_dir, "bin")

    if not os.path.exists(py_exe):
        print_err(f"Python executable not found: {py_exe}")

    # ── 2. Python packages ────────────────────────────────────────────────────
    print_step("Installing required Python packages...")
    reqs = ["fastapi", "uvicorn", "aiohttp", "yt-dlp", "imageio-ffmpeg", "aiofiles", "pydantic", "python-multipart", "certifi"]
    run_cmd([py_exe, "-m", "pip", "install", "--upgrade", "pip"])
    run_cmd([py_exe, "-m", "pip", "install", "--upgrade"] + reqs)
    print_ok("All Python packages installed")

    # ── 3. ffmpeg ─────────────────────────────────────────────────────────────
    print_step("Checking ffmpeg (needed for HD video merging)...")
    ffmpeg_exe_name = "ffmpeg.exe" if is_windows else "ffmpeg"
    local_ffmpeg    = os.path.join(backend_dir, ffmpeg_exe_name)

    if os.path.exists(local_ffmpeg):
        print_ok("Found bundled ffmpeg")
    elif shutil.which("ffmpeg"):
        print_ok("Found ffmpeg installed on system")
    else:
        print("  Downloading ffmpeg via imageio-ffmpeg...")
        try:
            script = "import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())"
            res = subprocess.run([py_exe, "-c", script], capture_output=True, text=True, check=True)
            src = res.stdout.strip()
            if src and os.path.exists(src):
                shutil.copy2(src, local_ffmpeg)
                if not is_windows:
                    os.chmod(local_ffmpeg, 0o755)
                print_ok("Downloaded ffmpeg successfully")
            else:
                print_err("imageio-ffmpeg returned no path")
        except subprocess.CalledProcessError as e:
            print_err(f"Failed to get ffmpeg: {e.stderr}")

    # ── 4. Prep env ───────────────────────────────────────────────────────────
    env = os.environ.copy()
    # Include Homebrew paths so yt-dlp can find deno for YouTube JS challenge solving
    homebrew_bin = "/opt/homebrew/bin"      # Apple Silicon Macs
    local_bin    = "/usr/local/bin"         # Intel Macs / older Homebrew
    env["PATH"] = f"{backend_dir}{os.pathsep}{bin_dir}{os.pathsep}{homebrew_bin}{os.pathsep}{local_bin}{os.pathsep}{env.get('PATH', '')}"
    os.makedirs(os.path.join(backend_dir, "temp_downloads"), exist_ok=True)

    # ── 5. Start backend ──────────────────────────────────────────────────────
    port = find_free_port(8000)
    local_ip = get_local_ip()

    print_step(f"Starting Media Fetch backend (port {port})...")
    backend_proc = subprocess.Popen(
        [py_exe, "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", str(port)],
        env=env, cwd=backend_dir
    )
    print_ok(f"Backend started → http://localhost:{port}")

    # ── 6. Info ───────────────────────────────────────────────────────────────
    print("\n" + "─"*55)
    print_ok("Backend server is running!")
    print_info(f"Local Access   → http://localhost:{port}")
    if local_ip != "127.0.0.1":
        print_info(f"Network Access → http://{local_ip}:{port}")
    ext_path = os.path.join(root_dir, "extension")
    print_info(f"Extension Code → '{ext_path}' (Load unpacked in Chrome)")
    print("\n  Press Ctrl+C to stop the server.\n")
    print("─"*55 + "\n")

    try:
        backend_proc.wait()
    except KeyboardInterrupt:
        print("\n\nStopping server...")
        backend_proc.terminate()
        print("Goodbye! 👋")

if __name__ == "__main__":
    main()
