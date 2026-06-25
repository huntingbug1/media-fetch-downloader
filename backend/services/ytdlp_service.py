import json
import asyncio
import os
import shutil
from typing import Dict, List, Optional, Any, Union
from pydantic import BaseModel

class VideoFormat(BaseModel):
    format_id: str
    extension: str
    quality: str
    resolution: Optional[int] = 0
    filesize_approx: Optional[int] = 0
    vcodec: str
    acodec: str
    fps: Optional[int] = 0
    width: Optional[int] = 0
    height: Optional[int] = 0
    is_video: bool
    is_audio: bool
    needs_merge: bool = False
    container: str = "mp4"
    url: Optional[str] = None

class VideoMetadata(BaseModel):
    _type: str = "video"
    id: str
    title: str
    duration: Optional[float] = 0
    thumbnail: str
    formats: List[VideoFormat]
    original_url: str
    ffmpeg_available: bool

class PlaylistEntry(BaseModel):
    id: Optional[str] = ""
    title: Optional[str] = "Unknown Title"
    url: Optional[str] = ""
    duration: Optional[float] = 0
    thumbnail: Optional[str] = ""

class PlaylistMetadata(BaseModel):
    _type: str = "playlist"
    id: str
    title: str
    entries: List[PlaylistEntry]
    original_url: str
    ffmpeg_available: bool

import re
import aiohttp
import sys

# Use the venv yt-dlp which has yt-dlp-ejs 0.8.0 (fixes Deno JS challenge crash).
# The venv binary is 2026.03.17 vs system 2026.02.21 which lacks the fix.
_HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # backend/
_VENV_YTDLP = os.path.join(_HERE, "venv", "bin", "yt-dlp")
YTDLP_BIN = _VENV_YTDLP if os.path.exists(_VENV_YTDLP) else "yt-dlp"

