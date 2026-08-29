/**
 * CloudMe - Frontend Single Page Application Engine
 * Google Drive & Google Photos Hybrid Experience
 */

// Dynamic Server URL handling for Standalone APK & Remote access
window.getCloudMeServerUrl = function() {
  const custom = localStorage.getItem('cloudme_custom_server_url');
  if (custom && custom.trim()) return custom.trim().replace(/\/+$/, '');
  const isNative = (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) || window.location.protocol === 'file:' || (window.location.hostname === 'localhost' && window.location.port !== '8080');
  if (isNative) return 'https://triple-bandwidth-dpi-prototype.trycloudflare.com';
  return window.location.origin;
};

window.apiUrl = function(endpoint) {
  if (!endpoint) return '';
  if (endpoint.startsWith('http://') || endpoint.startsWith('https://') || endpoint.startsWith('blob:') || endpoint.startsWith('data:')) {
    return endpoint;
  }
  const clean = endpoint.startsWith('/') ? endpoint : '/' + endpoint;
  return window.getCloudMeServerUrl() + clean;
};

const _origFetch = window.fetch;
window.fetch = function(input, init) {
  if (typeof input === 'string') {
    if (input.startsWith('/api') || input.startsWith('/webdav')) {
      input = window.apiUrl(input);
    }
  }
  return _origFetch.apply(this, arguments);
};

class CloudMeApp {
  constructor() {
    this.token = localStorage.getItem('cloudme_token');
    this.user = JSON.parse(localStorage.getItem('cloudme_user') || 'null');
    this.currentFolderId = null;
    this.currentNav = 'drive';
    this.currentViewMode = localStorage.getItem('cloudme_view_mode') || 'grid';
    this.selectedItemIds = new Set();
    this.activeContextItem = null;
    this.activeLightboxItem = null;
    this.itemsCache = [];
    this.activeUploads = [];

    this.init();
  }

  async init() {
    this.setupTheme();
    this.setupEventListeners();
    this.updateServerUrlDisplay();
    this.setupPullToRefresh();
    this.setupNativeBackupListener();
    await this.checkSystemStatus();
    if (window.lucide) lucide.createIcons();
  }

  getServerUrl() {
    return window.getCloudMeServerUrl();
  }

  apiUrl(endpoint) {
    return window.apiUrl(endpoint);
  }

  // -------------------------------------------------------------
  // 1. Initial System Check & Auth State
  // -------------------------------------------------------------
  async checkSystemStatus() {
    try {
      const res = await fetch('/api/setup/status');
      const data = await res.json();

      if (!data.isCompleted) {
        // Fresh install -> Open Setup Wizard
        this.openModal('setupWizardModal');
        if (data.defaultStoragePath) {
          const pathInput = document.getElementById('setupStoragePath');
          if (pathInput) pathInput.value = data.defaultStoragePath;
        }
        return;
      }

      if (data.appName) {
        document.getElementById('appBrandTitle').textContent = data.appName;
      }

      // Check public auth config (allowRegistration)
      try {
        const cfgRes = await fetch('/api/auth/config');
        if (cfgRes.ok) {
          const cfg = await cfgRes.json();
          this.allowRegistration = cfg.allowRegistration !== false;
          this.updateRegisterUI();
        }
      } catch(e) {}

      // If opening a public share URL, do NOT ask for login
      if (window.location.hash.startsWith('#share/')) {
        this.handleHashChange();
        return;
      }

      // Check if logged in
      if (!this.token || !this.user) {
        this.updateRegisterUI();
        this.openModal('authModal');
        return;
      }

      // Validate token with /api/auth/me
      const meRes = await fetch('/api/auth/me', {
        headers: { 'Authorization': `Bearer ${this.token}` }
      });

      if (!meRes.ok) {
        this.logout();
        return;
      }

      const meData = await meRes.json();
      this.user = meData.user;
      localStorage.setItem('cloudme_user', JSON.stringify(this.user));

      this.updateUserUI();
      this.handleHashChange();
    } catch (err) {
      console.error('System check failed:', err);
      this.showToast('Gagal terhubung ke server', 'error');
    }
  }

  updateUserUI() {
    if (!this.user) return;
    const initial = this.user.username.charAt(0).toUpperCase();
    document.getElementById('userAvatarInitial').textContent = initial;
    document.getElementById('userDisplayName').textContent = this.user.username;

    // Show Admin link if role is admin
    const adminNav = document.querySelector('.admin-only');
    if (adminNav) {
      adminNav.style.display = this.user.role === 'admin' ? 'flex' : 'none';
    }

    // Update Quota Bar
    const used = this.user.usedBytes || 0;
    const total = this.user.quotaBytes || (50 * 1024 * 1024 * 1024);
    const percent = Math.min(100, Math.round((used / total) * 100));

    document.getElementById('storageProgressBar').style.width = `${percent}%`;
    document.getElementById('storagePercentText').textContent = `${percent}%`;
    document.getElementById('storageUsedText').textContent = this.formatBytes(used);
    document.getElementById('storageTotalText').textContent = this.formatBytes(total);
  }

  updateRegisterUI() {
    const prompt = document.getElementById('authRegisterPrompt');
    const notice = document.getElementById('authRegisterDisabledNotice');
    if (prompt && notice) {
      if (this.allowRegistration === false) {
        prompt.style.display = 'none';
        notice.style.display = 'block';
      } else {
        prompt.style.display = 'block';
        notice.style.display = 'none';
      }
    }
  }

