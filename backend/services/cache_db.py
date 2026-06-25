import os
import sqlite3
import json
import time
import hashlib
import urllib.parse
from typing import Optional, Dict

# The DB file will be stored in the temp_downloads folder to remain temporary
DB_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "temp_downloads")
DB_PATH = os.path.join(DB_DIR, "media_fetch_cache.db")

def _clean_url_hash(url: str) -> str:
    """Generate stable URL hash for lookup."""
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
            ""
        ))
        return hashlib.md5(clean_url.encode('utf-8')).hexdigest()
    except Exception:
        return hashlib.md5(url.encode('utf-8')).hexdigest()

def init_db():
    """Create DB directory, cache file, and table."""
    os.makedirs(DB_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    try:
        cursor = conn.cursor()
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS video_cache (
                url_hash TEXT PRIMARY KEY,
                url TEXT NOT NULL,
                metadata_json TEXT NOT NULL,
                created_at REAL NOT NULL
            )
        """)
        conn.commit()
    finally:
        conn.close()

def get_cached_metadata(url: str) -> Optional[Dict]:
    """Retrieve metadata from cache if present and less than 12 hours old."""
    if not url:
        return None
    url_hash = _clean_url_hash(url)
    cutoff = time.time() - 43200  # 12 hours
    
    conn = sqlite3.connect(DB_PATH)
    try:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT metadata_json, created_at FROM video_cache WHERE url_hash = ?",
            (url_hash,)
        )
        row = cursor.fetchone()
        if row:
            metadata_json, created_at = row
            if created_at >= cutoff:
                try:
                    return json.loads(metadata_json)
                except Exception:
                    pass
            # If expired or corrupted, delete it
            cursor.execute("DELETE FROM video_cache WHERE url_hash = ?", (url_hash,))
            conn.commit()
    except Exception as e:
        print(f"[MediaFetch Cache] get_cached_metadata error: {e}")
    finally:
        conn.close()
    return None

def save_metadata(url: str, raw_metadata: dict):
    """Save metadata JSON to database with current timestamp."""
    if not url or not raw_metadata:
        return
    url_hash = _clean_url_hash(url)
    try:
        metadata_json = json.dumps(raw_metadata, ensure_ascii=False)
    except Exception as e:
        print(f"[MediaFetch Cache] json serialization failed: {e}")
        return

    conn = sqlite3.connect(DB_PATH)
    try:
        cursor = conn.cursor()
        cursor.execute(
            "INSERT OR REPLACE INTO video_cache (url_hash, url, metadata_json, created_at) VALUES (?, ?, ?, ?)",
            (url_hash, url, metadata_json, time.time())
        )
        conn.commit()
    except Exception as e:
        print(f"[MediaFetch Cache] save_metadata error: {e}")
    finally:
        conn.close()

def prune_expired():
    """Delete database entries older than 12 hours."""
    cutoff = time.time() - 43200
    conn = sqlite3.connect(DB_PATH)
    try:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM video_cache WHERE created_at < ?", (cutoff,))
        conn.commit()
        print(f"[MediaFetch Cache] Pruned expired entries from SQLite cache.")
    except Exception as e:
        print(f"[MediaFetch Cache] prune_expired error: {e}")
    finally:
        conn.close()
