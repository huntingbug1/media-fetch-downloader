# Download Animation & Progress Sync Specification

> This document describes the complete download lifecycle, UI animation states, and backend↔extension sync protocol for MediaFetch.

---

## 1. Download Lifecycle Overview

Every download flows through a deterministic state machine. The backend owns the truth; the extension reflects it.

```
┌─────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────┐    ┌────────┐
│ queued  │───▶│ downloading │───▶│   merging   │───▶│  ready  │───▶│  done  │
└─────────┘    └─────────────┘    └─────────────┘    └─────────┘    └────────┘
      │               │                  │                  │
      ▼               ▼                  ▼                  ▼
   [waiting]    [bytes flowing]    [ffmpeg muxing]   [file served]
```

**Failed** can happen from any state:
- `queued` → `failed`: Backend rejected parameters or URL is dead
- `downloading` → `failed`: Network cut, CDN 403, yt-dlp fatal error
- `merging` → `failed`: ffmpeg crash, disk full, temp file missing
- `ready` → `failed`: Browser download interrupted, backend restarted before FileResponse

---

## 2. Two Download Paths

### 2.1 Direct Stream (360p, audio, pre-muxed formats)
- Backend spawns `yt-dlp -o -` and pipes stdout directly to `StreamingResponse`
- Chrome receives a chunked HTTP stream with **no Content-Length**
- Extension uses `chrome.downloads.download()` → browser writes to disk progressively
- **Progress is INDETERMINATE** — Chrome knows bytes received but not total size

### 2.2 Merge Job (1080p, 4K, video+audio separate tracks)
- Backend spawns async subprocess: `yt-dlp -f bestvideo+bestaudio` + ffmpeg mux to temp file
- Job stored in in-memory `JOBS` dict with `status` + `progress` fields
- Extension polls `/api/download/status/{job_id}` every 2s
- When `status === "ready"`, extension requests `/api/download/file/{job_id}` → `FileResponse`
- Backend cleans up temp file after successful serve

---

## 3. Progress Sync Protocol

### 3.1 Backend → Extension (Merge Jobs)

**Endpoint:** `GET /api/download/status/{job_id}`

```json
{
  "job_id": "9a2b46d8c8b4",
  "status": "downloading",
  "progress": 67,
  "filename": "video.mp4",
  "error": null
}
```

| Status    | progress range | Meaning |
|-----------|----------------|---------|
| `queued`  | 0              | Subprocess not yet started |
| `downloading` | 0–95       | yt-dlp downloading + muxing |
| `merging` | 90–95          | ffmpeg final mux (short phase) |
| `ready`   | 100            | Temp file complete, ready for download |
| `failed`  | 0              | `error` field contains reason |

**Polling cadence:** Background script polls every 2000ms. Popup polls every 1500ms for redundancy (race-protected via `handledJobs` Set + `_mergeHandedOff` flag).

### 3.2 Chrome API → Extension (Direct Streams)

For direct streams there is **no backend polling**. Progress comes from Chrome's native download API:

```javascript
chrome.downloads.search({ id: downloadId }, items => {
  const dl = items[0];
  // dl.bytesReceived  → bytes written to disk so far
  // dl.totalBytes     → 0 if Content-Length unknown (indeterminate)
  // dl.state          → "in_progress" | "complete" | "interrupted"
});
```

**Polling cadence:** `setInterval` every 1000ms via `trackDownloadSpeed()`.

---

## 4. UI Animation States

### 4.1 Progress Bar Rendering Rules

| State | CSS class | Width | Animation |
|-------|-----------|-------|-----------|
| `queued` | — | 0% | None (static) |
| `downloading` (known size) | `dl-shimmer` | `bytesReceived/totalBytes × 100` | Shimmer gradient slides across bar |
| `downloading` (unknown size) | `dl-shimmer dl-indeterminate` | 100% | Full-width pulsing shimmer — indicates bytes are flowing but total is unknown |
| `merging` | `dl-shimmer` | 90–95% | Fast shimmer — signals final mux |
| `paused` | — | last known % | Static, no shimmer |
| `ready` → browser download | `dl-shimmer` | 95% → 100% | Shimmer until Chrome fires `onChanged` complete |
| `done` | — | 100% | Static green |
| `failed` | — | 0% or last known | Static red |

