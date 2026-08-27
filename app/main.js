const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, nativeImage, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { Store } = require('./lib/store');
const { Controller, PROJECTS_DIR } = require('./lib/controller');
const { readPlan } = require('./lib/plan');
const { readTransparencyEffects } = require('./lib/winfx');
const updater = require('./lib/updater');

let mainWindow = null;
let composerWindow = null;
let tray = null;
let store, controller;
// What the windows were actually built with, so Settings can tell whether the
// saved mode is live yet or still waiting on a restart.
let activeWindowMode = null;

const ICON_PATH = path.join(__dirname, 'assets', 'icon.png');
const PRELOAD = path.join(__dirname, 'preload.js');

// `transparent` can only be set when a window is constructed, so switching
// modes needs a relaunch — the Settings panel offers a Restart button.
function surfaceOptions() {
  const s = store.getSettings();
  if (s.windowMode === 'clear') {
    return { transparent: true, backgroundColor: '#00000000' };
  }
  return { backgroundColor: '#00000000', backgroundMaterial: s.material };
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1060,
    height: 660,
    minWidth: 680,
    minHeight: 440,
    frame: false,
    show: false,
    ...surfaceOptions(),
    icon: ICON_PATH,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Deliberately NOT shown on 'ready-to-show': that fires before webfonts have
  // loaded, so the window appears and then visibly reflows. The renderer signals
  // 'ui:ready' once fonts are in and the first layout is done.
  const revealMain = () => { if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) mainWindow.show(); };
  ipcMain.once('ui:ready-main', revealMain);
  setTimeout(revealMain, 2500); // safety net if that signal never arrives
  if (process.env.SIDECAR_DEBUG) {
    if (!process.env.SIDECAR_NO_DEVTOOLS) mainWindow.webContents.openDevTools({ mode: 'detach' });
    mainWindow.webContents.on('console-message', (e, level, message, line, source) => {
      console.log(`[main-window] ${message} (${source}:${line})`);
    });
  }
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) { e.preventDefault(); mainWindow.hide(); }
  });
}

function createComposerWindow() {
  const disp = screen.getPrimaryDisplay();
  const w = 680, h = 150;
  composerWindow = new BrowserWindow({
    width: w,
    height: h,
    x: Math.round(disp.workArea.x + (disp.workArea.width - w) / 2),
    y: Math.round(disp.workArea.y + disp.workArea.height * 0.24),
    frame: false,
    show: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    ...surfaceOptions(),
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
  });
  composerWindow.setAlwaysOnTop(true, 'screen-saver');
  composerWindow.loadFile(path.join(__dirname, 'renderer', 'composer.html'));
  // Only dismiss on blur if the user has asked for that. Off by default —
  // otherwise the prompt box disappears the moment you click anything else,
  // which makes it impossible to look something up while composing.
  composerWindow.on('blur', () => {
    if (composerWindow && !composerWindow.isDestroyed() && store.getSettings().composerAutoHide) {
      composerWindow.hide();
    }
  });
  if (process.env.SIDECAR_DEBUG) {
    composerWindow.webContents.on('console-message', (e, level, message, line, source) => {
      console.log(`[composer] ${message} (${source}:${line})`);
    });
  }
}

function toggleComposer() {
  if (!composerWindow || composerWindow.isDestroyed()) createComposerWindow();
  if (composerWindow.isVisible()) { composerWindow.hide(); return; }
  sendToComposerWhenReady('composer:reset');
  showComposer();
}

function sendToComposerWhenReady(channel, payload) {
  const send = () => composerWindow.webContents.send(channel, payload);
  if (composerWindow.webContents.isLoading()) composerWindow.webContents.once('did-finish-load', send);
  else send();
}

// Opens the composer already aimed at a specific session — used by the
// "Message <session>" bar in the main window's reader.
function openComposerFor(payload) {
  if (!composerWindow || composerWindow.isDestroyed()) createComposerWindow();
  sendToComposerWhenReady('composer:setTarget', payload);
  showComposer();
}

function toggleMain() {
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
  if (mainWindow.isVisible() && mainWindow.isFocused()) mainWindow.hide();
  else { mainWindow.show(); mainWindow.focus(); }
}

