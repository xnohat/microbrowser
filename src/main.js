// microbrowser - minimal Electron browser tuned for low-RAM Linux devices
// (Pi Zero 2 W / armv7l, 512 MB). Single window, single content view,
// persistent cookies, real Chromium UA, full keyboard navigation.

const { app, BrowserWindow, BrowserView, ipcMain, session, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ---------- Memory / GPU flags (must be set BEFORE app.whenReady) ----------
// NOTE: 'single-process' was tried and removed — it crashes Electron 27 with a
// node_platform.cc Isolate assertion on armv7l. Sandbox is already disabled.
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('disable-gpu-rasterization');
app.commandLine.appendSwitch('disable-accelerated-2d-canvas');
app.commandLine.appendSwitch('disable-accelerated-video-decode');
app.commandLine.appendSwitch('disable-accelerated-mjpeg-decode');
app.commandLine.appendSwitch('disable-accelerated-jpeg-decoding');
app.commandLine.appendSwitch('disable-d3d11');
app.commandLine.appendSwitch('disable-canvas-aa');
app.commandLine.appendSwitch('disable-composited-antialiasing');
// Fold the GPU into the main (browser) process — saves ~25-30 MB by killing
// one whole Chromium subprocess. Safe here because GPU acceleration is fully
// disabled anyway (everything above).
app.commandLine.appendSwitch('in-process-gpu');
// Trim background work that wakes the CPU and pages memory back in from swap
// while idle. Pi Zero 2 W has slow SD-card swap, so reducing idle activity is
// the difference between "barely loads" and "stuck thrashing" for heavy sites.
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-domain-reliability');
app.commandLine.appendSwitch('disable-sync');
app.commandLine.appendSwitch('disable-breakpad');
app.commandLine.appendSwitch('disable-crash-reporter');
app.commandLine.appendSwitch('disable-default-apps');
app.commandLine.appendSwitch('disable-extensions');
app.commandLine.appendSwitch('disable-hang-monitor');
app.commandLine.appendSwitch('disable-client-side-phishing-detection');
app.commandLine.appendSwitch('disable-renderer-accessibility');
app.commandLine.appendSwitch('disable-logging');
app.commandLine.appendSwitch('disable-print-preview');
app.commandLine.appendSwitch('disable-speech-api');
app.commandLine.appendSwitch('disable-translate');
app.commandLine.appendSwitch('disable-search-engine-choice-screen');
app.commandLine.appendSwitch('no-pings');
app.commandLine.appendSwitch('no-first-run');
app.commandLine.appendSwitch('no-default-browser-check');
app.commandLine.appendSwitch('metrics-recording-only');
app.commandLine.appendSwitch('force-color-profile', 'srgb');
// Kill features that bloat memory but aren't needed for browsing.
// AudioServiceOutOfProcess off = audio runs in main, one less subprocess.
app.commandLine.appendSwitch('disable-features',
  'CalculateNativeWinOcclusion,Translate,MediaRouter,OptimizationHints,' +
  'InterestFeedContentSuggestions,IsolateOrigins,site-per-process,' +
  'SpareRendererForSitePerProcess,GlobalMediaControls,HardwareMediaKeyHandling,' +
  'AcceptCHFrame,AutofillServerCommunication,CertificateTransparencyComponentUpdater,' +
  'NetworkTimeServiceQuerying,OptimizationGuideModelDownloading,' +
  'PrivacySandboxSettings4,FedCm,BackForwardCache,LazyFrameLoading,' +
  'CookieDeprecationFacilitatedTesting,TrustTokens,WebOTP,' +
  'WebRtcHideLocalIpsWithMdns,' +
  'AudioServiceOutOfProcess,AudioServiceLaunchOnStartup,AudioServiceSandbox');
// Fold the network service into the browser process — saves another whole
// Chromium subprocess (~25-30 MB). Both flag names are tried because the
// feature was renamed between Chromium versions.
app.commandLine.appendSwitch('enable-features',
  'NetworkServiceInProcess,NetworkServiceInProcess2');
// One renderer for the whole site graph (saves a lot on low-RAM devices).
app.commandLine.appendSwitch('process-per-site');
// V8 tuning:
//   --optimize-for-size : trade a little speed for smaller heap (used by
//                         Chrome's built-in low-end-device mode)
//   --lazy              : skip parsing functions until first call
//   --no-flush-bytecode : don't recompile under minor pressure (we GC ourselves)
//   --expose-gc         : reaper triggers major GCs from JS
app.commandLine.appendSwitch('js-flags',
  '--max-old-space-size=192 --optimize-for-size --lazy ' +
  '--no-flush-bytecode --expose-gc');
// Pi Zero often runs without a proper sandbox kernel config.
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('num-raster-threads', '1');
app.commandLine.appendSwitch('renderer-process-limit', '1');
// Cap Chromium caches so pages don't balloon over time.
app.commandLine.appendSwitch('disk-cache-size', String(16 * 1024 * 1024));
app.commandLine.appendSwitch('media-cache-size', String(4 * 1024 * 1024));
app.commandLine.appendSwitch('enable-aggressive-domstorage-flushing');

// Persistent user data lives in ~/.config/microbrowser (Linux default).
app.setPath('userData', path.join(app.getPath('home'), '.config', 'microbrowser'));

// Chromium UA without the "Electron/x.y.z" token — Google OAuth refuses to
// authenticate "insecure embedded browsers" advertising Electron.
const REAL_UA =
  'Mozilla/5.0 (X11; Linux armv7l) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chromium/118.0.5993.159 Chrome/118.0.5993.159 Safari/537.36';

const DEFAULT_HOME = 'about:blank';
const TAB_HEIGHT = 28;
const TOOLBAR_HEIGHT = 40;
const CHROME_HEIGHT = TAB_HEIGHT + TOOLBAR_HEIGHT;
const STATUS_HEIGHT = 22;
function contentBounds(w, h) {
  return { x: 0, y: CHROME_HEIGHT, width: w,
           height: Math.max(0, h - CHROME_HEIGHT - STATUS_HEIGHT) };
}

// ---------- Settings (persisted JSON) ----------
const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');
// permissionDecisions: { "<origin>|<perm>": "allow" | "deny" }
const DEFAULTS = { homeUrl: DEFAULT_HOME, zoom: 1.0, bookmarks: [], permissionDecisions: {}, history: [], tabs: [], activeTabId: null, slowUrls: [], urlBlockRules: [] };
const HISTORY_MAX = 500;
let settings = { ...DEFAULTS };
try {
  if (fs.existsSync(SETTINGS_PATH))
    Object.assign(settings, JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')));
} catch (_) { /* corrupt file → fall back to defaults */ }
// Compute the saved-tabs list NOW (before the renderer loads), otherwise the
// renderer's `pendingRestore` query races `ready-to-show` and returns null —
// the restore modal never shows AND no blank tab gets created.
const _savedTabs = (settings.tabs || []).filter(
  (t) => t && t.url && t.url !== 'about:blank' && t.url !== DEFAULT_HOME,
);
function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  } catch (_) {}
}