class YTDLPService:
    @staticmethod
    def is_ffmpeg_available() -> bool:
        return shutil.which("ffmpeg") is not None

    @staticmethod
    async def get_metadata(url: str, retries: int = 3, cookies_path: str = "") -> Dict[str, Any]:
        """
        Extracts metadata with retries for stability.
        Prioritizes TikWM for TikTok to get no-watermark links.
        Supports both single videos and playlists for other platforms.
        """
        print(f"[MediaFetch Backend] get_metadata called with URL: {url} (cookies: {'yes' if cookies_path else 'no'})")
        last_error = None
        for attempt in range(retries):
            try:
                # Improved playlist detection: only treat as playlist if it's a dedicated playlist URL
                # and NOT a single video that happens to be inside a playlist.
                is_playlist_url = ('list=' in url and 'watch?v=' not in url) or ('/playlist?' in url) or ('/channel/' in url and '/videos' in url)
                is_tiktok = 'tiktok.com' in url

                if is_tiktok:
                    try:
                        return await YTDLPService.tiktok_tikwm_fetch(url)
                    except Exception as e:
                        print(f"TikWM fetch failed (attempt {attempt+1}), trying yt-dlp: {str(e)}")

                is_youtube = 'youtube.com' in url or 'youtu.be' in url

                is_instagram = 'instagram.com' in url

                # Base command
                cmd = [
                    YTDLP_BIN,
                    "--dump-json",
                    "--no-warnings",
                    "--no-check-formats",
                    "--socket-timeout", "30",
                    "--retries", "2",
                    "--no-playlist" if not is_playlist_url else "--yes-playlist",
                    "--flat-playlist" if is_playlist_url else "--no-flat-playlist",
                    "--no-check-certificate", # Prevent SSL verification hangs
                    "--geo-bypass",          # Bypass regional blocks
                ]

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
                        "--add-header", "Accept-Language:en-US,en;q=0.9",
                    ])

                if cookies_path and os.path.exists(cookies_path):
                    cmd.extend(["--cookies", cookies_path])
                cmd.append(url)

                process = await asyncio.create_subprocess_exec(
                    *cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE
                )

                # Hard 90s timeout — allows time for ejs:github challenge solver download
                try:
                    stdout, stderr = await asyncio.wait_for(
                        process.communicate(), timeout=90
                    )
                except asyncio.TimeoutError:
                    process.kill()
                    raise Exception("Request timed out (90s). YouTube may be rate-limiting. Try again.")

                if process.returncode != 0:
                    error_msg = stderr.decode()
                    print(f"yt-dlp error output: {error_msg}")
                    if "Sign in to confirm your age" in error_msg:
                        raise Exception("Age restricted content requires login")
                    if "Sign in to confirm" in error_msg or "not a bot" in error_msg:
                        if attempt < retries - 1:
                            print("Bot detection hit, retrying...")
                            continue
                        raise Exception(
                            "YouTube blocked the request (bot detection). "
                            "Please try again in a few minutes, or sign into YouTube in Chrome."
                        )
                    if "HTTP Error 429" in error_msg:
                        raise Exception("YouTube rate limit hit. Please wait a minute and try again.")
                    raise Exception(f"yt-dlp error: {error_msg[:300]}")

                # Parse JSON output (handle both single object and NDJSON)
                results = []
                output_str = stdout.decode().strip()
                if not output_str:
                    raise Exception("Empty output from yt-dlp — YouTube may have blocked the request. Try again.")

                try:
                    # Try single JSON first
                    results.append(json.loads(output_str))
                except json.JSONDecodeError:
                    # Try NDJSON (multiple lines of JSON)
                    lines = [line for line in output_str.split('\n') if line.strip()]
                    for line in lines:
                        try:
                            results.append(json.loads(line))
                        except:
                            continue

                if not results:
                    raise Exception("Could not parse JSON from yt-dlp output")

                # Playlist Logic
                if is_playlist_url:
                    for obj in results:
                        if obj.get('_type') == 'playlist':
                            return obj
                    return YTDLPService._construct_synthetic_playlist(results, url)

                # Single Video Logic
                return results[0]

            except Exception as e:
                last_error = e
                print(f"Metadata fetch attempt {attempt+1} failed: {str(e)}")
                if attempt < retries - 1:
                    await asyncio.sleep(2)
                    
        if not last_error:
            last_error = Exception("Extraction failed: YouTube blocked the request or returned no data.")
        raise last_error

    @staticmethod
    def _construct_synthetic_playlist(entries: List[Dict], url: str) -> Dict[str, Any]:
        if not entries:
            raise Exception("No entries to construct playlist")
            
        first_entry = entries[0]
        # Try to find common playlist metadata from first entry
        playlist_title = first_entry.get('playlist_title') or first_entry.get('title') or "Playlist"
        playlist_id = first_entry.get('playlist_id') or first_entry.get('playlist') or "unknown_id"
        
        return {
            "_type": "playlist",
            "id": playlist_id,
            "title": playlist_title,
            "entries": entries,
            "original_url": url,
            "ffmpeg_available": YTDLPService.is_ffmpeg_available()
        }


    @staticmethod
    async def tiktok_tikwm_fetch(url: str) -> Dict[str, Any]:
        """
        Fetches TikTok metadata from TikWM API with HD support.
        Passes hd=1 to get 1080p+ stream via hdplay.
        """
        async with aiohttp.ClientSession() as session:
            async with session.post("https://www.tikwm.com/api/", data={"url": url, "hd": "1"}) as resp:
                if resp.status != 200:
                    raise Exception(f"TikWM API HTTP {resp.status}")
                result = await resp.json()
                if result.get("code") != 0:
                    raise Exception(f"TikWM API Error: {result.get('msg')}")
                
                data = result["data"]
                formats = []
                
                # 1080p HD (no watermark) — from hdplay
                if data.get("hdplay"):
                    formats.append({
                        "format_id": "no_watermark_hd",
                        "url": data["hdplay"],
                        "ext": "mp4",
                        "vcodec": "h264",
                        "acodec": "aac",
                        "width": 1080,
                        "height": 1920,
                        "resolution": 1080,
                        "format_note": "1080p No Watermark",
                        "quality_label": "1080p",
                        "filesize": data.get("hd_size", 0),
                    })
                
                # 720p (no watermark) — from play
                if data.get("play"):
                    formats.append({
                        "format_id": "no_watermark",
                        "url": data["play"],
                        "ext": "mp4",
                        "vcodec": "h264",
                        "acodec": "aac",
                        "width": 720,
                        "height": 1280,
                        "resolution": 720,
                        "format_note": "720p No Watermark",
                        "quality_label": "720p",
                        "filesize": data.get("size", 0),
                    })
                
                # SD with watermark
                if data.get("wmplay"):
                    formats.append({
                        "format_id": "watermark",
                        "url": data["wmplay"],
                        "ext": "mp4",
                        "vcodec": "h264",
                        "acodec": "aac",
                        "width": 576,
                        "height": 1024,
                        "resolution": 576,
                        "format_note": "SD With Watermark",
                        "quality_label": "SD",
                    })
                
                # Audio only
                if data.get("music"):
                    formats.append({
                        "format_id": "audio_only",
                        "url": data["music"],
                        "ext": "mp3",
                        "vcodec": "none",
                        "acodec": "mp3",
                        "format_note": "Audio Only",
                        "quality_label": "Audio",
                    })
                
                return {
                    "id": data.get("id", ""),
                    "title": data.get("title", "TikTok Video"),
                    "duration": data.get("duration", 0),
                    "thumbnail": data.get("cover", "") or data.get("origin_cover", ""),
                    "webpage_url": url,
                    "_is_tikwm": True,
                    "formats": formats
                }

    @staticmethod
    async def tiktok_fallback_scrape(url: str) -> Dict[str, Any]:
        """
        Manually scrapes TikTok page for the __UNIVERSAL_DATA_FOR_REHYDRATION__ JSON.
        Uses a deep-search approach to find media URLs regardless of page structure.
        """
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
        }
        
        async with aiohttp.ClientSession(headers=headers) as session:
            try:
                async with session.get(url, timeout=10) as response:
                    if response.status != 200:
                        raise Exception(f"HTTP {response.status}")
                    html = await response.text()
            except Exception as e:
                raise Exception(f"Request failed: {str(e)}")
                
        # Find the script tag containing rehydration data - more flexible regex
        match = re.search(r'<script[^>]+id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>(.*?)</script>', html, re.DOTALL)
        if not match:
             match = re.search(r'<script[^>]+type="application/json"[^>]*id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>(.*?)</script>', html, re.DOTALL)
        
        if not match:
            # Plan B: Try to find SIGI_STATE or other large JSON blobs
            match = re.search(r'<script id="SIGI_STATE" type="application/json">(.*?)</script>', html, re.DOTALL)
            
        if not match:
            raise Exception("Could not find rehydration data (Universal Data or SIGI)")
        
        try:
            data = json.loads(match.group(1))
            
            # Deep search helper to find playAddr/downloadAddr
            def deep_find(obj, keys):
                if not isinstance(obj, (dict, list)):
                    return None
                if isinstance(obj, list):
                    for item in obj:
                        res = deep_find(item, keys)
                        if res: return res
                    return None
                
                # Check keys in current dict
                for k in keys:
                    if k in obj and isinstance(obj[k], str) and obj[k].startswith('http'):
                        return obj[k]
                
                # Recurse
                for v in obj.values():
                    res = deep_find(v, keys)
                    if res: return res
                return None

            play_addr = deep_find(data, ["playAddr", "downloadAddr", "originAddr"])
            
            # Find video title/desc
            def find_val(obj, key):
                if not isinstance(obj, (dict, list)): return None
                if isinstance(obj, list):
                    for i in obj:
                        res = find_val(i, key)
                        if res: return res
                    return None
                if key in obj: return obj[key]
                for v in obj.values():
                    res = find_val(v, key)
                    if res: return res
                return None

            desc = find_val(data, "desc") or "TikTok Video"
            id_val = find_val(data, "id") or "tiktok_video"
            cover = find_val(data, "cover") or ""
            duration = find_val(data, "duration") or 0

            if not play_addr:
                raise Exception("Media URL not found in JSON data")
            
            return {
                "id": id_val,
                "title": desc,
                "duration": duration,
                "thumbnail": cover,
                "webpage_url": url,
                "formats": [
                    {
                        "format_id": "direct",
                        "url": play_addr,
                        "ext": "mp4",
                        "vcodec": "h264",
                        "acodec": "aac",
                        "format_note": "No Watermark (Direct)",
                        "quality_label": "HD"
                    }
                ]
            }
        except Exception as e:
            raise Exception(f"JSON parsing/search failed: {str(e)}")

    @staticmethod
    async def get_metadata_single(url: str) -> Dict[str, Any]:
        cmd = [YTDLP_BIN, "--dump-json", "--no-warnings", "--skip-download", "--no-playlist", url]
        process = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        stdout, _ = await process.communicate()
        return json.loads(stdout.decode())

    @staticmethod
    def process_metadata(raw_data: Union[Dict[str, Any], List[Dict[str, Any]]]) -> Union[VideoMetadata, PlaylistMetadata]:
        if not raw_data:
            raise Exception("No metadata returned from extraction")

        if isinstance(raw_data, list):
            if not raw_data:
                raise Exception("Metadata list is empty")
            first = raw_data[0]
            if not first:
                raise Exception("First metadata entry is null")
            if first.get('_type') == 'playlist' or 'entries' in first:
                main_obj = first
                entries = main_obj.get('entries', [])
            else:
                entries = raw_data
                main_obj = {'id': 'playlist', 'title': 'YouTube Playlist', 'webpage_url': ''}

            processed_entries = []
            for entry in entries:
                if not entry:
                    continue
                processed_entries.append(PlaylistEntry(
                    id=entry.get('id') or '',
                    title=entry.get('title') or 'Unknown Title',
                    url=entry.get('url') or f"https://www.youtube.com/watch?v={entry.get('id') or ''}",
                    duration=entry.get('duration') or 0,
                    thumbnail=entry.get('thumbnail') or ''
                ))
            
            return PlaylistMetadata(
                id=main_obj.get('id') or 'playlist',
                title=main_obj.get('title') or 'YouTube Playlist',
                entries=processed_entries,
                original_url=main_obj.get('webpage_url') or '',
                ffmpeg_available=YTDLPService.is_ffmpeg_available()
            )

        if not isinstance(raw_data, dict):
             raise Exception(f"Expected dict metadata, got {type(raw_data)}")

        if raw_data.get('_is_tikwm'):
            # TikWM formats — read actual resolution/size values
            formats_list = []
            for f in raw_data.get('formats', []):
                is_audio_only = f.get('vcodec') == 'none' or f.get('format_id') == 'audio_only'
                formats_list.append(VideoFormat(
                    format_id=str(f.get('format_id')),
                    extension=f.get('ext', 'mp4'),
                    quality=f.get('quality_label', 'HD'),
                    resolution=f.get('resolution', 0) or f.get('height', 0),
                    filesize_approx=f.get('filesize', 0) or f.get('filesize_approx', 0),
                    vcodec=f.get('vcodec', 'h264'),
                    acodec=f.get('acodec', 'aac'),
                    fps=f.get('fps', 0),
                    width=f.get('width', 0),
                    height=f.get('height', 0),
                    is_video=not is_audio_only,
                    is_audio=True,
                    needs_merge=False,
                    container=f.get('ext', 'mp4'),
                    url=f.get('url')
                ))
            
            return VideoMetadata(
                id=raw_data.get('id', ''),
                title=raw_data.get('title', 'TikTok Video'),
                duration=raw_data.get('duration', 0),
                thumbnail=raw_data.get('thumbnail', ''),
                formats=formats_list,
                original_url=raw_data.get('webpage_url', ''),
                ffmpeg_available=YTDLPService.is_ffmpeg_available()
            )

        if raw_data.get('_type') == 'playlist':
            return YTDLPService.process_metadata([raw_data])

        formats_list = []
        raw_formats = raw_data.get('formats') or []
        best_audio_size = 0
        for f in raw_formats:
            if not f: continue
            if f.get('vcodec') == 'none' and f.get('acodec') != 'none':
                size = f.get('filesize') or f.get('filesize_approx') or 0
                if size > best_audio_size:
                    best_audio_size = size

        for f in raw_formats:
            if not f: continue
            if 'storyboard' in (f.get('format_note') or '').lower() or (f.get('acodec') == 'none' and (f.get('vcodec') or 'none') == 'none'):
                continue
            vcodec = f.get('vcodec') or 'none'
            acodec = f.get('acodec') or 'none'
            is_video = vcodec != 'none'
            is_audio = acodec != 'none'
            needs_merge = is_video and not is_audio
            height = f.get('height') or 0
            quality_label = f.get('format_note') or f.get('quality_label') or (f"{height}p" if height else "unknown")
            filesize = (f.get('filesize') or f.get('filesize_approx') or 0)
            if needs_merge:
                filesize += best_audio_size

            formats_list.append(VideoFormat(
                format_id=str(f.get('format_id') or ''),
                extension=f.get('ext') or 'mp4',
                quality=str(quality_label),
                resolution=int(height),
                filesize_approx=int(filesize),
                vcodec=str(vcodec),
                acodec=str(acodec),
                fps=int(f.get('fps') or 0),
                width=int(f.get('width') or 0),
                height=int(height),
                is_video=is_video,
                is_audio=is_audio,
                needs_merge=needs_merge,
                container=f.get('ext') or 'mp4',
                url=f.get('url')
            ))
            
        thumbnail = raw_data.get('thumbnail') or ''
        thumbnails = raw_data.get('thumbnails')
        if not thumbnail and thumbnails and isinstance(thumbnails, list) and len(thumbnails) > 0:
            last_thumb = thumbnails[-1]
            if isinstance(last_thumb, dict):
                thumbnail = last_thumb.get('url') or ''
            elif isinstance(last_thumb, str):
                thumbnail = last_thumb

        return VideoMetadata(
            id=raw_data.get('id', ''),
            title=raw_data.get('title', 'Unknown Video'),
            duration=raw_data.get('duration', 0),
            thumbnail=thumbnail,
            formats=formats_list,
            original_url=raw_data.get('webpage_url', ''),
            ffmpeg_available=YTDLPService.is_ffmpeg_available()
        )

    @staticmethod
    def get_streaming_command(url: str, format_id: str, is_audio: bool = False) -> List[str]:
        """
        Generates the streaming command for direct output to stdout.
        """
        # Handle TikWM/Direct links where the format selection is already done
        if format_id in ["no_watermark", "watermark", "direct"]:
            return [
                YTDLP_BIN,
                "--no-warnings",
                "--no-playlist",
                "--buffer-size", "1024K",
                "-o", "-",
                url
            ]

        is_tiktok = 'tiktok.com' in url
        is_youtube = 'youtube.com' in url or 'youtu.be' in url

        cmd = [
            YTDLP_BIN,
            "--no-warnings",
            "--no-playlist",
            "--concurrent-fragments", "32",
            "--buffer-size", "1024K",
            "--http-chunk-size", "10M",
            "--no-mtime",
            "-o", "-",
        ]

        if is_tiktok:
            cmd.extend([
                "--extractor-args", "tiktok:api_hostname=api16-normal-c-useast1a.tiktokv.com",
                "--add-header", "Referer:https://www.tiktok.com/",
                "--add-header", "Origin:https://www.tiktok.com",
                "--user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            ])
        elif is_youtube or 'instagram.com' in url:
            pass


        if is_audio:
            cmd.extend([
                "-f", "bestaudio/best",
                "--extract-audio",
                "--audio-format", "mp3",
                "--audio-quality", "0",
            ])
        else:
            # Smart fallback: exact format first, then best video+audio, then best overall
            cmd.extend(["-f", f"{format_id}+bestaudio/bestvideo+bestaudio/best"])
            cmd.extend(["--merge-output-format", "mp4"])

        cmd.append(url)
        return cmd

    @staticmethod
    def get_file_command(url: str, format_id: str, output_path: str) -> List[str]:
        """
        Generates yt-dlp command that downloads to a real file (for merging via ffmpeg).
        Used for video downloads that need proper mp4 muxing.
        """
        is_tiktok = 'tiktok.com' in url

        # For direct TikWM URLs, just download the file directly
        if format_id in ["no_watermark", "watermark", "direct"]:
            return [
                YTDLP_BIN,
                "--no-warnings",
                "--no-playlist",
                "-o", output_path,
                url
            ]

        cmd = [
            YTDLP_BIN,
            "--no-warnings",
            "--no-playlist",
            "--concurrent-fragments", "16",
            "--buffer-size", "1024K",
            "--no-mtime",
            "--merge-output-format", "mp4",
            "-o", output_path,
        ]

        if is_tiktok:
            cmd.extend([
                "--extractor-args", "tiktok:api_hostname=api16-normal-c-useast1a.tiktokv.com",
                "--add-header", "Referer:https://www.tiktok.com/",
                "--add-header", "Origin:https://www.tiktok.com",
                "--user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            ])
        elif 'youtube.com' in url or 'youtu.be' in url or 'instagram.com' in url:
            pass

        cmd.extend(["-f", f"{format_id}+bestaudio/bestvideo+bestaudio/best"])
        cmd.append(url)
        return cmd