### 4.2 Status Text Format

| State | Text | Example |
|-------|------|---------|
| `queued` | ⏳ Queued | — |
| `downloading` known | ⬇ `{progress}%` · `{speed}` | ⬇ 67% · 2.4 MB/s |
| `downloading` indeterminate | ⬇ Downloading… · `{speed}` | ⬇ Downloading… · 1.8 MB/s |
| `merging` | ⚡ Merging… `{progress}%` | ⚡ Merging… 92% |
| `paused` | ⏸ `{progress}%` paused | ⏸ 45% paused |
| `done` | ✅ Done | — |
| `failed` | ❌ `{error}` | ❌ Backend restarted — pl… |

### 4.3 Speed Calculation

```javascript
// trackDownloadSpeed() in background.js
const elapsed = (now - prevTime) / 1000;        // seconds
const bytesDiff = dl.bytesReceived - prevBytes;  // bytes since last tick
const speed = elapsed > 0 ? bytesDiff / elapsed : 0;
```

**Formatter:**
- `< 1 KB/s` → `"Starting…"` (first tick or stalled)
- `< 1 MB/s` → `"{KB} KB/s"`
- `≥ 1 MB/s` → `"{MB} MB/s"` (1 decimal)

---

## 5. Indeterminate Progress (The "0% Stuck" Fix)

**Problem:** Direct streams often have `Content-Length: chunked` (no total size). Chrome's `dl.totalBytes === 0`, so naive math `bytesReceived / 0` yields `0%` forever even though data is flowing at full speed.

**Solution:**

```javascript
let progress;
if (dl.totalBytes > 0) {
    progress = Math.round(dl.bytesReceived / dl.totalBytes * 100);
} else if (dl.bytesReceived > 0) {
    progress = -1; // sentinel: indeterminate
} else {
    progress = 0;  // truly at start
}
```

**Rendering:**
- `progress === -1` → render full-width bar (`width: 100%`) + `dl-indeterminate` class
- Popup shows `"Downloading…"` instead of `"0%"`
- Speed still updates live so user knows data is moving

---

## 6. Merge Job Handoff Sequence

This is the most complex flow. Two actors (popup + background script) can see `ready` simultaneously. Race protection is mandatory.

```
Popup                          Background Script (SW)
───                            ──────────────────────
startDownload()
  └─► fetch /api/download → {job_id}
  └─► sendMessage POLL_MERGE_JOB ────────────────▶
                                                   pollMergeJob()
                                                   └─► fetch status every 2s

pollActiveDownloads()                              ...
  └─► fetch status every 1.5s                      ...
      sees "ready"                                 sees "ready"
      sets dl._mergeHandedOff = true               checks handledJobs.has(jobId)
      sends POLL_MERGE_JOB ────────▶               already has → NO-OP
      (redundant but harmless)                     
                                                   chrome.downloads.download()
                                                   trackDownloadSpeed()
```

**Why it works:**
1. `handledJobs` (Set in background.js) → prevents duplicate polling loops
2. `dl._mergeHandedOff` (flag in popup.js) → prevents duplicate `POLL_MERGE_JOB` messages
3. Both guards are required because MV3 Service Worker can terminate and restart, losing `handledJobs` but preserving `dl._mergeHandedOff` in storage

---

## 7. Pause / Resume / Cancel

### 7.1 Scope
Pause/resume **only works for downloads that have a Chrome native `downloadId`**:
- ✅ Direct streams — yes, Chrome native download is active
- ✅ Merge jobs AFTER `/api/download/file/` handoff — yes, Chrome is downloading the finished file
- ❌ Merge jobs in `queued` / `downloading` / `merging` — no native download exists yet; only **Cancel** is shown