let win = null;
let view = null;          // BrowserView for the currently active tab, or null

// ---------- CLI URL handling ----------
// When invoked from a terminal (or via xdg-open / `x-www-browser` because we
// registered as the default browser), the URL to open arrives in argv. Strip
// Chromium/Electron switches and pick the first plausible URL/path.
function urlFromArgv(argv) {
  if (!Array.isArray(argv)) return null;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!a || a.startsWith('-')) continue;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(a)) return a;
    if (/^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(a)) return 'https://' + a;
    if (a.startsWith('/') && fs.existsSync(a)) return 'file://' + a;
  }
  return null;
}
const initialURL = urlFromArgv(process.argv);

// Single-instance: if microbrowser is already running and the user invokes
// `microbrowser <url>` (e.g. via xdg-open from a terminal), forward the URL to
// the existing instance instead of starting a second app.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv2) => {
    const url = urlFromArgv(argv2);
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
    if (url) createTab(url);
  });
}

// ---------- Tabs (aggressive memory saving) ----------
// Invariant: at most ONE tab has a live BrowserView / renderer process at any
// time. Every other tab is just metadata (url, title, scroll) on disk. When
// switching tabs we destroy the outgoing renderer entirely and recreate a
// fresh one for the incoming tab. This keeps RSS tiny on 512 MB devices.
let tabs = [];            // [{ id, url, title, scroll: [x,y] }]
let activeTabId = null;
let suspendInFlight = null; // dedupe rapid switches
let pendingRestore = _savedTabs.length ? _savedTabs : null;  // saved tabs awaiting user decision on startup

function newTabId() {
  return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
function findTab(id) { return tabs.find((t) => t.id === id); }
function tabSummaries() {
  return tabs.map((t) => ({ id: t.id, url: t.url, title: t.title }));
}
function broadcastTabs() {
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send('tabs-state', { tabs: tabSummaries(), activeTabId });
  } catch (_) {}
}
function persistTabs() {
  settings.tabs = tabs.map((t) => ({
    id: t.id, url: t.url, title: t.title, scroll: t.scroll || [0, 0],
  }));
  settings.activeTabId = activeTabId;
  saveSettings();
}

// Snapshot the active tab's state, destroy its renderer, release memory.
async function suspendActiveTab() {
  if (suspendInFlight) return suspendInFlight;
  const v = view;
  const id = activeTabId;
  if (!v || !id) return;
  suspendInFlight = (async () => {
    const tab = findTab(id);
    const wc = v.webContents;
    if (tab && wc && !wc.isDestroyed()) {
      try { tab.url = wc.getURL() || tab.url; } catch (_) {}
      try { tab.title = wc.getTitle() || tab.title; } catch (_) {}
      try {
        const s = await wc.executeJavaScript(
          '[window.scrollX|0, window.scrollY|0]', true);
        if (Array.isArray(s)) tab.scroll = [s[0] | 0, s[1] | 0];
      } catch (_) {}
    }
    try { if (win && !win.isDestroyed()) win.removeBrowserView(v); } catch (_) {}
    try { if (wc && !wc.isDestroyed()) wc.destroy(); } catch (_) {}
    if (view === v) view = null;
    if (statusActiveWcId === (wc && wc.id)) statusActiveWcId = null;
    persistTabs();
    // Aggressive memory reclaim now that the renderer is gone.
    reapMemory();
  })();
  try { await suspendInFlight; }
  finally { suspendInFlight = null; }
}

async function activateTab(id) {
  const tab = findTab(id);
  if (!tab) return;
  if (id === activeTabId && view) return;
  await suspendActiveTab();
  activeTabId = id;
  attachViewForTab(tab);
  persistTabs();
  broadcastTabs();
}

function createTab(url, { activate = true } = {}) {
  const tab = {
    id: newTabId(),
    url: url || settings.homeUrl || DEFAULT_HOME,
    title: '',
    scroll: [0, 0],
  };
  tabs.push(tab);
  if (activate) activateTab(tab.id);
  else { persistTabs(); broadcastTabs(); }
  return tab.id;
}

async function closeTab(id) {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  if (id === activeTabId) {
    // Destroy renderer without bothering to snapshot (tab is being thrown away).
    const v = view;
    if (v) {
      try { if (win && !win.isDestroyed()) win.removeBrowserView(v); } catch (_) {}
      try { if (!v.webContents.isDestroyed()) v.webContents.destroy(); } catch (_) {}
      view = null;
      statusActiveWcId = null;
    }
    activeTabId = null;
  }
  tabs.splice(idx, 1);
  if (!tabs.length) {
    createTab(settings.homeUrl || DEFAULT_HOME);
    return;
  }
  if (!activeTabId) {
    const next = tabs[Math.min(idx, tabs.length - 1)];
    await activateTab(next.id);
  } else {
    persistTabs();
    broadcastTabs();
  }
}

