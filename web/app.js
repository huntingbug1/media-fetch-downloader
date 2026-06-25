// ── Configuration & State ──────────────────────────────────────────────────
const BACKEND_URL = window.location.origin;
let activeTab = 'downloader';
let downloads = [];
let currentVideoData = null;
let currentVideoUrl = '';

// DOM Elements
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// Toast Notification
function showToast(message, type = 'info') {
    const toast = $('#toast');
    const msgEl = $('#toast-message');
    const iconEl = $('.toast-icon');
    
    msgEl.textContent = message;
    
    // Set style/icon based on type
    if (type === 'success') {
        toast.style.borderColor = '#10b981';
        iconEl.className = 'fa-solid fa-circle-check toast-icon';
        iconEl.style.color = '#10b981';
    } else if (type === 'error') {
        toast.style.borderColor = '#ef4444';
        iconEl.className = 'fa-solid fa-circle-exclamation toast-icon';
        iconEl.style.color = '#ef4444';
    } else {
        toast.style.borderColor = '#0d9488';
        iconEl.className = 'fa-solid fa-circle-info toast-icon';
        iconEl.style.color = '#0d9488';
    }
    
    toast.classList.add('show');
    setTimeout(() => {
        toast.classList.remove('show');
    }, 4000);
}

// ── Tab Switching ─────────────────────────────────────────────────────────────
function switchTab(tabId) {
    activeTab = tabId;
    
    // Update navigation menu
    $$('.nav-item').forEach(btn => {
        if (btn.dataset.tab === tabId) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });
    
    // Update content area
    $$('.tab-content').forEach(section => {
        if (section.id === `tab-${tabId}`) {
            section.classList.add('active');
        } else {
            section.classList.remove('active');
        }
    });
    
    if (tabId === 'downloads') {
        renderDownloads();
    }
}

// Bind Navigation
$$('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// ── Local Storage Persistence ───────────────────────────────────────────────
function loadDownloads() {
    try {
        const stored = localStorage.getItem('mf_downloads');
        downloads = stored ? JSON.parse(stored) : [];
        
        // Resume polling for unfinished downloads
        downloads.forEach(dl => {
            if (['queued', 'downloading', 'merging'].includes(dl.status) && dl.jobId) {
                pollJobStatus(dl.jobId);
            }
        });
        
        updateActiveBadge();
    } catch (e) {
        console.error('Failed to load downloads', e);
        downloads = [];
    }
}

function saveDownloads() {
    try {
        localStorage.setItem('mf_downloads', JSON.stringify(downloads));
        updateActiveBadge();
    } catch (e) {
        console.error('Failed to save downloads', e);
    }
}

function updateActiveBadge() {
    const activeCount = downloads.filter(dl => 
        ['queued', 'downloading', 'merging'].includes(dl.status)
    ).length;
    
    const badge = $('#active-count');
    if (activeCount > 0) {
        badge.textContent = activeCount;
        badge.style.display = 'inline-block';
    } else {
        badge.style.display = 'none';
    }
}

// ── Fetch Video Metadata ─────────────────────────────────────────────────────
async function fetchVideoInfo() {
    const urlInput = $('#video-url').value.trim();
    if (!urlInput) {
        showToast('Please paste a valid video URL first.', 'error');
        return;
    }
    
    currentVideoUrl = urlInput;
    
    // Reset UI state
    hideElement('#video-info-card');
    showElement('#info-loading');
    
    try {
        const response = await fetch(`${BACKEND_URL}/api/info`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: urlInput })
        });
        
        if (!response.ok) {
            const errData = await response.json();
            throw new Error(errData.detail || 'Failed to extract video information.');
        }
        
        const data = await response.json();
        currentVideoData = data;
        
        if (data.entries && Array.isArray(data.entries)) {
            // It is a playlist!
            hideElement('#video-info-card');
            
            $('#playlist-title').textContent = data.title || 'YouTube Playlist';
            $('#playlist-count').textContent = `${data.entries.length} Videos`;
            // Set thumbnail from first item
            $('#playlist-thumbnail').src = data.entries[0]?.thumbnail || 'https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?w=500';
            $('#playlist-platform').textContent = detectPlatform(urlInput);
            
            // Populate preview items
            const listEl = $('#playlist-items-list');
            listEl.innerHTML = '';
            data.entries.slice(0, 10).forEach((entry, idx) => {
                const itemEl = document.createElement('div');
                itemEl.style.fontSize = '12px';
                itemEl.style.display = 'flex';
                itemEl.style.justifyContent = 'space-between';
                itemEl.style.color = 'var(--text-secondary)';
                itemEl.innerHTML = `
                    <span>${idx + 1}. ${entry.title || 'Unknown Title'}</span>
                    <span>${entry.duration ? formatDuration(entry.duration) : ''}</span>
                `;
                listEl.appendChild(itemEl);
            });
            if (data.entries.length > 10) {
                const moreEl = document.createElement('div');
                moreEl.style.fontSize = '11px';
                moreEl.style.color = 'var(--text-muted)';
                moreEl.style.fontStyle = 'italic';
                moreEl.style.marginTop = '4px';
                moreEl.textContent = `... and ${data.entries.length - 10} more videos`;
                listEl.appendChild(moreEl);
            }
            
            hideElement('#info-loading');
            showElement('#playlist-info-card');
            showToast('Playlist loaded successfully!', 'success');
        } else {
            // It is a single video!
            hideElement('#playlist-info-card');
            
            $('#video-title').textContent = data.title || 'Untitled Video';
            $('#video-thumbnail').src = data.thumbnail || 'https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?w=500';
            $('#video-duration').textContent = formatDuration(data.duration);
            $('#video-uploader').textContent = data.uploader || 'Unknown Channel';
            $('#video-platform').textContent = detectPlatform(urlInput);
            
            // Populate Formats Dropdowns
            populateFormats(data.formats || []);
            
            hideElement('#info-loading');
            showElement('#video-info-card');
            showToast('Video information loaded successfully!', 'success');
        }
    } catch (err) {
        hideElement('#info-loading');
        showToast(err.message, 'error');
        console.error(err);
    }
}

