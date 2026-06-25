import os
import asyncio
import shutil
import uuid
import zipfile
import unicodedata
import re
import json
import time
import hashlib
import urllib.parse
import aiohttp
from typing import Optional, List
from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from contextlib import asynccontextmanager
from services.ytdlp_service import YTDLPService, YTDLP_BIN
from services import cache_db


VERSION = "1.0.0"
UPDATE_STATUS = {"available": False, "latest": VERSION}

async def check_github_updates():
    """Query GitHub once a day to check if a new version is available."""
    while True:
        try:
            print("[MediaFetch Update] Checking GitHub for updates...")
            url = "https://raw.githubusercontent.com/huntingbug1/media-fetch-downloader/main/version.txt"
            async with aiohttp.ClientSession() as session:
                async with session.get(url, timeout=10) as resp:
                    if resp.status == 200:
                        remote_version = (await resp.text()).strip()
                        if remote_version and remote_version != VERSION:
                            UPDATE_STATUS["available"] = True
                            UPDATE_STATUS["latest"] = remote_version
                            print(f"[MediaFetch Update] A new update is available! Current: {VERSION}, Latest: {remote_version}")
                        else:
                            UPDATE_STATUS["available"] = False
                            UPDATE_STATUS["latest"] = VERSION
                            print(f"[MediaFetch Update] Up to date (v{VERSION}).")
                    else:
                        print(f"[MediaFetch Update] GitHub returned status {resp.status}")
        except Exception as e:
            print(f"[MediaFetch Update] Check failed: {e}")
        
        # Sleep for 24 hours (86400 seconds)
        await asyncio.sleep(86400)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup: delete temp files older than 1 hour. Keeps disk clean."""
    # Initialize SQLite Cache database
    try:
        cache_db.init_db()
        cache_db.prune_expired()
    except Exception as e:
        print(f"[MediaFetch Startup] Failed to initialize SQLite cache: {e}")

    # Launch daily update checking task
    update_task = asyncio.create_task(check_github_updates())

    cutoff = time.time() - 3600
    freed = 0
    try:
        for fname in os.listdir(TEMP_DIR):
            if fname == '.gitkeep':
                continue
            fpath = os.path.join(TEMP_DIR, fname)
            try:
                if os.path.getmtime(fpath) < cutoff:
                    sz = os.path.getsize(fpath) if os.path.isfile(fpath) else 0
                    if os.path.isfile(fpath):
                        os.remove(fpath)
                    else:
                        shutil.rmtree(fpath, ignore_errors=True)
                    freed += sz
            except Exception:
                pass
    except Exception:
        pass
    if freed:
        print(f"[MediaFetch] Startup cleanup: freed {freed / 1048576:.1f} MB from temp_downloads/")
    try:
        yield
    finally:
        update_task.cancel()


app = FastAPI(title="Media Fetch — Premium Downloader API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Disposition"],
)

TEMP_DIR = os.path.join(os.getcwd(), "temp_downloads")
os.makedirs(TEMP_DIR, exist_ok=True)


def _clean_url_hash(url: str) -> str:
    """
    Generate a stable, unique cache key hash for a URL.
    Parses the URL, sorts and keeps query parameters (e.g. YouTube watch?v=...),
    but strips URL fragments and tracking query parameters (utm_*, etc.).
    """
    try:
        parsed = urllib.parse.urlparse(url)
        q_params = urllib.parse.parse_qsl(parsed.query)
        clean_params = []
        for k, v in q_params:
            if not k.startswith("utm_") and k not in ("fbclid", "gclid"):
                clean_params.append((k, v))
        clean_params.sort()
        clean_query = urllib.parse.urlencode(clean_params)
        clean_url = urllib.parse.urlunparse((
            parsed.scheme,
            parsed.netloc.lower(),
            parsed.path,
            parsed.params,
            clean_query,
            ""  # strip fragment
        ))
        return hashlib.md5(clean_url.encode('utf-8')).hexdigest()
    except Exception:
        # Fallback to simple md5 hash of the original url if parsing fails
        return hashlib.md5(url.encode('utf-8')).hexdigest()


def _get_ffmpeg() -> str:
    """Find ffmpeg: check local backend dir first, then PATH."""
    here = os.path.dirname(os.path.abspath(__file__))
    for name in ("ffmpeg.exe" if os.name == "nt" else "ffmpeg", "ffmpeg"):
        local = os.path.join(here, name)
        if os.path.exists(local):
            return local
    return shutil.which("ffmpeg") or ""


def _has_aria2c() -> bool:
    return shutil.which("aria2c") is not None


def _write_temp_cookies(cookies_str: str) -> str:
    """
    Write a Netscape-format cookie string to a temp file.
    Returns the file path, or '' if cookies are empty/invalid.
    The caller is responsible for deleting the file after use.
    """
    if not cookies_str or len(cookies_str.strip()) < 30:
        return ""
    try:
        path = os.path.join(TEMP_DIR, f"ck_{uuid.uuid4().hex[:10]}.txt")
        with open(path, "w", encoding="utf-8") as f:
            f.write(cookies_str)
        return path
    except Exception:
        return ""


def _add_browser_cookies(cmd: List[str]) -> None:
    """Stub — browser cookies are now passed via the extension. See _write_temp_cookies."""
    pass


# ── Models ────────────────────────────────────────────────────────────────────

class InfoRequest(BaseModel):
    url: str
    cookies: str = ""   # Netscape-format cookies from the browser extension

class DownloadRequest(BaseModel):
    url: str = ""
    format_id: str = ""
    height: int = 0          # video height (px) — used to build a fallback quality selector
    filename: str = ""
    is_audio: bool = False
    needs_merge: bool = False
    expected_size: int = 0
    direct_url: str = ""     # TikWM direct media URL
    cookies: str = ""        # Netscape-format cookies from the browser extension
    is_dashboard: bool = False

class PlaylistDownloadRequest(BaseModel):
    playlist_url: str
    video_urls: List[str]
    quality: str
    limit: Optional[int] = 0  # 0 = all, N = first N videos
    is_dashboard: Optional[bool] = False

class TabItem(BaseModel):
    url: str
    cookies: Optional[str] = ""

class TabSyncRequest(BaseModel):
    tabs: List[TabItem]


# ── Helpers ───────────────────────────────────────────────────────────────────

def detect_platform(url: str) -> str:
    if not url:
        return "Other"
    url_lower = url.lower()
    if "youtube.com" in url_lower or "youtu.be" in url_lower:
        return "YouTube"
    if "instagram.com" in url_lower:
        return "Instagram"
    if "tiktok.com" in url_lower:
        return "TikTok"
    if "twitter.com" in url_lower or "x.com" in url_lower:
        return "Twitter"
    if "facebook.com" in url_lower or "fb.watch" in url_lower:
        return "Facebook"
    if "reddit.com" in url_lower or "v.redd.it" in url_lower:
        return "Reddit"
    return "Other"


def save_to_local_downloads(src_path: str, url: str, filename: str) -> bool:
    try:
        downloads_dir = os.path.expanduser("~/Downloads")
        if not os.path.exists(downloads_dir):
            return False
        
        platform = detect_platform(url)
        dest_dir = os.path.join(downloads_dir, "MediaFetch", platform)
        os.makedirs(dest_dir, exist_ok=True)
        
        dest_path = os.path.join(dest_dir, filename)
        shutil.copy2(src_path, dest_path)
        print(f"[MediaFetch Backend] Automatically saved dashboard download to local folder: {dest_path}")
        return True
    except Exception as e:
        print(f"[MediaFetch Backend] Failed to automatically save copy to local folder: {e}")
        return False


def make_safe_filename(name: str, ext: str) -> str:
    """
    Convert any video title into a safe filename:
    1. Normalize unicode (NFC) so accented chars survive
    2. Remove OS-reserved characters ( / \\ : * ? " < > | )
    3. Collapse whitespace
    4. Fallback to 'video' if empty after sanitisation
    """
    # Normalize unicode — keeps accented letters, Arabic, etc.
    name = unicodedata.normalize("NFC", name or "video")
    # Strip characters that are invalid in filenames on Windows/macOS/Linux
    name = re.sub(r'[/\\:*?"<>|]', "_", name)
    # Collapse runs of whitespace / underscores at edges
    name = re.sub(r"\s+", " ", name).strip().strip("_")
    # Truncate to 180 chars so path stays within limits
    name = name[:180] or "video"
    return f"{name}.{ext}"


def _content_disposition_header(filename: str) -> str:
    """
    Build a Content-Disposition header value that safely handles Unicode filenames.
    Uses RFC 5987 (filename*=UTF-8'') for modern browsers plus an ASCII fallback.
    HTTP headers must be latin-1 encodable, so raw emoji/Unicode will crash Starlette.
    """
    # ASCII fallback: strip everything non-ASCII
    ascii_name = filename.encode("ascii", "ignore").decode("ascii")
    if not ascii_name or ascii_name == ".mp4" or ascii_name == ".mp3":
        ascii_name = "video.mp4" if not filename.endswith(".mp3") else "audio.mp3"
    ascii_name = ascii_name.replace('"', '\\"')

    # RFC 5987 encoded real filename
    encoded = urllib.parse.quote(filename, safe="")

    return f'attachment; filename="{ascii_name}"; filename*=UTF-8\'\'{encoded}'


async def cleanup_file(path: str, job_id: str = "", delay: int = 300):
    """Delete a temp file/dir after a delay. The sleep is interruptible on shutdown."""
    try:
        await asyncio.sleep(delay)
    except asyncio.CancelledError:
        pass  # Server shutting down — that's fine, just clean up now
    try:
        if os.path.isdir(path):
            shutil.rmtree(path, ignore_errors=True)
        elif os.path.exists(path):
            os.remove(path)
    except Exception:
        pass
    if job_id:
        JOBS.pop(job_id, None)
        SERVED_JOBS.pop(job_id, None)


def _yt_format_selector(format_id: str, height: int = 0) -> str:
    """
    Build a robust YouTube format selector that falls back gracefully when a
    specific format_id has expired or is unavailable:
      1. Try the exact format_id + best audio
      2. Fall back to best video at the same height + best audio
      3. Fall back to best combined format at that height
      4. Last resort: absolute best
    """
    if height > 0:
        return (
            f"{format_id}+bestaudio/"
            f"bestvideo[height<={height}]+bestaudio/"
            f"best[height<={height}]/"
            f"best"
        )
    return f"{format_id}+bestaudio/best"


def _download_yt_cmd(url: str, format_id: str, output_path: str, height: int = 0, needs_merge: bool = False, info_json_path: Optional[str] = None, cookies_path: str = "") -> List[str]:
    """
    Build a yt-dlp command that downloads to a real file.
    Uses aria2c for maximum parallel download speed (16 connections — IDM-style).
    Works for YouTube, TikTok, Instagram, Twitter/X, and most other sites.
    """
    is_tiktok = "tiktok.com" in url
    is_youtube = "youtube.com" in url or "youtu.be" in url
    is_instagram = "instagram.com" in url
    is_direct = format_id in ("no_watermark", "watermark", "direct")

    cmd = [
        YTDLP_BIN,
        "--no-warnings",
        "--no-playlist",
        "--no-check-formats",
        "--no-mtime",
        "--force-ipv4",
        "-o", output_path,
    ]

    if info_json_path:
        cmd.extend(["--load-info-json", info_json_path])

    # aria2c = 16 parallel connections (like IDM)
    if _has_aria2c():
        cmd.extend([
            "--external-downloader", "aria2c",
            "--external-downloader-args",
            "aria2c:-x 16 -s 16 -k 1M --min-split-size=1M --file-allocation=none",
        ])
    else:
        # Fallback: yt-dlp native parallel fragments
        cmd.extend(["--concurrent-fragments", "16"])

    ffmpeg_path = _get_ffmpeg()
    if ffmpeg_path:
        cmd.extend(["--ffmpeg-location", ffmpeg_path])

    if is_direct:
        cmd.append(url)
        return cmd

    if is_youtube:
        cmd.extend([
            "--user-agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            "--add-header", "Accept-Language:en-US,en;q=0.9",
        ])

    if is_instagram:
        cmd.extend([
            "--user-agent",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        ])

    if is_tiktok:
        cmd.extend([
            "--extractor-args", "tiktok:api_hostname=api16-normal-c-useast1a.tiktokv.com",
            "--add-header", "Referer:https://www.tiktok.com/",
            "--add-header", "Origin:https://www.tiktok.com",
            "--user-agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        ])

    # Format selection: merge needs video+audio, non-merge is pre-muxed
    if needs_merge:
        if is_youtube:
            fmt = _yt_format_selector(format_id, height)
        else:
            fmt = f"{format_id}+bestaudio/best"
    else:
        # Pre-muxed format — download as-is (no double audio download)
        fmt = f"{format_id}/best"

    cmd.extend([
        "-f", fmt,
        "--merge-output-format", "mp4",
    ])
    if cookies_path and os.path.exists(cookies_path):
        cmd.extend(["--cookies", cookies_path])
    cmd.append(url)
    return cmd



def _stream_audio_cmd(url: str, format_id: str, info_json_path: Optional[str] = None, cookies_path: str = "") -> List[str]:
    """yt-dlp command that streams audio to stdout as MP3."""
    is_youtube = "youtube.com" in url or "youtu.be" in url
    is_instagram = "instagram.com" in url

    cmd = [
        YTDLP_BIN,
        "--no-warnings",
        "--no-playlist",
        "--no-check-formats",
        "-f", "bestaudio/best",
        "--extract-audio",
        "--audio-format", "mp3",
        "--audio-quality", "0",
        "-o", "-",
    ]

    if info_json_path:
        cmd.extend(["--load-info-json", info_json_path])
    ffmpeg_path = _get_ffmpeg()
    if ffmpeg_path:
        cmd.extend(["--ffmpeg-location", ffmpeg_path])
    if cookies_path and os.path.exists(cookies_path):
        cmd.extend(["--cookies", cookies_path])
    cmd.append(url)
    return cmd


def _stream_video_cmd(url: str, format_id: str, height: int = 0, info_json_path: Optional[str] = None, cookies_path: str = "") -> List[str]:
    """Stream a pre-muxed (video+audio already combined) format directly to stdout."""
    is_tiktok = "tiktok.com" in url
    is_youtube = "youtube.com" in url or "youtu.be" in url
    is_instagram = "instagram.com" in url
    is_direct = format_id in ("no_watermark", "watermark", "direct")

    cmd = [
        YTDLP_BIN,
        "--no-warnings",
        "--no-playlist",
        "--no-check-formats",
        "--concurrent-fragments", "16",
        "--buffer-size", "1024K",
        "--http-chunk-size", "10M",
        "--no-mtime",
        "-o", "-",
    ]

    if info_json_path:
        cmd.extend(["--load-info-json", info_json_path])

    ffmpeg_path = _get_ffmpeg()
    if ffmpeg_path:
        cmd.extend(["--ffmpeg-location", ffmpeg_path])

    if is_direct:
        cmd.append(url)
        return cmd

    if is_tiktok:
        cmd.extend([
            "--extractor-args", "tiktok:api_hostname=api16-normal-c-useast1a.tiktokv.com",
            "--add-header", "Referer:https://www.tiktok.com/",
            "--add-header", "Origin:https://www.tiktok.com",
            "--user-agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        ])
    elif is_youtube or is_instagram:
        if cookies_path and os.path.exists(cookies_path):
            cmd.extend(["--cookies", cookies_path])

    # Use smart fallback selector for YouTube; raw format_id for others
    if is_youtube:
        fmt = _yt_format_selector(format_id, height)
        cmd.extend(["-f", fmt, "--merge-output-format", "mp4"])
    else:
        cmd.extend(["-f", format_id])

    cmd.append(url)
    return cmd

# ── Job Store (in-memory async download tracker) ─────────────────────────────
import time
from dataclasses import dataclass, field

@dataclass
class DownloadJob:
    job_id: str
    filename: str
    expected_size: int = 0      # bytes, from format metadata
    status: str = "queued"     # queued | downloading | merging | ready | failed
    progress: int = 0           # 0-100
    speed: str = ""             # human-readable speed / progress info shown in UI
    file_path: Optional[str] = None
    error: Optional[str] = None
    created_at: float = field(default_factory=time.time)
    url: Optional[str] = None
    is_dashboard: bool = False

JOBS: dict[str, DownloadJob] = {}
# Jobs that were already served via download_file() — kept for 5 min so Chrome retries/resumes work
SERVED_JOBS: dict[str, DownloadJob] = {}

async def _run_merge_job(job: DownloadJob, cmd: List[str], temp_path: str, cookies_path: str = ""):
    """Run yt-dlp in background, track progress via file size, update job state."""
    try:
        job.status = "downloading"
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )

        # Timeout: 30 minutes max for merge jobs (handles YouTube throttling / stuck fragments)
        MAX_MERGE_SECONDS = 30 * 60
        elapsed = 0
        last_size = -1
        stall_seconds = 0

        # Poll file size every second while process runs
        while proc.returncode is None:
            await asyncio.sleep(1)
            elapsed += 1

            # Global timeout
            if elapsed > MAX_MERGE_SECONDS:
                proc.kill()
                job.status = "failed"
                job.error = "Download timed out (30 min) — try again or pick a lower quality"
                return

            try:
                # Check all partial files (yt-dlp may create .part, .f137.mp4, etc.)
                total_size = 0
                folder = os.path.dirname(temp_path)
                base = os.path.basename(temp_path)
                for f in os.listdir(folder):
                    if f == '.gitkeep':
                        continue
                    if f.startswith(base.split('.')[0][:12]):
                        fp = os.path.join(folder, f)
                        if os.path.isfile(fp):
                            total_size += os.path.getsize(fp)

                if total_size > 0:
                    mb = total_size / (1024 * 1024)
                    if job.expected_size > 0:
                        # Accurate % from expected size — cap at 90 to leave room for merge phase
                        job.progress = min(int(total_size * 90 / job.expected_size), 90)
                    else:
                        # No size info: use logarithmic curve so progress feels alive
                        # 100MB → ~50%, 500MB → ~75%, 2GB → ~90%
                        import math
                        job.progress = min(int(45 * math.log10(max(mb, 1) + 1)), 90)
                    job.speed = f"{mb:.0f} MB"
                    job.status = "downloading"

                    # Detect stall: no size change for 3 minutes = likely hung
                    if total_size == last_size:
                        stall_seconds += 1
                        if stall_seconds > 180:
                            proc.kill()
                            job.status = "failed"
                            job.error = "Download stalled — no progress for 3 minutes"
                            return
                    else:
                        stall_seconds = 0
                        last_size = total_size
            except Exception:
                pass

            # Check if process finished
            try:
                await asyncio.wait_for(proc.wait(), timeout=0.1)
            except asyncio.TimeoutError:
                pass

        # Process exited — check for output file
        if os.path.exists(temp_path) and os.path.getsize(temp_path) > 0:
            # Show "Merging…" briefly while we confirm the file is complete
            job.status = "merging"
            job.progress = 97
            job.speed = "Finalising…"
            await asyncio.sleep(0.5)  # tiny pause so UI can render the merging state
            job.file_path = temp_path
            job.status = "ready"
            job.progress = 100
            job.speed = ""
            if job.is_dashboard:
                save_to_local_downloads(temp_path, job.url, job.filename)
        else:
            job.status = "failed"
            job.error = "Download produced no output file"
    except Exception as e:
        job.status = "failed"
        job.error = str(e)
    finally:
        if cookies_path and os.path.exists(cookies_path):
            try:
                os.remove(cookies_path)
            except Exception:
                pass
async def pre_fetch_tabs_task(tabs: List[TabItem]):
    """Background task to pre-fetch metadata for uncached tab URLs."""
    try:
        cache_db.prune_expired()
    except Exception:
        pass

    for tab in tabs:
        url = tab.url
        if not url:
            continue
        try:
            # Check if already cached
            cached = cache_db.get_cached_metadata(url)
            if cached:
                continue # Already cached and active
            
            print(f"[MediaFetch Backend] Background pre-fetching metadata for: {url}")
            cookies_path = _write_temp_cookies(tab.cookies or "")
            try:
                raw = await YTDLPService.get_metadata(url, cookies_path=cookies_path)
                cache_db.save_metadata(url, raw)
            finally:
                if cookies_path and os.path.exists(cookies_path):
                    try:
                        os.remove(cookies_path)
                    except Exception:
                        pass
            # Sleep briefly to avoid hammering
            await asyncio.sleep(1)
        except Exception as e:
            print(f"[MediaFetch Backend] Background pre-fetch failed for {url}: {e}")


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/api/health")
async def health_check():
    return {
        "status": "ok",
        "version": VERSION,
        "update_available": UPDATE_STATUS["available"],
        "latest_version": UPDATE_STATUS["latest"]
    }


@app.post("/api/info")
@app.get("/api/info")
@app.get("/info")
async def get_video_info(
    request: Optional[InfoRequest] = None,
    url: Optional[str] = None,
    cookies: Optional[str] = "",
):
    target_url = (request.url if request else url) or ""
    target_cookies = (request.cookies if request else cookies) or ""
    if not target_url:
        raise HTTPException(status_code=400, detail="URL is required")
    
    # Check SQLite cache first
    try:
        cached = cache_db.get_cached_metadata(target_url)
        if cached:
            print(f"[MediaFetch Backend] Cache HIT for: {target_url}")
            return YTDLPService.process_metadata(cached)
    except Exception as ce:
        print(f"[MediaFetch Backend] Cache read error: {ce}")

    cookies_path = _write_temp_cookies(target_cookies)
    try:
        raw = await YTDLPService.get_metadata(target_url, cookies_path=cookies_path)
        try:
            cache_db.save_metadata(target_url, raw)
        except Exception as ce:
            print(f"[MediaFetch Backend] Cache write error: {ce}")
        return YTDLPService.process_metadata(raw)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if cookies_path and os.path.exists(cookies_path):
            try:
                os.remove(cookies_path)
            except Exception:
                pass


@app.post("/api/sync-tabs")
async def sync_tabs(request: TabSyncRequest, background_tasks: BackgroundTasks):
    """
    Accepts open/loaded tabs from extension.
    Fires off a background task to pre-fetch metadata for tabs that aren't already cached.
    """
    background_tasks.add_task(pre_fetch_tabs_task, request.tabs)
    return {"ok": True, "message": f"Sync started for {len(request.tabs)} tabs"}


@app.api_route("/api/download", methods=["GET", "POST"])
async def download_video(
    background_tasks: BackgroundTasks,
    request: Optional[DownloadRequest] = None,
    url: Optional[str] = None,
    format_id: Optional[str] = None,
    height: Optional[int] = 0,
    filename: Optional[str] = None,
    is_audio: Optional[bool] = False,
    needs_merge: Optional[bool] = False,
    expected_size: Optional[int] = 0,
    direct_url: Optional[str] = None,
    cookies: Optional[str] = "",
    is_dashboard: Optional[bool] = False,
):
    # ── Resolve parameters (POST body OR GET query string) ──
    target_url = (request.url if request and "url" in request.model_fields_set else url) or ""
    target_format = (request.format_id if request and "format_id" in request.model_fields_set else format_id) or ""
    target_height = (request.height if request and "height" in request.model_fields_set else height) or 0
    raw_filename = (request.filename if request and "filename" in request.model_fields_set else filename) or ""
    target_is_audio = request.is_audio if request and "is_audio" in request.model_fields_set else (is_audio or False)
    target_direct_url = (request.direct_url if request and "direct_url" in request.model_fields_set else direct_url) or ""
    target_cookies = (request.cookies if request and "cookies" in request.model_fields_set else cookies) or ""
    target_is_dashboard = request.is_dashboard if request and "is_dashboard" in request.model_fields_set else (is_dashboard or False)

    if not target_url or not target_format:
        raise HTTPException(status_code=400, detail="url and format_id are required")

    # Reuse cached yt-dlp info JSON to avoid a second page extraction when the
    # user already fetched metadata via /api/info. Falls back to live extraction
    # if the cache expired or was never populated.
    try:
        cache_key = _clean_url_hash(target_url)
        cached_info_path = os.path.join(TEMP_DIR, f"info_{cache_key}.json")
        if os.path.exists(cached_info_path):
            info_json_path = cached_info_path
            # Keep info JSON around long enough for the longest merge job (30 min timeout).
            background_tasks.add_task(cleanup_file, info_json_path, "", delay=1800)
        else:
            info_json_path = ""
    except Exception:
        info_json_path = ""

    # ── TikWM direct URL: proxy stream via aiohttp (no yt-dlp) ──
    TIKWM_FORMATS = ("no_watermark_hd", "no_watermark", "watermark", "audio_only")
    if target_format in TIKWM_FORMATS and target_direct_url:
        ext = "mp3" if target_is_audio else "mp4"
        base = re.sub(r"\.(mp4|mp3|webm|mkv|m4a)$", "", raw_filename, flags=re.IGNORECASE)
        safe = make_safe_filename(base or "video", ext)
        media_type = "audio/mpeg" if target_is_audio else "video/mp4"

        async def proxy_tikwm():
            local_file = None
            if target_is_dashboard:
                try:
                    downloads_dir = os.path.expanduser("~/Downloads")
                    if os.path.exists(downloads_dir):
                        platform = detect_platform(target_url)
                        dest_dir = os.path.join(downloads_dir, "MediaFetch", platform)
                        os.makedirs(dest_dir, exist_ok=True)
                        dest_path = os.path.join(dest_dir, safe)
                        local_file = open(dest_path, "wb")
                        print(f"[MediaFetch Backend] Saving local dashboard copy to: {dest_path}")
                except Exception as le:
                    print(f"[MediaFetch Backend] Failed to initialize local file write: {le}")

            headers = {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Referer": "https://www.tiktok.com/",
            }
            try:
                async with aiohttp.ClientSession() as session:
                    async with session.get(target_direct_url, headers=headers) as resp:
                        async for chunk in resp.content.iter_chunked(1024 * 1024):
                            if local_file:
                                local_file.write(chunk)
                            yield chunk
            finally:
                if local_file:
                    local_file.close()

        # No Content-Disposition header: the extension supplies the full relative
        # path (Downloads/Media Fetch/<Platform>/file.mp4) via chrome.downloads.download().
        # If the server sends a filename here, Chrome ignores the extension's path.
        return StreamingResponse(
            proxy_tikwm(),
            media_type=media_type,
        )

    ext = "mp3" if target_is_audio else "mp4"

    # Strip extension if the caller already included it (we'll re-add the correct one)
    base = re.sub(r"\.(mp4|mp3|webm|mkv|m4a)$", "", raw_filename, flags=re.IGNORECASE)
    safe_filename = make_safe_filename(base or "video", ext)

    # ── Audio: stream directly to browser (no temp file needed) ──
    if target_is_audio:
        cookies_path = _write_temp_cookies(target_cookies)
        cmd = _stream_audio_cmd(target_url, target_format, info_json_path=info_json_path, cookies_path=cookies_path)

        async def audio_generator():
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
                limit=10 * 1024 * 1024,
            )
            local_file = None
            if target_is_dashboard:
                try:
                    downloads_dir = os.path.expanduser("~/Downloads")
                    if os.path.exists(downloads_dir):
                        platform = detect_platform(target_url)
                        dest_dir = os.path.join(downloads_dir, "MediaFetch", platform)
                        os.makedirs(dest_dir, exist_ok=True)
                        dest_path = os.path.join(dest_dir, safe_filename)
                        local_file = open(dest_path, "wb")
                        print(f"[MediaFetch Backend] Saving local dashboard copy to: {dest_path}")
                except Exception as le:
                    print(f"[MediaFetch Backend] Failed to initialize local file write: {le}")

            try:
                while True:
                    chunk = await proc.stdout.read(2 * 1024 * 1024)
                    if not chunk:
                        break
                    if local_file:
                        local_file.write(chunk)
                    yield chunk
            finally:
                if local_file:
                    local_file.close()
                await proc.wait()
                if cookies_path and os.path.exists(cookies_path):
                    try:
                        os.remove(cookies_path)
                    except Exception:
                        pass

        # No Content-Disposition header so Chrome uses the extension's filename/path.
        return StreamingResponse(
            audio_generator(),
            media_type="audio/mpeg",
        )

    # ── Video ──────────────────────────────────────────────────────────────────
    target_needs_merge = request.needs_merge if request else (needs_merge or False)

    # Use async background download job for all videos (IDM-style parallel download via aria2c to a temp file, then served via FileResponse)
    job_id = uuid.uuid4().hex[:12]
    target_expected_size = (request.expected_size if request else expected_size) or 0
    job = DownloadJob(
        job_id=job_id,
        filename=safe_filename,
        expected_size=target_expected_size,
        url=target_url,
        is_dashboard=target_is_dashboard
    )
    JOBS[job_id] = job

    temp_name = f"{job_id}_{safe_filename}"
    temp_path = os.path.join(TEMP_DIR, temp_name)
    cookies_path = _write_temp_cookies(target_cookies)
    cmd = _download_yt_cmd(
        target_url, 
        target_format, 
        temp_path, 
        height=target_height, 
        needs_merge=target_needs_merge, 
        info_json_path=info_json_path,
        cookies_path=cookies_path
    )

    asyncio.create_task(_run_merge_job(job, cmd, temp_path, cookies_path=cookies_path))

    return {"job_id": job_id, "status": "queued", "filename": safe_filename}


@app.get("/api/download/status/{job_id}")
async def download_status(job_id: str):
    job = JOBS.get(job_id) or SERVED_JOBS.get(job_id)
    if not job:
        return {
            "job_id": job_id,
            "status": "failed",
            "progress": 0,
            "filename": "",
            "error": "Backend was restarted or job was lost",
        }
    return {
        "job_id": job.job_id,
        "status": job.status,
        "progress": job.progress,
        "filename": job.filename,
        "error": job.error,
    }


@app.get("/api/download/file/{job_id}")
async def download_file(job_id: str, background_tasks: BackgroundTasks):
    job = JOBS.get(job_id) or SERVED_JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.status != "ready":
        raise HTTPException(status_code=425, detail=f"Not ready yet: {job.status}")
    if not job.file_path or not os.path.exists(job.file_path):
        raise HTTPException(status_code=500, detail="File missing")

    # Build response BEFORE removing job — if FileResponse fails (e.g. header encoding),
    # the client can retry without getting a 404.
    try:
        # No Content-Disposition header so Chrome uses the extension's filename/path.
        response = FileResponse(
            job.file_path,
            media_type="video/mp4",
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to prepare download: {e}")

    background_tasks.add_task(cleanup_file, job.file_path, job_id)
    # Move to SERVED_JOBS instead of deleting so Chrome retries/resumes work
    JOBS.pop(job_id, None)
    SERVED_JOBS[job_id] = job
    return response



@app.post("/api/download-playlist")
async def download_playlist(
    request: PlaylistDownloadRequest,
):
    playlist_id = uuid.uuid4().hex[:12]
    zip_filename = f"playlist_{playlist_id}.zip"
    
    # Register job
    job = DownloadJob(
        job_id=playlist_id,
        filename=zip_filename,
        expected_size=0,
        url=request.playlist_url,
        is_dashboard=bool(request.is_dashboard)
    )
    JOBS[playlist_id] = job

    # Start async job and immediately return to caller
    asyncio.create_task(_run_playlist_job(job, playlist_id, request))
    return {"job_id": playlist_id, "status": "queued", "filename": zip_filename}


async def _run_playlist_job(job: DownloadJob, playlist_id: str, request: PlaylistDownloadRequest):
    playlist_folder = os.path.join(TEMP_DIR, f"playlist_{playlist_id}")
    os.makedirs(playlist_folder, exist_ok=True)

    # Apply limit if specified
    video_urls = request.video_urls
    if request.limit and request.limit > 0:
        video_urls = video_urls[:request.limit]
        job.filename = job.filename.replace('.zip', f'_first{request.limit}.zip')

    is_audio_only = request.quality == "audio"

    if is_audio_only:
        fmt_selector = "bestaudio/best"
    elif request.quality == "best":
        fmt_selector = "bestvideo+bestaudio/best"
    else:
        try:
            q = int(request.quality.replace("p", ""))
            fmt_selector = f"bestvideo[height<={q}]+bestaudio/bestvideo[height<={q}]/best"
        except ValueError:
            fmt_selector = "bestvideo+bestaudio/best"

    job.status = "downloading"
    total_videos = len(video_urls)
    completed_videos = 0

    async def download_one(idx: int, video_url: str) -> Optional[str]:
        nonlocal completed_videos
        try:
            out_path = os.path.join(playlist_folder, f"{idx:03d}_video.%(ext)s")
            cmd = [
                YTDLP_BIN, "--no-warnings", "--no-playlist", "--no-check-formats"
            ]
            ffmpeg_path = _get_ffmpeg()
            if ffmpeg_path:
                cmd.extend(["--ffmpeg-location", ffmpeg_path])
            if is_audio_only:
                cmd.extend(["-f", "bestaudio/best", "--extract-audio", "--audio-format", "mp3", "--audio-quality", "0", "-o", out_path, video_url])
            else:
                cmd.extend(["-f", fmt_selector, "--merge-output-format", "mp4", "-o", out_path, video_url])

            proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
            try:
                _, stderr = await asyncio.wait_for(proc.communicate(), timeout=600)  # Max 10 minutes per video
            except asyncio.TimeoutError:
                proc.kill()
                return None

            for f in os.listdir(playlist_folder):
                if f.startswith(f"{idx:03d}_video"):
                    return os.path.join(playlist_folder, f)
            return None
        except Exception:
            return None
        finally:
            completed_videos += 1
            if total_videos > 0:
                job.progress = int((completed_videos / total_videos) * 95)  # Max 95% until zipped

    semaphore = asyncio.Semaphore(4)
    async def bounded(idx, url):
        async with semaphore:
            return await download_one(idx, url)

    results = await asyncio.gather(*[bounded(idx, url) for idx, url in enumerate(video_urls, 1)])
    downloaded_files = [r for r in results if r]

    if not downloaded_files:
        job.status = "failed"
        job.error = "No videos downloaded successfully"
        shutil.rmtree(playlist_folder, ignore_errors=True)
        return

    job.status = "merging"  # Use merging status for zipping
    zip_path = os.path.join(TEMP_DIR, job.filename)

    try:
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for fp in downloaded_files:
                zf.write(fp, os.path.basename(fp))
        job.file_path = zip_path
        job.status = "ready"
        job.progress = 100
        if job.is_dashboard:
            save_to_local_downloads(zip_path, job.url, job.filename)
    except Exception as e:
        job.status = "failed"
        job.error = f"Zipping failed: {e}"
    finally:
        shutil.rmtree(playlist_folder, ignore_errors=True)



# Serve web dashboard at root
_WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web")
if os.path.isdir(_WEB_DIR):
    app.mount("/", StaticFiles(directory=_WEB_DIR, html=True), name="web")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