### 7.2 State Persistence
- `downloadId → dlId` mapping stored in `chrome.storage.local` as `native_to_dl_${downloadId}`
- If Service Worker restarts, `chrome.downloads.onChanged` restores mapping from storage
- Speed tracker restarts automatically on resume

### 7.3 Cancel Behavior
| Phase | Action |
|-------|--------|
| Chrome download active | `chrome.downloads.cancel(downloadId)` + mark failed |
| Backend merge running | Popup stops polling; backend temp file cleaned up on next `download_file()` call or process exit |

---

## 8. Backend Restart Recovery

**Scenario:** Backend crashes or is restarted while merge jobs are in-flight.

**Detection:**
```javascript
// Popup polling loop
const s = await fetch(`/api/download/status/${dl.jobId}`);
if (s.status === 'failed' && s.error?.includes('restarted')) {
    // Job is gone from in-memory JOBS dict
    // File may or may not exist on disk
}
```

**Behavior:**
1. Popup marks download as `failed` with error `"Backend restarted — please retry"`
2. Clears `jobId` so polling stops
3. Does NOT auto-retry (URL + format_id not stored in download entry)
4. User must manually retry from Video tab

**Cleanup:** On popup init, any download with `status === 'failed' && error.includes('restarted')` is auto-removed from history so stale errors don't clutter the UI.

---

## 9. Playlist Bulk Downloads

Playlists follow the same state machine but with different progress semantics:

| Phase | Backend progress | UI text |
|-------|------------------|---------|
| Downloading N videos | `completed / total × 95` | ⬇ `{progress}%` · `{N}/{total} videos` |
| Zipping | 95% | ⚡ Zipping… |
| Ready | 100% | ⬇ 95% → triggers file download |
| File download | Chrome API | ⬇ 95% → 100% |

**Limit selector:** User can choose `All / First 10 / 25 / 50 / 100`. Client-side slices the entries array; backend also respects `limit` parameter for defense-in-depth. ZIP filename reflects limit: `Playlist_first10.zip`.

---

## 10. Animation CSS Reference

```css
@keyframes dl-shimmer {
    0%   { background-position: 200% 0; }
    100% { background-position: -200% 0; }
}

.dl-progress-fill {
    height: 100%;
    background: linear-gradient(90deg, #14b8a6, #0ea5e9, #14b8a6);
    background-size: 200% 100%;
    animation: dl-shimmer 1.2s linear infinite;
    transition: width 0.4s ease;
}

.dl-indeterminate {
    width: 100% !important;
}
```

---

## 11. Quick Reference: Who Owns What

| Concern | Owner | Storage |
|---------|-------|---------|
| Job status truth | Backend | In-memory `JOBS` dict |
| Merge job polling | Background script | `handledJobs` Set (volatile) |
| Download progress | Background script | `dl_status_${dlId}` in `chrome.storage.local` |
| Native download mapping | Background script | `native_to_dl_${downloadId}` in `chrome.storage.local` |
| Speed tracking | Background script | `dlIdToProgressTimer` Map (volatile) |
| UI render | Popup | Reads from `chrome.storage.local` every 1.5s |
| Download history | Popup | `downloads` array in `chrome.storage.local` |

---

## 12. Common Issues & Diagnosis

| Symptom | Cause | Fix |
|---------|-------|-----|
| Stuck at 0% with speed showing | Direct stream, `totalBytes === 0` | Expected — shows indeterminate animation |
| Stuck at 95% forever | Merge job ready but `POLL_MERGE_JOB` never received | Check `handledJobs` + `_mergeHandedOff` flags |
| ❌ Backend restarted | Backend process died (crash or manual restart) | Old jobs lost; restart download manually |
| Progress jumps backward | Popup + background both polled; popup overwrote with older value | Race condition — ensure `_mergeHandedOff` is set |
| No pause button on active download | `nativeId` is null (merge job not yet handed off) | By design — pause only works for Chrome native downloads |
| Speed shows "Starting…" forever | `bytesDiff === 0` for >1s | Normal for slow starts or stalled connections |

---

*Document version: 1.0 — covers extension popup, background script, and backend sync as of current build.*