$('#btn-fetch').addEventListener('click', fetchVideoInfo);
$('#video-url').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') fetchVideoInfo();
});

// Format Dropdowns Population
function populateFormats(formats) {
    const videoSelect = $('#format-video');
    const audioSelect = $('#format-audio');
    
    videoSelect.innerHTML = '';
    audioSelect.innerHTML = '';
    
    // Sort formats
    const videoFormats = formats.filter(f => f.is_video);
    const audioFormats = formats.filter(f => f.is_audio);
    
    if (videoFormats.length > 0) {
        videoFormats.forEach(f => {
            const qualityStr = f.quality || (f.height ? `${f.height}p` : 'Unknown');
            const sizeStr = f.filesize_approx ? ` (~${formatBytes(f.filesize_approx)})` : '';
            const option = document.createElement('option');
            option.value = JSON.stringify({
                format_id: f.format_id,
                height: f.height || 0,
                needs_merge: f.needs_merge || false,
                expected_size: f.filesize_approx || 0,
                ext: f.extension || 'mp4'
            });
            option.textContent = `${qualityStr} (${f.extension || 'mp4'}) ${sizeStr}`;
            videoSelect.appendChild(option);
        });
    } else {
        const option = document.createElement('option');
        option.textContent = 'No video formats found';
        videoSelect.appendChild(option);
    }
    
    if (audioFormats.length > 0) {
        audioFormats.forEach(f => {
            const bitrateStr = f.quality || 'Best Audio';
            const sizeStr = f.filesize_approx ? ` (~${formatBytes(f.filesize_approx)})` : '';
            const option = document.createElement('option');
            option.value = JSON.stringify({
                format_id: f.format_id,
                expected_size: f.filesize_approx || 0
            });
            option.textContent = `${bitrateStr} (mp3) ${sizeStr}`;
            audioSelect.appendChild(option);
        });
    } else {
        const option = document.createElement('option');
        option.textContent = 'Best Quality MP3';
        option.value = JSON.stringify({ format_id: 'bestaudio', expected_size: 0 });
        option.textContent = 'Best Audio Quality (mp3)';
        audioSelect.appendChild(option);
    }
}

// ── Start Download Job ───────────────────────────────────────────────────────
async function triggerVideoDownload() {
    if (!currentVideoData) return;
    
    const selectedFormat = JSON.parse($('#format-video').value);
    const cleanTitle = sanitizeFilename(currentVideoData.title || 'video');
    const fullFilename = `${cleanTitle}.${selectedFormat.ext}`;
    
    const params = new URLSearchParams({
        url: currentVideoUrl,
        format_id: selectedFormat.format_id,
        height: selectedFormat.height.toString(),
        filename: fullFilename,
        is_audio: 'false',
        needs_merge: selectedFormat.needs_merge.toString(),
        expected_size: selectedFormat.expected_size.toString(),
        is_dashboard: 'true'
    });
    
    try {
        showToast('Initiating background video download job...', 'info');
        const response = await fetch(`${BACKEND_URL}/api/download?${params.toString()}`);
        if (!response.ok) throw new Error('Failed to start download job.');
        
        const data = await response.json();
        
        // Add to local state
        const newDl = {
            id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            jobId: data.job_id,
            title: currentVideoData.title || 'Untitled Video',
            thumbnail: currentVideoData.thumbnail || '',
            status: 'queued',
            progress: 0,
            filename: fullFilename,
            timestamp: Date.now()
        };
        
        downloads.unshift(newDl);
        saveDownloads();
        
        // Switch to downloads tab and trigger render
        switchTab('downloads');
        pollJobStatus(data.job_id);
    } catch (err) {
        showToast(err.message, 'error');
        console.error(err);
    }
}

