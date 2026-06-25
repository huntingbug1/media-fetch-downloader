// ── Supported platforms ───────────────────────────────────────────────────────
const SUPPORTED_PATTERNS = [
    /youtube\.com\/watch/, /youtu\.be\//, /youtube\.com\/shorts\//,
    /instagram\.com\/reel\//, /instagram\.com\/reels\//, /instagram\.com\/p\//,
    /instagram\.com\/stories\//,
    /tiktok\.com\/\@.+\/video/, /tiktok\.com\/t\//, /vt\.tiktok\.com\//,
    /twitter\.com\/.+\/status/, /x\.com\/.+\/status/,
    /facebook\.com\/.+\/videos\//, /facebook\.com\/watch/, /facebook\.com\/reel/, /fb\.watch\//,
    /reddit\.com\/r\/.+\/comments\//, /v\.redd\.it\//,
];
function isSupportedUrl(url) { return SUPPORTED_PATTERNS.some(p => p.test(url)); }

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
const BACKEND_URL = 'http://localhost:8000';

// ── In-memory maps ────────────────────────────────────────────────────────────
const fetchUrlInFlight = new Map();    // url → [sendResponse, ...]
const downloadIdToDlId = new Map();    // chrome downloadId → our dlId
const dlIdToProgressTimer = new Map(); // dlId → interval ID for speed tracking
const handledJobs = new Set();         // jobId → prevent duplicate POLL_MERGE_JOB handling

