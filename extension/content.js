(() => {
    'use strict';

    // Fallback backend URL — actual URL is read from storage at request time
    const BACKEND_DEFAULT = 'http://localhost:8000';
    const BTN_ID = 'mf-float-btn';
    const PANEL_ID = 'mf-float-panel';
    const STYLE_ID = 'mf-float-style';

    async function getBackendUrl() {
        try {
            const s = await chrome.storage.local.get(['backendUrl']);
            return s.backendUrl || BACKEND_DEFAULT;
        } catch (_) {
            return BACKEND_DEFAULT;
        }
    }

    async function getDownloadSettings() {
        try {
            const s = await chrome.storage.local.get(['downloadFolder', 'useSubfolders']);
            return {
                folder: (s.downloadFolder || 'MediaFetch').replace(/^\/+|\/+$/g, ''),
                useSubfolders: s.useSubfolders !== false,
            };
        } catch (_) {
            return { folder: 'MediaFetch', useSubfolders: true };
        }
    }

    function detectPlatformFolder(url) {
        if (/youtube\.com|youtu\.be/.test(url)) return 'YouTube';
        if (/instagram\.com/.test(url)) return 'Instagram';
        if (/tiktok\.com/.test(url)) return 'TikTok';
        if (/twitter\.com|x\.com/.test(url)) return 'Twitter';
        if (/facebook\.com|fb\.watch/.test(url)) return 'Facebook';
        if (/reddit\.com|v\.redd\.it/.test(url)) return 'Reddit';
        return 'Other';
    }

    function buildPath(filename, url, settings) {
        const parts = [];
        if (settings.folder) parts.push(settings.folder);
        if (settings.useSubfolders) parts.push(detectPlatformFolder(url));
        parts.push(filename);
        return parts.join('/');
    }

    function isContextValid() {
        return typeof chrome !== 'undefined' && chrome.runtime && !!chrome.runtime.id;
    }

    function showReloadToast() {
        removePanel();
        const existing = document.getElementById('mf-reload-toast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.id = 'mf-reload-toast';
        toast.innerHTML = `
            <div style="display:flex;align-items:center;gap:10px;">
                <span style="font-size:20px;">🔌</span>
                <div>
                    <div style="font-weight:700;color:#fff;font-size:13px;">Extension Updated</div>
                    <div style="color:#f8fafc;font-size:11px;margin-top:2px;font-weight:500;">Please refresh this page to resume downloading.</div>
                </div>
            </div>
        `;
        toast.style.cssText = 'position:fixed;z-index:2147483647;bottom:24px;right:24px;background:linear-gradient(135deg,#ef4444,#dc2626);color:#fff;padding:12px 18px;border-radius:12px;font-family:Inter,system-ui,sans-serif;box-shadow:0 10px 30px rgba(239,68,68,0.4);border:1px solid rgba(255,255,255,0.1);transition:opacity 0.15s ease;';
        document.body.appendChild(toast);
        setTimeout(() => {
            if (toast.parentNode) {
                toast.style.opacity = '0';
                setTimeout(() => toast.remove(), 150);
            }
        }, 6000);
    }


    function detectPlatform() {
        const h = location.hostname;
        const p = location.pathname;
        if (h.includes('youtube.com') && p.startsWith('/shorts/')) return 'yt-shorts';
        if (h.includes('youtube.com') && p.startsWith('/watch')) return 'youtube';
        if (h.includes('tiktok.com')) return 'tiktok';
        if (h.includes('instagram.com') && (p.startsWith('/reel') || p.startsWith('/reels') || p.startsWith('/p/'))) return 'instagram';
        if (h.includes('facebook.com') && p.startsWith('/reel')) return 'facebook-shorts';
        if (h.includes('facebook.com') || h.includes('fb.watch')) return 'facebook';
        if (h.includes('reddit.com') || h.includes('v.redd.it')) return 'reddit';
        return null;
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

    function getVideoUrl() {
        return cleanVideoUrl(location.href);
    }

    function injectStyles() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
            #${BTN_ID} {
                position: fixed;
                z-index: 2147483647;
                display: flex;
                align-items: center;
                gap: 7px;
                padding: 0 14px 0 10px;
                height: 40px;
                border-radius: 999px;
                background: rgba(8, 14, 26, 0.82);
                backdrop-filter: blur(14px) saturate(1.6);
                -webkit-backdrop-filter: blur(14px) saturate(1.6);
                border: 1px solid rgba(20,184,166,0.28);
                box-shadow:
                    0 0 0 1px rgba(20,184,166,0.10),
                    0 4px 24px rgba(0,0,0,0.55),
                    inset 0 1px 0 rgba(255,255,255,0.06);
                cursor: pointer;
                font-family: 'Inter', system-ui, sans-serif;
                font-size: 12px;
                font-weight: 600;
                color: #e2e8f0;
                letter-spacing: 0.1px;
                white-space: nowrap;
                pointer-events: auto;
                transition:
                    transform .22s cubic-bezier(.34,1.56,.64,1),
                    box-shadow .22s ease,
                    background .15s ease,
                    border-color .15s ease;
                animation: mf-entry .45s cubic-bezier(0.34,1.56,0.64,1) both;
                transform-origin: right center;
                overflow: hidden;
            }

            #${BTN_ID} .mf-pill-icon {
                display: flex;
                align-items: center;
                justify-content: center;
                width: 22px;
                height: 22px;
                border-radius: 50%;
                background: linear-gradient(135deg, #14b8a6, #0891b2);
                flex-shrink: 0;
                box-shadow: 0 2px 8px rgba(20,184,166,0.5);
                font-size: 11px;
                line-height: 1;
                color: #fff;
            }
            #${BTN_ID} .mf-pill-label {
                font-size: 11px;
                font-weight: 700;
                color: #94a3b8;
                letter-spacing: 0.2px;
                max-width: 80px;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            #${BTN_ID}:hover {
                transform: scale(1.06) translateY(-1px);
                background: rgba(8, 14, 26, 0.95);
                border-color: rgba(20,184,166,0.55);
                box-shadow:
                    0 0 0 1px rgba(20,184,166,0.25),
                    0 6px 32px rgba(0,0,0,0.65),
                    0 0 20px rgba(20,184,166,0.2),
                    inset 0 1px 0 rgba(255,255,255,0.08);
                color: #fff;
            }
            #${BTN_ID}:hover .mf-pill-label { color: #cbd5e1; }
            #${BTN_ID}:active {
                transform: scale(0.96) translateY(0) !important;
                transition-duration: .08s;
            }
            #${PANEL_ID} {
                position: fixed;
                z-index: 2147483647;
                /* width + max-height are set per-platform in JS via panelConfig() */
                overflow-y: auto;
                background: #080e1a;
                border: 1px solid rgba(255,255,255,0.08);
                border-radius: 14px;
                padding: 14px;
                color: #e2e8f0;
                font-family: 'Inter', system-ui, sans-serif;
                font-size: 13px;
                box-shadow: 0 20px 60px rgba(0,0,0,0.7), 0 0 0 1px rgba(20,184,166,0.1);
                animation: mf-panel-open 0.22s cubic-bezier(0.34,1.4,0.64,1) both;
                transform-origin: top right;
            }
            @keyframes mf-panel-open {
                from { opacity: 0; transform: scale(0.92) translateY(-6px); }
                to   { opacity: 1; transform: scale(1)    translateY(0);     }
            }
            #${PANEL_ID}::before {
                content: '';
                display: block;
                height: 2px;
                background: linear-gradient(90deg, #14b8a6, #0891b2, #6366f1);
                border-radius: 14px 14px 0 0;
                margin: -14px -14px 12px;
            }
            #${PANEL_ID} .mf-title {
                font-weight: 700;
                font-size: 12px;
                margin-bottom: 10px;
                padding-right: 22px;
                line-height: 1.3;
                max-height: 36px;
                overflow: hidden;
                color: #e2e8f0;
                letter-spacing: -0.2px;
            }
            #${PANEL_ID} .mf-thumb {
                width: 100%;
                height: 125px;
                object-fit: cover;
                border-radius: 9px;
                margin-bottom: 10px;
                background: #0d1625;
                display: block;
            }
            #${PANEL_ID} .mf-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 8px 10px;
                background: #0d1625;
                border-radius: 8px;
                margin-bottom: 4px;
                cursor: default;
                transition: background .12s, border-color .12s;
                user-select: none;
                border: 1px solid transparent;
            }
            #${PANEL_ID} .mf-row:hover { background: #111827; border-color: rgba(20,184,166,0.15); }
            #${PANEL_ID} .mf-row-left { display: flex; align-items: center; gap: 7px; }
            #${PANEL_ID} .mf-q { font-weight: 700; font-size: 13px; min-width: 48px; letter-spacing: -0.3px; }
            #${PANEL_ID} .mf-row-right { display: flex; align-items: center; gap: 5px; }
            #${PANEL_ID} .mf-badge-direct {
                font-size: 9px; font-weight: 700;
                padding: 2px 6px; border-radius: 4px;
                background: rgba(20,184,166,0.12); color: #14b8a6;
                border: 1px solid rgba(20,184,166,0.25);
                white-space: nowrap;
            }
            #${PANEL_ID} .mf-badge-merge {
                font-size: 9px; font-weight: 700;
                padding: 2px 6px; border-radius: 4px;
                background: rgba(99,102,241,0.12); color: #818cf8;
                border: 1px solid rgba(99,102,241,0.25);
                white-space: nowrap;
            }
            #${PANEL_ID} .mf-badge-audio {
                font-size: 9px; font-weight: 700;
                padding: 2px 6px; border-radius: 4px;
                background: rgba(251,191,36,0.1); color: #fbbf24;
                border: 1px solid rgba(251,191,36,0.2);
                white-space: nowrap;
            }
            #${PANEL_ID} .mf-size { font-size: 10px; color: #475569; }
            #${PANEL_ID} .mf-dl-btn {
                width: 28px;
                height: 28px;
                border-radius: 7px;
                background: linear-gradient(135deg, #14b8a6, #0891b2);
                color: #fff;
                border: none;
                cursor: pointer;
                font-size: 13px;
                display: flex;
                align-items: center;
                justify-content: center;
                flex-shrink: 0;
                transition: transform .15s, box-shadow .15s;
            }
            #${PANEL_ID} .mf-dl-btn:hover {
                transform: scale(1.1);
                box-shadow: 0 3px 10px rgba(20,184,166,0.4);
            }
            #${PANEL_ID} .mf-spinner {
                width: 26px;
                height: 26px;
                border: 3px solid #1e293b;
                border-top-color: #14b8a6;
                border-radius: 50%;
                animation: mf-spin .7s linear infinite;
                margin: 24px auto;
            }
            #${PANEL_ID} .mf-close {
                position: absolute;
                top: 16px;
                right: 12px;
                background: transparent;
                border: none;
                color: #475569;
                cursor: pointer;
                font-size: 16px;
                line-height: 1;
                padding: 0;
                width: 22px;
                height: 22px;
                transition: color .15s;
            }
            #${PANEL_ID} .mf-close:hover { color: #94a3b8; }
            #${PANEL_ID} .mf-group-label {
                font-size: 9px; color: #334155; font-weight: 700;
                text-transform: uppercase; letter-spacing: 1.2px;
                padding: 8px 2px 3px;
            }
            #${PANEL_ID} .mf-error { color: #fca5a5; text-align: center; padding: 16px; line-height: 1.5; font-size: 12px; }
            #${PANEL_ID} .mf-empty { color: #475569; text-align: center; padding: 16px; font-size: 12px; }
            #${PANEL_ID}::-webkit-scrollbar { width: 3px; }
            #${PANEL_ID}::-webkit-scrollbar-track { background: transparent; }
            #${PANEL_ID}::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 2px; }
            @keyframes mf-spin { to { transform: rotate(360deg); } }
            @keyframes mf-entry {
                from { transform: scale(0) rotate(-15deg); opacity: 0; }
                to   { transform: scale(1) rotate(0deg);  opacity: 1; }
            }
            @keyframes mf-spin-border {
                from { transform: rotate(0deg); }
                to   { transform: rotate(360deg); }
            }
        `;
        (document.head || document.documentElement).appendChild(style);
    }


    // ── Find the best visible video element ────────────────────────────────────
    function findBestVideo() {
        const videos = Array.from(document.querySelectorAll('video'));
        if (videos.length === 0) return null;

        // Score each video by visibility + size
        let best = null;
        let bestScore = -1;

        for (const v of videos) {
            const rect = v.getBoundingClientRect();
            const visibleW = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0));
            const visibleH = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
            const visibleArea = visibleW * visibleH;
            const area = rect.width * rect.height;
            const inViewport = visibleArea > 0;
            const score = area * (inViewport ? 2 : 0.1) + visibleArea;

            if (score > bestScore) {
                bestScore = score;
                best = v;
            }
        }
        return best;
    }

    function placeButton(btn, videoEl) {
        const platform = detectPlatform();
        const rect = videoEl.getBoundingClientRect();
        const pad = 10;
        const pillW = 130;
        const pillH = 40;

        let top, left;
        if (platform === 'instagram') {
            // Instagram: top-right, below Stories close button
            top  = rect.top + pad + 60;
            left = rect.right - pillW - pad;
        } else if (['yt-shorts', 'tiktok', 'facebook-shorts'].includes(platform)) {
            // Short-form players (YouTube Shorts, TikTok, FB Reels) keep action
            // bars on the right side. Pin the pill to the top-left so it never
            // overlaps those controls, with enough top padding to clear headers.
            top  = rect.top + pad + 55;
            left = rect.left + pad + 8;
        } else {
            // YouTube / others: TOP-right of player, clear of controls bar at bottom
            top  = rect.top + pad + 8;
            left = rect.right - pillW - pad;
        }

        // Clamp to viewport
        top  = Math.max(pad, Math.min(top,  window.innerHeight - pillH - pad));
        left = Math.max(pad, Math.min(left, window.innerWidth  - pillW - pad));

        btn.style.top  = top  + 'px';
        btn.style.left = left + 'px';
    }

    let panelOpen = false;

    function removePanel() {
        const p = document.getElementById(PANEL_ID);
        if (p) p.remove();
        panelOpen = false;
    }

    // Close panel when clicking outside
    document.addEventListener('click', (e) => {
        const panel = document.getElementById(PANEL_ID);
        const btn = document.getElementById(BTN_ID);
        if (panel && !panel.contains(e.target) && e.target !== btn) {
            removePanel();
        }
    }, true);

    function escapeHtml(t) {
        const d = document.createElement('div');
        d.textContent = t;
        return d.innerHTML;
    }

    function sanitize(n) {
        return (n || 'video').replace(/[/\\:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().substring(0, 100);
    }

    // ── Download ───────────────────────────────────────────────────────────────
    async function triggerDownload(url, filename, fallbackUrl = null) {
        if (!isContextValid()) {
            showReloadToast();
            return;
        }
        console.log('[MediaFetch] triggerDownload', url, filename);

        // Use chrome.downloads API — streams directly to disk, no memory bloat
        try {
            const res = await chrome.runtime.sendMessage({ type: 'DOWNLOAD_FILE', url, filename });
            console.log('[MediaFetch] background response', res);
            if (res?.ok) return;
        } catch (e) {
            console.log('[MediaFetch] background download failed', e);
        }

        // Try backend fallback if direct CDN download failed
        if (fallbackUrl) {
            console.log('[MediaFetch] Falling back to backend download:', fallbackUrl);
            try {
                const res = await chrome.runtime.sendMessage({ type: 'DOWNLOAD_FILE', url: fallbackUrl, filename });
                if (res?.ok) return;
            } catch (e) {
                console.log('[MediaFetch] Fallback download failed', e);
            }
        }

        // Final fallback: open in new tab
        console.log('[MediaFetch] Fallback: window.open');
        window.open(fallbackUrl || url, '_blank');
    }

    async function startDownload(pageUrl, format, title, isAudio, thumbnail) {
        if (!isContextValid()) {
            showReloadToast();
            return;
        }
        // Close the panel so user can see the video again
        removePanel();

        const ext = isAudio ? 'mp3' : 'mp4';
        const bareFilename = sanitize(title) + '.' + ext;
        const [backendUrl, dlSettings] = await Promise.all([getBackendUrl(), getDownloadSettings()]);
        const filename = buildPath(bareFilename, pageUrl, dlSettings);
        const TIKWM = ['no_watermark_hd', 'no_watermark', 'watermark', 'audio_only'];
        const cdnDirectUrl = TIKWM.includes(format.format_id) ? (format.url || '') : '';
        const params = new URLSearchParams({
            url: pageUrl,
            format_id: format.format_id,
            height: (format.height || format.resolution || 0).toString(),
            filename,
            is_audio: isAudio.toString(),
            needs_merge: (format.needs_merge === true && !cdnDirectUrl).toString(),
            expected_size: (format.filesize_approx || 0).toString(),
            direct_url: cdnDirectUrl,
        });

        const downloadUrl = `${backendUrl}/api/download?${params}`;
        const dlId = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
        const quality = isAudio ? 'Audio'
            : (format.quality || `${format.resolution || format.height || '?'}p`);

        // Register download in shared storage so popup Downloads tab shows it
        const platform = detectPlatform() || 'other';
        chrome.runtime.sendMessage({
            type: 'ADD_DOWNLOAD',
            entry: {
                id: dlId,
                title: title || 'Video',
                thumbnail: thumbnail || '',
                quality,
                platform: platform.charAt(0).toUpperCase() + platform.slice(1),
                status: 'downloading',
                progress: 5,
                speed: '',
                filename,
                timestamp: Date.now(),
            },
        });

        console.log('[MediaFetch] startDownload', { cdnDirectUrl, downloadUrl, dlId });

        // Path 1: TikWM CDN direct
        if (cdnDirectUrl) {
            chrome.runtime.sendMessage({ type: 'DOWNLOAD_FILE', url: cdnDirectUrl, filename, dlId });
            return;
        }

        // Path 2: Audio format (streamed directly, fast starting)
        if (isAudio) {
            chrome.runtime.sendMessage({ type: 'DOWNLOAD_FILE', url: downloadUrl, filename, dlId });
            return;
        }

        // Path 3: Merge job
        chrome.runtime.sendMessage({
            type: 'START_MERGE_JOB',
            downloadUrl,
            filename,
            dlId,
        });

        const toast = document.createElement('div');
        toast.textContent = '⬇ Download started — check extension popup';
        toast.style.cssText = 'position:fixed;z-index:2147483647;bottom:24px;right:24px;background:linear-gradient(135deg,#14b8a6,#0891b2);color:#fff;padding:11px 18px;border-radius:10px;font-family:Inter,system-ui,sans-serif;font-size:13px;font-weight:600;box-shadow:0 8px 24px rgba(20,184,166,0.5);letter-spacing:-0.2px;';
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 3000);
    }

    // ── Render quality panel ───────────────────────────────────────────────────
    // ── Platform-specific panel geometry ──────────────────────────────────────
    // Returns { width, maxH, top, left } tailored to each platform's layout.
    function panelConfig(platform, btn) {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const r  = btn.getBoundingClientRect();

        // Per-platform panel width and max height
        const configs = {
            youtube:         { w: 320, maxH: '75vh' },
            'yt-shorts':     { w: 300, maxH: '70vh' },
            instagram:       { w: 290, maxH: '65vh' },
            tiktok:          { w: 280, maxH: '70vh' },
            twitter:         { w: 310, maxH: '70vh' },
            facebook:        { w: 320, maxH: '70vh' },
            'facebook-shorts': { w: 300, maxH: '70vh' },
            reddit:          { w: 310, maxH: '70vh' },
        };
        const { w, maxH } = configs[platform] || { w: 310, maxH: '70vh' };

        // Default: open below the pill button, aligned to its right edge
        let top  = r.bottom + 10;
        let left = r.right - w;

        // If not enough room below → open above
        if (top + 320 > vh) top = Math.max(10, r.top - 320);

        // Clamp horizontal so panel stays inside viewport
        if (left < 10) left = 10;
        if (left + w > vw - 10) left = vw - w - 10;

        return { w, maxH, top, left };
    }

    function showPanel(btn, data, url) {
        removePanel();
        const panel = document.createElement('div');
        panel.id = PANEL_ID;

        const platform = detectPlatform();
        const cfg = panelConfig(platform, btn);
        panel.style.top     = cfg.top  + 'px';
        panel.style.left    = cfg.left + 'px';
        panel.style.width   = cfg.w    + 'px';
        panel.style.maxHeight = cfg.maxH;

        const closeBtn = document.createElement('button');
        closeBtn.className = 'mf-close';
        closeBtn.textContent = '×';
        closeBtn.onclick = (e) => { e.stopPropagation(); panel.remove(); };
        panel.appendChild(closeBtn);

        // Prevent YouTube / Instagram click handlers from dismissing the panel
        panel.addEventListener('click', e => { e.stopPropagation(); e.stopImmediatePropagation(); });
        panel.addEventListener('mousedown', e => { e.stopPropagation(); e.stopImmediatePropagation(); });

        if (data.error) {
            panel.innerHTML += `<div class="mf-error">${escapeHtml(data.error)}</div>`;
            document.body.appendChild(panel);
            return;
        }

        const thumb = document.createElement('img');
        thumb.className = 'mf-thumb';
        thumb.src = data.thumbnail || '';
        thumb.onerror = () => { thumb.style.display = 'none'; };
        panel.appendChild(thumb);

        const title = document.createElement('div');
        title.className = 'mf-title';
        title.textContent = data.title || 'Video';
        panel.appendChild(title);

        const fmts = data.formats || [];
        const videoFmts = fmts.filter(f => f.is_video);
        const audioFmts = fmts.filter(f => !f.is_video && f.is_audio);

        // Group by resolution, keep highest filesize (best quality) per resolution
        const byRes = new Map();
        for (const f of videoFmts) {
            const res = f.resolution || f.height || 0;
            if (res === 0) continue;
            const existing = byRes.get(res);
            if (!existing || (f.filesize_approx || 0) > (existing.filesize_approx || 0)) {
                byRes.set(res, f);
            }
        }
        const unique = [...byRes.values()].sort((a, b) => {
            const resA = a.resolution || a.height || 0;
            const resB = b.resolution || b.height || 0;
            return resB - resA;
        });
        const bestAudio = audioFmts.sort((a, b) => (b.filesize_approx || 0) - (a.filesize_approx || 0))[0];

        if (unique.length === 0 && !bestAudio) {
            panel.innerHTML += `<div class="mf-empty">No formats found.</div>`;
            document.body.appendChild(panel);
            return;
        }

        if (unique.length > 0) {
            const lbl = document.createElement('div');
            lbl.className = 'mf-group-label';
            lbl.textContent = '🎬 Video';
            panel.appendChild(lbl);
        }

        for (const f of unique) {
            const row = document.createElement('div');
            row.className = 'mf-row';
            const sizeStr = f.filesize_approx ? (f.filesize_approx > 1048576
                ? Math.round(f.filesize_approx / 1048576) + 'MB'
                : Math.round(f.filesize_approx / 1024) + 'KB') : '';
            const badge = f.needs_merge
                ? `<span class="mf-badge-merge">🔄 Merge</span>`
                : `<span class="mf-badge-direct">⚡ Direct</span>`;
            row.innerHTML = `
                <div class="mf-row-left">
                    <span class="mf-q">${(f.quality || `${f.resolution || f.height || '?'}p`).replace(/pp$/, 'p')}</span>
                </div>
                <div class="mf-row-right">
                    ${badge}
                    ${sizeStr ? `<span class="mf-size">${sizeStr}</span>` : ''}
                    <button class="mf-dl-btn" title="Download">⬇</button>
                </div>`;
            row.querySelector('.mf-dl-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                startDownload(url, f, data.title || 'video', false, data.thumbnail);
            });
            panel.appendChild(row);
        }


        if (bestAudio) {
            const audioLbl = document.createElement('div');
            audioLbl.className = 'mf-group-label';
            audioLbl.textContent = '🎵 Audio';
            panel.appendChild(audioLbl);

            const row = document.createElement('div');
            row.className = 'mf-row';
            row.innerHTML = `
                <div class="mf-row-left">
                    <span class="mf-q">MP3</span>
                </div>
                <div class="mf-row-right">
                    <span class="mf-badge-audio">🎵 Audio</span>
                    <button class="mf-dl-btn" title="Download">⬇</button>
                </div>`;
            row.querySelector('.mf-dl-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                startDownload(url, bestAudio, data.title || 'video', true, data.thumbnail);
            });
            panel.appendChild(row);
        }

        document.body.appendChild(panel);
    }

    // ── Main injection ─────────────────────────────────────────────────────────
    async function injectButton() {
        const platform = detectPlatform();
        if (!platform) return;

        const oldBtn = document.getElementById(BTN_ID);
        if (oldBtn) oldBtn.remove();
        removePanel();

        const videoEl = findBestVideo();
        if (!videoEl) {
            console.log('[MediaFetch] No visible video found on', platform);
            return;
        }

        injectStyles();

        // ── Build the pill button ──────────────────────────────────────────────
        const btn = document.createElement('button');
        btn.id = BTN_ID;
        btn.title = 'Download with Media Fetch';

        // Platform label shown in the pill
        const platformLabels = {
            youtube:   'YouTube',
            instagram: 'Instagram',
            tiktok:    'TikTok',
            twitter:   'Twitter / X',
            facebook:  'Facebook',
            reddit:    'Reddit',
        };
        const platformLabel = platformLabels[platform] || 'Video';

        btn.innerHTML = `
            <span class="mf-pill-icon">⬇</span>
            <span class="mf-pill-label">${platformLabel}</span>
        `;
        document.body.appendChild(btn);
        placeButton(btn, videoEl);

        // ── Auto-reposition on video resize / fullscreen ───────────────────────
        // When the user expands or fullscreens the video player the button must
        // follow. ResizeObserver fires on any size change; fullscreenchange covers
        // the viewport-level transition when the player goes true fullscreen.
        let reposTimer = null;
        function reposition() {
            const currentVideo = findBestVideo();
            const b = document.getElementById(BTN_ID);
            if (b && currentVideo) placeButton(b, currentVideo);
        }
        const videoResizeObs = new ResizeObserver(() => {
            clearTimeout(reposTimer);
            reposTimer = setTimeout(reposition, 80);
        });
        videoResizeObs.observe(videoEl);

        document.addEventListener('fullscreenchange', () => {
            // Small delay so the new layout is settled before we read getBoundingClientRect
            setTimeout(reposition, 120);
        });
        window.addEventListener('resize', () => {
            clearTimeout(reposTimer);
            reposTimer = setTimeout(reposition, 80);
        });

        let loading = false;
        let loadAborted = false;

        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            e.preventDefault();

            if (!isContextValid()) {
                showReloadToast();
                return;
            }

            // ── Toggle: if panel is open (loading or loaded), close it ──────────
            if (document.getElementById(PANEL_ID)) {
                loadAborted = true;   // signal in-flight fetch to not show results
                loading = false;
                removePanel();
                return;
            }

            if (loading) return;
            loadAborted = false;
            loading = true;
            removePanel();
            panelOpen = true;

            // ── Loading spinner panel — sized + positioned per platform ─────────
            const platform = detectPlatform();
            const cfg = panelConfig(platform, btn);
            const panel = document.createElement('div');
            panel.id = PANEL_ID;
            panel.style.top       = cfg.top  + 'px';
            panel.style.left      = cfg.left + 'px';
            panel.style.width     = cfg.w    + 'px';
            panel.style.maxHeight = cfg.maxH;
            panel.innerHTML = '<div class="mf-spinner"></div>';
            document.body.appendChild(panel);

            // Route through background service worker — content scripts
            // cannot call fetch() directly because YouTube's CSP blocks it.
            try {
                const pageUrl    = getVideoUrl();
                const backendUrl = await getBackendUrl();

                // Timeout safety: if SW is terminated, sendMessage hangs forever
                const result = await Promise.race([
                    chrome.runtime.sendMessage({ type: 'FETCH_URL', url: pageUrl, backendUrl }),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 15000))
                ]);

                if (loadAborted) return; // user clicked to close while loading

                if (result?.ok && result?.data) {
                    showPanel(btn, result.data, pageUrl);
                } else {
                    showPanel(btn, { error: result?.error || 'Failed to fetch video info' }, pageUrl);
                }
            } catch (err) {
                if (!loadAborted) showPanel(btn, { error: err.message || 'Failed to fetch' }, getVideoUrl());
            } finally {
                loading = false;
            }
        });

        console.log('[MediaFetch] Button injected on', platform);
    }

    // ── SPA watcher ────────────────────────────────────────────────────────────
    let lastUrl = location.href;
    let debounceTimer = null;

    function onNavigate() {
        if (location.href === lastUrl) return;
        lastUrl = location.href;
        const oldBtn = document.getElementById(BTN_ID);
        if (oldBtn) oldBtn.remove();
        removePanel();
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(injectButton, 1800);
    }

    const observer = new MutationObserver(() => {
        onNavigate();
        // Re-inject if button missing but video present — but NOT if panel is open
        if (!panelOpen && !document.getElementById(BTN_ID) && findBestVideo()) {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(injectButton, 800);
        }
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });

    // Also watch popstate for SPA navigation
    window.addEventListener('popstate', onNavigate);

    // Initial inject
    setTimeout(injectButton, 1500);
})();