function normalizeURL(input) {
  const s = (input || '').trim();
  if (!s) return settings.homeUrl;
  if (/^[a-z]+:\/\//i.test(s)) return s;
  if (/^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(s)) return 'https://' + s;
  return 'https://www.google.com/search?q=' + encodeURIComponent(s);
}

// ---------- Permission policy ----------
// Auto-allow only "boring" permissions that don't need a prompt
// (these never get a UI in Chrome either).
const AUTO_ALLOW = new Set([
  'clipboard-read', 'clipboard-sanitized-write', 'fullscreen',
  'pointerLock', 'background-sync',
]);
// Auto-deny things we never want (saves RAM, surprise).
const AUTO_DENY = new Set([
  'midi', 'midiSysex', 'serial', 'hid', 'usb', 'bluetooth',
  'storage-access', 'window-management', 'idle-detection',
]);
// Anything else (geolocation, media, notifications, persistent-storage)
// prompts the user the first time per origin, and the decision is
// remembered in settings.json.

function originOf(urlOrWc) {
  try {
    const u = typeof urlOrWc === 'string' ? urlOrWc : urlOrWc.getURL();
    const { protocol, host } = new URL(u);
    return protocol + '//' + host;
  } catch (_) { return ''; }
}
function permKey(origin, perm) { return origin + '|' + perm; }
function getPermDecision(origin, perm) {
  return settings.permissionDecisions[permKey(origin, perm)];
}
function setPermDecision(origin, perm, value) {
  if (value == null) delete settings.permissionDecisions[permKey(origin, perm)];
  else settings.permissionDecisions[permKey(origin, perm)] = value;
  saveSettings();
}

// Queue of pending prompts so the UI shows them one at a time.
let pendingPrompts = [];
let activePrompt = null;
let nextPromptId = 1;

function showNextPrompt() {
  if (activePrompt || !pendingPrompts.length) return;
  activePrompt = pendingPrompts.shift();
  if (win && !win.isDestroyed())
    win.webContents.send('permission-prompt', {
      id: activePrompt.id,
      origin: activePrompt.origin,
      perm: activePrompt.perm,
    });
}
function resolvePrompt(id, allow, remember) {
  if (!activePrompt || activePrompt.id !== id) return;
  const { origin, perm, cb } = activePrompt;
  if (remember) setPermDecision(origin, perm, allow ? 'allow' : 'deny');
  cb(allow);
  activePrompt = null;
  setImmediate(showNextPrompt);
}

function applyPermissionPolicy(ses) {
  ses.setPermissionRequestHandler((wc, perm, cb, details) => {
    if (AUTO_ALLOW.has(perm)) return cb(true);
    if (AUTO_DENY.has(perm))  return cb(false);
    const origin = originOf(details?.requestingUrl || wc);
    const saved = getPermDecision(origin, perm);
    if (saved === 'allow') return cb(true);
    if (saved === 'deny')  return cb(false);
    pendingPrompts.push({ id: nextPromptId++, origin, perm, cb });
    showNextPrompt();
  });
  ses.setPermissionCheckHandler((wc, perm, requestingOrigin) => {
    if (AUTO_ALLOW.has(perm)) return true;
    if (AUTO_DENY.has(perm))  return false;
    const origin = requestingOrigin || originOf(wc);
    return getPermDecision(origin, perm) === 'allow';
  });
}

// ---------- History ----------
function recordHistory(url, title) {
  if (!url || url === 'about:blank') return;
  if (/^(data|chrome|file|javascript):/i.test(url)) return;
  // Drop any prior entry for the same URL so most-recent rises to the top.
  settings.history = settings.history.filter((h) => h.url !== url);
  settings.history.unshift({ url, title: (title || '').slice(0, 200), t: Date.now() });
  if (settings.history.length > HISTORY_MAX)
    settings.history.length = HISTORY_MAX;
  saveSettings();
}
function searchHistory(q, limit = 8) {
  const s = (q || '').toLowerCase().trim();
  if (!s) return settings.history.slice(0, limit);
  const out = [];
  for (const h of settings.history) {
    if (h.url.toLowerCase().includes(s) ||
        (h.title && h.title.toLowerCase().includes(s))) {
      out.push(h);
      if (out.length >= limit) break;
    }
  }
  return out;
}

// ---------- Downloads ----------
// Save to ~/Downloads, notify the toolbar so it can show a toast.
function applyDownloads(ses) {
  ses.on('will-download', (_e, item) => {
    const dir = app.getPath('downloads');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    const target = path.join(dir, item.getFilename());
    item.setSavePath(target);
    item.on('done', (_e2, state) => {
      if (win && !win.isDestroyed())
        win.webContents.send('download', {
          name: item.getFilename(), state, path: target,
        });
    });
  });
}

// ---------- Slow-URL blocklist (cancel-at-start, self-learning) ----------
// Why this exists, in one paragraph:
//   Chromium allows at most 6 simultaneous HTTP/1.1 connections per host. If a
//   site (Facebook is the canonical offender) fires 6+ long-poll / comet
//   requests to the SAME host, every subsequent request to that host queues
//   forever — including render-blocking <link rel=stylesheet> and <script>
//   tags. The page then stays blank "until rendering". Electron's webRequest
//   API only lets us cancel a request at onBeforeRequest (i.e. before it
//   starts) — there's no mid-flight abort. So we do two things:
//     1. Seed a tiny built-in list of URL substrings that are universally
//        known long-pollers and never needed to render the page.
//     2. Learn at runtime: whenever the soft per-request timeout fires
//        (REQUEST_TIMEOUT_MS, ~60s), add that URL's host+pathPrefix to the
//        list so future requests matching it are cancelled at start.
//   The learned list persists in settings.json so a reboot still benefits.
const SLOW_TIMEOUT_MS_FOR_LEARN = 60_000;

// Built-in seed: only the truly safe-to-kill long-pollers. These never affect
// rendered content — they're chat presence sockets and telemetry beacons.
const SEED_BLOCK_SUBSTRINGS = [
  '://edge-chat.facebook.com/',
  '://edge-chat.messenger.com/',
  '://web-chat.facebook.com/',
];

// Learned set, populated at runtime from soft-timeout firings. Stored as URL
// substrings of the form "host/pathPrefix" (no scheme so http/https both
// match). Capped so it can't grow unbounded.
const LEARNED_BLOCK_MAX = 200;
let learnedBlock = new Set(Array.isArray(settings.slowUrls) ? settings.slowUrls : []);

// User-managed rules from the Settings UI. Each entry is { p: string, r: bool }
// — p = pattern, r = true if pattern is a JS regex source, false = plain
// substring match. Compiled regexes are cached so we don't re-parse per
// request (onBeforeRequest is on the hot path).
let userRules = Array.isArray(settings.urlBlockRules) ? settings.urlBlockRules.slice() : [];
let compiledUserRules = []; // [{ test: (url) => bool }]
function compileUserRules() {
  compiledUserRules = userRules.map((rule) => {
    if (rule && rule.r) {
      try {
        const re = new RegExp(rule.p);
        return { test: (u) => re.test(u) };
      } catch (_) {
        // Bad regex → match nothing (so we don't crash the request pipeline).
        return { test: () => false };
      }
    }
    const sub = (rule && rule.p) || '';
    if (!sub) return { test: () => false };
    return { test: (u) => u.indexOf(sub) >= 0 };
  });
}
compileUserRules();

function slowKeyFromUrl(u) {
  // Use host + first two path segments as the match key — narrow enough not
  // to over-block (won't kill all of facebook.com), broad enough to match the
  // same endpoint across query-string variations.
  try {
    const p = new URL(u);
    const parts = p.pathname.split('/').filter(Boolean).slice(0, 2);
    return p.host + '/' + parts.join('/');
  } catch (_) { return ''; }
}
function isBlockedUrl(u) {
  if (!u) return false;
  for (let i = 0; i < SEED_BLOCK_SUBSTRINGS.length; i++) {
    if (u.indexOf(SEED_BLOCK_SUBSTRINGS[i]) >= 0) return true;
  }
  for (let i = 0; i < compiledUserRules.length; i++) {
    if (compiledUserRules[i].test(u)) return true;
  }
  if (learnedBlock.size) {
    const key = slowKeyFromUrl(u);
    if (key && learnedBlock.has(key)) return true;
  }
  return false;
}
function learnSlowUrl(u) {
  const key = slowKeyFromUrl(u);
  if (!key || learnedBlock.has(key)) return;
  learnedBlock.add(key);
  // Cap with simple FIFO trim — Set iteration is insertion-ordered in JS.
  while (learnedBlock.size > LEARNED_BLOCK_MAX) {
    const oldest = learnedBlock.values().next().value;
    learnedBlock.delete(oldest);
  }
  settings.slowUrls = Array.from(learnedBlock);
  saveSettings();
}
function applyRequestBlocklist(ses) {
  ses.webRequest.onBeforeRequest((details, cb) => {
    if (isBlockedUrl(details.url)) return cb({ cancel: true });
    cb({});
  });
}

// ---------- Status bar state ----------
// Tracks load progress, current resource URL, last error, and memory use for
// the bottom status bar. Only requests from the *active* tab's webContents
// count toward percent/current-file; chrome UI requests are ignored.
let statusActiveWcId = null;
let statusCurrentUrl = '';
let statusTotal = 0;
let statusCompleted = 0;
let statusError = '';
let statusLoading = false;
let statusSendQueued = false;
// Middle-ellipsis trim so the status bar shows BOTH the host (begin) and the
// resource filename (end), e.g. "https://facebook.com/abc…/image.jpg".
// Without this, long FB URLs would either get cut off mid-host (losing the
// filename) or push the memory/percent fields out of view.
function trimResUrl(u, max = 72) {
  if (!u) return '';
  if (u.length <= max) return u;
  const half = Math.max(8, Math.floor((max - 1) / 2));
  return u.slice(0, half) + '…' + u.slice(-half);
}
function memoryUsage() {
  let appBytes = 0;
  try {
    for (const m of app.getAppMetrics()) {
      // workingSetSize is in KB on Linux/Win, see Electron docs.
      appBytes += ((m.memory && m.memory.workingSetSize) || 0) * 1024;
    }
  } catch (_) {}
  return {
    appBytes,
    sysFree: os.freemem(),
    sysTotal: os.totalmem(),
  };
}
function sendStatus() {
  statusSendQueued = false;
  if (!win || win.isDestroyed()) return;
  const pct = statusTotal === 0
    ? (statusLoading ? 0 : 100)
    : statusLoading
      ? Math.min(99, Math.round((statusCompleted / statusTotal) * 100))
      : 100;
  try {
    win.webContents.send('status-state', {
      url: trimResUrl(statusCurrentUrl),
      percent: pct,
      error: statusError,
      loading: statusLoading,
      mem: memoryUsage(),
    });
  } catch (_) {}
}
function scheduleStatus() {
  if (statusSendQueued) return;
  statusSendQueued = true;
  setTimeout(sendStatus, 80);
}
function resetStatusForNav() {
  // Drop any timers from the previous page — if one fired *after* this reset
  // it would corrupt the new page's percent (statusCompleted > statusTotal).
  for (const e of requestTimers.values()) clearTimeout(e.timer);
  requestTimers.clear();
  statusTotal = 0;
  statusCompleted = 0;
  statusCurrentUrl = '';
  statusError = '';
  statusLoading = true;
  scheduleStatus();
}
// Per-request soft timeout. Chromium/Electron's webRequest API can't cancel a
// request after it's started (no abort hook past onHeadersReceived). What it
// CAN do is stop letting that request wedge our UI: if a request hasn't
// completed within REQUEST_TIMEOUT_MS we count it as completed in the status
// tracker so the percent bar can reach 100% and the toolbar's "loading" flag
// settles. The actual socket keeps running in Chromium's network stack until
// it errors out naturally, but it stops blocking the user's perception of
// "page loaded". Long-polling endpoints (Facebook chat comet, etc.) are the
// usual culprits — they're async XHR/fetch so they never blocked render to
// begin with, only the load indicator.
const REQUEST_TIMEOUT_MS = 60_000;
// requestId -> { timer, counted } so we don't double-count completion when
// the real onCompleted/onErrorOccurred fires after our timeout already did.
const requestTimers = new Map();
function markRequestDone(id) {
  const entry = requestTimers.get(id);
  if (!entry) return false;
  clearTimeout(entry.timer);
  requestTimers.delete(id);
  if (entry.counted) return false; // timeout already counted it
  return true;
}
function applyStatusTracking(ses) {
  // onSendHeaders is non-blocking (observation-only) so it adds no latency.
  ses.webRequest.onSendHeaders((details) => {
    if (details.webContentsId !== statusActiveWcId) return;
    statusTotal++;
    statusCurrentUrl = details.url;
    const id = details.id;
    const url = details.url;
    const entry = { counted: false, timer: setTimeout(() => {
      // Soft timeout: treat as completed for status purposes so the UI
      // doesn't stay stuck at 99% / "loading" forever on hanging requests.
      const e = requestTimers.get(id);
      if (!e || e.counted) return;
      e.counted = true;
      statusCompleted++;
      scheduleStatus();
      // Self-learn: this URL didn't finish in 60s, so on the NEXT load we
      // cancel it at request-start. That frees up the per-host connection
      // slot Chromium would otherwise pin to a long-poll, letting render-
      // blocking CSS/JS to the same host actually get through.
      if (REQUEST_TIMEOUT_MS >= SLOW_TIMEOUT_MS_FOR_LEARN) learnSlowUrl(url);
    }, REQUEST_TIMEOUT_MS) };
    requestTimers.set(id, entry);
    scheduleStatus();
  });
  ses.webRequest.onCompleted((details) => {
    if (details.webContentsId !== statusActiveWcId) return;
    if (markRequestDone(details.id)) statusCompleted++;
    scheduleStatus();
  });
  ses.webRequest.onErrorOccurred((details) => {
    if (details.webContentsId !== statusActiveWcId) return;
    if (markRequestDone(details.id)) statusCompleted++;
    scheduleStatus();
  });
}

// ---------- Find in page ----------
function startFind(query, opts) {
  if (!view || !query) return;
  view.webContents.findInPage(query, opts || {});
}
function stopFind() {
  if (!view) return;
  view.webContents.stopFindInPage('clearSelection');
}

// ---------- Zoom ----------
function applyZoom(reset = false, delta = 0) {
  settings.zoom = reset
    ? 1.0
    : Math.max(0.5, Math.min(2.5, +(settings.zoom + delta).toFixed(2)));
  if (view) view.webContents.setZoomFactor(settings.zoom);
  if (win) win.webContents.send('zoom-changed', settings.zoom);
  saveSettings();
}

// ---------- Memory reaper ----------
// Every 45s and on blur/minimize/hide: clear Chromium HTTP/code caches,
// flush storage, force V8 GC in main + both renderers. Cookies survive.
function reapMemory() {
  const ses = session.fromPartition('persist:main');
  ses.clearCache().catch(() => {});
  ses.clearHostResolverCache().catch(() => {});
  ses.clearCodeCaches({ urls: [] }).catch(() => {});
  ses.flushStorageData();
  if (global.gc) try { global.gc(); } catch (_) {}
  const gcSnippet = 'try { if (typeof gc === "function") gc(); } catch (_) {}';
  if (win && !win.isDestroyed())
    win.webContents.executeJavaScript(gcSnippet).catch(() => {});
  if (view && !view.webContents.isDestroyed())
    view.webContents.executeJavaScript(gcSnippet).catch(() => {});
}

// ---------- Keyboard shortcuts ----------
function handleShortcut(e, input) {
  if (input.type !== 'keyDown') return;
  const ctrl = input.control || input.meta;
  const key = input.key.toLowerCase();

  if (ctrl && key === 'l')      { e.preventDefault(); win.webContents.send('focus-url'); }
  else if (ctrl && (key === 'r' || key === 'f5')) { e.preventDefault(); view?.webContents.reload(); }
  else if (ctrl && key === 'f') { e.preventDefault(); win.webContents.send('toggle-find'); }
  else if (ctrl && key === 'd') { e.preventDefault(); win.webContents.send('toggle-bookmark'); }
  else if (ctrl && (key === '+' || key === '=')) { e.preventDefault(); applyZoom(false, 0.1); }
  else if (ctrl && key === '-') { e.preventDefault(); applyZoom(false, -0.1); }
  else if (ctrl && key === '0') { e.preventDefault(); applyZoom(true); }
  else if (ctrl && key === 't') { e.preventDefault(); createTab(settings.homeUrl || DEFAULT_HOME); }
  else if (ctrl && key === 'w') { e.preventDefault(); if (activeTabId) closeTab(activeTabId); }
  else if (ctrl && key === 'tab') {
    e.preventDefault();
    if (tabs.length > 1) {
      const i = tabs.findIndex((t) => t.id === activeTabId);
      const next = tabs[(i + (input.shift ? -1 : 1) + tabs.length) % tabs.length];
      activateTab(next.id);
    }
  }
  else if (ctrl && key === 'q') { e.preventDefault(); app.quit(); }
  else if (key === 'f12')       { e.preventDefault(); view?.webContents.toggleDevTools(); }
  else if (input.alt && key === 'arrowleft')  { e.preventDefault(); if (view?.webContents.canGoBack())    view.webContents.goBack(); }
  else if (input.alt && key === 'arrowright') { e.preventDefault(); if (view?.webContents.canGoForward()) view.webContents.goForward(); }
  else if (key === 'escape')    { win.webContents.send('escape'); }
}

// ---------- Window + content view ----------
// Session policies (UA, permission handler, download handler) are global to
// `persist:main` so they only need to be installed once, not per-view.
let sessionInitialized = false;
function ensureSession() {
  if (sessionInitialized) return session.fromPartition('persist:main');
  const ses = session.fromPartition('persist:main');
  ses.setUserAgent(REAL_UA);
  applyPermissionPolicy(ses);
  applyDownloads(ses);
  applyRequestBlocklist(ses);
  applyStatusTracking(ses);
  sessionInitialized = true;
  return ses;
}

function attachViewForTab(tab) {
  ensureSession();
  view = new BrowserView({
    webPreferences: {
      partition: 'persist:main',
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      backgroundThrottling: true,
      spellcheck: false,
      webgl: false,
      // No V8 code cache on disk/RAM — saves a few MB per renderer and
      // avoids growing the SD-card cache file over time.
      v8CacheOptions: 'none',
      // Disable Chromium's "preload to RAM" eager image decode for offscreen
      // content; pages still load, just less proactively.
      enablePreferredSizeMode: false,
    },
  });
  win.setBrowserView(view);

  const [w, h] = win.getContentSize();
  view.setBounds(contentBounds(w, h));
  view.setAutoResize({ width: true, height: true });

  const wc = view.webContents;
  wc.setUserAgent(REAL_UA);
  wc.setZoomFactor(settings.zoom);
  wc.on('before-input-event', handleShortcut);
  statusActiveWcId = wc.id;
  resetStatusForNav();
  wc.on('did-start-navigation', (_e, _url, isInPlace, isMainFrame) => {
    if (isMainFrame) resetStatusForNav();
  });
  wc.on('did-start-loading', () => { statusLoading = true; scheduleStatus(); });
  wc.on('did-stop-loading',  () => { statusLoading = false; scheduleStatus(); });

  // window.open / target=_blank → open in a new tab instead of a new window.
  // A second BrowserWindow would duplicate the toolbar webContents and roughly
  // double RAM usage, which we can't afford here.
  wc.setWindowOpenHandler(({ url }) => {
    if (url && url !== 'about:blank') createTab(url);
    return { action: 'deny' };
  });

  const broadcast = () => {
    if (!win || win.isDestroyed()) return;
    if (view.webContents.isDestroyed()) return;
    try {
      win.webContents.send('nav-state', {
        url: wc.getURL(),
        title: wc.getTitle(),
        canGoBack: wc.canGoBack(),
        canGoForward: wc.canGoForward(),
        loading: wc.isLoading(),
        zoom: settings.zoom,
      });
    } catch (_) {}
  };
  wc.on('did-navigate', (_e, navUrl) => {
    recordHistory(navUrl, wc.getTitle());
    const t = findTab(activeTabId);
    if (t) { t.url = navUrl; t.scroll = [0, 0]; persistTabs(); broadcastTabs(); }
  });
  wc.on('did-navigate-in-page', (_e, navUrl, isMain) => {
    if (!isMain) return;
    const t = findTab(activeTabId);
    if (t) { t.url = navUrl; persistTabs(); broadcastTabs(); }
  });
  wc.on('page-title-updated', (_e, title) => {
    // Backfill title on most-recent entry if it matches the current URL.
    const cur = wc.getURL();
    const top = settings.history[0];
    if (top && top.url === cur && title && top.title !== title) {
      top.title = title.slice(0, 200);
      saveSettings();
    }
    const t = findTab(activeTabId);
    if (t && title && t.title !== title) {
      t.title = title.slice(0, 200);
      persistTabs();
      broadcastTabs();
    }
  });

  // One-shot scroll restore after the page finishes loading.
  const restoreScroll = tab.scroll && (tab.scroll[0] || tab.scroll[1])
    ? tab.scroll.slice() : null;
  if (restoreScroll) {
    wc.once('did-finish-load', () => {
      wc.executeJavaScript(
        'window.scrollTo(' + (restoreScroll[0] | 0) + ',' +
                              (restoreScroll[1] | 0) + ')',
        true,
      ).catch(() => {});
    });
  }
  wc.on('did-start-loading',    broadcast);
  wc.on('did-stop-loading',     broadcast);
  wc.on('did-navigate',         broadcast);
  wc.on('did-navigate-in-page', broadcast);
  wc.on('page-title-updated', broadcast);

  wc.on('found-in-page', (_e, result) => {
    if (win && !win.isDestroyed())
      win.webContents.send('find-result', result);
  });

  // Friendly error page on failed loads.
  wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
    if (!isMain || code === -3 /* aborted */) return;
    statusError = (desc || 'load failed') + ' (' + code + ')';
    scheduleStatus();
    const html = `<!doctype html><meta charset="utf-8"><title>Can't open page</title>
      <style>body{font:14px/1.4 sans-serif;background:#1e1e1e;color:#ddd;padding:40px;}
        code{background:#000;padding:2px 6px;border-radius:3px;color:#f88;}</style>
      <h2>Can't open page</h2>
      <p>${desc} <code>(${code})</code></p>
      <p><b>${url}</b></p>
      <p><a style="color:#4a8cff" href="javascript:history.back()">Go back</a> ·
         <a style="color:#4a8cff" href="javascript:location.reload()">Try again</a></p>`;
    wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  });

  wc.loadURL(tab.url || DEFAULT_HOME);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1024, height: 600,
    show: false,
    backgroundColor: '#1e1e1e',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      backgroundThrottling: true,
      spellcheck: false,
      webgl: false,
    },
  });

  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'chrome.html'));
  win.webContents.on('before-input-event', handleShortcut);

  // One-time listeners (registered here, NOT in attachViewForTab — otherwise
  // they would accumulate one per tab switch and leak both memory and time).
  win.on('resize', () => {
    if (!view || view.webContents.isDestroyed()) return;
    const [w, h] = win.getContentSize();
    view.setBounds(contentBounds(w, h));
  });
  app.on('browser-window-created', (_e, w) => {
    if (w.webContents) w.webContents.setUserAgent(REAL_UA);
  });
  win.once('ready-to-show', () => {
    win.show();
    // `pendingRestore` was computed up-front (see top of file) so the
    // renderer's startup query doesn't race this event. If there's nothing
    // to restore, open a single blank tab; otherwise leave tabs empty until
    // the user answers the restore modal.
    if (pendingRestore) {
      broadcastTabs();
      // If a URL was passed on the CLI, open it as an extra tab even when
      // there are saved tabs awaiting the restore prompt — the user clearly
      // asked to open *this* page right now.
      if (initialURL) createTab(initialURL);
    } else {
      createTab(initialURL || settings.homeUrl || DEFAULT_HOME);
    }
  });

  win.on('blur',     reapMemory);
  win.on('minimize', reapMemory);
  win.on('hide',     reapMemory);

  win.on('closed', () => { win = null; view = null; });
}