// ── URL cleaning ──────────────────────────────────────────────────────────────
function cleanVideoUrl(url) {
    if (!url) return '';
    try {
        const u = new URL(url);
        // YouTube Playlist
        if (u.hostname.includes('youtube.com') && u.pathname === '/playlist') {
            const list = u.searchParams.get('list');
            if (list) return `https://www.youtube.com/playlist?list=${list}`;
        }
        // YouTube Watch
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
        // YouTube Shorts
        if (u.hostname.includes('youtube.com') && u.pathname.startsWith('/shorts/')) {
            const parts = u.pathname.split('/');
            const id = parts[2];
            if (id) return `https://www.youtube.com/shorts/${id}`;
        }
        // YouTube short share link
        if (u.hostname.includes('youtu.be')) {
            const id = u.pathname.replace(/^\/+/, '');
            if (id) return `https://www.youtube.com/watch?v=${id}`;
        }
        // Instagram
        if (u.hostname.includes('instagram.com')) {
            const m = u.pathname.match(/^\/(reel|reels|p|stories)\/([^/]+)/);
            if (m) return `https://www.instagram.com/${m[1]}/${m[2]}/`;
        }
        // TikTok
        if (u.hostname.includes('tiktok.com')) {
            const m = u.pathname.match(/^\/(@[^/]+)\/video\/([^/]+)/);
            if (m) return `https://www.tiktok.com/${m[1]}/video/${m[2]}`;
        }
        // Twitter/X
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

// ── Cookie extraction ─────────────────────────────────────────────────────────
// Reads cookies for a URL's domain and formats as Netscape cookie file.
// This is safe — we only read cookies for supported video platforms and only
// send them to the local backend (localhost). Never to any third party.
async function getNetscapeCookies(urlStr) {
    try {
        const u = new URL(urlStr);
        if (u.hostname.includes('facebook.com') || u.hostname.includes('fb.watch')) {
            return '';
        }
        const base = u.hostname.replace(/^www\./, '');
        const domains = [u.hostname, `.${u.hostname}`, `.${base}`];
        
        const seen = new Set();
        const all = [];
        for (const domain of domains) {
            try {
                const cookies = await chrome.cookies.getAll({ domain });
                for (const c of cookies) {
                    const key = `${c.name}|${c.domain}|${c.path}`;
                    if (!seen.has(key)) { seen.add(key); all.push(c); }
                }
            } catch (_) {}
        }
        
        if (all.length === 0) return '';
        
        const lines = ['# Netscape HTTP Cookie File', '# Generated by Media Fetch Extension'];
        for (const c of all) {
            const dom   = c.domain.startsWith('.') ? c.domain : `.${c.domain}`;
            const flag  = c.domain.startsWith('.') ? 'TRUE' : 'FALSE';
            const sec   = c.secure ? 'TRUE' : 'FALSE';
            const exp   = c.expirationDate ? Math.floor(c.expirationDate) : 0;
            const val   = (c.value || '').replace(/\t/g, ' '); // tabs break Netscape format
            lines.push(`${dom}\t${flag}\t${c.path}\t${sec}\t${exp}\t${c.name}\t${val}`);
        }
        return lines.join('\n');
    } catch (_) {
        return '';
    }
}

function extractUrlFromDownloadUrl(downloadUrl) {
    try {
        return new URL(downloadUrl).searchParams.get('url') || '';
    } catch (_) {
        return '';
    }
}

// ── Storage helpers ───────────────────────────────────────────────────────────
function setDlStatus(dlId, status, extra = {}) {
    if (!dlId) return;
    storage.set({ [`dl_status_${dlId}`]: { status, ts: Date.now(), ...extra } });
    
    // Sync with the main downloads list to survive popup closures (with retry for race conditions)
    function updateList(retries = 5) {
        storage.get('downloads').then(s => {
            const list = s.downloads || [];
            const entry = list.find(d => d.id === dlId);
            if (entry) {
                entry.status = status;
                if (extra.progress !== undefined) entry.progress = extra.progress;
                if (extra.jobId !== undefined) entry.jobId = extra.jobId;
                if (extra.error !== undefined) entry.error = extra.error;
                if (extra.speed !== undefined) entry.speed = extra.speed;
                if (extra.nativeId !== undefined) entry.nativeId = extra.nativeId;
                storage.set({ downloads: list });
            } else if (retries > 0) {
                setTimeout(() => updateList(retries - 1), 100);
            }
        });
    }
    updateList();
}

function fmtSpeed(bps) {
    if (bps === 0) return 'Starting…';
    if (bps < 1024) return `${Math.round(bps)} B/s`;
    if (bps < 1048576) return `${(bps / 1024).toFixed(1)} KB/s`;
    return `${(bps / 1048576).toFixed(1)} MB/s`;
}

// ── Badge helpers + auto pre-fetch ────────────────────────────────────────────
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url) {
        // Clear stale tab state on URL change (SPA navigation)
        storage.remove(`info_${tabId}`);
        // Pre-fetch immediately when URL changes (SPA transitions don't fire 'complete')
        const url = cleanVideoUrl(changeInfo.url);
        if (isSupportedUrl(url)) {
            prefetchMetadata(tabId, url);
            chrome.action.setBadgeText({ text: '▼', tabId });
            chrome.action.setBadgeBackgroundColor({ color: '#0d9488', tabId });
        }
    }
    if (changeInfo.status === 'complete' && tab.url) {
        const url = cleanVideoUrl(tab.url);
        const on = isSupportedUrl(url);
        chrome.action.setBadgeText({ text: on ? '▼' : '', tabId });
        if (on) chrome.action.setBadgeBackgroundColor({ color: '#0d9488', tabId });
    }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
    try {
        const tab = await chrome.tabs.get(tabId);
        const on = isSupportedUrl(tab.url || '');
        chrome.action.setBadgeText({ text: on ? '▼' : '', tabId });
        if (on) chrome.action.setBadgeBackgroundColor({ color: '#0d9488', tabId });
        // Pre-fetch if we switched to a supported tab that hasn't been fetched yet
        if (on) prefetchMetadata(tabId, tab.url);
    } catch (_) { }
});

