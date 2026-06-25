// ── Safe storage wrapper ──────────────────────────────────────────────────────
const storage = {
    get: (keys) => new Promise((resolve) => {
        try {
            chrome.storage.local.get(keys, (res) => {
                if (chrome.runtime.lastError) console.warn('[MediaFetch Storage] get error:', chrome.runtime.lastError.message);
                resolve(res || {});
            });
        } catch (e) {
            console.error('[MediaFetch Storage] get exception:', e);
            resolve({});
        }
    }),
    set: (items) => new Promise((resolve) => {
        try {
            chrome.storage.local.set(items, () => {
                if (chrome.runtime.lastError) console.warn('[MediaFetch Storage] set error:', chrome.runtime.lastError.message);
                resolve();
            });
        } catch (e) {
            console.error('[MediaFetch Storage] set exception:', e);
            resolve();
        }
    }),
    remove: (keys) => new Promise((resolve) => {
        try {
            chrome.storage.local.remove(keys, () => {
                if (chrome.runtime.lastError) console.warn('[MediaFetch Storage] remove error:', chrome.runtime.lastError.message);
                resolve();
            });
        } catch (e) {
            console.error('[MediaFetch Storage] remove exception:', e);
            resolve();
        }
    })
};

// ── Config ────────────────────────────────────────────────────────────────────
const DEFAULT_BACKEND = 'http://localhost:8000';
let BACKEND_URL = DEFAULT_BACKEND;
let DOWNLOAD_FOLDER = 'MediaFetch';
let USE_SUBFOLDERS = true;

// ── DOM ───────────────────────────────────────────────────────────────────────
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const show = (e) => e && e.classList.remove('hidden');
const hide = (e) => e && e.classList.add('hidden');

// ── Download History ──────────────────────────────────────────────────────────
let downloads = [];
async function loadDownloads() {
    const s = await storage.get('downloads');
    downloads = s.downloads || [];
}
async function saveDownloads() { await storage.set({ downloads }); }