// ---------- IPC ----------
ipcMain.handle('nav', (_e, action, payload) => {
  if (!view) return;
  const wc = view.webContents;
  switch (action) {
    case 'back':    if (wc.canGoBack())    wc.goBack(); break;
    case 'forward': if (wc.canGoForward()) wc.goForward(); break;
    case 'reload':  wc.reload(); break;
    case 'stop':
      // wc.stop() only cancels in-flight network requests in the browser
      // process. The renderer's HTML parser, image decoders, and scripts that
      // are already running keep going (that's why pages appear to "keep
      // loading" after stop). window.stop() inside the renderer halts the
      // document loader and parser there too. We also blank out any media
      // elements that have begun decoding to free their buffers immediately.
      wc.stop();
      wc.executeJavaScript(
        '(function(){try{window.stop();}catch(_){}' +
        'try{for(const el of document.querySelectorAll(' +
          '"img,iframe,video,audio,source,script")){' +
          'try{if(el.tagName==="IMG"&&!el.complete)el.src="";' +
              'else if(el.tagName==="IFRAME")el.src="about:blank";' +
              'else if(el.tagName==="VIDEO"||el.tagName==="AUDIO"){' +
                'el.pause();el.removeAttribute("src");el.load();}' +
          '}catch(_){}}}catch(_){}})()',
        true,
      ).catch(() => {});
      // Force a nav-state push so the UI flips out of "loading" right away
      // (did-stop-loading may lag a beat behind on slow CPUs).
      setImmediate(() => {
        if (!win || win.isDestroyed() || wc.isDestroyed()) return;
        try {
          win.webContents.send('nav-state', {
            url: wc.getURL(),
            title: wc.getTitle(),
            canGoBack: wc.canGoBack(),
            canGoForward: wc.canGoForward(),
            loading: false,
            zoom: settings.zoom,
          });
        } catch (_) {}
      });
      break;
    case 'home':    wc.loadURL(settings.homeUrl); break;
    case 'go':      wc.loadURL(normalizeURL(payload)); break;
    case 'gc':      reapMemory(); break;
  }
});