// ── Pre-fetch function ────────────────────────────────────────────────────────
async function prefetchMetadata(tabId, rawUrl) {
    const url = cleanVideoUrl(rawUrl);
    const CACHE_KEY = `cache_${url}`;
    const KEY = `info_${tabId}`;

    const s = await storage.get(['backendUrl', CACHE_KEY, KEY]);

    // Skip if already cached (5-min TTL)
    const cached = s[CACHE_KEY];
    if (cached && Date.now() - cached.ts < 5 * 60 * 1000) {
        // Cache hit — make sure tab state reflects it for instant popup open
        const tabState = s[KEY];
        if (!tabState || tabState.status !== 'done' || tabState.url !== url) {
            storage.set({ [KEY]: { status: 'done', url, data: cached.data, ts: Date.now() } });
        }
        return;
    }

    // Skip if already loading for this exact url
    const existing = s[KEY];
    if (existing && existing.status === 'loading' && existing.url === url && Date.now() - existing.ts < 120000) return;

    const backendUrl = s.backendUrl || BACKEND_URL;
    storage.set({ [KEY]: { status: 'loading', url, ts: Date.now() } });

    try {
        const cookies = await getNetscapeCookies(url);
        const res = await fetch(`${backendUrl}/api/info`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, cookies }),
        });
        if (!res.ok) throw new Error(`Server ${res.status}`);
        const data = await res.json();
        storage.set({
            [CACHE_KEY]: { data, ts: Date.now() },
            [KEY]: { status: 'done', url, data, ts: Date.now() },
        });
    } catch (err) {
        // Silent fail — popup will retry via FETCH_INFO if user opens it
        storage.remove(KEY);
    }
}

// ── Download tracking via chrome.downloads events ─────────────────────────────
chrome.downloads.onChanged.addListener(async delta => {
    let dlId = downloadIdToDlId.get(delta.id);

    // If map is missing (MV3 service worker terminated), restore from storage
    if (!dlId) {
        const stored = await storage.get(`native_to_dl_${delta.id}`);
        dlId = stored[`native_to_dl_${delta.id}`];
        if (dlId) downloadIdToDlId.set(delta.id, dlId);
    }

    // Completion
    if (delta.state?.current === 'complete') {
        if (dlId) {
            setDlStatus(dlId, 'done', { progress: 100, speed: '' });
            downloadIdToDlId.delete(delta.id);
            const timer = dlIdToProgressTimer.get(dlId);
            if (timer) { clearInterval(timer); dlIdToProgressTimer.delete(dlId); }
        }
        chrome.downloads.search({ id: delta.id }, items => {
            const name = (items[0]?.filename || 'file').split('/').pop().split('\\').pop();
            chrome.notifications.create(`mf_done_${delta.id}`, {
                type: 'basic',
                iconUrl: 'icons/icon48.png',
                title: '✅ Download Complete',
                message: name,
                silent: false,
            });
        });
    }

    // Interrupted / error
    if (delta.state?.current === 'interrupted') {
        if (dlId) {
            setDlStatus(dlId, 'failed', { error: 'Download interrupted' });
            downloadIdToDlId.delete(delta.id);
            const timer = dlIdToProgressTimer.get(dlId);
            if (timer) { clearInterval(timer); dlIdToProgressTimer.delete(dlId); }
        }
    }

    // Paused
    if (delta.paused?.current === true && dlId) {
        setDlStatus(dlId, 'paused');
        const timer = dlIdToProgressTimer.get(dlId);
        if (timer) { clearInterval(timer); dlIdToProgressTimer.delete(dlId); }
    }
    // Resumed — restart speed tracker if needed
    if ((delta.paused?.current === false || delta.state?.current === 'in_progress') && dlId) {
        setDlStatus(dlId, 'downloading');
        if (!dlIdToProgressTimer.has(dlId)) {
            trackDownloadSpeed(delta.id, dlId);
        }
    }
});

// ── Toolbar badge sync ─────────────────────────────────────────────────────────
// Shows live download progress in the extension toolbar badge.
// • Active download  → teal badge with "XX%"
// • Multiple downloads → shows highest active %
// • Complete          → brief "✓" then clears
// • New download starts → resets immediately

let _badgeTimer = null;