function triggerAudioDownload() {
    if (!currentVideoData) return;
    
    const selectedFormat = JSON.parse($('#format-audio').value);
    const cleanTitle = sanitizeFilename(currentVideoData.title || 'audio');
    const fullFilename = `${cleanTitle}.mp3`;
    
    const params = new URLSearchParams({
        url: currentVideoUrl,
        format_id: selectedFormat.format_id,
        filename: fullFilename,
        is_audio: 'true',
        needs_merge: 'false',
        expected_size: selectedFormat.expected_size.toString(),
        is_dashboard: 'true'
    });
    
    const downloadUrl = `${BACKEND_URL}/api/download?${params.toString()}`;
    
    // Stream directly via browser file download
    showToast('Starting audio stream conversion. Download will start shortly...', 'success');
    
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = fullFilename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    
    // Add a record in downloads history as a direct download
    const newDl = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        jobId: null,
        title: `${currentVideoData.title || 'Untitled'} (Audio)`,
        thumbnail: currentVideoData.thumbnail || '',
        status: 'ready',
        progress: 100,
        filename: fullFilename,
        directUrl: downloadUrl,
        timestamp: Date.now()
    };
    
    downloads.unshift(newDl);
    saveDownloads();
}

async function triggerPlaylistDownload() {
    if (!currentVideoData || !currentVideoData.entries) return;
    
    const quality = $('#playlist-quality').value;
    const limit = parseInt($('#playlist-limit').value || '0', 10);
    const playlistUrl = currentVideoData.original_url || currentVideoUrl;
    const playlistTitle = sanitizeFilename(currentVideoData.title || 'Playlist');
    
    let videoUrls = currentVideoData.entries
        .map(e => e.url || (e.id ? `https://www.youtube.com/watch?v=${e.id}` : null))
        .filter(Boolean);
        
    if (videoUrls.length === 0) {
        showToast('No videos found in the playlist.', 'error');
        return;
    }
    
    const totalVideos = videoUrls.length;
    if (limit > 0 && limit < videoUrls.length) {
        videoUrls = videoUrls.slice(0, limit);
    }
    
    const countLabel = limit > 0 && limit < totalVideos ? `${videoUrls.length} of ${totalVideos}` : `${videoUrls.length}`;
    const zipFilename = `${playlistTitle}.zip`;
    
    try {
        showToast(`Initiating playlist download (${countLabel} videos)...`, 'info');
        const response = await fetch(`${BACKEND_URL}/api/download-playlist`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                playlist_url: playlistUrl,
                video_urls: videoUrls,
                quality: quality,
                limit: 0,
                is_dashboard: true
            })
        });
        
        if (!response.ok) throw new Error('Failed to start playlist download.');
        
        const data = await response.json();
        
        // Add to local state
        const newDl = {
            id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            jobId: data.job_id,
            title: `📦 ${currentVideoData.title || 'Playlist'} (${countLabel} videos)`,
            thumbnail: 'playlist.png',
            status: 'queued',
            progress: 0,
            filename: zipFilename,
            timestamp: Date.now()
        };
        
        downloads.unshift(newDl);
        saveDownloads();
        
        // Switch to downloads tab and trigger polling
        switchTab('downloads');
        pollJobStatus(data.job_id);
    } catch (err) {
        showToast(err.message, 'error');
        console.error(err);
    }
}

$('#btn-download-video').addEventListener('click', triggerVideoDownload);
$('#btn-download-audio').addEventListener('click', triggerAudioDownload);
$('#btn-download-playlist').addEventListener('click', triggerPlaylistDownload);