ipcMain.handle('find', (_e, action, q, opts) => {
  if (action === 'start') startFind(q, opts);
  else stopFind();
});

ipcMain.handle('zoom', (_e, action) => {
  if (action === 'in')    applyZoom(false, 0.1);
  else if (action === 'out')   applyZoom(false, -0.1);
  else if (action === 'reset') applyZoom(true);
  return settings.zoom;
});

ipcMain.handle('bookmarks', (_e, action, data) => {
  if (action === 'list') return settings.bookmarks;
  if (action === 'add') {
    if (!data || !data.url) return settings.bookmarks;
    if (!settings.bookmarks.some((b) => b.url === data.url))
      settings.bookmarks.push({ title: (data.title || data.url).slice(0, 80), url: data.url });
    saveSettings();
    return settings.bookmarks;
  }
  if (action === 'remove') {
    settings.bookmarks = settings.bookmarks.filter((b) => b.url !== data.url);
    saveSettings();
    return settings.bookmarks;
  }
  if (action === 'current') {
    if (!view) return null;
    return { url: view.webContents.getURL(), title: view.webContents.getTitle() };
  }
});

ipcMain.handle('settings', (_e, action, data) => {
  if (action === 'get') return { ...settings };
  if (action === 'setHome') {
    settings.homeUrl = data || DEFAULT_HOME;
    saveSettings();
    return settings.homeUrl;
  }
});