function updateGlobalBadge() {
    // Gather all active dl statuses from storage
    chrome.storage.local.get(null, items => {
        let maxProgress = -1;
        let anyActive   = false;
        let allDone     = true;

        for (const [key, val] of Object.entries(items)) {
            if (!key.startsWith('dl_status_')) continue;
            if (val.status === 'downloading' || val.status === 'merging') {
                anyActive = true;
                allDone   = false;
                if (val.progress != null && val.progress >= 0) {
                    maxProgress = Math.max(maxProgress, val.progress);
                }
            } else if (val.status !== 'done' && val.status !== 'failed') {
                allDone = false;
            }
        }

        if (anyActive) {
            const pct  = maxProgress >= 0 ? `${Math.round(maxProgress)}%` : '…';
            chrome.action.setBadgeText({ text: pct });
            chrome.action.setBadgeBackgroundColor({ color: '#0d9488' });
        } else if (allDone) {
            // Brief success flash, then restore ▼ badge
            chrome.action.setBadgeText({ text: '✓' });
            chrome.action.setBadgeBackgroundColor({ color: '#059669' });
            setTimeout(() => {
                chrome.action.setBadgeText({ text: '▼' });
                chrome.action.setBadgeBackgroundColor({ color: '#0d9488' });
            }, 2000);
        }
    });
}

// ── Speed tracker for a DOWNLOAD_FILE download ────────────────────────────────
function trackDownloadSpeed(downloadId, dlId) {
    // Prevent duplicate timers
    const existing = dlIdToProgressTimer.get(dlId);
    if (existing) { clearInterval(existing); }

    let prevBytes = 0;
    let prevTime = Date.now();

    const timer = setInterval(() => {
        chrome.downloads.search({ id: downloadId }, items => {
            const dl = items[0];
            if (!dl) {
                // Download vanished from Chrome's list — mark done if we haven't already
                setDlStatus(dlId, 'done', { progress: 100, speed: '' });
                clearInterval(timer); dlIdToProgressTimer.delete(dlId);
                updateGlobalBadge();
                return;
            }

            if (dl.state === 'complete') {
                setDlStatus(dlId, 'done', { progress: 100, speed: '' });
                clearInterval(timer); dlIdToProgressTimer.delete(dlId);
                updateGlobalBadge();
                return;
            }

            if (dl.state === 'interrupted') {
                setDlStatus(dlId, 'failed', { error: 'Download interrupted' });
                clearInterval(timer); dlIdToProgressTimer.delete(dlId);
                updateGlobalBadge();
                return;
            }

            const now = Date.now();
            const elapsed = (now - prevTime) / 1000;
            const bytesDiff = dl.bytesReceived - prevBytes;
            const speed = elapsed > 0 ? bytesDiff / elapsed : 0;
            prevBytes = dl.bytesReceived;
            prevTime = now;

            let progress;
            if (dl.totalBytes > 0) {
                progress = Math.round(dl.bytesReceived / dl.totalBytes * 100);
            } else if (dl.bytesReceived > 0) {
                progress = -1; // indeterminate (streaming, unknown size)
            } else {
                progress = 0;
            }
            setDlStatus(dlId, 'downloading', { progress, speed: fmtSpeed(speed) });

            // Update toolbar badge with live progress
            updateGlobalBadge();
        });
    }, 1000);

    dlIdToProgressTimer.set(dlId, timer);
    setTimeout(() => { clearInterval(timer); dlIdToProgressTimer.delete(dlId); }, 30 * 60 * 1000);
}
// Sync all open tabs with supported video URLs to the backend
async function syncOpenTabs() {
    try {
        const base = await probeBackendPort() || BACKEND_URL;
        
        chrome.tabs.query({}, async (tabs) => {
            const list = [];
            for (const tab of tabs) {
                if (tab.url && isSupportedUrl(cleanVideoUrl(tab.url))) {
                    const cookies = await getNetscapeCookies(tab.url);
                    list.push({ url: cleanVideoUrl(tab.url), cookies });
                }
            }
            if (list.length === 0) return;
            
            console.log(`[MediaFetch BG] Syncing ${list.length} open tabs to backend...`);
            fetch(`${base}/api/sync-tabs`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tabs: list })
            }).then(res => {
                if (res.ok) console.log(`[MediaFetch BG] Sync tabs successfully sent.`);
                else console.warn(`[MediaFetch BG] Sync tabs failed: ${res.status}`);
            }).catch(e => {
                console.error(`[MediaFetch BG] Sync tabs fetch error:`, e);
            });
        });
    } catch (e) {
        console.error(`[MediaFetch BG] syncOpenTabs error:`, e);
    }
}

