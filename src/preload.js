// Bridge for the toolbar UI. Tiny on purpose.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mb', {
  // Navigation
  nav: (action, payload) => ipcRenderer.invoke('nav', action, payload),

  // Find in page
  findStart: (q, opts) => ipcRenderer.invoke('find', 'start', q, opts),
  findStop:  ()         => ipcRenderer.invoke('find', 'stop'),
  onFindResult: (cb)   => ipcRenderer.on('find-result', (_e, r) => cb(r)),

  // Zoom
  zoom: (action) => ipcRenderer.invoke('zoom', action),
  onZoom: (cb)   => ipcRenderer.on('zoom-changed', (_e, z) => cb(z)),

  // Bookmarks
  bookmarks: (action, data) => ipcRenderer.invoke('bookmarks', action, data),

  // Settings
  settings: (action, data) => ipcRenderer.invoke('settings', action, data),

  // History
  history: (action, data) => ipcRenderer.invoke('history', action, data),

  // URL blocklist (cancel-at-start + auto-learned slow URLs)
  blocklist: (action, data) => ipcRenderer.invoke('blocklist', action, data),

  // Permissions
  permission: (action, data) => ipcRenderer.invoke('permission', action, data),
  onPermissionPrompt: (cb) => ipcRenderer.on('permission-prompt', (_e, p) => cb(p)),

  // Downloads
  onDownload: (cb) => ipcRenderer.on('download', (_e, info) => cb(info)),

  // Navigation state stream
  onNavState: (cb) => ipcRenderer.on('nav-state', (_e, s) => cb(s)),

  // Status bar stream (current resource, percent, error, memory)
  onStatusState: (cb) => ipcRenderer.on('status-state', (_e, s) => cb(s)),

  // Tabs
  tabs: (action, data) => ipcRenderer.invoke('tabs', action, data),
  onTabsState: (cb) => ipcRenderer.on('tabs-state', (_e, s) => cb(s)),

  // Shortcuts forwarded from main
  onFocusUrl:       (cb) => ipcRenderer.on('focus-url', () => cb()),
  onToggleFind:     (cb) => ipcRenderer.on('toggle-find', () => cb()),
  onToggleBookmark: (cb) => ipcRenderer.on('toggle-bookmark', () => cb()),
  onEscape:         (cb) => ipcRenderer.on('escape', () => cb()),

  viewVisible: (v) => ipcRenderer.invoke('view-visible', v),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  clearData: (kind) => ipcRenderer.invoke('clear-data', kind),
  about: () => ipcRenderer.invoke('about'),
});