ipcMain.handle('permission', (_e, action, data) => {
  if (action === 'respond') {
    resolvePrompt(data.id, !!data.allow, !!data.remember);
    return true;
  }
  if (action === 'list') {
    // Group decisions by origin for the settings UI.
    const out = {};
    for (const k of Object.keys(settings.permissionDecisions)) {
      const [origin, perm] = k.split('|');
      (out[origin] = out[origin] || {})[perm] = settings.permissionDecisions[k];
    }
    return out;
  }
  if (action === 'set') {
    setPermDecision(data.origin, data.perm, data.value); // 'allow'|'deny'|null
    return true;
  }
  if (action === 'clear') {
    if (data?.origin) {
      for (const k of Object.keys(settings.permissionDecisions))
        if (k.startsWith(data.origin + '|')) delete settings.permissionDecisions[k];
    } else {
      settings.permissionDecisions = {};
    }
    saveSettings();
    return true;
  }
});

ipcMain.handle('blocklist', (_e, action, data) => {
  if (action === 'list') {
    return {
      seed: SEED_BLOCK_SUBSTRINGS.slice(),       // read-only built-ins
      rules: userRules.slice(),                  // user-editable
      learned: Array.from(learnedBlock),         // auto-learned at runtime
    };
  }
  if (action === 'add') {
    const p = (data && typeof data.p === 'string') ? data.p.trim() : '';
    const r = !!(data && data.r);
    if (!p) return { ok: false, error: 'empty pattern' };
    // Validate regex up front so the user gets immediate feedback instead of
    // silently-broken rules.
    if (r) { try { new RegExp(p); } catch (e) { return { ok: false, error: e.message }; } }
    if (userRules.some((x) => x.p === p && !!x.r === r))
      return { ok: true, dupe: true };
    userRules.push({ p, r });
    settings.urlBlockRules = userRules;
    saveSettings();
    compileUserRules();
    return { ok: true };
  }
  if (action === 'remove') {
    const p = data && data.p;
    const r = !!(data && data.r);
    userRules = userRules.filter((x) => !(x.p === p && !!x.r === r));
    settings.urlBlockRules = userRules;
    saveSettings();
    compileUserRules();
    return { ok: true };
  }
  if (action === 'removeLearned') {
    if (data && data.key) learnedBlock.delete(data.key);
    settings.slowUrls = Array.from(learnedBlock);
    saveSettings();
    return { ok: true };
  }
  if (action === 'clearLearned') {
    learnedBlock.clear();
    settings.slowUrls = [];
    saveSettings();
    return { ok: true };
  }
});