// Probe localhost ports 8000-8005 to detect active backend port if offline
async function probeBackendPort() {
    try {
        const s = await storage.get('backendUrl');
        const currentUrl = s.backendUrl || BACKEND_URL;
        
        // Test current URL first
        try {
            const testRes = await fetch(`${currentUrl}/api/health`, { method: 'GET', signal: AbortSignal.timeout(1000) });
            if (testRes.ok) {
                const health = await testRes.json();
                if (health.status === 'ok') {
                    return currentUrl;
                }
            }
        } catch (_) {}

        console.log(`[MediaFetch BG] Stored backend offline. Probing ports 8000-8020...`);
        // Probe a wide range — start.py picks the first free port starting at 8000,
        // so on busy machines it may land anywhere up to ~8020.
        const ports = Array.from({ length: 21 }, (_, i) => 8000 + i); // 8000..8020
        const promises = ports.map(async (port) => {
            const url = `http://localhost:${port}`;
            try {
                const res = await fetch(`${url}/api/health`, { method: 'GET', signal: AbortSignal.timeout(1500) });
                if (res.ok) {
                    const health = await res.json();
                    if (health.status === 'ok') {
                        return { url, port, version: health.version };
                    }
                }
            } catch (_) {}
            return null;
        });

        const results = await Promise.all(promises);
        // Pick the lowest-numbered active port (most likely the intended one)
        const active = results.filter(r => r !== null).sort((a, b) => a.port - b.port)[0];
        if (active) {
            console.log(`[MediaFetch BG] Auto-detected active backend at: ${active.url} (port ${active.port})`);
            await storage.set({ backendUrl: active.url });
            return active.url;
        }
    } catch (e) {
        console.error('[MediaFetch BG] probeBackendPort error:', e);
    }
    return null;
}