function startWatcher() {
  let timer = null;
  const notify = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('sessions:changed');
    }, 450);
  };
  try {
    fs.watch(PROJECTS_DIR, { recursive: true }, notify);
  } catch (e) {
    console.error('[sidecar] could not watch', PROJECTS_DIR, e.message);
  }
  // fs.watch(recursive) can miss events under load — a slow poll is a cheap backstop
  setInterval(notify, 15000);
}

// Global hotkeys are re-registered whenever they change. If a chord is already
// owned by another app, registration fails silently at the OS level — so this
// reports back which ones actually took, rather than pretending both worked.
function applyHotkeys() {
  globalShortcut.unregisterAll();
  const s = store.getSettings();
  const result = { composer: false, main: false };
  try { result.composer = globalShortcut.register(s.hotkeyComposer, toggleComposer); } catch (e) { result.composer = false; }
  try { result.main = globalShortcut.register(s.hotkeyMain, toggleMain); } catch (e) { result.main = false; }
  return result;
}

// The main process can't read a CSS media query, so the renderer reports the
// system's reduced-motion state and this resolves the same three-way setting
// for the composer's window-height tween.
let systemPrefersReducedMotion = false;
function animationsEnabled() {
  const mode = store.getSettings().animations;
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  return !systemPrefersReducedMotion;
}

function applyMaterial(material) {
  if (store.getSettings().windowMode !== 'glass') return; // no material in clear mode
  for (const w of [mainWindow, composerWindow]) {
    if (!w || w.isDestroyed()) continue;
    try { w.setBackgroundMaterial(material); } catch (e) { /* older Windows — ignore */ }
  }
}

// Electron's setSize snaps instantly, which made the prompt box jump when the
// session picker opened. Tween it instead, easing out over ~180ms.
let composerTween = null;

// A window created with resizable:false pins its minimum size to whatever it
// currently is, so setSize can grow it but is silently ignored when shrinking.
// Lifting the flag around the resize is what makes the box able to collapse
// again; it goes straight back so the edges stay undraggable.
function sizeComposer(w, h) {
  const locked = !composerWindow.isResizable();
  if (locked) composerWindow.setResizable(true);
  composerWindow.setSize(w, h);
  if (locked) composerWindow.setResizable(false);
}

function setComposerHeight(target, animate) {
  if (!composerWindow || composerWindow.isDestroyed()) return;
  const [w, from] = composerWindow.getSize();
  const to = Math.max(150, Math.min(620, Math.round(target)));
  if (composerTween) { clearInterval(composerTween); composerTween = null; }
  if (Math.abs(to - from) < 2) return;
  if (!animate) { sizeComposer(w, to); return; }

  const start = Date.now(), dur = 180;
  composerTween = setInterval(() => {
    if (!composerWindow || composerWindow.isDestroyed()) { clearInterval(composerTween); composerTween = null; return; }
    const t = Math.min(1, (Date.now() - start) / dur);
    const eased = 1 - Math.pow(1 - t, 3);      // ease-out cubic
    sizeComposer(w, Math.round(from + (to - from) * eased));
    if (t >= 1) { clearInterval(composerTween); composerTween = null; }
  }, 12);
}

function broadcastSettings() {
  const s = store.getSettings();
  for (const w of [mainWindow, composerWindow]) {
    if (w && !w.isDestroyed()) w.webContents.send('settings:changed', s);
  }
}