ipcMain.handle('history', (_e, action, data) => {
  if (action === 'search') return searchHistory(data?.q, data?.limit || 8);
  if (action === 'list')   return settings.history.slice(0, data?.limit || 200);
  if (action === 'delete') {
    if (!data?.url) return false;
    const before = settings.history.length;
    settings.history = settings.history.filter((h) => h.url !== data.url);
    if (settings.history.length !== before) saveSettings();
    return true;
  }
  if (action === 'clear') {
    settings.history = [];
    saveSettings();
    return true;
  }
});

ipcMain.handle('tabs', async (_e, action, data) => {
  if (action === 'list')   return { tabs: tabSummaries(), activeTabId };
  if (action === 'new')    return createTab(data && data.url);
  if (action === 'close')  { await closeTab(data && data.id); return true; }
  if (action === 'switch') { await activateTab(data && data.id); return true; }
  if (action === 'pendingRestore') {
    return pendingRestore ? { count: pendingRestore.length } : null;
  }
  if (action === 'restore') {
    const saved = pendingRestore || [];
    pendingRestore = null;
    if (data && data.choice === 'yes' && saved.length) {
      tabs = saved.map((t) => ({
        id: t.id || newTabId(),
        url: t.url || DEFAULT_HOME,
        title: t.title || '',
        scroll: Array.isArray(t.scroll) ? t.scroll : [0, 0],
      }));
      activeTabId = settings.activeTabId && findTab(settings.activeTabId)
        ? settings.activeTabId
        : (tabs[0] && tabs[0].id) || null;
      const t = findTab(activeTabId);
      if (t) attachViewForTab(t);
      persistTabs();
      broadcastTabs();
    } else {
      // Fresh session: discard the saved list and open one blank tab.
      tabs = [];
      activeTabId = null;
      createTab('about:blank');
    }
    return true;
  }
});

