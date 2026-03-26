const app = {
  basePath: window.BASEPATH || '',
  currentPath: './',
  selectedFile: null,
  renameFile: null,
  files: [],

  async init() {
    this.setupThemeSync();
    this.setupDragDrop();
    this.setupFileInput();
    this.setupKeyboardShortcuts();
    await this.loadFiles();
  },

  api(path) {
    return `${this.basePath}${path}`;
  },

  setupThemeSync() {
    const keys = (window.THEME_KEYS || 'gmgui-theme,theme').split(',').map(k => k.trim());

    const syncTheme = () => {
      let theme = null;
      for (const key of keys) {
        const val = localStorage.getItem(key);
        if (val === 'dark' || val === 'light') { theme = val; break; }
      }
      if (!theme) theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      document.documentElement.className = theme;
      document.documentElement.setAttribute('data-theme', theme);
    };

    syncTheme();

    window.addEventListener('storage', e => {
      if (keys.includes(e.key)) syncTheme();
    });

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncTheme);
  },

  setupKeyboardShortcuts() {
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') this.closePreview();
      if (e.key === 'Escape') this.closeRename();
      if (e.key === 'Escape') this.closeMkdir();
    });
  },

  setupDragDrop() {
    const uploadArea = document.getElementById('uploadArea');
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(evt => {
      uploadArea.addEventListener(evt, e => e.preventDefault());
      document.addEventListener(evt, e => e.preventDefault());
    });

    uploadArea.addEventListener('dragover', () => uploadArea.classList.add('dragover'));
    uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));
    uploadArea.addEventListener('drop', e => {
      uploadArea.classList.remove('dragover');
      this.handleFiles(e.dataTransfer.files);
    });
  },

  setupFileInput() {
    document.getElementById('fileInput').addEventListener('change', e => {
      this.handleFiles(e.target.files);
    });
  },

  async handleFiles(files) {
    if (!files.length) return;

    const formData = new FormData();
    for (const file of files) {
      formData.append('files', file);
    }

    try {
      const response = await fetch(`${this.basePath}/api/upload?path=${encodeURIComponent(this.currentPath)}`, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) throw new Error('Upload failed');
      await this.loadFiles();
    } catch (err) {
      this.showError(`Upload error: ${err.message}`);
    }
  },

  async loadFiles(path = './') {
    this.currentPath = path;
    this.showLoading(true);
    this.clearError();

    try {
      const response = await fetch(this.api(`/api/list/${encodeURIComponent(path)}`));
      if (!response.ok) throw new Error('Failed to load files');

      const result = await response.json();
      if (!result.ok) throw new Error(result.error);

      this.files = result.value.children || [];
      this.renderBreadcrumbs(result.value.path);
      this.renderFiles(this.files);
    } catch (err) {
      this.showError(`Error loading files: ${err.message}`);
    } finally {
      this.showLoading(false);
    }
  },

  escapeAttr(text) {
    return String(text).replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  },

  renderBreadcrumbs(currentPath) {
    const container = document.getElementById('breadcrumbs');
    const parts = currentPath === './' ? [] : currentPath.split('/').filter(Boolean);

    let html = '<button class="breadcrumb-btn" onclick="app.loadFiles(\'./\')">Root</button>';

    let path = './';
    for (const part of parts) {
      path = path === './' ? `./${part}` : `${path}/${part}`;
      html += `<span class="breadcrumb-sep">/</span><button class="breadcrumb-btn" onclick="app.loadFiles('${this.escapeAttr(path)}')">${this.escapeHtml(part)}</button>`;
    }

    container.innerHTML = html;
  },

  renderFiles(files) {
    const container = document.getElementById('fileList');

    if (!files.length) {
      container.innerHTML = '<div class="empty-state">No files</div>';
      return;
    }

    let html = '';
    for (const file of files) {
      const icon = this.getFileIcon(file.type);
      const size = file.type === 'dir' ? '-' : this.formatSize(file.size);
      const date = new Date(file.time?.modified).toLocaleDateString();
      const safePath = this.escapeAttr(file.path);
      const safeType = this.escapeAttr(file.type);
      const safeName = this.escapeAttr(file.name);

      html += `
        <div class="file-row" data-path="${safePath}" data-type="${safeType}">
          <div class="file-info">
            <span class="file-icon">${icon}</span>
            <div class="file-details">
              <div class="file-name" onclick="app.openFile('${safePath}', '${safeType}')">${this.escapeHtml(file.name)}</div>
              <div class="file-meta">${size} · ${date}</div>
            </div>
          </div>
          <div class="file-actions">
            ${file.type === 'dir' ? `<button class="icon-btn" onclick="app.loadFiles('${safePath}')" title="Open">→</button>` : ''}
            ${file.type !== 'dir' ? `<button class="icon-btn" draggable="true" ondragstart="app.startDragDownload('${safePath}')" title="Drag to download" style="cursor: grab;">⬆</button>` : ''}
            <button class="icon-btn" onclick="app.downloadFile('${safePath}')" title="Download">⬇</button>
            <button class="icon-btn" onclick="app.startRename('${safePath}', '${safeName}')" title="Rename">✎</button>
            <button class="icon-btn delete" onclick="app.deleteFile('${safePath}')" title="Delete">✕</button>
          </div>
        </div>
      `;
    }

    container.innerHTML = html;
  },

  startDragDownload(filePath) {
    const fileName = filePath.split('/').pop();
    event.dataTransfer.setData('text/uri-list', this.api(`/api/download/${encodeURIComponent(filePath)}`));
    event.dataTransfer.effectAllowed = 'copy';
  },

  openFile(filePath, fileType) {
    if (fileType === 'dir') {
      this.loadFiles(filePath);
      return;
    }

    this.selectedFile = filePath;
    this.showPreview(filePath, fileType);
  },

  async showPreview(filePath, fileType) {
    const modal = document.getElementById('previewModal');
    const previewContainer = document.getElementById('previewContainer');
    const previewName = document.getElementById('previewName');
    const fileName = filePath.split('/').pop();

    previewName.textContent = fileName;
    previewContainer.innerHTML = '<div class="preview-loading"><div class="spinner"></div>Loading file...</div>';
    modal.style.display = 'flex';

    try {
      if (['image', 'video', 'audio'].includes(fileType)) {
        if (fileType === 'image') {
          previewContainer.innerHTML = `<img src="${this.api(`/api/download/${encodeURIComponent(filePath)}`)}" alt="${this.escapeHtml(fileName)}" class="preview-media">`;
        } else if (fileType === 'video') {
          previewContainer.innerHTML = `<video controls class="preview-media"><source src="${this.api(`/api/download/${encodeURIComponent(filePath)}`)}"></video>`;
        } else if (fileType === 'audio') {
          previewContainer.innerHTML = `<audio controls style="width: 100%;"><source src="${this.api(`/api/download/${encodeURIComponent(filePath)}`)}"></audio>`;
        }
      } else {
        const response = await fetch(this.api(`/api/view/${encodeURIComponent(filePath)}`));
        if (!response.ok) throw new Error('Failed to load file');

        const result = await response.json();
        if (!result.ok) throw new Error(result.error);

        const ext = fileName.split('.').pop().toLowerCase();
        let html = '';

        if (['json'].includes(ext)) {
          try {
            const formatted = JSON.stringify(JSON.parse(result.value), null, 2);
            html = `<pre class="preview-text"><code>${this.escapeHtml(formatted)}</code></pre>`;
          } catch {
            html = `<pre class="preview-text"><code>${this.escapeHtml(result.value)}</code></pre>`;
          }
        } else if (['md', 'markdown', 'txt', 'log'].includes(ext)) {
          html = `<pre class="preview-text"><code>${this.escapeHtml(result.value)}</code></pre>`;
        } else if (['js', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'cpp', 'css', 'html', 'xml', 'yaml', 'yml', 'sh', 'bash', 'go', 'rs', 'java', 'kotlin', 'swift'].includes(ext)) {
          html = `<pre class="preview-code"><code class="language-${ext}">${this.escapeHtml(result.value)}</code></pre>`;
          previewContainer.innerHTML = html;
          if (window.hljs) window.hljs.highlightAll();
          return;
        } else {
          html = `<pre class="preview-text"><code>${this.escapeHtml(result.value.substring(0, 10000))}${result.value.length > 10000 ? '\n\n... (file truncated)' : ''}</code></pre>`;
        }

        previewContainer.innerHTML = html;
      }
    } catch (err) {
      previewContainer.innerHTML = `<div class="preview-error">Error loading file: ${this.escapeHtml(err.message)}</div>`;
    }
  },

  closePreview() {
    document.getElementById('previewModal').style.display = 'none';
    this.selectedFile = null;
  },

  downloadFile(filePath) {
    const fileName = filePath.split('/').pop();
    window.location.href = this.api(`/api/download/${encodeURIComponent(filePath)}`);
  },

  startRename(filePath, fileName) {
    this.renameFile = filePath;
    document.getElementById('renameInput').value = fileName;
    document.getElementById('renameModal').style.display = 'flex';
    document.getElementById('renameInput').focus();
    document.getElementById('renameInput').select();
  },

  async confirmRename() {
    const newName = document.getElementById('renameInput').value.trim();
    if (!newName) {
      this.showError('Please enter a name');
      return;
    }

    try {
      const formData = new FormData();
      formData.append('path', this.renameFile);
      formData.append('name', newName);

      const response = await fetch(this.api('/api/rename'), {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) throw new Error('Rename failed');
      this.closeRename();
      await this.loadFiles(this.currentPath);
    } catch (err) {
      this.showError(`Rename error: ${err.message}`);
    }
  },

  closeRename() {
    document.getElementById('renameModal').style.display = 'none';
    this.renameFile = null;
  },

  showCreateFolder() {
    document.getElementById('mkdirInput').value = '';
    document.getElementById('mkdirModal').style.display = 'flex';
    document.getElementById('mkdirInput').focus();
  },

  async confirmMkdir() {
    const folderName = document.getElementById('mkdirInput').value.trim();
    if (!folderName) {
      this.showError('Please enter a folder name');
      return;
    }

    try {
      const folderPath = this.currentPath === './' ? `./${folderName}` : `${this.currentPath}/${folderName}`;
      const formData = new FormData();
      formData.append('path', folderPath);

      const response = await fetch(this.api('/api/mkdir'), {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) throw new Error('Create folder failed');
      this.closeMkdir();
      await this.loadFiles(this.currentPath);
    } catch (err) {
      this.showError(`Error creating folder: ${err.message}`);
    }
  },

  closeMkdir() {
    document.getElementById('mkdirModal').style.display = 'none';
  },

  async deleteFile(filePath) {
    if (!confirm('Are you sure you want to delete this?')) return;

    try {
      const response = await fetch(this.api(`/api/file/${encodeURIComponent(filePath)}`), {
        method: 'DELETE',
      });

      if (!response.ok) throw new Error('Delete failed');
      await this.loadFiles(this.currentPath);
    } catch (err) {
      this.showError(`Delete error: ${err.message}`);
    }
  },

  getFileIcon(type) {
    const icons = {
      dir: '📁', image: '🖼️', video: '🎬', audio: '🎵',
      code: '💻', text: '📝', archive: '📦', document: '📄',
      other: '📋'
    };
    return icons[type] || icons.other;
  },

  formatSize(bytes) {
    if (!bytes) return '-';
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
      size /= 1024;
      unit++;
    }
    return `${size.toFixed(1)} ${units[unit]}`;
  },

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  },

  showLoading(show) {
    document.getElementById('loading').style.display = show ? 'flex' : 'none';
  },

  showError(message) {
    const box = document.getElementById('error');
    box.textContent = message;
    box.style.display = 'block';
  },

  clearError() {
    document.getElementById('error').style.display = 'none';
  }
};

window.addEventListener('DOMContentLoaded', () => app.init());