function addDownload(entry) {
    downloads.unshift(entry);
    if (downloads.length > 50) downloads = downloads.slice(0, 50);
    saveDownloads(); renderDownloads(); updateBadge();
}
function updateDownload(id, updates) {
    const d = downloads.find(d => d.id === id);
    if (d) { Object.assign(d, updates); saveDownloads(); renderDownloads(); updateBadge(); }
}
function updateBadge() {
    const n = downloads.filter(d => ['downloading', 'queued', 'merging'].includes(d.status)).length;
    const el = $('#dl-count');
    if (!el) return;
    if (n > 0) { el.textContent = n; show(el); } else { hide(el); }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const SUPPORTED = [
    /youtube\.com\/watch/, /youtu\.be\//, /youtube\.com\/shorts\//,
    /youtube\.com\/playlist/,
    /instagram\.com\/reel\//, /instagram\.com\/reels\//, /instagram\.com\/p\//,
    /instagram\.com\/stories\//,
    /tiktok\.com\/\@.+\/video/, /tiktok\.com\/t\//, /vt\.tiktok\.com\//,
    /twitter\.com\/.+\/status/, /x\.com\/.+\/status/,
    /facebook\.com\/.+\/videos\//, /facebook\.com\/watch/, /facebook\.com\/reel/, /fb\.watch\//,
    /reddit\.com\/r\/.+\/comments\//, /v\.redd\.it\//,
];

function isSupportedUrl(url) { return SUPPORTED.some(p => p.test(url)); }
function isPlaylistUrl(url) { return /youtube\.com\/playlist\?/.test(url) || (/youtube\.com\/watch/.test(url) && /[?&]list=/.test(url)); }
function formatBytes(b) { if (!b) return ''; return b < 1048576 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1048576).toFixed(1)} MB`; }
function formatDuration(s) { if (!s) return ''; const m = Math.floor(s / 60); return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`; }
function sanitize(n) { return (n || 'video').replace(/[/\\:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().substring(0, 100); }
function detectPlatform(url) {
    if (/youtube\.com|youtu\.be/.test(url)) return 'YouTube';
    if (/instagram\.com/.test(url)) return 'Instagram';
    if (/tiktok\.com/.test(url)) return 'TikTok';
    if (/twitter\.com|x\.com/.test(url)) return 'Twitter';
    if (/facebook\.com|fb\.watch/.test(url)) return 'Facebook';
    if (/reddit\.com|v\.redd\.it/.test(url)) return 'Reddit';
    return 'Other';
}
function buildPath(filename, url) {
    const parts = [];
    if (DOWNLOAD_FOLDER) parts.push(DOWNLOAD_FOLDER);
    if (USE_SUBFOLDERS) parts.push(detectPlatform(url));
    parts.push(filename);
    return parts.join('/');
}

function cleanVideoUrl(url) {
    if (!url) return '';
    try {
        const u = new URL(url);
        if (u.hostname.includes('youtube.com') && u.pathname === '/playlist') {
            const list = u.searchParams.get('list');
            if (list) return `https://www.youtube.com/playlist?list=${list}`;
        }
        if (u.hostname.includes('youtube.com') && u.pathname === '/watch') {
            const v = u.searchParams.get('v');
            if (v) {
                const clean = new URL('https://www.youtube.com/watch');
                clean.searchParams.set('v', v);
                const list = u.searchParams.get('list');
                if (list) clean.searchParams.set('list', list);
                return clean.toString();
            }
        }
        if (u.hostname.includes('youtube.com') && u.pathname.startsWith('/shorts/')) {
            const parts = u.pathname.split('/');
            const id = parts[2];
            if (id) return `https://www.youtube.com/shorts/${id}`;
        }
        if (u.hostname.includes('youtu.be')) {
            const id = u.pathname.replace(/^\/+/, '');
            if (id) return `https://www.youtube.com/watch?v=${id}`;
        }
        if (u.hostname.includes('instagram.com')) {
            const m = u.pathname.match(/^\/(reel|reels|p|stories)\/([^/]+)/);
            if (m) return `https://www.instagram.com/${m[1]}/${m[2]}/`;
        }
        if (u.hostname.includes('tiktok.com')) {
            const m = u.pathname.match(/^\/(@[^/]+)\/video\/([^/]+)/);
            if (m) return `https://www.tiktok.com/${m[1]}/video/${m[2]}`;
        }
        if (u.hostname.includes('twitter.com') || u.hostname.includes('x.com')) {
            const m = u.pathname.match(/^\/([^/]+)\/status\/([^/]+)/);
            if (m) return `https://twitter.com/${m[1]}/status/${m[2]}`;
        }
        u.search = '';
        return u.toString();
    } catch (_) {
        return url;
    }
}

// ── Tab Switching ─────────────────────────────────────────────────────────────
function switchTab(name) {
    $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    $$('.tab-content').forEach(c => c.classList.toggle('hidden', !c.id.startsWith(name)));
    if (name === 'downloads') renderDownloads();
    storage.set({ lastActiveTab: name });
}

$$('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));

// ── Settings ──────────────────────────────────────────────────────────────────
$('#settings-btn').addEventListener('click', () => $('#settings-panel').classList.toggle('hidden'));
$('#save-settings').addEventListener('click', async () => {
    const u = $('#backend-url').value.trim().replace(/\/+$/, '');
    if (u) BACKEND_URL = u;
    DOWNLOAD_FOLDER = $('#download-folder').value.trim().replace(/^\/+|\/+$/g, '') || 'MediaFetch';
    USE_SUBFOLDERS = $('#subfolder-toggle').checked;
    await storage.set({ backendUrl: BACKEND_URL, downloadFolder: DOWNLOAD_FOLDER, useSubfolders: USE_SUBFOLDERS });
    hide($('#settings-panel'));
});

// ── Clear All ─────────────────────────────────────────────────────────────────
$('#clear-all-btn').addEventListener('click', () => {
    downloads = downloads.filter(d => ['downloading', 'queued', 'merging'].includes(d.status));
    saveDownloads(); renderDownloads(); updateBadge();
    // Scroll list back to top so user sees the clean state
    const list = $('#downloads-list');
    if (list) list.scrollTop = 0;
});

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
    chrome.runtime.sendMessage({ type: 'SYNC_TABS' }).catch(() => {});
    try {
        const probeRes = await chrome.runtime.sendMessage({ type: 'PROBE_BACKEND' });
        if (probeRes && probeRes.ok && probeRes.url) {
            console.log(`[MediaFetch Popup] Auto-probed active backend: ${probeRes.url}`);
        }
    } catch (_) {}
    const s = await storage.get(['backendUrl', 'downloadFolder', 'useSubfolders', 'lastActiveTab']);
    BACKEND_URL = s.backendUrl || DEFAULT_BACKEND;
    DOWNLOAD_FOLDER = s.downloadFolder || 'MediaFetch';
    USE_SUBFOLDERS = s.useSubfolders !== false;
    const lastActiveTab = s.lastActiveTab || 'video'; // default to video tab

    $('#backend-url').value = BACKEND_URL;
    $('#download-folder').value = DOWNLOAD_FOLDER;
    $('#subfolder-toggle').checked = USE_SUBFOLDERS;

    await loadDownloads();
    // Safe cleanup: remove stuck/zombie active downloads only if they lack IDs AND are older than 5 minutes
    const before = downloads.length;
    downloads = downloads.filter(d => {
        if (['downloading', 'merging', 'paused'].includes(d.status)) {
            if (d.jobId || d.nativeId) return true;
            // 5 minutes grace period (300000ms) for newly started downloads to get their jobId/nativeId from backend
            if (d.timestamp && (Date.now() - d.timestamp < 300000)) return true;
            return false;
        }
        return true; // Keep done, failed, queued, etc.
    });
    if (downloads.length !== before) {
        await saveDownloads();
    }
    renderDownloads(); // Always render downloads initially so the UI is ready
    updateBadge();
    switchTab(lastActiveTab);
    pollActiveDownloads();

    // Support opening popup.html in a tab with ?url=... (from content-script button)
    const params = new URLSearchParams(window.location.search);
    let url = params.get('url') ? cleanVideoUrl(params.get('url')) : '';

    let tab = null;
    let tabId = null;
    try {
        const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
        tab = t;
        tabId = t?.id || null;
        if (!url) {
            url = cleanVideoUrl(t?.url || '');
        }
        logDebug('Resolved active tab', { tabId, url });
    } catch (tabErr) {
        logDebug('Failed to query active tab', { error: tabErr.message });
    }

    if (!isSupportedUrl(url)) {
        show($('#loading'));
        if (!tabId || !tab) {
            logDebug('URL not supported, no tab context', { url });
            hide($('#loading')); show($('#unsupported')); return;
        }
        if (tab.url?.startsWith('chrome://') || tab.url?.startsWith('edge://') || tab.url?.startsWith('about:')) {
            logDebug('URL is internal browser page', { url: tab.url });
            hide($('#loading')); show($('#unsupported')); return;
        }
        try {
            logDebug('Attempting executeScript for embedded video on', { url: tab.url });
            const results = await chrome.scripting.executeScript({
                target: { tabId: tabId, allFrames: true },
                func: () => {
                    const els = Array.from(document.querySelectorAll('iframe, video, object, embed'));
                    const p = [
                        /youtube\.com\/embed\//i, /youtube-nocookie\.com\/embed\//i,
                        /tiktok\.com\/embed\//i, /instagram\.com\/(p|reel|tv)\/.*\/embed/i,
                        /player\.vimeo\.com\/video\//i, /dailymotion\.com\/embed\/video\//i,
                        /twitter\.com\/i\/cards\//i, /x\.com\/i\/cards\//i
                    ];
                    for (const el of els) {
                        const src = el.src || el.getAttribute('data-src') || '';
                        if (src && p.some(rx => rx.test(src))) return src;
                    }
                    return null;
                }
            });
            const embedUrl = results.find(r => r.result)?.result;
            if (embedUrl) {
                url = cleanVideoUrl(embedUrl.startsWith?.('//') ? 'https:' + embedUrl : embedUrl);
                logDebug('Resolved embed url', { embedUrl, cleaned: url });
            } else {
                logDebug('No embedded video found via executeScript');
                hide($('#loading')); show($('#unsupported')); return;
            }
        } catch (scriptErr) {
            logDebug('executeScript failed', { error: scriptErr.message });
            hide($('#loading')); show($('#unsupported')); return;
        }
    }

    // ── Check cached info before re-fetching ────────────────────────────────────
    let cached = null;
    try {
        cached = await chrome.runtime.sendMessage({ type: 'GET_INFO', tabId: tabId || tab?.id, url });
        logDebug('Checked cached info status', { status: cached?.status, hasData: !!cached?.data });
    } catch (msgErr) {
        logDebug('GET_INFO sendMessage failed', { error: msgErr.message });
    }

    if (cached?.status === 'done' && cached?.data) {
        hide($('#loading'));
        const data = cached.data;
        try {
            if (data?.type === 'playlist' || data?.entries) {
                renderPlaylist(data, url);
            } else {
                renderVideoInfo(data, url);
            }
        } catch (renderErr) {
            logDebug('Crash during cached render', { error: renderErr.message });
            $('#error-text').textContent = 'Render Error: ' + renderErr.message;
            show($('#error-msg'));
        }
        return;
    }

    fetchVideoInfo(url, tabId || tab?.id);
}

async function fetchVideoInfo(url, tabId) {
    show($('#loading'));
    hide($('#error-msg'));
    hide($('#video-info'));
    hide($('#playlist-info'));

    // Remove any leftover retry button
    const oldRetry = $('#loading-retry');
    if (oldRetry) oldRetry.remove();

    // ── Engaging step animation while waiting ─────────────────────────────────
    const STEPS = [
        '🔍 Detecting video platform…',
        '📡 Connecting to backend…',
        '🎬 Fetching video info…',
        '⚙️ Processing formats…',
        '⚡ Almost ready…',
    ];
    let stepIdx = 0;
    const pEl = $('#loading p');
    if (pEl) pEl.textContent = STEPS[0];

    const stepTimer = setInterval(() => {
        stepIdx = Math.min(stepIdx + 1, STEPS.length - 1);
        if (pEl) pEl.textContent = STEPS[stepIdx];
    }, 1400);

    let completed = false;

    // Retry button/timeout logic: show retry button after 45s
    const startTs = Date.now();
    const uiTimer = setInterval(() => {
        if (completed) {
            clearInterval(uiTimer);
            return;
        }
        const elapsed = Math.round((Date.now() - startTs) / 1000);
        if (elapsed > 45 && !$('#loading-retry')) {
            const retryBtn = document.createElement('button');
            retryBtn.id = 'loading-retry';
            retryBtn.className = 'btn btn-sm';
            retryBtn.style.marginTop = '10px';
            retryBtn.textContent = '↺ Retry';
            retryBtn.addEventListener('click', () => {
                clearInterval(uiTimer);
                clearInterval(stepTimer);
                chrome.runtime.sendMessage({ type: 'CLEAR_INFO', tabId }).catch(() => {});
                fetchVideoInfo(url, tabId);
            });
            $('#loading').appendChild(retryBtn);
        }
    }, 1000);

    // Call FETCH_URL to load video formats
    try {
        const response = await chrome.runtime.sendMessage({ type: 'FETCH_URL', url, backendUrl: BACKEND_URL });
        if (completed) return;
        completed = true;
        clearInterval(uiTimer);
        clearInterval(stepTimer);
        hide($('#loading'));

        if (response && response.ok && response.data) {
            const data = response.data;
            try {
                if (data.type === 'playlist' || data.entries) {
                    renderPlaylist(data, url);
                } else {
                    renderVideoInfo(data, url);
                }
            } catch (renderErr) {
                logDebug('Crash during render', { error: renderErr.message });
                $('#error-text').textContent = 'Render Error: ' + renderErr.message;
                show($('#error-msg'));
            }
        } else {
            const errMsg = (response && response.error) || 'Failed to fetch video info';
            $('#error-text').textContent = errMsg;
            show($('#error-msg'));
        }
    } catch (err) {
        if (completed) return;
        completed = true;
        clearInterval(uiTimer);
        clearInterval(stepTimer);
        hide($('#loading'));
        $('#error-text').textContent = err.message || 'Connection lost';
        show($('#error-msg'));
    }
}

// ── Render Single Video ───────────────────────────────────────────────────────
function renderVideoInfo(data, pageUrl) {
    if (!data) {
        $('#error-text').textContent = 'Received invalid data from backend';
        show($('#error-msg'));
        return;
    }
    const origUrl = data.original_url || pageUrl;
    $('#video-thumb').src = data.thumbnail || 'icons/icon128.png';
    $('#video-title').textContent = data.title || 'Unknown Video';
    $('#video-duration').textContent = formatDuration(data.duration);

    const formats = data.formats || [];
    const videoFmts = formats.filter(f => f.is_video);
    const audioFmts = formats.filter(f => !f.is_video && f.is_audio);

    // Group by resolution, keep the highest filesize (best quality) for each
    const byRes = new Map();
    for (const f of videoFmts) {
        const res = f.resolution || f.height || 0;
        if (res === 0) continue;
        const existing = byRes.get(res);
        if (!existing || (f.filesize_approx || 0) > (existing.filesize_approx || 0)) {
            byRes.set(res, f);
        }
    }
    const uniqueVideo = [...byRes.values()].sort((a, b) => {
        const resA = a.resolution || a.height || 0;
        const resB = b.resolution || b.height || 0;
        return resB - resA;
    });
    const bestAudio = audioFmts.sort((a, b) => (b.filesize_approx || 0) - (a.filesize_approx || 0))[0];

    const list = $('#formats-list');
    list.innerHTML = '';

    if (uniqueVideo.length > 0) {
        const lbl = document.createElement('div'); lbl.className = 'format-group-label'; lbl.textContent = '🎬 Video';
        list.appendChild(lbl);
        for (const f of uniqueVideo) list.appendChild(makeFormatRow(f, data, origUrl, false));
    }
    if (bestAudio) {
        const lbl = document.createElement('div'); lbl.className = 'format-group-label'; lbl.textContent = '🎵 Audio';
        list.appendChild(lbl);
        list.appendChild(makeFormatRow(bestAudio, data, origUrl, true));
    }

    show($('#video-info'));
}

function makeFormatRow(format, data, origUrl, isAudio) {
    const row = document.createElement('div');
    row.className = 'format-row';
    const q = isAudio
        ? 'MP3 Audio'
        : (format.quality || `${format.resolution || format.height || '?'}p`).replace(/pp$/, 'p');
    const detail = isAudio
        ? (format.acodec || 'audio').split('.')[0]
        : `${(format.vcodec || '').split('.')[0] || 'video'}${format.fps ? ` · ${format.fps}fps` : ''}`;
    const size = formatBytes(format.filesize_approx);

    // Speed badge: audio = gold, direct stream = teal, merge = indigo
    let badgeHtml;
    if (isAudio) {
        badgeHtml = `<span class="badge-audio">🎵 Audio</span>`;
    } else if (!format.needs_merge) {
        badgeHtml = `<span class="badge-direct">⚡ Direct</span>`;
    } else {
        badgeHtml = `<span class="badge-merge">🔄 Merge</span>`;
    }

    row.innerHTML = `
    <div class="format-info">
        <span class="format-quality">${q}</span>
        <span class="format-detail">${detail}</span>
    </div>
    <div class="format-right">
        ${badgeHtml}
        ${size ? `<span class="format-size">${size}</span>` : ''}
        <button class="btn btn-download">⬇</button>
    </div>`;
    row.querySelector('.btn-download').addEventListener('click', () => startDownload(format, data, origUrl, isAudio));
    return row;
}

// ── Render Playlist ───────────────────────────────────────────────────────────
function renderPlaylist(data, pageUrl) {
    const entries = data.entries || [];
    $('#playlist-title').textContent = data.title || 'YouTube Playlist';
    $('#playlist-count').textContent = `${entries.length} videos`;

    const entriesEl = $('#playlist-entries');
    entriesEl.innerHTML = '';
    entries.forEach((e, i) => {
        const row = document.createElement('div');
        row.className = 'playlist-entry';
        row.innerHTML = `<span class="pe-num">${i + 1}</span><span class="pe-title">${e.title || 'Video ' + (i + 1)}</span><span class="pe-dur">${formatDuration(e.duration)}</span>`;
        entriesEl.appendChild(row);
    });

    const plBtn = $('#playlist-download-btn');
    const newPlBtn = plBtn.cloneNode(true);
    plBtn.parentNode.replaceChild(newPlBtn, plBtn);
    newPlBtn.addEventListener('click', async () => {
        const quality = $('#playlist-quality').value;
        const isAudio = quality === 'audio';
        const limit = parseInt($('#playlist-limit').value || '0', 10);
        const playlistUrl = data.original_url || pageUrl;
        const playlistTitle = sanitize(data.title || 'Playlist');

        let videoUrls = entries
            .map(e => e.url || (e.id ? `https://www.youtube.com/watch?v=${e.id}` : null))
            .filter(Boolean);

        if (videoUrls.length === 0) return;

        const totalVideos = videoUrls.length;
        if (limit > 0 && limit < videoUrls.length) {
            videoUrls = videoUrls.slice(0, limit);
        }
        const countLabel = limit > 0 && limit < totalVideos ? `${videoUrls.length} of ${totalVideos}` : `${videoUrls.length}`;
        const zipFilename = buildPath(`${playlistTitle}.zip`, playlistUrl);

        const dlId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

        addDownload({
            id: dlId, title: `📦 ${playlistTitle} (${countLabel} videos)`,
            thumbnail: 'icons/playlist.png',
            quality: isAudio ? 'Audio' : quality, platform: 'YouTube',
            status: 'downloading', progress: 0, jobId: null,
            filename: zipFilename, timestamp: Date.now(),
        });

        switchTab('downloads');

        chrome.runtime.sendMessage({
            type: 'START_PLAYLIST_JOB',
            playlistUrl,
            videoUrls,
            quality: isAudio ? 'audio' : quality,
            dlId
        }, (res) => {
            if (chrome.runtime.lastError || !res?.ok) {
                console.error('[MediaFetch] Playlist job start failed:', chrome.runtime.lastError?.message || res?.error);
                updateDownload(dlId, { status: 'failed', error: 'Failed to start playlist job in background' });
            }
        });
    });

    show($('#playlist-info'));
}

async function startPlaylistEntry(dl) {
    updateDownload(dl.id, { status: 'downloading' });
    const isAudio = dl.isAudio;
    const quality = dl.qualityStr || '720p';
    const heightMap = { '4k': 2160, '1080p': 1080, '720p': 720, '480p': 480, '360p': 360 };
    const height = heightMap[quality.toLowerCase()] || 720;

    const params = new URLSearchParams({
        url: dl.entryUrl,
        format_id: isAudio ? 'bestaudio' : `bestvideo[height<=${height}]+bestaudio/best[height<=${height}]`,
        filename: dl.filename.split('/').pop(),
        is_audio: isAudio.toString(),
        needs_merge: (!isAudio).toString(),
        expected_size: '0',
    });

    try {
        if (isAudio) {
            chrome.runtime.sendMessage({
                type: 'DOWNLOAD_FILE',
                url: `${BACKEND_URL}/api/download?${params}`,
                filename: dl.filename,
                dlId: dl.id,
            });
            updateDownload(dl.id, { status: 'downloading' });
        } else {
            chrome.runtime.sendMessage({
                type: 'START_MERGE_JOB',
                downloadUrl: `${BACKEND_URL}/api/download?${params}`,
                filename: dl.filename,
                dlId: dl.id,
            });
            updateDownload(dl.id, { status: 'queued' });
        }
    } catch (err) {
        updateDownload(dl.id, { status: 'failed' });
        startNextQueued();
    }
}

function startNextQueued() {
    const next = downloads.find(d => d.status === 'queued' && d.entryUrl);
    if (next) startPlaylistEntry(next);
}

// ── Single Video Download ─────────────────────────────────────────────────────
async function startDownload(format, data, origUrl, isAudio) {
    const ext = isAudio ? 'mp3' : 'mp4';
    const filename = buildPath(`${sanitize(data.title)}.${ext}`, origUrl);
    const dlId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const quality = isAudio ? 'Audio' : (format.quality || `${format._displayRes || format.resolution || format.height || '?'}p`);

    const TIKWM = ['no_watermark_hd', 'no_watermark', 'watermark', 'audio_only'];
    // Only bypass backend for TikWM formats — they have pre-signed CDN URLs that don't
    // require Referer headers. YouTube/Instagram CDN URLs need Referer: <platform>/
    // which chrome.downloads.download() cannot send, causing silent 403 failures.
    const cdnDirectUrl = TIKWM.includes(format.format_id) ? (format.url || '') : '';

    // For YouTube, numeric format IDs (e.g. "400") can expire between metadata fetch and download.
    // Use a height-based selector instead — it always resolves correctly via _yt_format_selector().
    const isYouTube = /youtube\.com|youtu\.be/.test(origUrl);
    const fmtHeight = format.height || format.resolution || 0;
    const resolvedFormatId = (isYouTube && !isAudio && /^\d+$/.test(format.format_id) && fmtHeight > 0)
        ? `bestvideo[height<=${fmtHeight}]+bestaudio`  // height-based — never expires
        : format.format_id;                             // use raw ID for TikTok/Instagram/etc.

    const params = new URLSearchParams({
        url: origUrl,
        format_id: resolvedFormatId,
        height: fmtHeight.toString(),
        filename: filename.split('/').pop(),
        is_audio: isAudio.toString(),
        needs_merge: (format.needs_merge === true && !cdnDirectUrl).toString(),
        expected_size: (format.filesize_approx || 0).toString(),
        direct_url: cdnDirectUrl,
    });

    const downloadUrl = `${BACKEND_URL}/api/download?${params}`;

    addDownload({
        id: dlId, title: data.title || 'Untitled', thumbnail: data.thumbnail || '',
        quality, platform: detectPlatform(origUrl),
        status: 'downloading', progress: 0, jobId: null, filename, timestamp: Date.now(),
    });

    switchTab('downloads');

    // ── Path 1: TikWM CDN direct (pre-signed URL, no Referer needed) ────────────
    if (cdnDirectUrl) {
        updateDownload(dlId, { status: 'downloading', progress: 50 });
        chrome.runtime.sendMessage({
            type: 'DOWNLOAD_FILE',
            url: cdnDirectUrl,
            filename,
            dlId,
        }, (res) => {
            if (chrome.runtime.lastError || !res?.ok) {
                console.warn('[MediaFetch] TikWM CDN failed, falling back to backend:', chrome.runtime.lastError?.message || res?.error);
                chrome.runtime.sendMessage({ type: 'DOWNLOAD_FILE', url: downloadUrl, filename, dlId },
                    (fb) => { if (chrome.runtime.lastError || !fb?.ok) updateDownload(dlId, { status: 'failed' }); });
            }
        });
        return;
    }

    // ── Path 2: Audio format (streamed directly, fast starting) ─────────────────
    if (isAudio) {
        updateDownload(dlId, { status: 'downloading', progress: 20 });
        chrome.runtime.sendMessage({
            type: 'DOWNLOAD_FILE',
            url: downloadUrl,
            filename,
            dlId,
        }, (res) => {
            if (chrome.runtime.lastError || !res?.ok) {
                console.error('[MediaFetch] Backend stream download failed:', chrome.runtime.lastError?.message || res?.error);
                updateDownload(dlId, { status: 'failed' });
            }
        });
        return;
    }

    // ── Merge job: delegate to background.js so it extracts cookies + handles POST ──
    chrome.runtime.sendMessage({
        type: 'START_MERGE_JOB',
        downloadUrl,
        filename,
        dlId,
    }, (res) => {
        if (chrome.runtime.lastError || !res?.ok) {
            console.error('[MediaFetch] Merge job start failed:', chrome.runtime.lastError?.message || res?.error);
            updateDownload(dlId, { status: 'failed' });
        }
    });
}

// ── Poll Jobs ─────────────────────────────────────────────────────────────────
let pollTimer = null;

async function syncAndPollDownloads() {
    // 1. Check for background-completed downloads + nativeId mapping
    const activeIds = downloads.filter(d => !['done', 'failed'].includes(d.status)).map(d => d.id);
    if (activeIds.length > 0) {
        const keys = activeIds.map(id => `dl_status_${id}`);
        const nativeKeys = activeIds.map(id => `dl_native_id_${id}`);
        try {
            const [updates, nativeIds] = await Promise.all([
                storage.get(keys),
                storage.get(nativeKeys),
            ]);
            let changed = false;
            for (const dl of downloads) {
                const up = updates[`dl_status_${dl.id}`];
                if (up) {
                    const patch = {};
                    if (up.status && dl.status !== up.status) { patch.status = up.status; }
                    if (up.progress !== undefined && dl.progress !== up.progress) { patch.progress = up.progress; }
                    if (up.speed !== undefined && dl.speed !== up.speed) { patch.speed = up.speed; }
                    if (up.error !== undefined && dl.error !== up.error) { patch.error = up.error; }
                    if (up.jobId !== undefined && dl.jobId !== up.jobId) { patch.jobId = up.jobId; }
                    
                    if (Object.keys(patch).length > 0) {
                        Object.assign(dl, patch);
                        changed = true;
                    }
                }
                const nid = nativeIds[`dl_native_id_${dl.id}`];
                if (nid !== undefined && dl.nativeId !== nid) {
                    dl.nativeId = nid;
                    changed = true;
                }
            }
            if (changed) {
                await saveDownloads();
                renderDownloads();
                updateBadge();
            }
        } catch (e) {
            logDebug('Reconciliation failed', { error: e.message });
        }
    }

    // 2. Hand off merge jobs to background.js if not already done
    // Background script polls the backend directly — popup just reads storage.
    // This avoids double-polling (popup + background) which wastes resources.
    const active = downloads.filter(d => d.jobId && !d._mergeHandedOff && ['downloading', 'queued', 'merging'].includes(d.status));
    for (const dl of active) {
        dl._mergeHandedOff = true;
        chrome.runtime.sendMessage({
            type: 'POLL_MERGE_JOB',
            jobId: dl.jobId,
            filename: dl.filename,
            dlId: dl.id,
        });
    }
}

function pollActiveDownloads() {
    if (pollTimer) clearInterval(pollTimer);
    syncAndPollDownloads();
    pollTimer = setInterval(syncAndPollDownloads, 1500);
}

// ── Render Downloads ──────────────────────────────────────────────────────────

function renderDownloads() {
    const list = $('#downloads-list');
    const empty = $('#downloads-empty');
    const clearBtn = $('#clear-all-btn');
    if (!list) return;

    if (downloads.length === 0) {
        show(empty); hide(clearBtn); list.innerHTML = '';
        return;
    }
    hide(empty);
    if (downloads.some(d => ['done', 'failed'].includes(d.status))) show(clearBtn);
    else hide(clearBtn);

    list.innerHTML = '';
    for (const dl of downloads) {
        const item = document.createElement('div');
        item.className = 'dl-item';

        const isActive  = ['downloading', 'queued', 'merging'].includes(dl.status);
        const isPaused  = dl.status === 'paused';
        const hasNative = dl.nativeId != null;

        // ── Indeterminate flag: direct stream with unknown total size ──────────
        const isIndeterminate = dl.progress === -1;

        // ── Progress block HTML — real data only, no layout shifts ─────────────────
        let progressBlock = '';
        const realPct = dl.progress != null && dl.progress >= 0 ? dl.progress : 0;

        if (dl.status === 'downloading' || dl.status === 'merging' || dl.status === 'queued') {
            const initSpd = dl.speed ? '⬇ ' + dl.speed : '';
            if (dl.status === 'queued') {
                progressBlock = `
                <div class="dl-counter-row">
                    <span class="dl-counter-num dl-counter-queued">Queued in line…</span>
                </div>
                <div class="dl-progress">
                    <div class="dl-progress-fill" style="width: 0%; opacity: 0.3;"></div>
                </div>`;
            } else if (dl.status === 'merging') {
                progressBlock = `
                <div class="dl-counter-row">
                    <span class="dl-counter-num dl-counter-merging">Merging video & audio…</span>
                </div>
                <div class="dl-progress">
                    <div class="dl-progress-fill dl-indeterminate"></div>
                </div>`;
            } else if (isIndeterminate) {
                progressBlock = `
                <div class="dl-counter-row">
                    <span class="dl-counter-num dl-counter-indeterminate">Downloading…</span>
                    <span class="dl-counter-speed">${initSpd}</span>
                </div>
                <div class="dl-progress">
                    <div class="dl-progress-fill dl-indeterminate"></div>
                </div>`;
            } else {
                progressBlock = `
                <div class="dl-counter-row">
                    <span class="dl-counter-num">${realPct}%</span>
                    <span class="dl-counter-speed">${initSpd}</span>
                </div>
                <div class="dl-progress">
                    <div class="dl-progress-fill dl-progress-live" style="width:${realPct}%"></div>
                </div>`;
            }

        } else if (isPaused) {
            const pct = dl.progress != null && dl.progress >= 0 ? dl.progress : 0;
            progressBlock = `
            <div class="dl-counter-row">
                <span class="dl-counter-num dl-counter-paused">${pct.toFixed(2)}%</span>
                <span class="dl-counter-speed">⏸ Paused</span>
            </div>
            <div class="dl-progress">
                <div class="dl-progress-fill" style="width:${pct}%;opacity:0.4"></div>
            </div>`;
        }

        // ── Status badges (non-progress states) ───────────────────────────────
        let badge = '';
        if (dl.status === 'done')   badge = `<span class="dl-status done">✅ Done</span>`;
        if (dl.status === 'failed') {
            // Map known yt-dlp errors to friendly one-liners
            const raw = dl.error || 'Failed';
            let friendly = raw;
            if (/requested format is not available/i.test(raw))   friendly = 'Format unavailable — try a different quality';
            else if (/http error 403/i.test(raw))                  friendly = 'Access denied (403) — try again';
            else if (/http error 429/i.test(raw))                  friendly = 'Rate limited — wait a minute and retry';
            else if (/sign in to confirm/i.test(raw))              friendly = 'Age-restricted — sign into YouTube first';
            else if (/video unavailable/i.test(raw))               friendly = 'Video unavailable in your region';
            else if (/private video/i.test(raw))                   friendly = 'Private video — no access';
            else if (/timed out/i.test(raw))                       friendly = 'Timed out — try a lower quality';
            else if (/no output file/i.test(raw))                  friendly = 'Download failed — try again';
            badge = `<span class="dl-status failed" title="${raw.replace(/"/g, '&quot;')}">❌ ${friendly.substring(0, 60)}</span>`;
        }

        item.innerHTML = `
      <img class="dl-thumb" src="${dl.thumbnail || 'icons/icon128.png'}" alt="" />
      <div class="dl-info">
        <div class="dl-title">${dl.title}</div>
        <div class="dl-meta">
          <span class="dl-quality">${dl.quality}</span>
          <span class="dl-platform">${dl.platform || ''}</span>
          ${badge}
        </div>
        ${progressBlock}
      </div>
      <div class="dl-controls">
        ${(isActive && hasNative) ? `<button class="dl-ctrl-btn" data-action="pause" data-id="${dl.id}" title="Pause">⏸</button>` : ''}
        ${isPaused ? `<button class="dl-ctrl-btn dl-ctrl-resume" data-action="resume" data-id="${dl.id}" title="Resume">▶</button>` : ''}
        ${(isActive || isPaused) ? `<button class="dl-ctrl-btn dl-ctrl-cancel" data-action="cancel" data-id="${dl.id}" title="Cancel">✕</button>` : ''}
      </div>`;

        item.querySelectorAll('.dl-ctrl-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const { action, id } = btn.dataset;
                if (action === 'pause')  chrome.runtime.sendMessage({ type: 'PAUSE_DOWNLOAD',  dlId: id });
                if (action === 'resume') chrome.runtime.sendMessage({ type: 'RESUME_DOWNLOAD', dlId: id });
                if (action === 'cancel') {
                    chrome.runtime.sendMessage({ type: 'CANCEL_DOWNLOAD', dlId: id });
                    updateDownload(id, { status: 'failed', error: 'Cancelled' });
                }
            });
        });

        list.appendChild(item);
    }
}

// ── Debug Logging helper ──────────────────────────────────────────────────────
async function logDebug(msg, data = {}) {
    const s = await storage.get('debug_logs');
    const logs = s.debug_logs || [];
    logs.push({ timestamp: new Date().toISOString(), message: msg, data });
    if (logs.length > 80) logs.shift();
    await storage.set({ debug_logs: logs });
    console.log(`[MediaFetch Debug] ${msg}`, data);
}

// Bind Copy Debug Logs button
const copyLogsBtn = $('#copy-debug-logs');
if (copyLogsBtn) {
    copyLogsBtn.addEventListener('click', async () => {
        const s = await storage.get('debug_logs');
        const logs = s.debug_logs || [];
        const text = JSON.stringify(logs, null, 2);
        try {
            await navigator.clipboard.writeText(text);
            copyLogsBtn.textContent = '✓ Copied!';
            setTimeout(() => { copyLogsBtn.textContent = '📋 Copy Debug Logs'; }, 2000);
        } catch (err) {
            console.error('Clipboard copy failed:', err);
            copyLogsBtn.textContent = '❌ Failed to copy';
            setTimeout(() => { copyLogsBtn.textContent = '📋 Copy Debug Logs'; }, 2000);
        }
    });
}

init();