  // -------------------------------------------------------------
  // 2. Event Listeners & Router
  // -------------------------------------------------------------
  setupEventListeners() {
    window.addEventListener('hashchange', () => this.handleHashChange());

    // Navigation item clicks
    document.querySelectorAll('.nav-item').forEach(el => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        const nav = el.getAttribute('data-nav');
        window.location.hash = nav;
      });
    });

    // Mobile Hamburger Button
    document.getElementById('btnToggleMobileSidebar')?.addEventListener('click', () => this.toggleMobileSidebar(true));

    // Bottom Nav clicks
    document.querySelectorAll('.bottom-nav-item[data-bottom-nav]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        const nav = el.getAttribute('data-bottom-nav');
        window.location.hash = nav;
      });
    });

    // Theme toggle
    document.getElementById('btnThemeToggle')?.addEventListener('click', () => this.toggleTheme());

    // User Menu dropdown toggle
    const userBtn = document.getElementById('btnUserMenu');
    const userDropdown = document.getElementById('userMenuDropdown');
    userBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      userDropdown.style.display = userDropdown.style.display === 'block' ? 'none' : 'block';
    });

    // + New Action dropdown
    const newBtn = document.getElementById('btnNewAction');
    const newDropdown = document.getElementById('newMenuDropdown');
    newBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      newDropdown.style.display = newDropdown.style.display === 'block' ? 'none' : 'block';
    });

    // Global click listener to close dropdowns & context menu
    document.addEventListener('click', () => {
      if (userDropdown) userDropdown.style.display = 'none';
      if (newDropdown) newDropdown.style.display = 'none';
      this.closeContextMenu();
    });

    // Global Search listener with debounce
    let searchTimeout;
    const searchInput = document.getElementById('globalSearchInput');
    const typeFilter = document.getElementById('searchTypeFilter');
    const onSearch = () => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => this.loadFiles(), 300);
    };
    searchInput?.addEventListener('input', onSearch);
    typeFilter?.addEventListener('change', onSearch);

    // View Switcher (Grid vs List)
    document.getElementById('btnViewGrid')?.addEventListener('click', () => this.setViewMode('grid'));
    document.getElementById('btnViewList')?.addEventListener('click', () => this.setViewMode('list'));

    // Sort By Selector
    document.getElementById('sortBySelector')?.addEventListener('change', () => this.loadFiles());

    // Drag and drop anywhere
    const dropZone = document.getElementById('mainDropZone');
    window.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.style.border = '2px dashed var(--accent-primary)';
    });
    window.addEventListener('dragleave', (e) => {
      if (e.clientX === 0 || e.clientY === 0) {
        dropZone.style.border = 'none';
      }
    });
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.style.border = 'none';
      if (e.dataTransfer && e.dataTransfer.files.length > 0) {
        this.handleFilesSelected(e.dataTransfer.files);
      }
    });
  }

  toggleMobileSidebar(open) {
    const sidebar = document.getElementById('appSidebar');
    const backdrop = document.getElementById('sidebarBackdrop');
    if (sidebar) sidebar.classList.toggle('mobile-open', open);
    if (backdrop) backdrop.classList.toggle('active', open);
  }

  openMobileActionSheet() {
    this.openModal('mobileActionSheetModal');
    if (window.lucide) lucide.createIcons();
  }

  handleHashChange() {
    const rawHash = window.location.hash.replace('#', '') || 'drive';
    const parts = rawHash.split('/');
    const nav = parts[0];
    this.currentNav = nav;

    // Auto-close sidebar drawer on mobile after navigation
    this.toggleMobileSidebar(false);

    // 1. PUBLIC SHARE ROUTE (Guest Mode - No Login Required)
    if (nav === 'share') {
      const shareToken = parts[1];
      const sidebar = document.getElementById('appSidebar');
      const bottomNav = document.querySelector('.mobile-bottom-nav');
      const fab = document.getElementById('mobileFab');
      const toolbar = document.querySelector('.content-toolbar');

      if (sidebar) sidebar.style.display = 'none';
      if (bottomNav) bottomNav.style.display = 'none';
      if (fab) fab.style.display = 'none';
      if (toolbar) toolbar.style.display = 'none';

      document.getElementById('foldersSection').style.display = 'none';
      document.getElementById('filesSectionGrid').style.display = 'none';
      document.getElementById('filesSectionList').style.display = 'none';
      document.getElementById('photosTimelineView').style.display = 'none';
      document.getElementById('mobileBackupView').style.display = 'none';
      document.getElementById('adminPanelView').style.display = 'none';
      document.getElementById('emptyStateContainer').style.display = 'none';
      document.getElementById('publicShareView').style.display = 'block';

      this.loadPublicShare(shareToken);
      return;
    }

    // Normal Logged In Mode
    const sidebar = document.getElementById('appSidebar');
    const bottomNav = document.querySelector('.mobile-bottom-nav');
    const fab = document.getElementById('mobileFab');
    const toolbar = document.querySelector('.content-toolbar');
    const isFileView = (nav === 'drive' || nav === 'starred' || nav === 'recent' || nav === 'trash');

    if (sidebar) sidebar.style.display = 'flex';
    if (bottomNav) bottomNav.style.display = '';
    if (fab) fab.style.display = isFileView ? '' : 'none';
    if (toolbar) toolbar.style.display = isFileView ? 'flex' : 'none';
    document.getElementById('publicShareView').style.display = 'none';

    // If not logged in, prompt auth
    if (!this.token || !this.user) {
      this.openModal('authModal');
      return;
    }

    // Handle Folder Navigation (e.g. #drive/folderId)
    if (nav === 'drive' && parts[1]) {
      this.currentFolderId = parts[1];
    } else if (nav === 'drive') {
      this.currentFolderId = null;
    }

    // Update active nav class for sidebar links
    document.querySelectorAll('.nav-item').forEach(el => {
      el.classList.toggle('active', el.getAttribute('data-nav') === nav);
    });

    // Update active class for mobile bottom navigation bar
    document.querySelectorAll('.bottom-nav-item[data-bottom-nav]').forEach(el => {
      el.classList.toggle('active', el.getAttribute('data-bottom-nav') === nav);
    });

    // Switch view containers
    document.getElementById('foldersSection').style.display = (nav === 'drive' || nav === 'starred' || nav === 'recent') ? 'block' : 'none';
    document.getElementById('filesSectionGrid').style.display = (this.currentViewMode === 'grid' && (nav === 'drive' || nav === 'starred' || nav === 'recent' || nav === 'trash')) ? 'block' : 'none';
    document.getElementById('filesSectionList').style.display = (this.currentViewMode === 'list' && (nav === 'drive' || nav === 'starred' || nav === 'recent' || nav === 'trash')) ? 'block' : 'none';
    document.getElementById('photosTimelineView').style.display = nav === 'photos' ? 'block' : 'none';
    document.getElementById('mobileBackupView').style.display = nav === 'mobile-sync' ? 'block' : 'none';
    document.getElementById('adminPanelView').style.display = nav === 'admin' ? 'block' : 'none';
    document.getElementById('emptyStateContainer').style.display = 'none';

    this.clearSelection();

    if (nav === 'photos') {
      this.loadPhotosTimeline();
    } else if (nav === 'mobile-sync') {
      this.renderMobileSyncHub();
    } else if (nav === 'admin') {
      this.loadAdminPanel();
    } else {
      this.loadFiles();
    }
  }

  // -------------------------------------------------------------
  // Public Share Page Loader (Guest Accessible: Files & Folders)
  // -------------------------------------------------------------
  async loadPublicShare(token) {
    const container = document.getElementById('publicShareView');
    if (!token) {
      container.innerHTML = '<div style="text-align: center; padding: 3rem;">Token tautan tidak valid.</div>';
      return;
    }

    container.innerHTML = '<div style="text-align: center; padding: 3rem; color: var(--text-muted);">Memuat berkas / folder publik...</div>';

    try {
      const res = await fetch(`/api/shares/${token}`);
      const data = await res.json();

      if (!res.ok) {
        container.innerHTML = `
          <div style="max-width: 500px; margin: 3rem auto; text-align: center; background: var(--bg-card); padding: 2.5rem; border-radius: var(--radius-xl); border: 1px solid var(--border-color); box-shadow: var(--shadow-xl);">
            <i data-lucide="alert-circle" style="width: 56px; height: 56px; color: var(--color-danger); margin-bottom: 1rem;"></i>
            <h2 style="font-size: 1.35rem; margin-bottom: 0.5rem;">Tautan Tidak Ditemukan</h2>
            <p style="color: var(--text-muted); font-size: 0.9rem; margin-bottom: 1.5rem;">${data.error || 'Tautan berbagi ini mungkin sudah dihapus atau kedaluwarsa.'}</p>
            <a href="/" class="btn btn-primary">Buka CloudMe</a>
          </div>
        `;
        if (window.lucide) lucide.createIcons();
        return;
      }

      // CASE 1: MULTI-FILE BUNDLE SHARE
      if (data.isMulti) {
        this.renderPublicMultiShare(token, data);
        return;
      }

      // CASE 2: SHARED FOLDER EXPLORER
      if (data.isFolder) {
        if (data.requiresPassword) {
          container.innerHTML = `
            <div style="max-width: 520px; margin: 3rem auto; background: var(--bg-card); padding: 2.25rem; border-radius: var(--radius-xl); border: 1px solid var(--border-color); box-shadow: var(--shadow-xl);">
              <div style="display: flex; align-items: center; gap: 0.6rem; margin-bottom: 1.25rem;">
                <div class="brand-logo" style="width: 32px; height: 32px;">
                  <i data-lucide="cloud" style="width: 18px; height: 18px;"></i>
                </div>
                <span style="font-weight: 700; font-size: 1.1rem;">CloudMe</span>
              </div>
              <div style="text-align: center; margin-bottom: 1.5rem;">
                <div style="width: 60px; height: 60px; border-radius: 50%; background: rgba(245, 158, 11, 0.15); color: #f59e0b; display: flex; align-items: center; justify-content: center; margin: 0 auto 1rem auto;">
                  <i data-lucide="lock" style="width: 28px; height: 28px;"></i>
                </div>
                <h3 style="font-size: 1.2rem; margin-bottom: 0.35rem;">Folder Diproteksi Password</h3>
                <p style="font-size: 0.85rem; color: var(--text-muted);">Folder <strong>"${this.escapeHtml(data.name)}"</strong> dibagikan oleh <strong>${this.escapeHtml(data.ownerName)}</strong></p>
              </div>
              <div class="form-group">
                <label class="form-label">Masukkan Password Akses Folder:</label>
                <input type="password" id="publicFolderPassInput" class="form-input" placeholder="Password folder..." autofocus>
              </div>
              <button class="btn btn-primary" style="width: 100%; padding: 0.75rem;" onclick="app.verifyPublicFolderPassword('${token}')">
                <i data-lucide="key" style="width: 16px; height: 16px;"></i>
                <span>Buka Folder</span>
              </button>
            </div>
          `;
          if (window.lucide) lucide.createIcons();
          return;
        }

        // Directly load folder contents
        await this.loadSharedFolderContents(token, null, '');
        return;
      }

      // CASE 2: SINGLE FILE VIEWER
      const isImg = data.mimeType && data.mimeType.startsWith('image/');
      const isVid = data.mimeType && data.mimeType.startsWith('video/');
      const isAud = data.mimeType && data.mimeType.startsWith('audio/');

      let previewHtml = '';
      if (isImg) {
        previewHtml = `<div style="max-height: 360px; overflow: hidden; border-radius: var(--radius-lg); margin-bottom: 1.5rem; background: var(--bg-tertiary); display: flex; align-items: center; justify-content: center;">
          <img src="${this.apiUrl('/api/shares/' + token + '/preview')}" style="max-width: 100%; max-height: 360px; object-fit: contain;" alt="${this.escapeHtml(data.name)}">
        </div>`;
      } else if (isVid) {
        previewHtml = `<div style="border-radius: var(--radius-lg); overflow: hidden; margin-bottom: 1.5rem; background: #000;">
          <video controls autoplay style="width: 100%; max-height: 360px;">
            <source src="${this.apiUrl('/api/shares/' + token + '/preview')}" type="${data.mimeType}">
          </video>
        </div>`;
      } else if (isAud) {
        previewHtml = `<div style="padding: 1.5rem; background: var(--bg-tertiary); border-radius: var(--radius-lg); margin-bottom: 1.5rem; text-align: center;">
          <audio controls autoplay style="width: 100%;">
            <source src="${this.apiUrl('/api/shares/' + token + '/preview')}" type="${data.mimeType}">
          </audio>
        </div>`;
      }

      container.innerHTML = `
        <div style="max-width: 600px; margin: 2rem auto; background: var(--bg-card); padding: 2rem; border-radius: var(--radius-xl); border: 1px solid var(--border-color); box-shadow: var(--shadow-xl);">
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 1.5rem; border-bottom: 1px solid var(--border-color); padding-bottom: 1rem;">
            <div style="display: flex; align-items: center; gap: 0.6rem;">
              <div class="brand-logo" style="width: 32px; height: 32px;">
                <i data-lucide="cloud" style="width: 18px; height: 18px;"></i>
              </div>
              <span style="font-weight: 700; font-size: 1.1rem;">CloudMe</span>
            </div>
            <a href="/" class="btn btn-secondary" style="font-size: 0.8rem; padding: 0.4rem 0.8rem;">Masuk ke Akun</a>
          </div>

          ${previewHtml}

          <div style="display: flex; align-items: flex-start; gap: 1rem; margin-bottom: 1.5rem;">
            <div style="width: 48px; height: 48px; border-radius: var(--radius-lg); background: var(--bg-tertiary); display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
              <i data-lucide="${this.getFileIcon(data.mimeType)}" style="width: 24px; height: 24px; color: var(--accent-primary);"></i>
            </div>
            <div style="flex: 1; overflow: hidden;">
              <h2 style="font-size: 1.25rem; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-bottom: 0.25rem;">
                ${this.escapeHtml(data.name)}
              </h2>
              <div style="font-size: 0.85rem; color: var(--text-muted); display: flex; gap: 1rem; flex-wrap: wrap;">
                <span>${this.formatBytes(data.sizeBytes)}</span>
                <span>Dibagikan oleh <strong>${this.escapeHtml(data.ownerName)}</strong></span>
              </div>
            </div>
          </div>

          <!-- Password Prompt if Required -->
          ${data.requiresPassword ? `
            <div style="background: var(--bg-tertiary); padding: 1.25rem; border-radius: var(--radius-lg); margin-bottom: 1.5rem; border: 1px solid var(--border-color);">
              <label class="form-label">🔐 Berkas Ini Diproteksi Password:</label>
              <div style="display: flex; gap: 0.5rem; margin-top: 0.5rem;">
                <input type="password" id="publicSharePassword" class="form-input" placeholder="Masukkan password...">
                <button class="btn btn-primary" onclick="app.downloadPublicShareWithPass('${token}')">Unduh</button>
              </div>
            </div>
          ` : ''}

          <!-- Action Buttons -->
          <div style="display: flex; gap: 0.75rem; flex-wrap: wrap;">
            ${data.allowDownload ? `
              <a href="${this.apiUrl('/api/shares/' + token + '/download')}" class="btn btn-primary" style="flex: 1; padding: 0.8rem 1.25rem; text-decoration: none; font-size: 0.95rem; justify-content: center;">
                <i data-lucide="download" style="width: 18px; height: 18px;"></i>
                <span>Unduh Berkas (${this.formatBytes(data.sizeBytes)})</span>
              </a>
            ` : `
              <div style="color: var(--text-muted); font-size: 0.85rem; padding: 0.5rem;">Pengunduhan dinonaktifkan oleh pemilik file.</div>
            `}
          </div>
        </div>
      `;

      if (window.lucide) lucide.createIcons();
    } catch (err) {
      container.innerHTML = '<div style="color: var(--color-danger); text-align: center; padding: 3rem;">Gagal memuat berkas.</div>';
    }
  }

  verifyPublicFolderPassword(token) {
    const input = document.getElementById('publicFolderPassInput');
    const pass = input ? input.value : '';
    if (!pass) {
      this.showAlert('Password Diperlukan', 'Silakan masukkan password untuk membuka folder.', 'warning');
      return;
    }
    this.publicFolderPassword = pass;
    this.loadSharedFolderContents(token, null, pass);
  }

  async loadSharedFolderContents(token, folderId = null, password = '') {
    const container = document.getElementById('publicShareView');
    const pwd = password || this.publicFolderPassword || '';
    const query = new URLSearchParams();
    if (folderId) query.set('folderId', folderId);
    if (pwd) query.set('password', pwd);

    try {
      const res = await fetch(`/api/shares/${token}/contents?${query.toString()}`);
      const data = await res.json();

      if (!res.ok) {
        this.showAlert('Akses Ditolak', data.error || 'Gagal memuat isi folder.', 'error');
        return;
      }

      const { rootFolderId, currentFolder, breadcrumbs, items } = data;
      const subfolders = items.filter(i => i.is_folder === 1);
      const files = items.filter(i => i.is_folder === 0);

      container.innerHTML = `
        <div style="max-width: 1000px; margin: 1.5rem auto; padding: 0 1rem;">
          <!-- Top Header -->
          <div style="background: var(--bg-card); padding: 1.25rem 1.5rem; border-radius: var(--radius-xl); border: 1px solid var(--border-color); box-shadow: var(--shadow-md); margin-bottom: 1.5rem; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 1rem;">
            <div style="display: flex; align-items: center; gap: 0.75rem;">
              <div class="brand-logo" style="width: 36px; height: 36px;">
                <i data-lucide="folder" style="width: 20px; height: 20px; color: #fbbf24;"></i>
              </div>
              <div>
                <h2 style="font-size: 1.25rem; font-weight: 700; margin-bottom: 2px;">${this.escapeHtml(breadcrumbs[0]?.name || currentFolder.name)}</h2>
                <div style="font-size: 0.8rem; color: var(--text-muted);">
                  Folder Bersama Publik • ${items.length} item di direktori ini
                </div>
              </div>
            </div>

            <div style="display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap;">
              <a href="/api/shares/${token}/download-zip${pwd ? `?password=${encodeURIComponent(pwd)}` : ''}" class="btn btn-primary" style="padding: 0.6rem 1.2rem; font-size: 0.88rem; text-decoration: none;">
                <i data-lucide="archive" style="width: 16px; height: 16px;"></i>
                <span>Unduh Seluruh Folder (ZIP)</span>
              </a>
              <a href="/" class="btn btn-secondary" style="font-size: 0.88rem; padding: 0.6rem 1rem;">Masuk Akun</a>
            </div>
          </div>

          <!-- Breadcrumbs Navigation -->
          <div style="display: flex; align-items: center; gap: 0.5rem; font-size: 0.95rem; margin-bottom: 1.25rem; background: var(--bg-secondary); padding: 0.75rem 1rem; border-radius: var(--radius-lg); border: 1px solid var(--border-color); flex-wrap: wrap;">
            <i data-lucide="folder-open" style="width: 18px; height: 18px; color: #fbbf24;"></i>
            ${breadcrumbs.map((b, idx) => `
              <span class="breadcrumb-item ${idx === breadcrumbs.length - 1 ? 'active' : ''}" style="cursor: pointer; ${idx === breadcrumbs.length - 1 ? 'font-weight: 600; color: var(--text-primary);' : 'color: var(--text-secondary);'}" onclick="app.loadSharedFolderContents('${token}', '${b.id}', '${pwd}')">
                ${this.escapeHtml(b.name)}
              </span>
              ${idx < breadcrumbs.length - 1 ? '<span style="color: var(--text-muted);">/</span>' : ''}
            `).join('')}
          </div>

          <!-- Subfolders Section -->
          ${subfolders.length > 0 ? `
            <div style="margin-bottom: 1.75rem;">
              <h4 style="font-size: 0.85rem; font-weight: 600; text-transform: uppercase; color: var(--text-muted); margin-bottom: 0.75rem;">Folder (${subfolders.length})</h4>
              <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 1rem;">
                ${subfolders.map(f => `
                  <div class="folder-card" style="cursor: pointer; transition: all var(--transition-fast);" onclick="app.loadSharedFolderContents('${token}', '${f.id}', '${pwd}')">
                    <i data-lucide="folder" class="folder-icon" style="color: #fbbf24;"></i>
                    <span class="folder-name" style="font-weight: 500;">${this.escapeHtml(f.name)}</span>
                    <i data-lucide="chevron-right" style="width: 16px; height: 16px; margin-left: auto; color: var(--text-muted);"></i>
                  </div>
                `).join('')}
              </div>
            </div>
          ` : ''}

          <!-- Files Section -->
          <div>
            <h4 style="font-size: 0.85rem; font-weight: 600; text-transform: uppercase; color: var(--text-muted); margin-bottom: 0.75rem;">Berkas (${files.length})</h4>
            ${files.length === 0 && subfolders.length === 0 ? `
              <div style="text-align: center; padding: 3rem; background: var(--bg-card); border-radius: var(--radius-lg); color: var(--text-muted); border: 1px solid var(--border-color);">
                <i data-lucide="folder-open" style="width: 48px; height: 48px; margin-bottom: 0.75rem;"></i>
                <p>Folder ini kosong.</p>
              </div>
            ` : `
              <div class="file-table-container" style="background: var(--bg-card); border-radius: var(--radius-xl); border: 1px solid var(--border-color); box-shadow: var(--shadow-md);">
                <table class="file-table" style="width: 100%;">
                  <thead>
                    <tr>
                      <th>Nama Berkas</th>
                      <th>Ukuran</th>
                      <th>Tipe</th>
                      <th>Terakhir Diubah</th>
                      <th style="text-align: right;">Aksi</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${files.map(f => `
                      <tr>
                        <td>
                          <div style="display: flex; align-items: center; gap: 0.6rem;">
                            <i data-lucide="${this.getFileIcon(f.mime_type)}" style="width: 18px; height: 18px; color: var(--accent-primary);"></i>
                            <span style="font-weight: 500;">${this.escapeHtml(f.name)}</span>
                          </div>
                        </td>
                        <td>${this.formatBytes(f.size_bytes)}</td>
                        <td>${f.mime_type || 'File'}</td>
                        <td>${new Date(f.updated_at).toLocaleDateString('id-ID')}</td>
                        <td style="text-align: right;">
                          <div style="display: flex; justify-content: flex-end; gap: 0.4rem;">
                            <a href="/api/shares/${token}/file/${f.id}/preview${pwd ? `?password=${encodeURIComponent(pwd)}` : ''}" target="_blank" class="btn btn-secondary" style="padding: 0.3rem 0.6rem; font-size: 0.78rem;">
                              <i data-lucide="eye" style="width: 13px; height: 13px;"></i>
                              <span>Lihat</span>
                            </a>
                            <a href="/api/shares/${token}/file/${f.id}/download${pwd ? `?password=${encodeURIComponent(pwd)}` : ''}" class="btn btn-primary" style="padding: 0.3rem 0.6rem; font-size: 0.78rem; text-decoration: none;">
                              <i data-lucide="download" style="width: 13px; height: 13px;"></i>
                              <span>Unduh</span>
                            </a>
                          </div>
                        </td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
            `}
          </div>
        </div>
      `;

      if (window.lucide) lucide.createIcons();
    } catch (err) {
      container.innerHTML = '<div style="color: var(--color-danger); text-align: center; padding: 3rem;">Gagal memuat isi folder.</div>';
    }
  }

  renderPublicMultiShare(token, data) {
    const container = document.getElementById('publicShareContainer');
    const items = data.items || [];

    container.innerHTML = `
      <div style="max-width: 800px; margin: 2rem auto; background: var(--bg-card); padding: 1.5rem 2rem; border-radius: var(--radius-xl); border: 1px solid var(--border-color); box-shadow: var(--shadow-xl); box-sizing: border-box; width: 100%;">
        <!-- Header -->
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 1.25rem; border-bottom: 1px solid var(--border-color); padding-bottom: 1rem; flex-wrap: wrap; gap: 0.75rem;">
          <div style="display: flex; align-items: center; gap: 0.6rem;">
            <div class="brand-logo" style="width: 34px; height: 34px; background: var(--accent-gradient);">
              <i data-lucide="layers" style="width: 18px; height: 18px; color: #fff;"></i>
            </div>
            <div>
              <span style="font-weight: 700; font-size: 1.1rem; display: block;">CloudMe Share</span>
              <span style="font-size: 0.78rem; color: var(--text-muted);">Dibagikan oleh <strong>${this.escapeHtml(data.ownerName)}</strong></span>
            </div>
          </div>
          <a href="/" class="btn btn-secondary" style="font-size: 0.8rem; padding: 0.4rem 0.8rem;">Masuk ke Akun</a>
        </div>

        <!-- Collection Summary Card -->
        <div style="display: flex; align-items: center; justify-content: space-between; background: var(--bg-tertiary); padding: 1.25rem; border-radius: var(--radius-lg); margin-bottom: 1.5rem; flex-wrap: wrap; gap: 1rem;">
          <div>
            <h2 style="font-size: 1.2rem; font-weight: 700; margin-bottom: 0.25rem;">${this.escapeHtml(data.name)}</h2>
            <div style="font-size: 0.85rem; color: var(--text-muted); display: flex; gap: 1rem;">
              <span>📦 ${data.itemsCount} berkas</span>
              <span>💾 Total: ${this.formatBytes(data.sizeBytes)}</span>
            </div>
          </div>
          ${data.allowDownload ? `
            <a href="/api/shares/${token}/download" class="btn btn-primary" style="padding: 0.65rem 1.25rem; font-size: 0.88rem; text-decoration: none;">
              <i data-lucide="download" style="width: 16px; height: 16px;"></i>
              <span>Unduh Semua (.ZIP)</span>
            </a>
          ` : ''}
        </div>

        <!-- Password Prompt if Required -->
        ${data.requiresPassword ? `
          <div style="background: var(--bg-tertiary); padding: 1.25rem; border-radius: var(--radius-lg); margin-bottom: 1.5rem; border: 1px solid var(--border-color);">
            <label class="form-label">🔐 Koleksi Ini Diproteksi Password:</label>
            <div style="display: flex; gap: 0.5rem; margin-top: 0.5rem;">
              <input type="password" id="publicSharePassword" class="form-input" placeholder="Masukkan password...">
              <button class="btn btn-primary" onclick="app.downloadPublicShareWithPass('${token}')">Buka & Unduh</button>
            </div>
          </div>
        ` : ''}

        <!-- Files List Table -->
        <div style="overflow-x: auto;">
          <table class="file-table" style="width: 100%;">
            <thead>
              <tr>
                <th style="text-align: left;">Nama Berkas</th>
                <th style="width: 110px;">Ukuran</th>
                <th style="width: 110px; text-align: right;">Aksi</th>
              </tr>
            </thead>
            <tbody>
              ${items.map(item => `
                <tr>
                  <td>
                    <div style="display: flex; align-items: center; gap: 0.6rem;">
                      <i data-lucide="${this.getFileIcon(item.mime_type)}" style="width: 18px; height: 18px; color: var(--accent-primary); flex-shrink: 0;"></i>
                      <span style="font-weight: 500; word-break: break-all;">${this.escapeHtml(item.name)}</span>
                    </div>
                  </td>
                  <td style="color: var(--text-muted); font-size: 0.85rem;">${this.formatBytes(item.size_bytes)}</td>
                  <td style="text-align: right;">
                    <div style="display: inline-flex; gap: 0.4rem; justify-content: flex-end;">
                      <a href="/api/shares/${token}/file/${item.id}/preview" target="_blank" class="btn btn-secondary" style="padding: 4px 8px; font-size: 0.75rem; text-decoration: none;" title="Lihat">
                        <i data-lucide="eye" style="width: 13px; height: 13px;"></i>
                      </a>
                      <a href="/api/shares/${token}/file/${item.id}/download" class="btn btn-primary" style="padding: 4px 8px; font-size: 0.75rem; text-decoration: none;" title="Unduh Berkas">
                        <i data-lucide="download" style="width: 13px; height: 13px;"></i>
                      </a>
                    </div>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;

    if (window.lucide) lucide.createIcons();
  }

  downloadPublicShareWithPass(token) {
    const passInput = document.getElementById('publicSharePassword');
    const password = passInput ? passInput.value : '';
    if (!password) {
      this.showAlert('Password Diperlukan', 'Silakan masukkan password berkas.', 'warning');
      return;
    }
    window.location.href = `/api/shares/${token}/download?password=${encodeURIComponent(password)}`;
  }

  setViewMode(mode) {
    this.currentViewMode = mode;
    localStorage.setItem('cloudme_view_mode', mode);
    
    document.getElementById('btnViewGrid').style.background = mode === 'grid' ? 'var(--bg-secondary)' : 'transparent';
    document.getElementById('btnViewList').style.background = mode === 'list' ? 'var(--bg-secondary)' : 'transparent';

    if (this.currentNav === 'drive' || this.currentNav === 'starred' || this.currentNav === 'recent' || this.currentNav === 'trash') {
      document.getElementById('filesSectionGrid').style.display = mode === 'grid' ? 'block' : 'none';
      document.getElementById('filesSectionList').style.display = mode === 'list' ? 'block' : 'none';
    }
  }

  // -------------------------------------------------------------
  // 3. Load & Render Files / Folders (Google Drive Style)
  // -------------------------------------------------------------
  async loadFiles() {
    const search = document.getElementById('globalSearchInput')?.value || '';
    const type = document.getElementById('searchTypeFilter')?.value || 'all';
    const sortVal = document.getElementById('sortBySelector')?.value || 'name_asc';
    const [sortBy, sortOrder] = sortVal.split('_');

    const params = new URLSearchParams({
      parentId: this.currentFolderId || 'root',
      view: this.currentNav === 'drive' ? 'all' : this.currentNav,
      search,
      type,
      sortBy: sortBy === 'date' ? 'updated_at' : sortBy,
      sortOrder
    });

    try {
      const res = await fetch(`/api/files?${params.toString()}`, {
        headers: { 'Authorization': `Bearer ${this.token}` }
      });
      const data = await res.json();
      this.itemsCache = data.items || [];

      this.renderBreadcrumbs(data.breadcrumbs || []);
      this.renderItems(this.itemsCache);
    } catch (err) {
      console.error('Load files error:', err);
    }
  }

  renderBreadcrumbs(breadcrumbs) {
    const container = document.getElementById('breadcrumbContainer');
    if (!container) return;

    if (this.currentNav === 'starred') {
      container.innerHTML = `<span class="breadcrumb-item active">⭐ Favorit (Starred)</span>`;
      return;
    }
    if (this.currentNav === 'recent') {
      container.innerHTML = `<span class="breadcrumb-item active">🕒 Terbaru (Recent)</span>`;
      return;
    }
    if (this.currentNav === 'trash') {
      container.innerHTML = `<span class="breadcrumb-item active">🗑️ Sampah (Trash)</span>`;
      return;
    }

    container.innerHTML = breadcrumbs.map((bc, idx) => {
      const isLast = idx === breadcrumbs.length - 1;
      const targetHash = bc.id === 'root' ? '#drive' : `#drive/${bc.id}`;
      return `
        <span class="breadcrumb-item ${isLast ? 'active' : ''}" onclick="window.location.hash='${targetHash}'">${bc.name}</span>
        ${!isLast ? '<span class="breadcrumb-separator">/</span>' : ''}
      `;
    }).join('');
  }

  renderItems(items) {
    const folderGrid = document.getElementById('folderGrid');
    const fileGrid = document.getElementById('fileGrid');
    const tableBody = document.getElementById('fileTableBody');
    const emptyState = document.getElementById('emptyStateContainer');
    const foldersSection = document.getElementById('foldersSection');

    folderGrid.innerHTML = '';
    fileGrid.innerHTML = '';
    tableBody.innerHTML = '';

    const folders = items.filter(i => i.is_folder === 1);
    const files = items.filter(i => i.is_folder === 0);

    if (items.length === 0) {
      if (this.currentNav !== 'photos' && this.currentNav !== 'mobile-sync' && this.currentNav !== 'admin') {
        emptyState.style.display = 'block';
      } else {
        emptyState.style.display = 'none';
      }
      foldersSection.style.display = 'none';
      return;
    }
    emptyState.style.display = 'none';

    const emptyTrashBtn = document.getElementById('btnEmptyTrash');
    if (emptyTrashBtn) {
      emptyTrashBtn.style.display = this.currentView === 'trash' && items.length > 0 ? 'inline-flex' : 'none';
    }

    // 1. Render Folders
    if (folders.length > 0) {
      foldersSection.style.display = 'block';
      folders.forEach(f => {
        const el = document.createElement('div');
        el.className = `folder-card ${this.selectedItemIds.has(f.id) ? 'selected' : ''}`;
        el.setAttribute('data-item-id', f.id);
        el.innerHTML = `
          <i data-lucide="folder" class="folder-icon" style="color: #fbbf24; flex-shrink: 0;"></i>
          <span class="folder-name" style="flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${this.escapeHtml(f.name)}</span>
          ${f.is_starred ? '<i data-lucide="star" style="width: 14px; height: 14px; color: #f59e0b; flex-shrink: 0;"></i>' : ''}
          <button class="btn-icon" style="width: 28px; height: 28px; margin-left: auto; flex-shrink: 0;" title="Opsi Folder" onclick="event.stopPropagation(); app.showContextMenu(event, app.getItemById('${f.id}'))">
            <i data-lucide="more-vertical" style="width: 14px; height: 14px;"></i>
          </button>
        `;
        el.addEventListener('click', (e) => this.handleItemClick(e, f));
        el.addEventListener('dblclick', () => {
          window.location.hash = `#drive/${f.id}`;
        });
        el.addEventListener('contextmenu', (e) => this.showContextMenu(e, f));
        folderGrid.appendChild(el);
      });
    } else {
      foldersSection.style.display = 'none';
    }

    // 2. Render Files (Grid Cards)
    files.forEach(f => {
      const el = document.createElement('div');
      el.className = `file-card ${this.selectedItemIds.has(f.id) ? 'selected' : ''}`;
      el.setAttribute('data-item-id', f.id);
      
      let thumbnailHtml = `<i data-lucide="${this.getFileIcon(f.mime_type)}" class="file-icon-placeholder"></i>`;
      if (f.mime_type && f.mime_type.startsWith('image/')) {
        thumbnailHtml = `
          <img src="${this.apiUrl('/api/files/' + f.id + '/preview?token=' + this.token)}" class="file-thumb-img" alt="${this.escapeHtml(f.name)}" loading="lazy" decoding="async" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
          <div style="display: none; width: 100%; height: 100%; align-items: center; justify-content: center;">
            <i data-lucide="image" style="width: 36px; height: 36px; color: var(--text-muted);"></i>
          </div>
        `;
      } else if (f.mime_type && f.mime_type.startsWith('video/')) {
        thumbnailHtml = `
          <div style="position: relative; width: 100%; height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; background: linear-gradient(135deg, #18181b 0%, #09090b 100%); overflow: hidden;">
            <div style="width: 44px; height: 44px; border-radius: 50%; background: rgba(99, 102, 241, 0.35); border: 1.5px solid rgba(99, 102, 241, 0.7); display: flex; align-items: center; justify-content: center;">
              <i data-lucide="play" style="width: 20px; height: 20px; color: #ffffff; margin-left: 2px;"></i>
            </div>
            <span style="font-size: 0.72rem; color: rgba(255,255,255,0.7); margin-top: 6px;">Video</span>
          </div>
        `;
      }

      el.innerHTML = `
        <div class="file-thumbnail-container" style="position: relative;">
          ${thumbnailHtml}
          <button class="btn-icon" style="position: absolute; top: 6px; right: 6px; background: rgba(15, 23, 42, 0.85); color: #ffffff; width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; z-index: 5;" title="Opsi Berkas" onclick="event.stopPropagation(); app.showContextMenu(event, app.getItemById('${f.id}'))">
            <i data-lucide="more-vertical" style="width: 14px; height: 14px;"></i>
          </button>
        </div>
        <div class="file-card-body">
          <div class="file-card-title">${this.escapeHtml(f.name)}</div>
          <div class="file-card-meta">
            <span>${this.formatBytes(f.size_bytes)}</span>
            <span>${new Date(f.updated_at).toLocaleDateString('id-ID')}</span>
          </div>
        </div>
      `;

      el.addEventListener('click', (e) => this.handleItemClick(e, f));
      el.addEventListener('dblclick', () => this.openLightbox(f));
      el.addEventListener('contextmenu', (e) => this.showContextMenu(e, f));
      fileGrid.appendChild(el);
    });

    // 3. Render Files & Folders (List Table)
    items.forEach(item => {
      const tr = document.createElement('tr');
      tr.className = this.selectedItemIds.has(item.id) ? 'selected' : '';
      tr.setAttribute('data-item-id', item.id);
      const isFolder = item.is_folder === 1;

      tr.innerHTML = `
        <td onclick="event.stopPropagation();">
          <input type="checkbox" data-item-id="${item.id}" ${this.selectedItemIds.has(item.id) ? 'checked' : ''} onchange="app.toggleItemSelect('${item.id}', this.checked)">
        </td>
        <td>
          <div style="display: flex; align-items: center; gap: 0.6rem;">
            <i data-lucide="${isFolder ? 'folder' : this.getFileIcon(item.mime_type)}" style="width: 18px; height: 18px; color: ${isFolder ? '#fbbf24' : 'var(--accent-primary)'};"></i>
            <span style="font-weight: 500;">${this.escapeHtml(item.name)}</span>
            ${item.is_starred ? '<i data-lucide="star" style="width: 14px; height: 14px; color: #f59e0b;"></i>' : ''}
          </div>
        </td>
        <td>${isFolder ? '—' : this.formatBytes(item.size_bytes)}</td>
        <td>${isFolder ? 'Folder' : (item.mime_type || 'File')}</td>
        <td>${new Date(item.updated_at).toLocaleString('id-ID')}</td>
        <td style="text-align: right;" onclick="event.stopPropagation();">
          <button class="btn-icon" style="width: 28px; height: 28px;" onclick="app.showContextMenu(event, app.getItemById('${item.id}'))">
            <i data-lucide="more-vertical" style="width: 14px; height: 14px;"></i>
          </button>
        </td>
      `;

      tr.addEventListener('click', (e) => this.handleItemClick(e, item));
      tr.addEventListener('dblclick', () => {
        if (isFolder) window.location.hash = `#drive/${item.id}`;
        else this.openLightbox(item);
      });
      tr.addEventListener('contextmenu', (e) => this.showContextMenu(e, item));
      tableBody.appendChild(tr);
    });

    this.updateSelectionUI();
    if (window.lucide) lucide.createIcons();
  }

  // -------------------------------------------------------------
  // 4. Google Photos Timeline View
  // -------------------------------------------------------------
  async loadPhotosTimeline() {
    const view = document.getElementById('photosTimelineView');
    view.innerHTML = '<div style="text-align: center; padding: 2rem; color: var(--text-muted);">Memuat foto & video...</div>';

    try {
      const res = await fetch('/api/photos/timeline', {
        headers: { 'Authorization': `Bearer ${this.token}` }
      });
      const data = await res.json();
      const timeline = data.timeline || [];

      if (timeline.length === 0) {
        view.innerHTML = `
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem; flex-wrap: wrap; gap: 0.75rem;">
            <div>
              <h2 style="font-size: 1.35rem; font-weight: 700;">📸 Galeri Foto & Video</h2>
              <p style="font-size: 0.85rem; color: var(--text-muted);">Disusun otomatis berdasarkan tanggal pengambilan asli.</p>
            </div>
            <button class="btn btn-secondary" onclick="app.openTakeoutModal()" style="font-size: 0.85rem;">
              <i data-lucide="package-check" style="width: 16px; height: 16px; color: #ec4899;"></i>
              <span>Migrasi Google Takeout</span>
            </button>
          </div>
          <div style="text-align: center; padding: 4rem 1rem; color: var(--text-muted);">
            <i data-lucide="image" style="width: 64px; height: 64px; margin-bottom: 1rem;"></i>
            <h3>Belum ada foto atau video</h3>
            <p style="font-size: 0.9rem; margin-top: 0.5rem;">Unggah foto, gunakan migrasi Google Takeout, atau sambungkan aplikasi Android untuk auto-backup.</p>
          </div>
        `;
        if (window.lucide) lucide.createIcons();
        return;
      }

      view.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem; flex-wrap: wrap; gap: 0.75rem;">
          <div>
            <h2 style="font-size: 1.35rem; font-weight: 700;">📸 Galeri Foto & Video</h2>
            <p style="font-size: 0.85rem; color: var(--text-muted);">Disusun otomatis berdasarkan tanggal pengambilan asli.</p>
          </div>
          <button class="btn btn-secondary" onclick="app.openTakeoutModal()" style="font-size: 0.85rem;">
            <i data-lucide="package-check" style="width: 16px; height: 16px; color: #ec4899;"></i>
            <span>Migrasi Google Takeout</span>
          </button>
        </div>
      ` + timeline.map(group => {
        const allGroupSelected = group.items.length > 0 && group.items.every(i => this.selectedItemIds.has(i.id));
        return `
        <div class="photos-timeline-group">
          <div class="timeline-date-header" style="display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; flex-wrap: wrap;">
            <div style="display: flex; align-items: center; gap: 0.5rem;">
              <i data-lucide="calendar" style="width: 17px; height: 17px; color: var(--accent-primary);"></i>
              <span>${this.escapeHtml(group.displayDate)}</span>
              <span style="font-size: 0.78rem; color: var(--text-muted); font-weight: normal;">(${group.items.length} media)</span>
            </div>
            <button type="button" class="btn btn-secondary" style="padding: 2px 10px; font-size: 0.74rem; border-radius: var(--radius-full);" onclick="app.toggleGroupSelect('${this.escapeHtml(group.displayDate)}')">
              <i data-lucide="${allGroupSelected ? 'check-square' : 'check'}" style="width: 12px; height: 12px;"></i>
              <span>${allGroupSelected ? 'Batal Pilih' : 'Pilih Tanggal Ini'}</span>
            </button>
          </div>
          <div class="photos-grid">
            ${group.items.map(item => {
              const isVideo = item.mime_type && item.mime_type.startsWith('video/');
              const isSel = this.selectedItemIds.has(item.id);
              if (isVideo) {
                return `
                  <div class="photo-card ${isSel ? 'selected' : ''}" data-item-id="${item.id}" onclick="app.handlePhotoClick(event, app.getItemById('${item.id}'))" style="background: linear-gradient(135deg, #18181b 0%, #09090b 100%);">
                    <button type="button" class="photo-select-btn ${isSel ? 'selected' : ''}" title="Pilih video ini" onclick="app.togglePhotoSelect(event, '${item.id}')">
                      <i data-lucide="${isSel ? 'check' : 'circle'}" style="width: 14px; height: 14px;"></i>
                    </button>
                    <button type="button" class="photo-menu-btn" title="Opsi Video" onclick="event.stopPropagation(); app.showContextMenu(event, app.getItemById('${item.id}'))">
                      <i data-lucide="more-vertical" style="width: 14px; height: 14px;"></i>
                    </button>
                    <div style="width: 100%; height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 10px; pointer-events: none;">
                      <div style="width: 48px; height: 48px; border-radius: 50%; background: rgba(99, 102, 241, 0.35); border: 1.5px solid rgba(99, 102, 241, 0.7); display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 14px rgba(0,0,0,0.5);">
                        <i data-lucide="play" style="width: 22px; height: 22px; color: #ffffff; margin-left: 2px;"></i>
                      </div>
                      <span style="font-size: 0.72rem; color: rgba(255,255,255,0.75); margin-top: 8px; text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 90%;">${this.escapeHtml(item.name)}</span>
                    </div>
                    <div class="photo-overlay-badge" style="display: flex; align-items: center; gap: 4px;">
                      <i data-lucide="video" style="width: 12px; height: 12px;"></i>
                      <span>Video</span>
                    </div>
                  </div>
                `;
              }
              return `
                <div class="photo-card ${isSel ? 'selected' : ''}" data-item-id="${item.id}" onclick="app.handlePhotoClick(event, app.getItemById('${item.id}'))">
                  <button type="button" class="photo-select-btn ${isSel ? 'selected' : ''}" title="Pilih foto ini" onclick="app.togglePhotoSelect(event, '${item.id}')">
                    <i data-lucide="${isSel ? 'check' : 'circle'}" style="width: 14px; height: 14px;"></i>
                  </button>
                  <button type="button" class="photo-menu-btn" title="Opsi Foto" onclick="event.stopPropagation(); app.showContextMenu(event, app.getItemById('${item.id}'))">
                    <i data-lucide="more-vertical" style="width: 14px; height: 14px;"></i>
                  </button>
                  <img src="${this.apiUrl('/api/files/' + item.id + '/preview?token=' + this.token)}" alt="${this.escapeHtml(item.name)}" loading="lazy" decoding="async" onerror="this.style.display='none'; if(this.nextElementSibling) this.nextElementSibling.style.display='flex';">
                  <div style="display: none; width: 100%; height: 100%; align-items: center; justify-content: center; background: var(--bg-tertiary);">
                    <i data-lucide="image" style="width: 32px; height: 32px; color: var(--text-muted);"></i>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      `;
      }).join('');

      this.timelineCache = timeline;

      // Add timeline items to cache
      this.itemsCache = [];
      timeline.forEach(g => g.items.forEach(i => {
        this.itemsCache.push(i);
      }));

      if (window.lucide) lucide.createIcons();
    } catch (err) {
      view.innerHTML = '<div style="color: var(--color-danger); text-align: center; padding: 2rem;">Gagal memuat galeri foto.</div>';
    }
  }

  // -------------------------------------------------------------
  // 5. Android Auto-Backup Hub
  // -------------------------------------------------------------
  async renderMobileSyncHub() {
    const view = document.getElementById('mobileBackupView');
    const origin = this.getServerUrl();
    const webdavUrl = `${origin}/webdav`;

    view.innerHTML = `
      <div style="max-width: 800px; margin: 0 auto; width: 100%; box-sizing: border-box;">
        <div class="sync-hub-card">
          <div style="display: flex; align-items: center; gap: 1rem; margin-bottom: 1.5rem; flex-wrap: wrap;">
            <div class="brand-logo" style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); flex-shrink: 0;">
              <i data-lucide="smartphone" style="width: 24px; height: 24px;"></i>
            </div>
            <div style="flex: 1; min-width: 200px;">
              <h2 style="font-size: 1.3rem; font-weight: 700; line-height: 1.3;">Backup Otomatis Foto & Video Android</h2>
              <p style="color: var(--text-muted); font-size: 0.82rem; margin-top: 2px;">Sinkronisasi galeri HP Android langsung ke server CloudMe Anda</p>
            </div>
          </div>

          <!-- Native In-App Auto Backup Card -->
          <div class="sync-param-card" style="background: linear-gradient(135deg, rgba(99, 102, 241, 0.15) 0%, rgba(168, 85, 247, 0.1) 100%); border: 1.5px solid var(--accent-primary); margin-bottom: 2rem; padding: 1.25rem; border-radius: var(--radius-lg);">
            <div style="display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; margin-bottom: 1rem;">
              <div style="display: flex; align-items: center; gap: 0.75rem;">
                <div style="width: 44px; height: 44px; border-radius: 50%; background: var(--accent-primary); display: flex; align-items: center; justify-content: center; color: #fff; flex-shrink: 0;">
                  <i data-lucide="camera" style="width: 22px; height: 22px;"></i>
                </div>
                <div>
                  <h3 style="font-size: 1.1rem; font-weight: 700; color: #fff;">Cadangkan Galeri HP Otomatis</h3>
                  <p id="nativeBackupSubtitle" style="font-size: 0.82rem; color: var(--text-secondary); margin-top: 2px;">Otomatis upload foto & video baru dari kamera HP di latar belakang</p>
                </div>
              </div>
              <button id="btnToggleNativeBackup" class="btn btn-primary" style="padding: 0.65rem 1.25rem; font-weight: 600;" onclick="app.toggleNativeAutoBackup()">
                <i data-lucide="power" style="width: 16px; height: 16px;"></i>
                <span id="txtToggleNativeBackup">Aktifkan Auto-Backup</span>
              </button>
            </div>

            <div style="display: flex; align-items: center; justify-content: space-between; border-top: 1px solid var(--border-color); padding-top: 0.85rem; margin-top: 0.5rem; flex-wrap: wrap; gap: 0.75rem;">
              <div style="font-size: 0.85rem; color: var(--text-muted); flex: 1; min-width: 180px;">
                Status: <strong id="nativeBackupStatusText" style="color: var(--text-primary);">Memeriksa...</strong>
              </div>
              <div style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
                <button id="btnCancelNativeSync" class="btn btn-secondary" style="padding: 0.45rem 0.85rem; font-size: 0.82rem; color: #ef4444; border-color: rgba(239, 68, 68, 0.3);" onclick="app.cancelNativeSync()">
                  <i data-lucide="square" style="width: 14px; height: 14px;"></i>
                  <span>Hentikan Sync</span>
                </button>
                <button id="btnSyncNowNative" class="btn btn-secondary" style="padding: 0.45rem 0.9rem; font-size: 0.82rem;" onclick="app.triggerNativeSyncNow()">
                  <i data-lucide="refresh-cw" style="width: 14px; height: 14px;"></i>
                  <span>Sinkronkan Sekarang</span>
                </button>
              </div>
            </div>
          </div>

          <div class="sync-steps-grid">
            <div class="sync-step-card">
              <div class="sync-step-num">1</div>
              <div class="sync-step-title">Gunakan WebDAV</div>
              <div class="sync-step-desc">Aplikasi backup HP (seperti FolderSync) dapat otomatis upload file kamera baru via WebDAV.</div>
            </div>
            <div class="sync-step-card">
              <div class="sync-step-num">2</div>
              <div class="sync-step-title">Atur Jadwal Sync</div>
              <div class="sync-step-desc">Atur agar sync hanya berjalan saat terhubung Wi-Fi dan HP sedang di-charge baterai.</div>
            </div>
            <div class="sync-step-card">
              <div class="sync-step-num">3</div>
              <div class="sync-step-title">Otomatis Terindeks</div>
              <div class="sync-step-desc">Foto yang masuk langsung muncul di galeri timeline berdasarkan tanggal pengambilan asli.</div>
            </div>
          </div>

          <h3 style="font-size: 1.05rem; margin-bottom: 0.6rem; color: var(--accent-primary); display: flex; align-items: center; gap: 0.5rem;">
            <i data-lucide="refresh-cw" style="width: 18px; height: 18px;"></i>
            <span>Cara 1: Gunakan Aplikasi Background Sync (FolderSync / AutoSync)</span>
          </h3>
          <p style="font-size: 0.88rem; color: var(--text-secondary); margin-bottom: 1rem; line-height: 1.5;">
            Aplikasi gratis seperti <strong>FolderSync</strong> di Google Play Store mendukung auto-upload foto baru saat terhubung Wi-Fi dan saat HP sedang diisi daya (*charging*).
          </p>

          <div class="sync-param-card">
            <div class="sync-param-row">
              <span class="sync-param-label">Protokol:</span>
              <span style="font-weight: 600; font-size: 0.92rem;">WebDAV (HTTPS / HTTP)</span>
            </div>

            <div class="sync-param-row">
              <span class="sync-param-label">Server URL (WebDAV):</span>
              <div class="sync-param-value-container">
                <code class="sync-param-code">${webdavUrl}</code>
                <button class="btn btn-secondary" style="padding: 0.4rem 0.75rem; font-size: 0.78rem; white-space: nowrap; flex-shrink: 0;" onclick="app.copyText('${webdavUrl}', 'URL WebDAV berhasil disalin!')">
                  <i data-lucide="copy" style="width: 14px; height: 14px;"></i>
                  <span>Salin URL</span>
                </button>
              </div>
            </div>

            <div class="sync-param-row">
              <span class="sync-param-label">Username Akun:</span>
              <div class="sync-param-value-container">
                <strong style="font-size: 0.95rem;">${this.user ? this.escapeHtml(this.user.username) : 'username_anda'}</strong>
                <button class="btn btn-secondary" style="padding: 0.4rem 0.75rem; font-size: 0.78rem; white-space: nowrap; flex-shrink: 0;" onclick="app.copyText('${this.user ? this.escapeHtml(this.user.username) : ''}', 'Username berhasil disalin!')">
                  <i data-lucide="copy" style="width: 14px; height: 14px;"></i>
                  <span>Salin User</span>
                </button>
              </div>
            </div>

            <div class="sync-param-row">
              <span class="sync-param-label">Password:</span>
              <span style="font-size: 0.88rem; color: var(--text-secondary);">Gunakan password akun CloudMe Anda</span>
            </div>
          </div>

          <h3 style="font-size: 1.05rem; margin-bottom: 0.6rem; color: var(--accent-primary); display: flex; align-items: center; gap: 0.5rem;">
            <i data-lucide="qr-code" style="width: 18px; height: 18px;"></i>
            <span>Cara 2: PWA Mobile Web & QR Code Akses</span>
          </h3>
          <p style="font-size: 0.88rem; color: var(--text-secondary); margin-bottom: 1rem; line-height: 1.5;">
            Buka link web ini di browser Chrome di HP Anda, lalu pilih <strong>"Tambahkan ke Layar Utama / Install App"</strong> untuk membuka CloudMe layaknya aplikasi native.
          </p>

          <div class="sync-qr-section">
            <div style="background: #ffffff; padding: 10px; border-radius: var(--radius-md); box-shadow: var(--shadow-sm); flex-shrink: 0; display: inline-flex;">
              <img src="${this.apiUrl('/api/shares/test/qr')}" style="width: 110px; height: 110px; display: block;" alt="QR Code Link" id="mobileHubQr">
            </div>
            <div style="flex: 1; min-width: 0; text-align: left;">
              <div style="font-weight: 600; font-size: 0.9rem; margin-bottom: 0.35rem;">Alamat Akses Server:</div>
              <div style="margin-bottom: 0.75rem;">
                <code class="sync-param-code" style="display: block;">${origin}</code>
              </div>
              <button class="btn btn-secondary" style="padding: 0.4rem 0.75rem; font-size: 0.78rem;" onclick="app.copyText('${origin}', 'Alamat server berhasil disalin!')">
                <i data-lucide="copy" style="width: 14px; height: 14px;"></i>
                <span>Salin Alamat Server</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    `;

    if (window.lucide) lucide.createIcons();
    this.checkNativeBackupStatus();
  }

  setupNativeBackupListener() {
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.AutoBackup) {
      window.Capacitor.Plugins.AutoBackup.addListener('syncProgress', (data) => {
        const statusText = document.getElementById('nativeBackupStatusText');
        if (statusText && data && data.status) {
          statusText.innerHTML = `<span style="color: var(--accent-primary); font-weight: 600;">🔄 ${this.escapeHtml(data.status)}</span>`;
        }
        if (data && data.current > 0 && data.current === data.total) {
          setTimeout(() => {
            this.checkNativeBackupStatus();
            if (this.currentNav === 'photos') this.loadPhotosTimeline();
          }, 1500);
        }
      });
    }
  }

  setupPullToRefresh() {
    let startY = 0;
    let currentY = 0;
    let isPulling = false;
    let isRefreshing = false;
    const threshold = 70;

    const indicator = document.getElementById('pullToRefreshIndicator');
    const icon = document.getElementById('ptrIcon');
    const text = document.getElementById('ptrText');
    if (!indicator) return;

    window.addEventListener('touchstart', (e) => {
      const mainContent = document.querySelector('.main-content');
      const scrollEl = document.scrollingElement || document.documentElement || document.body;
      const scrollTop = mainContent ? mainContent.scrollTop : Math.max(scrollEl.scrollTop, window.scrollY, 0);

      if (scrollTop <= 2 && !isRefreshing) {
        startY = e.touches[0].clientY;
        isPulling = true;
      } else {
        isPulling = false;
      }
    }, { passive: true });

    window.addEventListener('touchmove', (e) => {
      if (!isPulling || isRefreshing) return;
      currentY = e.touches[0].clientY;
      const deltaY = currentY - startY;

      if (deltaY > 10) {
        const pullDistance = Math.min(deltaY * 0.45, 90);
        indicator.style.opacity = Math.min(pullDistance / threshold, 1);
        indicator.style.transform = `translateY(${pullDistance}px)`;

        if (pullDistance >= threshold * 0.7) {
          if (text) text.textContent = 'Lepaskan untuk memuat ulang';
          if (icon) icon.style.transform = 'rotate(180deg)';
        } else {
          if (text) text.textContent = 'Tarik untuk memuat ulang';
          if (icon) icon.style.transform = 'rotate(0deg)';
        }
      }
    }, { passive: true });

    window.addEventListener('touchend', async () => {
      if (!isPulling || isRefreshing) return;
      isPulling = false;
      const deltaY = currentY - startY;
      const pullDistance = Math.min(deltaY * 0.45, 90);

      if (pullDistance >= threshold * 0.7) {
        isRefreshing = true;
        indicator.style.transform = `translateY(55px)`;
        indicator.style.opacity = '1';
        if (text) text.textContent = 'Memperbarui...';
        if (icon) {
          icon.style.transform = 'rotate(0deg)';
          icon.classList.add('spin');
        }

        try {
          await this.refreshCurrentView();
        } catch (err) {
          console.error('Refresh error:', err);
        }

        setTimeout(() => {
          indicator.style.transform = `translateY(0)`;
          indicator.style.opacity = '0';
          if (icon) icon.classList.remove('spin');
          isRefreshing = false;
          startY = 0;
          currentY = 0;
        }, 500);
      } else {
        indicator.style.transform = `translateY(0)`;
        indicator.style.opacity = '0';
        startY = 0;
        currentY = 0;
      }
    }, { passive: true });
  }

  async checkNativeBackupStatus() {
    const statusText = document.getElementById('nativeBackupStatusText');
    const toggleBtn = document.getElementById('btnToggleNativeBackup');
    const toggleTxt = document.getElementById('txtToggleNativeBackup');
    if (!statusText || !toggleBtn) return;

    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.AutoBackup) {
      try {
        const res = await window.Capacitor.Plugins.AutoBackup.getStatus();
        if (res && res.isEnabled) {
          statusText.innerHTML = `<span style="color: var(--color-success); font-weight: 600;">● Aktif</span> (Total ${res.totalUploaded || 0} foto tercadangkan)`;
          toggleBtn.className = 'btn btn-secondary';
          if (toggleTxt) toggleTxt.textContent = 'Matikan Auto-Backup';
          return;
        }
      } catch (err) {
        console.warn('AutoBackup getStatus error:', err);
      }
    }

    statusText.innerHTML = `<span style="color: var(--text-muted);">Nonaktif</span>`;
    toggleBtn.className = 'btn btn-primary';
    if (toggleTxt) toggleTxt.textContent = 'Aktifkan Auto-Backup';
  }

  async toggleNativeAutoBackup() {
    if (!window.Capacitor || !window.Capacitor.Plugins || !window.Capacitor.Plugins.AutoBackup) {
      this.showToast('Fitur auto-backup otomatis tersedia saat membuka aplikasi CloudMe di HP Android.', 'info');
      return;
    }

    try {
      const status = await window.Capacitor.Plugins.AutoBackup.getStatus();
      if (status && status.isEnabled) {
        await window.Capacitor.Plugins.AutoBackup.disableAutoBackup();
        this.showToast('Auto-backup galeri dinonaktifkan.', 'info');
        this.checkNativeBackupStatus();
        return;
      }

      // Check / Request media permissions from Android system dialog
      if (!status.hasPermission) {
        this.showToast('Meminta izin akses foto & video galeri...', 'info');
        const permRes = await window.Capacitor.Plugins.AutoBackup.requestPermissions();
        if (!permRes || !permRes.granted) {
          this.showToast('⚠️ Izin akses media ditolak. Mohon izinkan akses di Pengaturan Aplikasi HP.', 'error');
          return;
        }
      }

      const serverUrl = this.getServerUrl();
      await window.Capacitor.Plugins.AutoBackup.enableAutoBackup({
        serverUrl: serverUrl,
        token: this.token,
        intervalMinutes: 15
      });
      this.showToast('✅ Auto-backup aktif! Memindai foto galeri...', 'success');
      this.checkNativeBackupStatus();
    } catch (err) {
      this.showToast('Gagal mengubah status auto-backup: ' + (err.message || err), 'error');
    }
  }

  async triggerNativeSyncNow() {
    if (!window.Capacitor || !window.Capacitor.Plugins || !window.Capacitor.Plugins.AutoBackup) {
      this.showToast('Fitur sinkronisasi langsung tersedia di aplikasi Android.', 'info');
      return;
    }

    try {
      // Also ensure permissions before syncNow
      const status = await window.Capacitor.Plugins.AutoBackup.getStatus();
      if (!status.hasPermission) {
        const permRes = await window.Capacitor.Plugins.AutoBackup.requestPermissions();
        if (!permRes || !permRes.granted) {
          this.showToast('⚠️ Izin akses media diperlukan untuk sinkronisasi.', 'error');
          return;
        }
      }

      await window.Capacitor.Plugins.AutoBackup.syncNow();
      this.showToast('🔄 Memindai galeri dan menyinkronkan foto baru...', 'info');
      setTimeout(() => {
        this.checkNativeBackupStatus();
        if (this.currentNav === 'photos') this.loadPhotosTimeline();
      }, 3500);
    } catch (err) {
      this.showToast('Gagal memicu sinkronisasi: ' + (err.message || err), 'error');
    }
  }

  async cancelNativeSync() {
    if (!window.Capacitor || !window.Capacitor.Plugins || !window.Capacitor.Plugins.AutoBackup) {
      this.showToast('Fitur kontrol sinkronisasi tersedia di aplikasi Android.', 'info');
      return;
    }

    try {
      await window.Capacitor.Plugins.AutoBackup.cancelSync();
      const statusText = document.getElementById('nativeBackupStatusText');
      if (statusText) statusText.innerHTML = '<span style="color: #ef4444; font-weight: 600;">⛔ Sinkronisasi dihentikan</span>';
      this.showToast('⛔ Sinkronisasi galeri berhasil dihentikan.', 'info');
      setTimeout(() => this.checkNativeBackupStatus(), 1200);
    } catch (err) {
      this.showToast('Gagal membatalkan sinkronisasi: ' + (err.message || err), 'error');
    }
  }

  // -------------------------------------------------------------
  // 6. Admin Panel View
  // -------------------------------------------------------------
  async loadAdminPanel() {
    const view = document.getElementById('adminPanelView');
    view.innerHTML = '<div style="text-align: center; padding: 2rem;">Memuat data administrator & media penyimpanan...</div>';

    try {
      const [statsRes, usersRes, drivesRes] = await Promise.all([
        fetch('/api/admin/stats', { headers: { 'Authorization': `Bearer ${this.token}` } }),
        fetch('/api/admin/users', { headers: { 'Authorization': `Bearer ${this.token}` } }),
        fetch('/api/admin/drives', { headers: { 'Authorization': `Bearer ${this.token}` } })
      ]);

      const statsData = await statsRes.json();
      const usersData = await usersRes.json();
      const drivesData = await drivesRes.json();
      this.serverDiskInfo = (statsData.system && statsData.system.disk) ? statsData.system.disk : null;

      const disk = this.serverDiskInfo || { totalBytes: 0, freeBytes: 0, usedBytes: 0, usedPercent: 0 };
      const diskTotalFormatted = this.formatBytes(disk.totalBytes);
      const diskFreeFormatted = this.formatBytes(disk.freeBytes);
      const diskUsedFormatted = this.formatBytes(disk.usedBytes);

      view.innerHTML = `
        <div style="max-width: 1000px; margin: 0 auto;">
          <h2 style="font-size: 1.5rem; margin-bottom: 1.5rem;">⚙️ Admin Dashboard & Server Monitor</h2>

          <!-- Physical Server Hard Disk Overview Gauge -->
          <div style="background: var(--bg-card); border: 1px solid var(--border-color); padding: 1.5rem; border-radius: var(--radius-xl); margin-bottom: 1.5rem; box-shadow: var(--shadow-md);">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; flex-wrap: wrap; gap: 0.5rem;">
              <div style="display: flex; align-items: center; gap: 0.6rem;">
                <i data-lucide="hard-drive" style="width: 22px; height: 22px; color: var(--accent-primary);"></i>
                <h3 style="font-size: 1.1rem; font-weight: 600;">Status Hard Disk Fisik Server</h3>
              </div>
              <div style="font-size: 0.85rem; color: var(--text-muted);">
                Sisa Ruang Bebas: <strong style="color: var(--color-success);">${diskFreeFormatted}</strong> / Total ${diskTotalFormatted}
              </div>
            </div>
            
            <div class="storage-bar-bg" style="height: 12px; margin-bottom: 0.5rem;">
              <div class="storage-bar-fill" style="width: ${disk.usedPercent}%; background: ${disk.usedPercent > 85 ? 'var(--color-danger)' : 'linear-gradient(90deg, #6366f1, #38bdf8)'};"></div>
            </div>
            <div style="display: flex; justify-content: space-between; font-size: 0.8rem; color: var(--text-muted); flex-wrap: wrap; gap: 0.5rem;">
              <span>Terpakai oleh seluruh file server: <strong>${diskUsedFormatted}</strong> (${disk.usedPercent}%)</span>
              <span>Platform: <strong>${statsData.system.platform} (${statsData.system.arch})</strong></span>
            </div>
          </div>

          <!-- Physical Drives & Storage Path Configuration (Select HDD / SSD Drive) -->
          <div style="background: var(--bg-card); border: 1px solid var(--border-color); padding: 1.5rem; border-radius: var(--radius-xl); margin-bottom: 1.5rem; box-shadow: var(--shadow-md);">
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 1.25rem; flex-wrap: wrap; gap: 0.5rem;">
              <div style="display: flex; align-items: center; gap: 0.6rem;">
                <i data-lucide="database" style="width: 22px; height: 22px; color: var(--accent-primary);"></i>
                <div>
                  <h3 style="font-size: 1.1rem; font-weight: 600;">Pilihan Media Penyimpanan (HDD / SSD Drive)</h3>
                  <p style="font-size: 0.8rem; color: var(--text-muted); margin-top: 2px;">Pilih drive fisik komputer (Drive C:, D:, E:, dll.) untuk menyimpan seluruh berkas CloudMe</p>
                </div>
              </div>
            </div>

            <!-- Detected Drives Grid -->
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 1rem; margin-bottom: 1.25rem;">
              ${(drivesData.drives || []).map(d => `
                <div style="background: ${d.isActive ? 'rgba(99, 102, 241, 0.1)' : 'var(--bg-tertiary)'}; border: 1px solid ${d.isActive ? 'var(--accent-primary)' : 'var(--border-color)'}; padding: 1rem; border-radius: var(--radius-lg); position: relative;">
                  <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
                    <span style="font-weight: 600; font-size: 0.95rem; display: flex; align-items: center; gap: 0.4rem;">
                      <i data-lucide="hard-drive" style="width: 16px; height: 16px; color: ${d.isActive ? 'var(--accent-primary)' : 'var(--text-muted)'};"></i>
                      ${d.name}
                    </span>
                    ${d.isActive ? '<span style="font-size: 0.7rem; font-weight: 600; color: #fff; background: var(--accent-primary); padding: 2px 8px; border-radius: var(--radius-full);">Aktif Digunakan</span>' : ''}
                  </div>
                  <div class="storage-bar-bg" style="height: 6px; margin-bottom: 0.4rem;">
                    <div class="storage-bar-fill" style="width: ${d.usedPercent}%; background: ${d.usedPercent > 85 ? 'var(--color-danger)' : 'var(--accent-gradient)'};"></div>
                  </div>
                  <div style="display: flex; justify-content: space-between; font-size: 0.75rem; color: var(--text-muted); margin-bottom: 0.75rem;">
                    <span>Bebas: <strong style="color: var(--color-success);">${this.formatBytes(d.freeBytes)}</strong></span>
                    <span>Total: ${this.formatBytes(d.totalBytes)}</span>
                  </div>
                  <button class="btn btn-secondary" style="width: 100%; padding: 0.4rem 0.5rem; font-size: 0.78rem; justify-content: center;" onclick="app.selectDrivePath('${d.root.replace(/\\/g, '\\\\')}')">
                    <i data-lucide="folder-plus" style="width: 14px; height: 14px;"></i>
                    <span>Gunakan ${d.name}</span>
                  </button>
                </div>
              `).join('')}
            </div>

            <!-- Custom Path Input -->
            <div style="background: var(--bg-tertiary); padding: 1.25rem; border-radius: var(--radius-lg); border: 1px solid var(--border-color);">
              <label class="form-label" style="margin-bottom: 0.4rem; font-weight: 600;">Path Direktori Penyimpanan Server:</label>
              <div style="display: flex; gap: 0.75rem; flex-wrap: wrap;">
                <input type="text" id="adminStoragePathInput" class="form-input" style="flex: 1; min-width: 260px;" value="${this.escapeHtml(drivesData.currentStorageDir || '')}" placeholder="Contoh: D:\\CloudMeStorage">
                <button class="btn btn-primary" id="btnSaveStoragePath" onclick="app.saveStoragePath()">
                  <i data-lucide="save" style="width: 16px; height: 16px;"></i>
                  <span>Terapkan Path</span>
                </button>
              </div>
              <div style="margin-top: 0.75rem; display: flex; align-items: center; gap: 0.5rem;">
                <input type="checkbox" id="adminMigrateFilesCheck" checked style="width: 16px; height: 16px; accent-color: var(--accent-primary);">
                <label for="adminMigrateFilesCheck" style="font-size: 0.82rem; color: var(--text-secondary); cursor: pointer;">
                  Otomatis salin & pindahkan data berkas pengguna lama ke lokasi drive baru
                </label>
              </div>
            </div>
          </div>

          <!-- Metric Cards -->
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1.25rem; margin-bottom: 2rem;">
            <div style="background: var(--bg-card); border: 1px solid var(--border-color); padding: 1.25rem; border-radius: var(--radius-lg);">
              <div style="color: var(--text-muted); font-size: 0.85rem;">Total Pengguna</div>
              <div style="font-size: 1.8rem; font-weight: 700; color: var(--accent-primary);">${statsData.stats.totalUsers}</div>
            </div>
            <div style="background: var(--bg-card); border: 1px solid var(--border-color); padding: 1.25rem; border-radius: var(--radius-lg);">
              <div style="color: var(--text-muted); font-size: 0.85rem;">Total File Tersimpan</div>
              <div style="font-size: 1.8rem; font-weight: 700; color: var(--color-success);">${statsData.stats.totalFiles}</div>
            </div>
            <div style="background: var(--bg-card); border: 1px solid var(--border-color); padding: 1.25rem; border-radius: var(--radius-lg);">
              <div style="color: var(--text-muted); font-size: 0.85rem;">Penyimpanan Terpakai</div>
              <div style="font-size: 1.8rem; font-weight: 700; color: var(--color-info);">${this.formatBytes(statsData.stats.totalStorageUsed)}</div>
            </div>
            <div style="background: var(--bg-card); border: 1px solid var(--border-color); padding: 1.25rem; border-radius: var(--radius-lg);">
              <div style="color: var(--text-muted); font-size: 0.85rem;">Media Foto / Video</div>
              <div style="font-size: 1.8rem; font-weight: 700; color: var(--color-warning);">${statsData.stats.totalPhotos}</div>
            </div>
          <!-- Registration Access Control Card (Enable / Disable Registration) -->
          <div style="background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-xl); padding: 1.25rem 1.5rem; margin-bottom: 1.5rem; box-shadow: var(--shadow-md);">
            <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 1rem;">
              <div style="display: flex; align-items: center; gap: 0.85rem;">
                <div style="width: 42px; height: 42px; border-radius: var(--radius-md); background: ${statsData.settings.allowRegistration ? 'rgba(16, 185, 129, 0.12)' : 'rgba(239, 68, 68, 0.12)'}; display: flex; align-items: center; justify-content: center; color: ${statsData.settings.allowRegistration ? '#10b981' : '#ef4444'}; flex-shrink: 0;">
                  <i data-lucide="${statsData.settings.allowRegistration ? 'user-check' : 'user-x'}" style="width: 22px; height: 22px;"></i>
                </div>
                <div>
                  <div style="display: flex; align-items: center; gap: 0.5rem;">
                    <h3 style="font-size: 1.05rem; font-weight: 600;">Pendaftaran Akun Baru (Registrasi Publik)</h3>
                    <span style="font-size: 0.72rem; font-weight: 700; padding: 2px 8px; border-radius: var(--radius-full); ${statsData.settings.allowRegistration ? 'background: rgba(16, 185, 129, 0.15); color: #10b981;' : 'background: rgba(239, 68, 68, 0.15); color: #ef4444;'}">
                      ${statsData.settings.allowRegistration ? 'DIBUKA' : 'DITUTUP'}
                    </span>
                  </div>
                  <p style="font-size: 0.8rem; color: var(--text-muted); margin-top: 2px;">
                    ${statsData.settings.allowRegistration ? 'Pendaftaran mandiri aktif. Siapa saja dapat membuat akun baru melalui formulir registrasi di halaman login.' : 'Pendaftaran mandiri dinonaktifkan (ditutup). Pengguna baru hanya dapat dibuat oleh Admin melalui tombol Tambah Pengguna.'}
                  </p>
                </div>
              </div>
              <button class="btn ${statsData.settings.allowRegistration ? 'btn-danger' : 'btn-primary'}" style="font-size: 0.85rem; padding: 0.55rem 1.15rem;" onclick="app.toggleRegistrationSetting(${!statsData.settings.allowRegistration})">
                <i data-lucide="${statsData.settings.allowRegistration ? 'user-x' : 'user-check'}" style="width: 15px; height: 15px;"></i>
                <span>${statsData.settings.allowRegistration ? 'Nonaktifkan Registrasi (Tutup)' : 'Aktifkan Registrasi (Buka)'}</span>
              </button>
            </div>
          </div>

          <!-- User Management Table -->
          <div style="background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-xl); padding: 1.5rem; box-shadow: var(--shadow-md);">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.25rem; flex-wrap: wrap; gap: 0.75rem;">
              <div>
                <h3 style="font-size: 1.15rem; font-weight: 700; display: flex; align-items: center; gap: 0.5rem;">
                  <i data-lucide="users" style="width: 20px; height: 20px; color: var(--accent-primary);"></i>
                  Daftar Pengguna & Manajemen Akun
                </h3>
                <p style="font-size: 0.8rem; color: var(--text-muted); margin-top: 2px;">Kelola akun pengguna, reset password, hak akses peran, dan alokasi kuota penyimpanan</p>
              </div>
              <button class="btn btn-primary" style="font-size: 0.85rem; padding: 0.5rem 1rem;" onclick="app.openAddUserModal()">
                <i data-lucide="user-plus" style="width: 16px; height: 16px;"></i>
                <span>Tambah Pengguna</span>
              </button>
            </div>

            <div class="file-table-container">
              <table class="file-table" style="width: 100%;">
                <thead>
                  <tr>
                    <th>Pengguna</th>
                    <th>Peran</th>
                    <th>Penyimpanan Terpakai</th>
                    <th>Alokasi Kuota</th>
                    <th style="text-align: right;">Aksi</th>
                  </tr>
                </thead>
                <tbody>
                  ${usersData.users.map(u => {
                    const isSelf = this.user && this.user.id === u.id;
                    const usedPct = Math.min(100, Math.round((u.used_bytes / (u.storage_quota_bytes || 1)) * 100));
                    const quotaGB = Math.round(u.storage_quota_bytes / (1024 * 1024 * 1024));

                    return `
                      <tr>
                        <td>
                          <div style="display: flex; align-items: center; gap: 0.75rem;">
                            <div style="width: 34px; height: 34px; border-radius: 50%; background: ${u.role === 'admin' ? 'linear-gradient(135deg, #f59e0b, #d97706)' : 'linear-gradient(135deg, #6366f1, #4f46e5)'}; color: #ffffff; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 0.88rem; flex-shrink: 0;">
                              ${this.escapeHtml(u.username.charAt(0).toUpperCase())}
                            </div>
                            <div>
                              <div style="font-weight: 600; font-size: 0.92rem; display: flex; align-items: center; gap: 0.4rem;">
                                <span>${this.escapeHtml(u.username)}</span>
                                ${isSelf ? '<span style="font-size: 0.68rem; font-weight: 700; color: var(--accent-primary); background: rgba(99, 102, 241, 0.15); padding: 1px 6px; border-radius: 4px;">Akun Anda</span>' : ''}
                              </div>
                              <div style="font-size: 0.78rem; color: var(--text-muted);">${this.escapeHtml(u.email)}</div>
                            </div>
                          </div>
                        </td>
                        <td>
                          <span style="display: inline-flex; align-items: center; gap: 4px; padding: 3px 10px; border-radius: var(--radius-full); font-size: 0.75rem; font-weight: 600; background: ${u.role === 'admin' ? 'rgba(245, 158, 11, 0.15)' : 'var(--bg-tertiary)'}; color: ${u.role === 'admin' ? '#f59e0b' : 'var(--text-secondary)'}; border: 1px solid ${u.role === 'admin' ? 'rgba(245, 158, 11, 0.3)' : 'var(--border-color)'};">
                            <i data-lucide="${u.role === 'admin' ? 'shield-check' : 'user'}" style="width: 12px; height: 12px;"></i>
                            ${u.role === 'admin' ? 'Administrator' : 'User'}
                          </span>
                        </td>
                        <td>
                          <div style="font-weight: 600; font-size: 0.85rem;">${this.formatBytes(u.used_bytes)}</div>
                          <div style="font-size: 0.74rem; color: var(--text-muted);">${u.file_count || 0} berkas (${usedPct}%)</div>
                        </td>
                        <td>
                          <div style="font-weight: 600; font-size: 0.85rem;">${this.formatBytes(u.storage_quota_bytes)}</div>
                          <div class="storage-bar-bg" style="height: 5px; width: 85px; margin-top: 4px;">
                            <div class="storage-bar-fill" style="width: ${usedPct}%; background: ${usedPct > 90 ? 'var(--color-danger)' : 'var(--accent-gradient)'};"></div>
                          </div>
                        </td>
                        <td style="text-align: right;">
                          <div style="display: flex; justify-content: flex-end; gap: 0.4rem; flex-wrap: wrap;">
                            <button class="btn btn-secondary" style="padding: 0.35rem 0.65rem; font-size: 0.78rem;" title="Edit Pengguna & Password" onclick="app.openEditUserModal('${u.id}')">
                              <i data-lucide="pencil" style="width: 13px; height: 13px;"></i>
                              <span>Edit</span>
                            </button>
                            <button class="btn btn-secondary" style="padding: 0.35rem 0.65rem; font-size: 0.78rem;" title="Ubah Kuota" onclick="app.editUserQuota('${u.id}', '${quotaGB}')">
                              <i data-lucide="hard-drive" style="width: 13px; height: 13px;"></i>
                              <span>Kuota</span>
                            </button>
                            ${!isSelf ? `
                              <button class="btn btn-danger" style="padding: 0.35rem 0.65rem; font-size: 0.78rem;" title="Hapus Pengguna" onclick="app.deleteUser('${u.id}', '${this.escapeHtml(u.username)}')">
                                <i data-lucide="trash-2" style="width: 13px; height: 13px;"></i>
                                <span>Hapus</span>
                              </button>
                            ` : ''}
                          </div>
                        </td>
                      </tr>
                    `;
                  }).join('')}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      `;

      this.adminUsersCache = usersData.users || [];

      if (window.lucide) lucide.createIcons();
    } catch (err) {
      view.innerHTML = '<div style="color: var(--color-danger); text-align: center; padding: 2rem;">Gagal memuat Admin Panel.</div>';
    }
  }

  selectDrivePath(driveRoot) {
    const input = document.getElementById('adminStoragePathInput');
    if (input) {
      const cleanRoot = driveRoot.endsWith('\\') ? driveRoot : driveRoot + '\\';
      input.value = `${cleanRoot}CloudMeStorage`;
      this.showToast(`💡 Path disetel ke ${input.value}. Klik 'Terapkan Path' untuk menyimpan.`, 'info');
    }
  }

  async saveStoragePath() {
    const input = document.getElementById('adminStoragePathInput');
    const check = document.getElementById('adminMigrateFilesCheck');
    const newPath = input ? input.value.trim() : '';
    const migrateExisting = check ? check.checked : true;

    if (!newPath) {
      this.showAlert('Peringatan', 'Masukkan path direktori penyimpanan yang valid.', 'warning');
      return;
    }

    const confirmed = await this.showConfirm(
      'Konfirmasi Pengalihan Storage Drive',
      `Anda akan mengalihkan direktori penyimpanan server ke:<br><br><strong style="color: var(--accent-primary); word-break: break-all;">${this.escapeHtml(newPath)}</strong><br><br>${migrateExisting ? '✅ Berkas pengguna lama akan otomatis dimigrasi ke lokasi baru.' : '⚠️ Berkas lama tidak akan dimigrasi otomatis.'}`,
      { confirmText: 'Terapkan Lokasi', cancelText: 'Batal', iconType: 'warning' }
    );

    if (!confirmed) return;

    const btn = document.getElementById('btnSaveStoragePath');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i data-lucide="loader" class="animate-spin" style="width: 16px; height: 16px;"></i> <span>Memproses...</span>';
      if (window.lucide) lucide.createIcons();
    }

    try {
      const res = await fetch('/api/admin/storage-path', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`
        },
        body: JSON.stringify({ newPath, migrateExisting })
      });

      const data = await res.json();
      if (res.ok && data.success) {
        this.showAlert('Sukses!', data.message, 'success');
        this.loadAdminPanel();
        this.checkSystemStatus();
      } else {
        this.showAlert('Gagal Mengalihkan Storage', data.error || 'Terjadi kesalahan.', 'error');
      }
    } catch (err) {
      this.showAlert('Kesalahan Koneksi', 'Gagal menghubungi server.', 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i data-lucide="save" style="width: 16px; height: 16px;"></i> <span>Terapkan Path</span>';
        if (window.lucide) lucide.createIcons();
      }
    }
  }

  async toggleRegistrationSetting(allow) {
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`
        },
        body: JSON.stringify({ allowRegistration: allow })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        this.allowRegistration = allow;
        this.showToast(allow ? '✅ Registrasi publik berhasil dibuka.' : '🔒 Registrasi publik berhasil ditutup.', 'success');
        this.loadAdminPanel();
      } else {
        this.showAlert('Gagal', data.error || 'Gagal mengubah pengaturan registrasi.', 'error');
      }
    } catch (err) {
      this.showAlert('Kesalahan Koneksi', 'Gagal menghubungi server.', 'error');
    }
  }

  editUserQuota(userId, currentQuotaGB) {
    this.targetQuotaUserId = userId;
    const user = this.adminUsersCache ? this.adminUsersCache.find(u => u.id === userId) : null;
    const label = document.getElementById('quotaEditUserLabel');
    if (label) label.textContent = `Pengguna: ${user ? user.username : 'User'}`;
    const input = document.getElementById('quotaEditInput');
    if (input) input.value = currentQuotaGB || 50;

    // Update physical disk helper text
    const diskInfoText = document.getElementById('quotaEditDiskInfoText');
    if (diskInfoText) {
      if (this.serverDiskInfo && this.serverDiskInfo.totalBytes > 0) {
        const freeGB = Math.round(this.serverDiskInfo.freeBytes / (1024*1024*1024));
        const totalGB = Math.round(this.serverDiskInfo.totalBytes / (1024*1024*1024));
        diskInfoText.innerHTML = `Hard Disk Server: <strong>${freeGB} GB Bebas</strong> dari Total <strong>${totalGB} GB</strong>`;
      } else {
        diskInfoText.textContent = `Hard Disk Server Tersedia`;
      }
    }

    this.checkQuotaOverprovision();
    this.openModal('quotaEditModal');
    if (window.lucide) lucide.createIcons();
  }

  checkQuotaOverprovision() {
    const input = document.getElementById('quotaEditInput');
    const warningBox = document.getElementById('quotaOverprovisionWarning');
    const warningText = document.getElementById('quotaOverprovisionWarningText');
    if (!input || !warningBox || !warningText) return;

    const val = parseInt(input.value || '0', 10);
    if (!this.serverDiskInfo || !this.serverDiskInfo.totalBytes) {
      warningBox.style.display = 'none';
      return;
    }

    const totalDiskGB = Math.round(this.serverDiskInfo.totalBytes / (1024*1024*1024));
    const freeDiskGB = Math.round(this.serverDiskInfo.freeBytes / (1024*1024*1024));

    if (val > totalDiskGB) {
      warningBox.style.display = 'block';
      warningText.innerHTML = `Kapasitas kuota (<strong>${val} GB</strong>) melebihi kapasitas fisik seluruh hard disk server (<strong>${totalDiskGB} GB</strong>). Sistem mengizinkan alokasi ini (<em>Overprovisioning</em>), namun proses unggah pengguna akan otomatis berhenti saat kapasitas fisik hard disk server habis.`;
    } else if (val > freeDiskGB) {
      warningBox.style.display = 'block';
      warningText.innerHTML = `Kapasitas kuota (<strong>${val} GB</strong>) lebih besar dari sisa ruang bebas hard disk saat ini (<strong>${freeDiskGB} GB Bebas</strong>).`;
    } else {
      warningBox.style.display = 'none';
    }
  }

  async saveUserQuota() {
    const input = document.getElementById('quotaEditInput');
    const quotaGB = parseInt(input ? input.value : '0', 10);
    if (!quotaGB || quotaGB <= 0) {
      this.showAlert('Input Tidak Valid', 'Masukkan angka kapasitas kuota (GB) yang valid (minimal 1 GB).', 'warning');
      return;
    }

    const btn = document.getElementById('btnSaveQuota');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Menyimpan...';
    }

    try {
      const res = await fetch(`/api/admin/users/${this.targetQuotaUserId}/quota`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`
        },
        body: JSON.stringify({ quotaGB })
      });

      const data = await res.json();
      if (res.ok) {
        this.closeModal('quotaEditModal');
        this.showToast('✅ Kuota pengguna berhasil diperbarui!', 'success');
        this.loadAdminPanel();
        this.checkSystemStatus(); // refresh current user storage bar if editing self
      } else {
        this.showAlert('Gagal', data.error || 'Gagal mengubah kuota.', 'error');
      }
    } catch (err) {
      this.showAlert('Kesalahan Koneksi', 'Gagal menghubungi server untuk mengubah kuota.', 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Simpan Kuota';
      }
    }
  }

  // -------------------------------------------------------------
  // 6.5. Admin User Management CRUD
  // -------------------------------------------------------------
  openAddUserModal() {
    const form = document.getElementById('adminAddUserForm');
    if (form) form.reset();
    const quotaInput = document.getElementById('adminAddQuota');
    if (quotaInput) quotaInput.value = 50;
    this.openModal('adminAddUserModal');
    if (window.lucide) lucide.createIcons();
    const userField = document.getElementById('adminAddUsername');
    if (userField) userField.focus();
  }

  async submitAddUser(e) {
    e.preventDefault();
    const username = document.getElementById('adminAddUsername')?.value.trim();
    const email = document.getElementById('adminAddEmail')?.value.trim();
    const password = document.getElementById('adminAddPassword')?.value;
    const role = document.getElementById('adminAddRole')?.value || 'user';
    const quotaGB = parseInt(document.getElementById('adminAddQuota')?.value || '50', 10);

    if (!username || !email || !password) {
      this.showAlert('Data Belum Lengkap', 'Username, email, dan password wajib diisi.', 'warning');
      return;
    }

    if (username.length < 3) {
      this.showAlert('Username Terlalu Pendek', 'Username minimal 3 karakter.', 'warning');
      return;
    }

    if (password.length < 4) {
      this.showAlert('Password Terlalu Pendek', 'Password minimal 4 karakter.', 'warning');
      return;
    }

    const btn = document.getElementById('btnSubmitAddUser');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i data-lucide="loader" class="animate-spin" style="width: 16px; height: 16px;"></i> <span>Menyimpan...</span>';
      if (window.lucide) lucide.createIcons();
    }

    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`
        },
        body: JSON.stringify({ username, email, password, role, quotaGB })
      });

      const data = await res.json();
      if (res.ok && data.success) {
        this.closeModal('adminAddUserModal');
        this.showToast(`🎉 Pengguna '${username}' berhasil ditambahkan!`, 'success');
        this.loadAdminPanel();
      } else {
        this.showAlert('Gagal Menambah Pengguna', data.error || 'Terjadi kesalahan.', 'error');
      }
    } catch (err) {
      this.showAlert('Kesalahan Koneksi', 'Gagal menghubungi server untuk membuat akun.', 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i data-lucide="user-plus" style="width: 16px; height: 16px;"></i> <span>Simpan Pengguna</span>';
        if (window.lucide) lucide.createIcons();
      }
    }
  }

  openEditUserModal(userId) {
    const user = this.adminUsersCache ? this.adminUsersCache.find(u => u.id === userId) : null;
    if (!user) {
      this.showToast('Data pengguna tidak ditemukan.', 'error');
      return;
    }

    const idInput = document.getElementById('adminEditUserId');
    const userInput = document.getElementById('adminEditUsername');
    const emailInput = document.getElementById('adminEditEmail');
    const passInput = document.getElementById('adminEditPassword');
    const roleInput = document.getElementById('adminEditRole');
    const quotaInput = document.getElementById('adminEditQuota');

    if (idInput) idInput.value = user.id;
    if (userInput) userInput.value = user.username;
    if (emailInput) emailInput.value = user.email;
    if (passInput) passInput.value = '';
    if (roleInput) roleInput.value = user.role;
    if (quotaInput) quotaInput.value = Math.round(user.storage_quota_bytes / (1024 * 1024 * 1024));

    this.openModal('adminEditUserModal');
    if (window.lucide) lucide.createIcons();
    if (userInput) userInput.focus();
  }

  async submitEditUser(e) {
    e.preventDefault();
    const userId = document.getElementById('adminEditUserId')?.value;
    const username = document.getElementById('adminEditUsername')?.value.trim();
    const email = document.getElementById('adminEditEmail')?.value.trim();
    const password = document.getElementById('adminEditPassword')?.value.trim();
    const role = document.getElementById('adminEditRole')?.value || 'user';
    const quotaGB = parseInt(document.getElementById('adminEditQuota')?.value || '50', 10);

    if (!userId || !username || !email) {
      this.showAlert('Data Belum Lengkap', 'Username dan email wajib diisi.', 'warning');
      return;
    }

    const btn = document.getElementById('btnSubmitEditUser');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i data-lucide="loader" class="animate-spin" style="width: 16px; height: 16px;"></i> <span>Menyimpan...</span>';
      if (window.lucide) lucide.createIcons();
    }

    try {
      const payload = { username, email, role, quotaGB };
      if (password) payload.password = password;

      const res = await fetch(`/api/admin/users/${userId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`
        },
        body: JSON.stringify(payload)
      });

      const data = await res.json();
      if (res.ok && data.success) {
        this.closeModal('adminEditUserModal');
        this.showToast(`✅ Data pengguna '${username}' berhasil diperbarui!`, 'success');
        this.loadAdminPanel();
        if (this.user && this.user.id === userId) {
          this.user.username = username;
          this.user.email = email;
          this.user.role = role;
          this.user.quotaBytes = quotaGB * 1024 * 1024 * 1024;
          localStorage.setItem('cloudme_user', JSON.stringify(this.user));
          this.updateUserUI();
        }
      } else {
        this.showAlert('Gagal Memperbarui Pengguna', data.error || 'Terjadi kesalahan.', 'error');
      }
    } catch (err) {
      this.showAlert('Kesalahan Koneksi', 'Gagal menghubungi server untuk memperbarui data akun.', 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i data-lucide="check" style="width: 16px; height: 16px;"></i> <span>Simpan Perubahan</span>';
        if (window.lucide) lucide.createIcons();
      }
    }
  }

  async deleteUser(userId, username) {
    if (this.user && this.user.id === userId) {
      this.showAlert('Aksi Ditolak', 'Anda tidak dapat menghapus akun Anda sendiri.', 'warning');
      return;
    }

    const confirmed = await this.showConfirm(
      'Hapus Akun Pengguna',
      `Apakah Anda yakin ingin menghapus akun pengguna <strong>"${this.escapeHtml(username)}"</strong>?<br><br><span style="color: var(--color-danger);">⚠️ Peringatan: Seluruh berkas, folder, riwayat sinkronisasi foto, dan data penyimpanan fisik milik pengguna ini akan <strong>DIHAPUS PERMANEN</strong> dari server!</span>`,
      {
        confirmText: 'Ya, Hapus Pengguna',
        cancelText: 'Batal',
        isDanger: true,
        iconType: 'danger'
      }
    );

    if (!confirmed) return;

    try {
      const res = await fetch(`/api/admin/users/${userId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${this.token}` }
      });

      const data = await res.json();
      if (res.ok && data.success) {
        this.showToast(`🗑️ Akun pengguna '${username}' berhasil dihapus.`, 'success');
        this.loadAdminPanel();
      } else {
        this.showAlert('Gagal Menghapus Pengguna', data.error || 'Terjadi kesalahan.', 'error');
      }
    } catch (err) {
      this.showAlert('Kesalahan Koneksi', 'Gagal menghubungi server untuk menghapus akun.', 'error');
    }
  }

  // -------------------------------------------------------------
  // 7. Upload Management (Chunked & Streaming)
  // -------------------------------------------------------------
  async handleFilesSelected(files) {
    if (!files || files.length === 0) return;
    const fileList = Array.from(files);
    
    this.openUploadTray();
    
    for (const file of fileList) {
      if (file.size > 20 * 1024 * 1024) {
        // Use Chunked Upload for files > 20MB
        await this.uploadLargeFileChunked(file);
      } else {
        // Standard Upload
        await this.uploadSingleFile(file);
      }
    }

    this.loadFiles();
    this.checkSystemStatus(); // refresh quota
  }

  async uploadSingleFile(file) {
    const uploadId = 'up_' + Date.now() + Math.random().toString(36).substring(2, 6);
    this.addUploadTrayItem(uploadId, file.name, file.size);

    const formData = new FormData();
    formData.append('files', file);
    if (this.currentFolderId) formData.append('parentId', this.currentFolderId);

    try {
      const res = await fetch('/api/files/upload', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.token}` },
        body: formData
      });

      if (res.ok) {
        this.updateUploadTrayItem(uploadId, 100, 'Selesai');
      } else {
        const errData = await res.json();
        this.updateUploadTrayItem(uploadId, 0, 'Gagal: ' + (errData.error || ''));
      }
    } catch (err) {
      this.updateUploadTrayItem(uploadId, 0, 'Error koneksi');
    }
  }

  async uploadLargeFileChunked(file) {
    const uploadId = 'chunk_' + Date.now();
    const chunkSize = 5 * 1024 * 1024; // 5MB per chunk
    const totalChunks = Math.ceil(file.size / chunkSize);

    this.addUploadTrayItem(uploadId, file.name, file.size);

    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
      const start = chunkIndex * chunkSize;
      const end = Math.min(file.size, start + chunkSize);
      const chunkBlob = file.slice(start, end);

      const formData = new FormData();
      formData.append('chunk', chunkBlob, file.name);
      formData.append('uploadId', uploadId);
      formData.append('chunkIndex', chunkIndex);
      formData.append('totalChunks', totalChunks);
      formData.append('fileName', file.name);
      formData.append('totalSize', file.size);
      if (this.currentFolderId) formData.append('parentId', this.currentFolderId);

      const res = await fetch('/api/files/upload-chunk', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.token}` },
        body: formData
      });

      if (!res.ok) {
        this.updateUploadTrayItem(uploadId, 0, 'Gagal upload chunk');
        return;
      }

      const percent = Math.round(((chunkIndex + 1) / totalChunks) * 100);
      this.updateUploadTrayItem(uploadId, percent, `${percent}%`);
    }

    this.updateUploadTrayItem(uploadId, 100, 'Selesai');
  }

  openUploadTray() {
    const tray = document.getElementById('uploadTray');
    if (tray) tray.style.display = 'block';
  }
  closeUploadTray() {
    const tray = document.getElementById('uploadTray');
    if (tray) tray.style.display = 'none';
  }
  toggleUploadTrayMinimize() {
    const body = document.getElementById('uploadTrayBody');
    if (body) body.style.display = body.style.display === 'none' ? 'flex' : 'none';
  }
  addUploadTrayItem(id, name, size) {
    const body = document.getElementById('uploadTrayBody');
    if (!body) return;
    const item = document.createElement('div');
    item.className = 'upload-item-card';
    item.id = `tray_item_${id}`;
    item.innerHTML = `
      <div style="display: flex; justify-content: space-between; font-size: 0.85rem; margin-bottom: 4px;">
        <span style="font-weight: 500; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${this.escapeHtml(name)}</span>
        <span id="tray_status_${id}" style="color: var(--accent-primary);">0%</span>
      </div>
      <div class="progress-bar-bg" style="height: 4px;">
        <div id="tray_prog_${id}" class="progress-bar-fill" style="width: 0%;"></div>
      </div>
    `;
    body.prepend(item);
  }
  updateUploadTrayItem(id, percent, status) {
    const prog = document.getElementById(`tray_prog_${id}`);
    const st = document.getElementById(`tray_status_${id}`);
    if (prog) prog.style.width = `${percent}%`;
    if (st) st.textContent = status;
  }

  // -------------------------------------------------------------
  // 8. File Actions & Modals (Folder, Rename, Move, Star, Delete)
  // -------------------------------------------------------------
  openNewFolderModal() {
    document.getElementById('inputDialogTitle').textContent = 'Buat Folder Baru';
    const valInput = document.getElementById('inputDialogValue');
    valInput.value = 'Folder Tanpa Judul';
    this.openModal('inputDialogModal');
    valInput.focus();
    valInput.select();

    document.getElementById('btnInputDialogConfirm').onclick = async () => {
      const name = valInput.value.trim();
      if (!name) return;
      await fetch('/api/files/folder', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`
        },
        body: JSON.stringify({ name, parentId: this.currentFolderId })
      });
      this.closeModal('inputDialogModal');
      this.loadFiles();
    };
  }

  showContextMenu(e, item) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    this.activeContextItem = item;

    const menu = document.getElementById('contextMenu');
    if (!menu) return;
    menu.style.display = 'block';

    let x = (e && typeof e.clientX === 'number' && e.clientX > 0) ? e.clientX : window.innerWidth / 2 - 95;
    let y = (e && typeof e.clientY === 'number' && e.clientY > 0) ? e.clientY : window.innerHeight / 2 - 120;

    menu.style.left = `${Math.max(10, Math.min(x, window.innerWidth - 210))}px`;
    menu.style.top = `${Math.max(10, Math.min(y, window.innerHeight - 320))}px`;

    document.getElementById('ctxStarText').textContent = item.is_starred ? 'Hapus dari Favorit' : 'Tambah ke Favorit';
    document.getElementById('ctxPreview').style.display = item.is_folder ? 'none' : 'flex';
    document.getElementById('ctxShare').style.display = 'flex';
    if (window.lucide) lucide.createIcons();
  }

  closeContextMenu() {
    const menu = document.getElementById('contextMenu');
    if (menu) menu.style.display = 'none';
  }

  openRenameModal(item, onRenamed = null) {
    if (!item) return;
    document.getElementById('inputDialogTitle').textContent = `Ganti Nama ${item.is_folder ? 'Folder' : 'Berkas'}`;
    const valInput = document.getElementById('inputDialogValue');
    valInput.value = item.name;
    this.openModal('inputDialogModal');
    valInput.focus();
    valInput.select();

    document.getElementById('btnInputDialogConfirm').onclick = async () => {
      const name = valInput.value.trim();
      if (!name || name === item.name) {
        this.closeModal('inputDialogModal');
        return;
      }
      try {
        const res = await fetch(`/api/files/${item.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.token}` },
          body: JSON.stringify({ name })
        });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || 'Gagal mengubah nama');
        item.name = name;
        this.closeModal('inputDialogModal');
        this.showToast('✅ Nama berhasil diubah!', 'success');
        if (onRenamed) onRenamed(name);
        this.refreshCurrentView();
      } catch (err) {
        this.showToast(`Gagal: ${err.message}`, 'error');
      }
    };
  }

  async refreshCurrentView() {
    if (this.currentNav === 'photos') {
      await this.loadPhotosTimeline();
    } else if (this.currentNav === 'backup') {
      await this.renderMobileSyncHub();
    } else if (this.currentNav === 'admin') {
      await this.loadAdminPanel();
    } else {
      await this.loadFiles();
    }
  }

  batchRename() {
    if (this.selectedItemIds.size !== 1) return;
    const singleId = Array.from(this.selectedItemIds)[0];
    const item = this.getItemById(singleId);
    if (!item) return;
    this.openRenameModal(item);
  }

  renameActiveLightboxFile() {
    if (!this.activeLightboxItem) return;
    this.openRenameModal(this.activeLightboxItem, (newName) => {
      this.activeLightboxItem.name = newName;
      document.getElementById('lightboxFileName').textContent = newName;
    });
  }

  async ctxAction(action) {
    const item = this.activeContextItem;
    if (!item) return;
    this.closeContextMenu();

    if (action === 'preview') {
      this.openLightbox(item);
    } else if (action === 'download') {
      window.open(this.apiUrl('/api/files/' + item.id + '/download?token=' + this.token), '_blank');
    } else if (action === 'share') {
      this.openShareModal(item);
    } else if (action === 'star') {
      await fetch(`/api/files/${item.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.token}` },
        body: JSON.stringify({ is_starred: !item.is_starred })
      });
      this.refreshCurrentView();
    } else if (action === 'rename') {
      this.openRenameModal(item);
    } else if (action === 'delete') {
      const isTrash = this.currentView === 'trash';
      const confirmed = await this.showConfirm(
        isTrash ? 'Hapus Permanen' : 'Pindahkan ke Sampah',
        isTrash 
          ? `Apakah Anda yakin ingin menghapus <strong>"${this.escapeHtml(item.name)}"</strong> secara permanen dari hard disk? Tindakan ini tidak dapat dibatalkan.`
          : `Pindahkan <strong>"${this.escapeHtml(item.name)}"</strong> ke tempat sampah?`,
        {
          confirmText: isTrash ? 'Hapus Permanen' : 'Pindahkan ke Sampah',
          cancelText: 'Batal',
          isDanger: isTrash,
          iconType: isTrash ? 'danger' : 'warning'
        }
      );
      if (confirmed) {
        await fetch(`/api/files/${item.id}${isTrash ? '?permanent=true' : ''}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${this.token}` }
        });
        this.showToast(isTrash ? '🗑️ Item berhasil dihapus permanen.' : '🗑️ Item dipindahkan ke sampah.', 'success');
        this.refreshCurrentView();
        this.checkSystemStatus();
      }
    }
  }

  // -------------------------------------------------------------
  // 9. Lightbox Media Previewer (Photos, Video, Audio, PDF, Text)
  // -------------------------------------------------------------
  openLightbox(item) {
    this.activeLightboxItem = item;
    const lightbox = document.getElementById('mediaLightbox');
    const container = document.getElementById('lightboxMediaContainer');
    document.getElementById('lightboxFileName').textContent = item.name;

    lightbox.style.display = 'flex';
    container.innerHTML = '';

    const mimeType = item.mime_type || '';

    if (mimeType.startsWith('image/')) {
      container.innerHTML = `<img src="${this.apiUrl('/api/files/' + item.id + '/preview?token=' + this.token)}" alt="${this.escapeHtml(item.name)}">`;
    } else if (mimeType.startsWith('video/')) {
      container.innerHTML = `
        <video controls autoplay style="max-width: 90%; max-height: 85vh;">
          <source src="${this.apiUrl('/api/files/' + item.id + '/preview?token=' + this.token)}" type="${mimeType}">
          Browser Anda tidak mendukung pemutar video ini.
        </video>
      `;
    } else if (mimeType.startsWith('audio/')) {
      container.innerHTML = `
        <div style="background: var(--bg-card); padding: 2rem; border-radius: var(--radius-xl); text-align: center; border: 1px solid var(--border-color);">
          <i data-lucide="music" style="width: 64px; height: 64px; margin-bottom: 1rem; color: var(--accent-primary);"></i>
          <h3 style="margin-bottom: 1rem;">${this.escapeHtml(item.name)}</h3>
          <audio controls autoplay style="width: 320px;">
            <source src="${this.apiUrl('/api/files/' + item.id + '/preview?token=' + this.token)}" type="${mimeType}">
          </audio>
        </div>
      `;
      if (window.lucide) lucide.createIcons();
    } else if (mimeType.includes('pdf')) {
      container.innerHTML = `<iframe src="${this.apiUrl('/api/files/' + item.id + '/preview?token=' + this.token)}" style="width: 85vw; height: 85vh; border: none; border-radius: var(--radius-md);"></iframe>`;
    } else {
      container.innerHTML = `
        <div style="text-align: center; color: #ffffff;">
          <i data-lucide="file" style="width: 64px; height: 64px; margin-bottom: 1rem;"></i>
          <h3>Preview tidak didukung untuk tipe file ini</h3>
          <button class="btn btn-primary" style="margin-top: 1rem;" onclick="app.downloadActiveLightboxFile()">
            <i data-lucide="download"></i> Unduh File (${app.formatBytes(item.size_bytes)})
          </button>
        </div>
      `;
      if (window.lucide) lucide.createIcons();
    }
  }

  closeLightbox() {
    const lightbox = document.getElementById('mediaLightbox');
    if (lightbox) lightbox.style.display = 'none';
    const container = document.getElementById('lightboxMediaContainer');
    if (container) container.innerHTML = '';
  }

  downloadActiveLightboxFile() {
    if (this.activeLightboxItem) {
      window.open(this.apiUrl('/api/files/' + this.activeLightboxItem.id + '/download?token=' + this.token), '_blank');
    }
  }

  shareActiveLightboxFile() {
    if (this.activeLightboxItem) {
      this.closeLightbox();
      this.openShareModal(this.activeLightboxItem);
    }
  }

  // -------------------------------------------------------------
  // 10. Sharing & QR Code Generation
  // -------------------------------------------------------------
  async openShareModal(item) {
    this.activeBatchShareItems = null;
    this.activeContextItem = item;
    const title = document.querySelector('#shareModal h3');
    if (title) title.textContent = 'Bagikan Berkas';
    this.openModal('shareModal');
    await this.generateNewShareLink();
  }

  async openBatchShareModal() {
    if (this.selectedItemIds.size === 0) return;
    const ids = Array.from(this.selectedItemIds);
    this.activeBatchShareItems = ids.map(id => this.getItemById(id)).filter(Boolean);
    this.activeContextItem = null;

    const title = document.querySelector('#shareModal h3');
    if (title) title.textContent = `Bagikan ${this.activeBatchShareItems.length} Berkas Terpilih`;
    this.openModal('shareModal');
    await this.generateNewShareLink();
  }

  async generateNewShareLink() {
    const isBatch = this.activeBatchShareItems && this.activeBatchShareItems.length > 0;
    const item = this.activeContextItem;
    if (!isBatch && !item) return;

    const password = document.getElementById('sharePasswordInput')?.value || '';
    const expiresInDays = document.getElementById('shareExpirySelect')?.value || '';

    try {
      const payload = isBatch
        ? { fileIds: this.activeBatchShareItems.map(i => i.id), password, expiresInDays }
        : { fileId: item.id, password, expiresInDays };

      const res = await fetch('/api/shares', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.token}` },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.share) {
        const shareInput = document.getElementById('shareUrlInput');
        if (shareInput) shareInput.value = data.share.shareUrl;
        const qrImg = document.getElementById('shareQrCodeImg');
        if (qrImg) qrImg.src = this.apiUrl(`/api/shares/${data.share.token}/qr`);
      }
    } catch (err) {
      this.showToast('Gagal membuat tautan berbagi', 'error');
    }
  }

  copyShareUrl() {
    const input = document.getElementById('shareUrlInput');
    if (!input || !input.value) return;
    input.select();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(input.value);
    }
    this.showToast('✅ Tautan berbagi berhasil disalin ke clipboard!', 'success');
  }

  // -------------------------------------------------------------
  // 11. Multi-Selection & Batch Actions
  // -------------------------------------------------------------
  handleItemClick(e, item) {
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      if (this.selectedItemIds.has(item.id)) {
        this.selectedItemIds.delete(item.id);
      } else {
        this.selectedItemIds.add(item.id);
      }
      this.updateSelectionUI();
    }
  }

  toggleItemSelect(id, checked) {
    if (checked) this.selectedItemIds.add(id);
    else this.selectedItemIds.delete(id);
    this.updateSelectionUI();
  }

  toggleSelectAll(checked) {
    if (checked) {
      this.itemsCache.forEach(i => this.selectedItemIds.add(i.id));
    } else {
      this.selectedItemIds.clear();
    }
    this.updateSelectionUI();
  }

  clearSelection() {
    this.selectedItemIds.clear();
    this.updateSelectionUI();
  }

  updateSelectionUI() {
    const count = this.selectedItemIds.size;
    const total = this.itemsCache.length;

    // 1. Batch Bar
    const batchBar = document.getElementById('batchActionBar');
    if (batchBar) batchBar.style.display = count > 0 ? 'flex' : 'none';
    const countText = document.getElementById('batchSelectedCount');
    if (countText) countText.textContent = `${count} item dipilih`;

    // Toggle Batch Rename button: only visible if exactly 1 item is selected
    const btnRename = document.getElementById('btnBatchRename');
    if (btnRename) {
      btnRename.style.display = count === 1 ? 'inline-flex' : 'none';
    }

    if (count > 0 && window.lucide) lucide.createIcons();

    // 2. Select All Checkbox state in Table Header
    const selectAllCheckbox = document.getElementById('selectAllCheckbox');
    if (selectAllCheckbox) {
      selectAllCheckbox.checked = (total > 0 && count === total);
      selectAllCheckbox.indeterminate = (count > 0 && count < total);
    }

    // 3. Toolbar Select All Button Text
    const toolbarSelectBtn = document.getElementById('btnToolbarSelectAllText');
    if (toolbarSelectBtn) {
      toolbarSelectBtn.textContent = (total > 0 && count === total) ? 'Batal Pilih' : 'Pilih Semua';
    }

    // 4. Update all Table Row Checkboxes & Classes
    document.querySelectorAll('#fileTableBody tr').forEach(tr => {
      const id = tr.getAttribute('data-item-id');
      if (id) {
        const isSel = this.selectedItemIds.has(id);
        tr.classList.toggle('selected', isSel);
        const cb = tr.querySelector('input[type="checkbox"]');
        if (cb) cb.checked = isSel;
      }
    });

    // 5. Update all Grid Cards Classes
    document.querySelectorAll('.file-card, .folder-card').forEach(card => {
      const id = card.getAttribute('data-item-id');
      if (id) {
        card.classList.toggle('selected', this.selectedItemIds.has(id));
      }
    });

    // 6. Update all Photo Cards & Selection Checkboxes
    document.querySelectorAll('.photo-card').forEach(card => {
      const id = card.getAttribute('data-item-id');
      if (id) {
        const isSel = this.selectedItemIds.has(id);
        card.classList.toggle('selected', isSel);
        const selBtn = card.querySelector('.photo-select-btn');
        if (selBtn) {
          selBtn.classList.toggle('selected', isSel);
          const icon = selBtn.querySelector('i, svg');
          if (icon) {
            icon.setAttribute('data-lucide', isSel ? 'check' : 'circle');
          }
        }
      }
    });

    document.body.classList.toggle('has-selection', count > 0);
    if (window.lucide) lucide.createIcons();
  }

  handlePhotoClick(e, item) {
    if (!item) return;
    // If already in selection mode or modifier keys pressed, toggle selection
    if (this.selectedItemIds.size > 0 || e.ctrlKey || e.metaKey || e.shiftKey) {
      this.toggleItemSelect(item.id, !this.selectedItemIds.has(item.id));
    } else {
      // Normal click opens lightbox
      this.openLightbox(item);
    }
  }

  togglePhotoSelect(e, itemId) {
    if (e) e.stopPropagation();
    this.toggleItemSelect(itemId, !this.selectedItemIds.has(itemId));
  }

  toggleGroupSelect(displayDate) {
    if (!this.timelineCache) return;
    const group = this.timelineCache.find(g => g.displayDate === displayDate);
    if (!group || !group.items) return;

    const allGroupSelected = group.items.length > 0 && group.items.every(i => this.selectedItemIds.has(i.id));
    group.items.forEach(i => {
      if (allGroupSelected) {
        this.selectedItemIds.delete(i.id);
      } else {
        this.selectedItemIds.add(i.id);
      }
    });
    this.updateSelectionUI();
  }

  async batchDownloadZip() {
    if (this.selectedItemIds.size === 0) return;
    const ids = Array.from(this.selectedItemIds);

    const res = await fetch('/api/files/batch-download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.token}` },
      body: JSON.stringify({ ids })
    });

    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `CloudMe_Download_${Date.now()}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async batchDelete() {
    if (this.selectedItemIds.size === 0) return;
    const isTrash = this.currentView === 'trash';
    const confirmed = await this.showConfirm(
      isTrash ? 'Hapus Permanen' : 'Pindahkan ke Sampah',
      isTrash 
        ? `Hapus <strong>PERMANEN</strong> ${this.selectedItemIds.size} item yang dipilih dari hard disk?<br><br><span style="color: var(--color-danger);">⚠️ Tindakan ini tidak dapat dibatalkan.</span>`
        : `Pindahkan <strong>${this.selectedItemIds.size} item</strong> yang dipilih ke tempat sampah?`,
      {
        confirmText: isTrash ? 'Ya, Hapus Permanen' : 'Pindahkan ke Sampah',
        cancelText: 'Batal',
        isDanger: isTrash,
        iconType: isTrash ? 'danger' : 'warning'
      }
    );

    if (confirmed) {
      for (const id of this.selectedItemIds) {
        await fetch(`/api/files/${id}${isTrash ? '?permanent=true' : ''}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${this.token}` }
        });
      }
      this.clearSelection();
      this.showToast(isTrash ? '🗑️ Item berhasil dihapus permanen.' : '🗑️ Item dipindahkan ke sampah.', 'success');
      this.refreshCurrentView();
      this.checkSystemStatus();
    }
  }

  async emptyTrash() {
    const confirmed = await this.showConfirm(
      'Kosongkan Seluruh Tempat Sampah',
      'Apakah Anda yakin ingin mengosongkan seluruh tempat sampah?<br><br><span style="color: var(--color-danger);">⚠️ Semua berkas dan folder di sampah akan dihapus <strong>PERMANEN dari media penyimpanan hard disk</strong> dan tidak dapat dikembalikan!</span>',
      {
        confirmText: 'Ya, Kosongkan Permanen',
        cancelText: 'Batal',
        isDanger: true,
        iconType: 'danger'
      }
    );

    if (!confirmed) return;

    try {
      const res = await fetch('/api/files/trash/empty', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.token}` }
      });
      const data = await res.json();
      if (res.ok) {
        this.showToast('🗑️ Tempat sampah berhasil dikosongkan permanen!', 'success');
        this.clearSelection();
        this.loadFiles();
        this.checkSystemStatus();
      } else {
        this.showAlert('Gagal', data.error || 'Gagal mengosongkan tempat sampah.', 'error');
      }
    } catch (err) {
      this.showAlert('Kesalahan Koneksi', 'Gagal menghubungi server.', 'error');
    }
  }

  // -------------------------------------------------------------
  // 12. Setup Wizard & Auth Forms
  // -------------------------------------------------------------
  async handleSetupSubmit(e) {
    e.preventDefault();
    const appName = document.getElementById('setupAppName').value;
    const adminUsername = document.getElementById('setupAdminUser').value;
    const adminEmail = document.getElementById('setupAdminEmail').value;
    const adminPassword = document.getElementById('setupAdminPass').value;
    const storagePath = document.getElementById('setupStoragePath').value;
    const defaultQuotaGB = document.getElementById('setupDefaultQuota').value;

    const btn = document.getElementById('btnSubmitSetup');
    btn.disabled = true;
    btn.textContent = 'Memproses instalasi...';

    try {
      const res = await fetch('/api/setup/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          appName, adminUsername, adminEmail, adminPassword, storagePath, defaultQuotaGB
        })
      });

      const data = await res.json();
      if (res.ok) {
        this.closeModal('setupWizardModal');
        // Auto login with admin
        const loginRes = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ usernameOrEmail: adminUsername, password: adminPassword })
        });
        const loginData = await loginRes.json();
        this.setAuthSession(loginData.token, loginData.user);
      } else {
        alert(data.error || 'Gagal instalasi');
        btn.disabled = false;
        btn.textContent = 'Selesaikan Instalasi & Masuk';
      }
    } catch (err) {
      alert('Koneksi gagal');
      btn.disabled = false;
    }
  }

  async handleLogin(e) {
    e.preventDefault();
    const usernameOrEmail = document.getElementById('loginUsername').value;
    const password = document.getElementById('loginPassword').value;

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usernameOrEmail, password })
      });
      const data = await res.json();
      if (res.ok) {
        this.closeModal('authModal');
        this.setAuthSession(data.token, data.user);
      } else {
        alert(data.error || 'Login gagal');
      }
    } catch (err) {
      alert('Error koneksi');
    }
  }

  async handleRegister(e) {
    e.preventDefault();
    const username = document.getElementById('regUsername').value;
    const email = document.getElementById('regEmail').value;
    const password = document.getElementById('regPassword').value;

    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, email, password })
      });
      const data = await res.json();
      if (res.ok) {
        this.closeModal('authModal');
        this.setAuthSession(data.token, data.user);
      } else {
        alert(data.error || 'Pendaftaran gagal');
      }
    } catch (err) {
      alert('Error koneksi');
    }
  }

  setAuthSession(token, user) {
    this.token = token;
    this.user = user;
    localStorage.setItem('cloudme_token', token);
    localStorage.setItem('cloudme_user', JSON.stringify(user));
    this.updateUserUI();
    this.handleHashChange();
  }

  logout() {
    localStorage.removeItem('cloudme_token');
    localStorage.removeItem('cloudme_user');
    this.token = null;
    this.user = null;
    window.location.reload();
  }

  toggleAuthMode(mode) {
    if (mode === 'register' && this.allowRegistration === false) {
      this.showAlert('Registrasi Ditutup', 'Pendaftaran akun mandiri dinonaktifkan oleh Administrator. Silakan hubungi admin server untuk dibuatkan akun baru.', 'warning');
      return;
    }
    document.getElementById('loginForm').style.display = mode === 'login' ? 'block' : 'none';
    document.getElementById('registerForm').style.display = mode === 'register' ? 'block' : 'none';
    document.getElementById('authModalTitle').textContent = mode === 'login' ? 'Masuk ke CloudMe' : 'Daftar Akun Baru';
  }

  // -------------------------------------------------------------
  // 12.5. Remote URL & Google Drive Migration
  // -------------------------------------------------------------
  openUrlImportModal() {
    const urlInput = document.getElementById('importUrlInput');
    const nameInput = document.getElementById('importCustomNameInput');
    if (urlInput) urlInput.value = '';
    if (nameInput) nameInput.value = '';
    this.openModal('urlImportModal');
    if (urlInput) urlInput.focus();
  }

  async handleUrlImportSubmit(e) {
    e.preventDefault();
    const urlInput = document.getElementById('importUrlInput');
    const nameInput = document.getElementById('importCustomNameInput');
    const url = urlInput ? urlInput.value.trim() : '';
    const customFileName = nameInput ? nameInput.value.trim() : '';

    if (!url) return;

    const btn = document.getElementById('btnSubmitUrlImport');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i data-lucide="loader" class="animate-spin" style="width: 16px; height: 16px;"></i> <span id="btnImportText">Menghubungi server...</span>';
      if (window.lucide) lucide.createIcons();
    }

    const uploadId = 'imp_' + Date.now();
    this.openUploadTray();
    this.addUploadTrayItem(uploadId, customFileName || 'Impor dari Google Drive / URL', 0);
    this.updateUploadTrayItem(uploadId, 5, 'Menghubungi...');

    try {
      const response = await fetch('/api/files/import-url', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`,
          'Accept': 'text/event-stream'
        },
        body: JSON.stringify({
          url,
          parentId: this.currentFolderId,
          customFileName
        })
      });

      if (!response.ok && !response.body) {
        throw new Error('Gagal menghubungi server');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let isCompleted = false;
      let finalData = null;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep last partial line

        let currentEvent = 'message';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue; // ignore keepalive pings

          if (trimmed.startsWith('event:')) {
            currentEvent = trimmed.replace('event:', '').trim();
          } else if (trimmed.startsWith('data:')) {
            try {
              const data = JSON.parse(trimmed.replace('data:', '').trim());
              if (currentEvent === 'progress') {
                const pct = data.percent || 0;
                const statusTxt = data.status || 'Memproses...';
                this.updateUploadTrayItem(uploadId, pct, `${pct}% - ${statusTxt}`);
                const btnText = document.getElementById('btnImportText');
                if (btnText) btnText.textContent = `${pct}% ${statusTxt.substring(0, 25)}`;
              } else if (currentEvent === 'complete') {
                isCompleted = true;
                finalData = data;
              } else if (currentEvent === 'error') {
                throw new Error(data.error || 'Terjadi kesalahan saat impor.');
              }
            } catch (errParse) {
              if (currentEvent === 'error') throw errParse;
            }
          }
        }
      }

      if (isCompleted && finalData) {
        this.updateUploadTrayItem(uploadId, 100, 'Selesai');
        this.closeModal('urlImportModal');
        const successMsg = finalData.isFolder 
          ? `🎉 Berhasil mengimpor folder "${finalData.folder?.name || 'Google Drive'}" beserta ${finalData.folder?.totalFiles || 0} berkas!`
          : `✅ Berhasil mengimpor "${finalData.file?.name || 'berkas'}" ke CloudMe!`;
        this.showToast(successMsg, 'success');
        this.loadFiles();
        this.checkSystemStatus();
      } else if (!isCompleted) {
        this.updateUploadTrayItem(uploadId, 100, 'Selesai');
        this.closeModal('urlImportModal');
        this.showToast('✅ Berkas berhasil diimpor ke CloudMe!', 'success');
        this.loadFiles();
        this.checkSystemStatus();
      }
    } catch (err) {
      console.error('Import error:', err);
      this.updateUploadTrayItem(uploadId, 0, 'Gagal');
      alert(err.message || 'Gagal menghubungi server untuk mengunduh dari URL.');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i data-lucide="download-cloud" style="width: 16px; height: 16px;"></i> <span>Mulai Impor ke Cloud</span>';
        if (window.lucide) lucide.createIcons();
      }
    }
  }

  openTakeoutModal() {
    const fileInput = document.getElementById('takeoutZipFileInput');
    const urlInput = document.getElementById('takeoutUrlInput');
    if (fileInput) fileInput.value = '';
    if (urlInput) urlInput.value = '';
    this.openModal('takeoutModal');
  }

  async handleTakeoutSubmit(e) {
    e.preventDefault();
    const fileInput = document.getElementById('takeoutZipFileInput');
    const urlInput = document.getElementById('takeoutUrlInput');
    const zipFile = fileInput && fileInput.files && fileInput.files[0];
    const url = urlInput ? urlInput.value.trim() : '';

    if (!zipFile && !url) {
      alert('Silakan pilih file ZIP atau masukkan link URL Google Takeout.');
      return;
    }

    const btn = document.getElementById('btnSubmitTakeout');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i data-lucide="loader" class="animate-spin"></i> <span>Mengekstrak & Memproses...</span>';
      if (window.lucide) lucide.createIcons();
    }

    const uploadId = 'to_' + Date.now();
    this.openUploadTray();
    this.addUploadTrayItem(uploadId, zipFile ? zipFile.name : 'Takeout ZIP Importer', 0);
    this.updateUploadTrayItem(uploadId, 25, 'Mengekstrak...');

    try {
      let res;
      if (zipFile) {
        const formData = new FormData();
        formData.append('zipFile', zipFile);
        res = await fetch('/api/photos/import-takeout', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${this.token}` },
          body: formData
        });
      } else {
        res = await fetch('/api/photos/import-takeout', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.token}`
          },
          body: JSON.stringify({ url })
        });
      }

      const data = await res.json();
      if (res.ok && data.success) {
        this.updateUploadTrayItem(uploadId, 100, 'Selesai');
        this.closeModal('takeoutModal');
        const s = data.summary;
        this.showToast(`🎉 Sukses memigrasikan ${s.totalImported} media (${s.totalPhotos} foto, ${s.totalVideos} video)!`, 'success');
        if (this.currentNav === 'photos') {
          this.loadPhotosTimeline();
        } else {
          this.loadFiles();
        }
        this.checkSystemStatus();
      } else {
        this.updateUploadTrayItem(uploadId, 0, 'Gagal');
        alert(data.error || 'Gagal memproses arsip Google Takeout.');
      }
    } catch (err) {
      this.updateUploadTrayItem(uploadId, 0, 'Error');
      alert('Gagal memproses arsip Google Takeout.');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i data-lucide="package-check" style="width: 16px; height: 16px;"></i> <span>Mulai Ekstraksi & Migrasi</span>';
        if (window.lucide) lucide.createIcons();
      }
    }
  }

  // -------------------------------------------------------------
  // 13. UI Helpers & Modals
  // -------------------------------------------------------------
  openModal(id) {
    const modal = document.getElementById(id);
    if (modal) modal.classList.add('active');
  }
  closeModal(id) {
    const modal = document.getElementById(id);
    if (modal) modal.classList.remove('active');
  }
  setupTheme() {
    const theme = localStorage.getItem('cloudme_theme') || 'dark';
    document.documentElement.setAttribute('data-theme', theme);
    this.updateThemeIcon(theme);
  }
  toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('cloudme_theme', next);
    this.updateThemeIcon(next);
  }
  updateThemeIcon(theme) {
    const icon = document.getElementById('themeIcon');
    if (icon) icon.setAttribute('data-lucide', theme === 'dark' ? 'moon' : 'sun');
    if (window.lucide) lucide.createIcons();
  }

  formatBytes(bytes, decimals = 2) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
  }

  escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  getItemById(id) {
    return this.itemsCache.find(i => i.id === id) || null;
  }

  getFileIcon(mime) {
    if (!mime) return 'file';
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'music';
    if (mime.includes('pdf')) return 'file-text';
    if (mime.includes('zip') || mime.includes('tar') || mime.includes('rar')) return 'archive';
    return 'file';
  }

  // -------------------------------------------------------------
  // 14. API Key & Mobile Sync Management
  // -------------------------------------------------------------
  showApiKeyModal() {
    if (!this.user) return;
    const apiKeyInput = document.getElementById('modalApiKeyInput');
    const jwtInput = document.getElementById('modalJwtTokenInput');
    if (apiKeyInput) apiKeyInput.value = this.user.apiKey || 'Belum ada API Key';
    if (jwtInput) jwtInput.value = this.token || '';
    
    this.openModal('apiKeyModal');
    if (window.lucide) lucide.createIcons();
  }

  showMobileSyncModal() {
    window.location.hash = '#mobile-sync';
  }

  copyApiKey() {
    const input = document.getElementById('modalApiKeyInput');
    if (!input || !input.value) return;
    input.select();
    navigator.clipboard.writeText(input.value);
    this.showToast('✅ API Key berhasil disalin ke clipboard!', 'success');
  }

  copyJwtToken() {
    const input = document.getElementById('modalJwtTokenInput');
    if (!input || !input.value) return;
    input.select();
    navigator.clipboard.writeText(input.value);
    this.showToast('✅ JWT Token berhasil disalin!', 'success');
  }

  copyText(text, successMsg = 'Teks berhasil disalin!') {
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        this.showToast(`✅ ${successMsg}`, 'success');
      }).catch(() => {
        this.fallbackCopyText(text, successMsg);
      });
    } else {
      this.fallbackCopyText(text, successMsg);
    }
  }

  fallbackCopyText(text, successMsg) {
    const input = document.createElement('textarea');
    input.value = text;
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.appendChild(input);
    input.focus();
    input.select();
    try {
      document.execCommand('copy');
      this.showToast(`✅ ${successMsg}`, 'success');
    } catch (e) {
      this.showToast('Silakan salin teks secara manual.', 'warning');
    }
    input.remove();
  }

  async confirmRegenerateApiKey() {
    const confirmed = await this.showConfirm(
      "Regenerasi API Key",
      "⚠️ <strong>PERINGATAN PENTING:</strong><br><br>Menghasilkan API Key baru akan <strong>MEMUTUS SEMUA perangkat HP Android dan skrip otomatis</strong> yang sedang terhubung ke akun ini.<br><br>Apakah Anda yakin ingin membuat API Key baru sekarang?",
      {
        confirmText: "Ya, Buat API Key Baru",
        cancelText: "Batal",
        isDanger: true,
        iconType: "warning"
      }
    );

    if (!confirmed) return;

    try {
      const res = await fetch('/api/auth/regenerate-api-key', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.token}` }
      });
      const data = await res.json();

      if (res.ok && data.apiKey) {
        this.user.apiKey = data.apiKey;
        localStorage.setItem('cloudme_user', JSON.stringify(this.user));

        const apiKeyInput = document.getElementById('modalApiKeyInput');
        if (apiKeyInput) apiKeyInput.value = data.apiKey;

        this.showAlert(
          "API Key Baru Berhasil Dibuat!",
          "Kunci rahasia lama telah dinonaktifkan. Jangan lupa perbarui API Key ini di aplikasi HP Android atau skrip otomatis Anda.",
          "success"
        );
        this.showToast('✅ API Key diperbarui!', 'success');
      } else {
        this.showAlert('Gagal Regenerasi', data.error || 'Terjadi kesalahan.', 'error');
      }
    } catch (err) {
      this.showAlert('Kesalahan Koneksi', 'Gagal menghubungi server untuk regenerasi API Key.', 'error');
    }
  }

  showAlert(title, message, type = 'info') {
    return new Promise((resolve) => {
      const badge = document.getElementById('dialogIconBadge');
      const icon = document.getElementById('dialogIcon');
      const titleEl = document.getElementById('dialogTitle');
      const msgEl = document.getElementById('dialogMessage');
      const cancelBtn = document.getElementById('btnDialogCancel');
      const confirmBtn = document.getElementById('btnDialogConfirm');

      if (titleEl) titleEl.textContent = title || 'Pemberitahuan';
      if (msgEl) msgEl.innerHTML = message || '';

      if (cancelBtn) cancelBtn.style.display = 'none';
      if (confirmBtn) {
        confirmBtn.className = 'btn btn-primary';
        confirmBtn.textContent = 'Mengerti';
        confirmBtn.style.flex = '1';
      }

      if (type === 'error') {
        if (badge) {
          badge.style.background = 'rgba(239, 68, 68, 0.15)';
          badge.style.color = '#ef4444';
          badge.style.boxShadow = '0 0 25px rgba(239, 68, 68, 0.3)';
        }
        if (icon) icon.setAttribute('data-lucide', 'alert-circle');
      } else if (type === 'warning') {
        if (badge) {
          badge.style.background = 'rgba(245, 158, 11, 0.15)';
          badge.style.color = '#f59e0b';
          badge.style.boxShadow = '0 0 25px rgba(245, 158, 11, 0.3)';
        }
        if (icon) icon.setAttribute('data-lucide', 'alert-triangle');
      } else if (type === 'success') {
        if (badge) {
          badge.style.background = 'rgba(16, 185, 129, 0.15)';
          badge.style.color = '#10b981';
          badge.style.boxShadow = '0 0 25px rgba(16, 185, 129, 0.3)';
        }
        if (icon) icon.setAttribute('data-lucide', 'check-circle');
      } else {
        if (badge) {
          badge.style.background = 'rgba(99, 102, 241, 0.15)';
          badge.style.color = 'var(--accent-primary)';
          badge.style.boxShadow = '0 0 25px rgba(99, 102, 241, 0.3)';
        }
        if (icon) icon.setAttribute('data-lucide', 'info');
      }

      this.openModal('customDialogModal');
      if (window.lucide) lucide.createIcons();

      const onConfirm = () => {
        confirmBtn.removeEventListener('click', onConfirm);
        this.closeModal('customDialogModal');
        resolve(true);
      };
      confirmBtn.addEventListener('click', onConfirm, { once: true });
    });
  }

  showConfirm(title, message, options = {}) {
    const {
      confirmText = 'Lanjutkan',
      cancelText = 'Batal',
      isDanger = false,
      iconType = 'warning'
    } = options;

    return new Promise((resolve) => {
      const badge = document.getElementById('dialogIconBadge');
      const icon = document.getElementById('dialogIcon');
      const titleEl = document.getElementById('dialogTitle');
      const msgEl = document.getElementById('dialogMessage');
      const cancelBtn = document.getElementById('btnDialogCancel');
      const confirmBtn = document.getElementById('btnDialogConfirm');

      if (titleEl) titleEl.textContent = title || 'Konfirmasi';
      if (msgEl) msgEl.innerHTML = message || '';

      if (cancelBtn) {
        cancelBtn.style.display = 'block';
        cancelBtn.textContent = cancelText;
      }
      if (confirmBtn) {
        confirmBtn.className = isDanger ? 'btn btn-danger' : 'btn btn-primary';
        confirmBtn.textContent = confirmText;
        confirmBtn.style.flex = '1';
      }

      if (isDanger || iconType === 'danger') {
        if (badge) {
          badge.style.background = 'rgba(239, 68, 68, 0.15)';
          badge.style.color = '#ef4444';
          badge.style.boxShadow = '0 0 25px rgba(239, 68, 68, 0.3)';
        }
        if (icon) icon.setAttribute('data-lucide', 'trash-2');
      } else if (iconType === 'warning') {
        if (badge) {
          badge.style.background = 'rgba(245, 158, 11, 0.15)';
          badge.style.color = '#f59e0b';
          badge.style.boxShadow = '0 0 25px rgba(245, 158, 11, 0.3)';
        }
        if (icon) icon.setAttribute('data-lucide', 'alert-triangle');
      } else {
        if (badge) {
          badge.style.background = 'rgba(99, 102, 241, 0.15)';
          badge.style.color = 'var(--accent-primary)';
          badge.style.boxShadow = '0 0 25px rgba(99, 102, 241, 0.3)';
        }
        if (icon) icon.setAttribute('data-lucide', 'help-circle');
      }

      this.openModal('customDialogModal');
      if (window.lucide) lucide.createIcons();

      const onConfirm = () => {
        cleanup();
        this.closeModal('customDialogModal');
        resolve(true);
      };
      const onCancel = () => {
        cleanup();
        this.closeModal('customDialogModal');
        resolve(false);
      };
      const cleanup = () => {
        confirmBtn.removeEventListener('click', onConfirm);
        cancelBtn.removeEventListener('click', onCancel);
      };

      confirmBtn.addEventListener('click', onConfirm, { once: true });
      cancelBtn.addEventListener('click', onCancel, { once: true });
    });
  }

  // -------------------------------------------------------------
  // Dynamic Server URL Management (for Mobile APK & Remote)
  // -------------------------------------------------------------
  getServerUrl() {
    const custom = localStorage.getItem('cloudme_custom_server_url');
    if (custom && custom.trim()) return custom.trim().replace(/\/+$/, '');
    const isNative = (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) || window.location.protocol === 'file:' || (window.location.hostname === 'localhost' && window.location.port !== '8080');
    if (isNative) return 'https://triple-bandwidth-dpi-prototype.trycloudflare.com';
    return window.location.origin;
  }

  updateServerUrlDisplay() {
    const serverUrl = this.getServerUrl();
    const display = document.getElementById('authServerDisplay');
    if (display) {
      display.textContent = `Server: ${serverUrl.replace(/^https?:\/\//, '')}`;
      display.title = serverUrl;
    }
  }

  openServerConfigModal() {
    const input = document.getElementById('inputCustomServerUrl');
    if (input) input.value = this.getServerUrl();
    const statusBox = document.getElementById('serverTestStatusBox');
    if (statusBox) statusBox.style.display = 'none';
    this.openModal('serverConfigModal');
  }

  setServerUrlPreset(type) {
    const input = document.getElementById('inputCustomServerUrl');
    if (!input) return;
    if (type === 'tunnel') {
      input.value = 'https://triple-bandwidth-dpi-prototype.trycloudflare.com';
    } else if (type === 'local') {
      input.value = 'http://192.168.18.89:8080';
    } else if (type === 'origin') {
      input.value = window.location.origin;
    }
  }

  async testServerConnection() {
    const input = document.getElementById('inputCustomServerUrl');
    const statusBox = document.getElementById('serverTestStatusBox');
    if (!input || !statusBox) return;

    let url = (input.value || '').trim().replace(/\/+$/, '');
    if (!url) {
      statusBox.style.display = 'block';
      statusBox.style.background = 'rgba(239, 68, 68, 0.15)';
      statusBox.style.color = '#ef4444';
      statusBox.innerHTML = '❌ Masukkan URL server terlebih dahulu.';
      return;
    }

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
      input.value = url;
    }

    statusBox.style.display = 'block';
    statusBox.style.background = 'rgba(59, 130, 246, 0.15)';
    statusBox.style.color = '#3b82f6';
    statusBox.innerHTML = '⏳ Menghubungi server...';

    try {
      const res = await _origFetch(`${url}/api/info`, { signal: AbortSignal.timeout(6000) });
      const data = await res.json();
      if (data && data.appName) {
        statusBox.style.background = 'rgba(16, 185, 129, 0.15)';
        statusBox.style.color = '#10b981';
        statusBox.innerHTML = `✅ Terhubung! Server <strong>${this.escapeHtml(data.appName)} v${data.version || '1.0'}</strong> aktif.`;
      } else {
        throw new Error('Format respon server tidak dikenal');
      }
    } catch (err) {
      statusBox.style.background = 'rgba(239, 68, 68, 0.15)';
      statusBox.style.color = '#ef4444';
      statusBox.innerHTML = `❌ Gagal terhubung (${this.escapeHtml(err.message)}). Pastikan server aktif dan URL benar.`;
    }
  }

  saveServerUrl() {
    const input = document.getElementById('inputCustomServerUrl');
    if (!input) return;
    let url = (input.value || '').trim().replace(/\/+$/, '');
    if (url && !url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }
    if (url) {
      localStorage.setItem('cloudme_custom_server_url', url);
    } else {
      localStorage.removeItem('cloudme_custom_server_url');
    }
    this.closeModal('serverConfigModal');
    this.updateServerUrlDisplay();
    this.showToast('✅ Alamat server berhasil disimpan!', 'success');
    this.checkSystemStatus();
  }

  showToast(msg, type = 'info') {
    const toast = document.createElement('div');
    toast.style.cssText = `
      position: fixed; bottom: 2rem; left: 50%; transform: translateX(-50%);
      background: var(--bg-secondary); border: 1px solid var(--border-color);
      color: var(--text-primary); padding: 0.75rem 1.5rem; border-radius: var(--radius-full);
      box-shadow: var(--shadow-xl); z-index: 150; font-weight: 500; font-size: 0.9rem;
      animation: fadeIn 0.2s ease;
    `;
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  }
}

// Instantiate App
window.app = new CloudMeApp();