// ── Poll Job Status ─────────────────────────────────────────────────────────
async function pollJobStatus(jobId) {
    const interval = setInterval(async () => {
        try {
            const response = await fetch(`${BACKEND_URL}/api/download/status/${jobId}`);
            if (!response.ok) return;
            
            const data = await response.json();
            const dl = downloads.find(d => d.jobId === jobId);
            
            if (!dl) {
                clearInterval(interval);
                return;
            }
            
            dl.status = data.status;
            dl.progress = data.progress;
            
            if (data.status === 'ready') {
                dl.progress = 100;
                showToast(`"${dl.title}" has completed downloading!`, 'success');
                clearInterval(interval);
                
                // Automatically download the file to the browser's downloads folder
                const saveUrl = `${BACKEND_URL}/api/download/file/${jobId}`;
                const a = document.createElement('a');
                a.href = saveUrl;
                a.download = dl.filename;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
            } else if (data.status === 'failed') {
                showToast(`Failed to download "${dl.title}": ${data.error || 'Unknown error'}`, 'error');
                clearInterval(interval);
            }
            
            saveDownloads();
            
            // Only update DOM if currently on downloads tab
            if (activeTab === 'downloads') {
                renderDownloads();
            }
        } catch (e) {
            console.error('Error polling status', e);
        }
    }, 1500);
}

// ── Rendering Downloads Tab ──────────────────────────────────────────────────
function renderDownloads() {
    const container = $('#downloads-container');
    container.innerHTML = '';
    
    if (downloads.length === 0) {
        container.innerHTML = `
            <div class="empty-downloads" id="empty-state">
                <i class="fa-solid fa-folder-open"></i>
                <p>No downloads yet. Go to Downloader to download your first media file.</p>
            </div>
        `;
        return;
    }
    
    downloads.forEach(dl => {
        const card = document.createElement('div');
        card.className = 'download-item glass-panel';
        
        let statusText = 'Processing...';
        let statusClass = 'text-secondary';
        
        if (dl.status === 'queued') statusText = 'Queued in line...';
        else if (dl.status === 'downloading') statusText = `Downloading (${dl.progress}%)`;
        else if (dl.status === 'merging') statusText = 'Merging audio & video...';
        else if (dl.status === 'ready') { statusText = 'Completed'; statusClass = 'text-success'; }
        else if (dl.status === 'failed') { statusText = 'Failed'; statusClass = 'text-danger'; }
        
        const saveUrl = dl.jobId ? `${BACKEND_URL}/api/download/file/${dl.jobId}` : (dl.directUrl || '#');
        
        card.innerHTML = `
            <div class="thumb">
                <img src="${dl.thumbnail || 'https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?w=500'}" alt="Thumb">
            </div>
            <div class="info">
                <h4>${dl.title}</h4>
                <div class="status-row">
                    <span class="${statusClass}">${statusText}</span>
                    <span>${dl.filename}</span>
                </div>
                <div class="progress-wrapper">
                    <div class="progress-container">
                        <div class="progress-fill" style="width: ${dl.progress || 0}%"></div>
                    </div>
                    <span class="progress-percent">${dl.progress || 0}%</span>
                </div>
            </div>
            <div class="actions">
                ${dl.status === 'ready' ? 
                    `<a href="${saveUrl}" class="download-item action-btn btn-save" download="${dl.filename}">
                        <i class="fa-solid fa-download"></i> Save to Device
                     </a>` : 
                    `<button class="download-item action-btn" disabled style="background: rgba(255,255,255,0.05); color: var(--text-muted);">
                        <i class="fa-solid fa-spinner fa-spin"></i> Wait...
                     </button>`
                }
            </div>
        `;
        
        container.appendChild(card);
    });
}

// ── Utility Helpers ──────────────────────────────────────────────────────────
function hideElement(selector) {
    const el = $(selector);
    if (el) el.style.display = 'none';
}

function showElement(selector) {
    const el = $(selector);
    if (el) el.style.display = 'block';
}

function formatDuration(s) {
    if (!s) return '0:00';
    const hrs = Math.floor(s / 3600);
    const mins = Math.floor((s % 3600) / 60);
    const secs = Math.floor(s % 60);
    
    if (hrs > 0) {
        return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    return `${mins}:${String(secs).padStart(2, '0')}`;
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function detectPlatform(url) {
    if (/youtube\.com|youtu\.be/.test(url)) return 'YouTube';
    if (/instagram\.com/.test(url)) return 'Instagram';
    if (/tiktok\.com/.test(url)) return 'TikTok';
    if (/twitter\.com|x\.com/.test(url)) return 'Twitter';
    if (/facebook\.com|fb\.watch/.test(url)) return 'Facebook';
    if (/reddit\.com|v\.redd\.it/.test(url)) return 'Reddit';
    return 'Web Video';
}

function sanitizeFilename(name) {
    return name
        .replace(/[/\\:*?"<>|]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 100);
}

// Initialize on page load
window.addEventListener('DOMContentLoaded', () => {
    loadDownloads();
});