// ── Message listener ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

    if (msg.type === 'PROBE_BACKEND') {
        probeBackendPort().then((url) => {
            sendResponse({ ok: !!url, url });
        });
        return true;
    }

    if (msg.type === 'SYNC_TABS') {
        syncOpenTabs();
        sendResponse({ ok: true });
        return true;
    }

    // ── FETCH_INFO: popup requests video info (with cache + dedup) ────────────
    if (msg.type === 'FETCH_INFO') {
        const { url, backendUrl, tabId } = msg;
        const KEY = `info_${tabId}`;
        const CACHE_KEY = `cache_${url}`;

        storage.get([KEY, CACHE_KEY]).then(async s => {
            const cached = s[CACHE_KEY];
            if (cached && Date.now() - cached.ts < 5 * 60 * 1000) {
                storage.set({ [KEY]: { status: 'done', url, data: cached.data, ts: Date.now() } });
                sendResponse({ status: 'done', data: cached.data });
                return;
            }

            const existing = s[KEY];
            if (existing && existing.status === 'loading' && existing.url === url && Date.now() - existing.ts < 120000) {
                sendResponse({ status: 'loading' });
                return;
            }

            storage.set({ [KEY]: { status: 'loading', url, ts: Date.now() } });
            sendResponse({ status: 'loading' });

            try {
                const cookies = await getNetscapeCookies(url);
                const res = await fetch(`${backendUrl}/api/info`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url, cookies }),
                });
                if (!res.ok) { const d = await res.json().catch(() => null); throw new Error(d?.detail || `Server ${res.status}`); }
                const data = await res.json();
                storage.set({
                    [CACHE_KEY]: { data, ts: Date.now() },
                    [KEY]: { status: 'done', url, data, ts: Date.now() },
                });
            } catch (err) {
                storage.set({ [KEY]: { status: 'error', url, error: err.message || 'Failed to fetch', ts: Date.now() } });
            }
        });
        return true;
    }

    // ── GET_INFO: popup polls for current fetch status ────────────────────────
    if (msg.type === 'GET_INFO') {
        const KEY = `info_${msg.tabId}`;
        const CACHE_KEY = msg.url ? `cache_${msg.url}` : null;

        storage.get([KEY, CACHE_KEY].filter(Boolean)).then(s => {
            const tabState = s[KEY];
            const tabStateStale = tabState && msg.url && tabState.url && tabState.url !== msg.url;

            if (!tabStateStale && tabState && tabState.status === 'loading') {
                sendResponse(tabState);
                return;
            }
            const cached = CACHE_KEY ? s[CACHE_KEY] : null;
            if (cached && Date.now() - cached.ts < 5 * 60 * 1000) {
                sendResponse({ status: 'done', data: cached.data });
                return;
            }
            if (tabStateStale) { sendResponse({ status: 'idle' }); return; }
            sendResponse(tabState || { status: 'idle' });
        });
        return true;
    }

    // ── FETCH_URL: content script requests video info (CSP bypass) ───────────
    if (msg.type === 'FETCH_URL') {
        const { url, backendUrl } = msg;
        const CACHE_KEY = `cache_${url}`;

        storage.get(CACHE_KEY).then(async s => {
            const cached = s[CACHE_KEY];
            if (cached && Date.now() - cached.ts < 5 * 60 * 1000) {
                sendResponse({ ok: true, data: cached.data });
                return;
            }
            if (fetchUrlInFlight.has(url)) {
                fetchUrlInFlight.get(url).push(sendResponse);
                return;
            }
            fetchUrlInFlight.set(url, [sendResponse]);
            try {
                const cookies = await getNetscapeCookies(url);
                const res = await fetch(`${backendUrl}/api/info`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url, cookies }),
                });
                if (!res.ok) { const d = await res.json().catch(() => null); throw new Error(d?.detail || `Server ${res.status}`); }
                const data = await res.json();
                storage.set({ [CACHE_KEY]: { data, ts: Date.now() } });
                const responders = fetchUrlInFlight.get(url) || [];
                fetchUrlInFlight.delete(url);
                responders.forEach(fn => fn({ ok: true, data }));
            } catch (err) {
                const responders = fetchUrlInFlight.get(url) || [];
                fetchUrlInFlight.delete(url);
                responders.forEach(fn => fn({ ok: false, error: err.message || 'Failed to fetch video info' }));
            }
        });
        return true;
    }

    if (msg.type === 'CLEAR_INFO') {
        storage.remove(`info_${msg.tabId}`);
        sendResponse({ ok: true });
        return true;
    }

    // ── DOWNLOAD_FILE: trigger chrome download, track speed + status ──────────
    if (msg.type === 'DOWNLOAD_FILE') {
        let { url, filename, dlId } = msg;
        storage.get('backendUrl').then(async s => {
            const base = s.backendUrl || BACKEND_URL;
            // Match any localhost port dynamically — don't hardcode 8000/8080
            const isLocalhost = url.startsWith(base) || /^http:\/\/localhost:\d+/.test(url);
            if (isLocalhost) {
                try {
                    const targetUrl = new URL(url).searchParams.get('url');
                    if (targetUrl) {
                        const cookies = await getNetscapeCookies(targetUrl);
                        if (cookies) {
                            const parsed = new URL(url);
                            parsed.searchParams.set('cookies', cookies);
                            url = parsed.toString();
                        }
                    }
                } catch (_) {}
            }
            try {
                chrome.downloads.download({ url, filename, saveAs: false }, (downloadId) => {
                    if (chrome.runtime.lastError) {
                        setDlStatus(dlId, 'failed', { error: chrome.runtime.lastError.message });
                        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
                    } else {
                        // Track native download ID for pause/resume/cancel
                        if (dlId && downloadId) {
                            downloadIdToDlId.set(downloadId, dlId);
                            storage.set({
                                [`dl_native_id_${dlId}`]: downloadId,
                                [`native_to_dl_${downloadId}`]: dlId,
                            });
                            // Also update the downloads entry so popup knows pause is available
                            storage.get('downloads').then(s2 => {
                                const list = s2.downloads || [];
                                const entry = list.find(d => d.id === dlId);
                                if (entry) {
                                    entry.nativeId = downloadId;
                                    storage.set({ downloads: list });
                                }
                            });
                            trackDownloadSpeed(downloadId, dlId);
                        }
                        sendResponse({ ok: true, downloadId });
                    }
                });
            } catch (dlErr) {
                console.error('[MediaFetch BG] DOWNLOAD_FILE chrome.downloads.download exception:', dlErr);
                setDlStatus(dlId, 'failed', { error: dlErr.message || 'Chrome download call failed' });
                sendResponse({ ok: false, error: dlErr.message || 'Chrome download call failed' });
            }
        });
        return true;
    }

    // ── PAUSE_DOWNLOAD ────────────────────────────────────────────────────────
    if (msg.type === 'PAUSE_DOWNLOAD') {
        const { dlId } = msg;
        storage.get(`dl_native_id_${dlId}`).then(s => {
            const nativeId = s[`dl_native_id_${dlId}`];
            if (nativeId != null) {
                chrome.downloads.pause(nativeId, () => {
                    if (!chrome.runtime.lastError) setDlStatus(dlId, 'paused');
                });
            }
        });
        sendResponse({ ok: true });
        return true;
    }

    // ── RESUME_DOWNLOAD ───────────────────────────────────────────────────────
    if (msg.type === 'RESUME_DOWNLOAD') {
        const { dlId } = msg;
        storage.get(`dl_native_id_${dlId}`).then(s => {
            const nativeId = s[`dl_native_id_${dlId}`];
            if (nativeId != null) {
                chrome.downloads.resume(nativeId, () => {
                    if (!chrome.runtime.lastError) setDlStatus(dlId, 'downloading');
                });
            }
        });
        sendResponse({ ok: true });
        return true;
    }

    // ── CANCEL_DOWNLOAD ───────────────────────────────────────────────────────
    if (msg.type === 'CANCEL_DOWNLOAD') {
        const { dlId } = msg;
        storage.get(`dl_native_id_${dlId}`).then(s => {
            const nativeId = s[`dl_native_id_${dlId}`];
            if (nativeId != null) {
                chrome.downloads.cancel(nativeId, () => {
                    setDlStatus(dlId, 'failed', { error: 'Cancelled' });
                });
            } else {
                // Merge job cancellation: mark failed, stop polling via status check
                setDlStatus(dlId, 'failed', { error: 'Cancelled' });
            }
        });
        sendResponse({ ok: true });
        return true;
    }

    // ── ADD_DOWNLOAD: content script registers a download in shared storage ───
    if (msg.type === 'ADD_DOWNLOAD') {
        const { entry } = msg;
        storage.get('downloads').then(s => {
            let list = s.downloads || [];
            list = list.filter(d => d.id !== entry.id); // deduplicate
            list.unshift(entry);
            if (list.length > 50) list = list.slice(0, 50);
            storage.set({ downloads: list });
        });
        sendResponse({ ok: true });
        return true;
    }

    // ── START_MERGE_JOB: backend builds merged mp4 ───────────────────────────
    if (msg.type === 'START_MERGE_JOB') {
        const { downloadUrl, filename, dlId } = msg;
        handleMergeJob(downloadUrl, filename, dlId);
        sendResponse({ ok: true });
        return true;
    }

    if (msg.type === 'POLL_MERGE_JOB') {
        const { jobId, filename, dlId } = msg;
        pollMergeJob(jobId, filename, dlId);
        sendResponse({ ok: true });
        return true;
    }

    if (msg.type === 'START_PLAYLIST_JOB') {
        const { playlistUrl, videoUrls, quality, dlId } = msg;
        handlePlaylistJob(playlistUrl, videoUrls, quality, dlId);
        sendResponse({ ok: true });
        return true;
    }
});