// Hide the BrowserView while a chrome overlay (settings, prompt, dropdown)
// is open — without this the overlays render but get covered by the page.
ipcMain.handle('view-visible', (_e, visible) => {
  if (!view || !win || win.isDestroyed()) return;
  if (visible) {
    const [w, h] = win.getContentSize();
    view.setBounds(contentBounds(w, h));
  } else {
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  }
});

ipcMain.handle('open-external', (_e, url) => shell.openExternal(url));

ipcMain.handle('clear-data', async (_e, kind) => {
  const ses = session.fromPartition('persist:main');
  if (kind === 'cache') {
    await ses.clearCache();
    await ses.clearCodeCaches({ urls: [] });
    return true;
  }
  if (kind === 'cookies') {
    await ses.clearStorageData({
      storages: ['cookies', 'localstorage', 'sessionstorage', 'indexdb',
                 'websql', 'serviceworkers', 'shadercache', 'cachestorage'],
    });
    return true;
  }
  if (kind === 'history') {
    settings.history = [];
    saveSettings();
    return true;
  }
  if (kind === 'all') {
    await ses.clearCache();
    await ses.clearStorageData();
    settings.bookmarks = [];
    settings.permissionDecisions = {};
    settings.history = [];
    saveSettings();
    return true;
  }
});

ipcMain.handle('about', () => ({
  app: app.getName(),
  version: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  platform: process.platform,
  arch: process.arch,
}));

// ---------- App lifecycle ----------
app.whenReady().then(() => {
  session.fromPartition('persist:main').setUserAgent(REAL_UA);
  createWindow();
  setInterval(reapMemory, 45_000).unref();
  // Memory readings change even when no nav events fire — push every 2 s.
  setInterval(sendStatus, 2_000).unref();
});

app.on('window-all-closed', () => app.quit());