function registerIpc() {
  ipcMain.handle('sessions:list', () => controller.getSessions());
  ipcMain.handle('sessions:transcript', (e, id, depth) => controller.getTranscript(id, depth));
  ipcMain.handle('sessions:markRead', (e, id) => controller.markRead(id));
  ipcMain.handle('sessions:setPinned', (e, id, pinned) => controller.setPinned(id, pinned));
  ipcMain.handle('sessions:setHue', (e, key, hue) => controller.setHue(key, hue));
  ipcMain.handle('sessions:focus', (e, id) => controller.focusSession(id));
  ipcMain.handle('sessions:send', (e, payload) => controller.send(payload));
  ipcMain.handle('sessions:answerQuestion', (e, payload) => controller.answerQuestion(payload));
  ipcMain.handle('sessions:edits', (e, id) => controller.getEdits(id));
  ipcMain.handle('sessions:acceptDiff', (e, id) => controller.acceptDiff(id));
  ipcMain.handle('sessions:rejectDiff', (e, id) => controller.rejectDiff(id));
  ipcMain.handle('usage:get', (e, hours) => controller.getUsage(hours));
  ipcMain.handle('keybindings:status', () => controller.diffShortcutStatus());
  ipcMain.handle('keybindings:install', () => controller.installDiffShortcuts());
  ipcMain.handle('composer:hide', () => { composerWindow && composerWindow.hide(); });
  ipcMain.handle('composer:openFor', (e, payload) => openComposerFor(payload));
  ipcMain.handle('composer:toggle', () => toggleComposer());
  ipcMain.handle('composer:resize', (e, h) => {
    composerReadyHeight = h;
    // While hidden, snap silently — animating a window nobody can see only
    // guarantees the first frame after show() is mid-tween.
    const visible = composerWindow && !composerWindow.isDestroyed() && composerWindow.isVisible();
    setComposerHeight(h, visible && animationsEnabled());
  });
  ipcMain.on('ui:ready-main', () => {});   // handled by the once() listener above
  ipcMain.handle('settings:reportReducedMotion', (e, v) => { systemPrefersReducedMotion = !!v; });
  ipcMain.handle('plan:get', () => readPlan());
  ipcMain.handle('settings:get', () => store.getSettings());
  ipcMain.handle('settings:set', (e, partial) => {
    const before = store.getSettings();
    const after = store.setSettings(partial);
    let hotkeys = null;
    if (after.hotkeyComposer !== before.hotkeyComposer || after.hotkeyMain !== before.hotkeyMain) {
      hotkeys = applyHotkeys();
    }
    if (after.material !== before.material) applyMaterial(after.material);
    broadcastSettings();
    return { settings: after, hotkeys };
  });
  ipcMain.handle('settings:hotkeyStatus', () => applyHotkeys());
  ipcMain.handle('settings:surfaceInfo', async () => ({
    windowsTransparencyEffects: await readTransparencyEffects(),
    activeMode: activeWindowMode,
  }));
  ipcMain.handle('app:relaunch', () => { app.isQuitting = true; app.relaunch(); app.exit(0); });
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('update:state', () => updater.getState());
  ipcMain.handle('update:check', () => updater.check(app, { silent: false }));
  ipcMain.handle('update:download', () => updater.download());
  ipcMain.handle('update:install', () => { app.isQuitting = true; updater.installNow(); });
  ipcMain.handle('main:hide', () => { mainWindow && mainWindow.hide(); });
  ipcMain.handle('main:minimize', () => { mainWindow && mainWindow.minimize(); });
  ipcMain.handle('shell:openPath', (e, p) => shell.showItemInFolder(p));
  // http(s) only — a transcript is other people's model output, not a place
  // a file:// or javascript: link should ever be able to fire from.
  ipcMain.handle('shell:openExternal', (e, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
  });
}

// Only one Sidecar should ever hold the global hotkeys and the userData
// cache at once — a second launch (double-clicked by accident, or started
// while one's already in the tray) just focuses the existing window instead
// of spawning a competing instance.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    store = new Store(path.join(app.getPath('userData'), 'sidecar-data.json'));
    controller = new Controller(store);

    activeWindowMode = store.getSettings().windowMode;
    createMainWindow();

    tray = new Tray(nativeImage.createFromPath(ICON_PATH));
    tray.setToolTip('Sidecar');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Sidecar', click: toggleMain },
      { label: 'New prompt…', click: toggleComposer },
      { type: 'separator' },
      { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
    ]));
    tray.on('click', toggleMain);

    const hk = applyHotkeys();
    const s = store.getSettings();
    if (!hk.composer) console.error(`[sidecar] ${s.hotkeyComposer} is already taken by another app`);
    if (!hk.main) console.error(`[sidecar] ${s.hotkeyMain} is already taken by another app`);

    registerIpc();
    startWatcher();


    updater.init({
      onState: (st) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:changed', st);
      },
    });
    // One quiet check shortly after launch, then daily. Nothing downloads
    // without you saying so.
    setTimeout(() => updater.check(app, { silent: true }), 8000);
    setInterval(() => updater.check(app, { silent: true }), 24 * 60 * 60 * 1000);
  });

  app.on('window-all-closed', (e) => e.preventDefault()); // lives in the tray
  app.on('before-quit', () => { app.isQuitting = true; });
  app.on('will-quit', () => globalShortcut.unregisterAll());
}