// ── Merge job handler ─────────────────────────────────────────────────────────
async function handleMergeJob(downloadUrl, filename, dlId) {
    setDlStatus(dlId, 'queued', { progress: 0 });
    try {
        const cookies = await getNetscapeCookies(extractUrlFromDownloadUrl(downloadUrl));
        const res = await fetch(downloadUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cookies }),
        });
        if (!res.ok) { setDlStatus(dlId, 'failed', { error: `Server ${res.status}` }); return; }
        const data = await res.json();
        const jobId = data.job_id;
        if (!jobId) { setDlStatus(dlId, 'failed', { error: 'No job ID from server' }); return; }
        setDlStatus(dlId, 'downloading', { progress: 10, jobId });
        pollMergeJob(jobId, filename, dlId);
    } catch (e) {
        setDlStatus(dlId, 'failed', { error: e.message });
    }
}

async function pollMergeJob(jobId, filename, dlId) {
    // Prevent duplicate handling — popup may send POLL_MERGE_JOB multiple times
    if (handledJobs.has(jobId)) return;

    // Check if cancelled before polling
    const stored = await storage.get(`dl_status_${dlId}`);
    const cur = stored[`dl_status_${dlId}`];
    if (cur?.status === 'failed') return; // cancelled

    try {
        const { backendUrl } = await storage.get('backendUrl');
        const base = backendUrl || BACKEND_URL;
        const statusRes = await fetch(`${base}/api/download/status/${jobId}`);
        if (!statusRes.ok) { setTimeout(() => pollMergeJob(jobId, filename, dlId), 1500); return; }
        const status = await statusRes.json();

        if (status.status === 'ready') {
            handledJobs.add(jobId);
            setDlStatus(dlId, 'downloading', { progress: 95 });
            const fileUrl = `${base}/api/download/file/${jobId}`;
            try {
                chrome.downloads.download({ url: fileUrl, filename, saveAs: false }, (downloadId) => {
                    if (chrome.runtime.lastError) {
                        console.error('[MediaFetch BG] Final merge download failed:', chrome.runtime.lastError.message);
                        setDlStatus(dlId, 'failed', { error: chrome.runtime.lastError.message });
                        handledJobs.delete(jobId);
                    } else {
                        if (dlId && downloadId) {
                            downloadIdToDlId.set(downloadId, dlId);
                            storage.set({
                                [`dl_native_id_${dlId}`]: downloadId,
                                [`native_to_dl_${downloadId}`]: dlId,
                            });
                            // Update downloads entry with nativeId for pause button
                            storage.get('downloads').then(s => {
                                const list = s.downloads || [];
                                const entry = list.find(d => d.id === dlId);
                                if (entry) { entry.nativeId = downloadId; storage.set({ downloads: list }); }
                            });
                            trackDownloadSpeed(downloadId, dlId);
                        }
                    }
                });
            } catch (dlErr) {
                console.error('[MediaFetch BG] chrome.downloads.download exception:', dlErr);
                setDlStatus(dlId, 'failed', { error: dlErr.message || 'Chrome download call failed' });
                handledJobs.delete(jobId);
            }
        } else if (status.status === 'failed') {
            setDlStatus(dlId, 'failed', { error: status.error || 'Merge failed' });
        } else {
            setDlStatus(dlId, 'downloading', { progress: status.progress || 0, jobId });
            setTimeout(() => pollMergeJob(jobId, filename, dlId), 1500);
        }
    } catch (e) {
        console.error('[MediaFetch BG] pollMergeJob error:', e);
        setTimeout(() => pollMergeJob(jobId, filename, dlId), 1500);
    }
}

async function handlePlaylistJob(playlistUrl, videoUrls, quality, dlId) {
    setDlStatus(dlId, 'queued', { progress: 0 });
    try {
        const { backendUrl } = await storage.get('backendUrl');
        const base = backendUrl || BACKEND_URL;
        const cookies = await getNetscapeCookies(playlistUrl);
        const res = await fetch(`${base}/api/download-playlist`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                playlist_url: playlistUrl,
                video_urls: videoUrls,
                quality: quality,
                limit: 0
            }),
        });
        if (!res.ok) { setDlStatus(dlId, 'failed', { error: `Server ${res.status}` }); return; }
        const data = await res.json();
        const jobId = data.job_id;
        if (!jobId) { setDlStatus(dlId, 'failed', { error: 'No job ID from server' }); return; }
        setDlStatus(dlId, 'downloading', { progress: 10, jobId });
        pollMergeJob(jobId, `${data.filename || 'playlist.zip'}`, dlId);
    } catch (e) {
        setDlStatus(dlId, 'failed', { error: e.message });
    }
}

// Sync open tabs on service worker startup
chrome.runtime.onStartup.addListener(syncOpenTabs);
chrome.runtime.onInstalled.addListener(syncOpenTabs);
