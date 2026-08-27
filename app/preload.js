const { contextBridge, ipcRenderer } = require('electron');

// Everything crossing into the main process is reduced to plain primitives
// first. Electron structured-clones IPC arguments, and anything that isn't a
// plain value — a DOM reference that slipped into an array, a getter, a proxy
// from the isolated world — fails with an opaque "conversion failure from"
// TypeError that names neither the field nor the value. Coercing here means a
// bad value becomes an empty string rather than an unexplained crash.
const str = (v) => (v === null || v === undefined ? '' : String(v));
const strList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

function cleanSendPayload(p) {
  const o = p || {};
  return {
    sessionId: str(o.sessionId),
    text: str(o.text),
    images: strList(o.images),
    submit: !!o.submit,
  };
}

contextBridge.exposeInMainWorld('sidecar', {
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  getTranscript: (id, depth) => ipcRenderer.invoke('sessions:transcript', str(id), Number(depth) || 1),
  markRead: (id) => ipcRenderer.invoke('sessions:markRead', id),
  setPinned: (id, pinned) => ipcRenderer.invoke('sessions:setPinned', id, pinned),
  setHue: (key, hue) => ipcRenderer.invoke('sessions:setHue', key, hue),
  focusSession: (id) => ipcRenderer.invoke('sessions:focus', id),
  send: (payload) => ipcRenderer.invoke('sessions:send', cleanSendPayload(payload)),
  answerQuestion: (payload) => ipcRenderer.invoke('sessions:answerQuestion', {
    sessionId: str((payload || {}).sessionId), answerText: str((payload || {}).answerText),
  }),
  getEdits: (id) => ipcRenderer.invoke('sessions:edits', id),
  acceptDiff: (id) => ipcRenderer.invoke('sessions:acceptDiff', id),
  rejectDiff: (id) => ipcRenderer.invoke('sessions:rejectDiff', id),
  getUsage: (hours) => ipcRenderer.invoke('usage:get', hours),
  getPlan: () => ipcRenderer.invoke('plan:get'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (partial) => ipcRenderer.invoke('settings:set', JSON.parse(JSON.stringify(partial || {}))),
  hotkeyStatus: () => ipcRenderer.invoke('settings:hotkeyStatus'),
  reportReducedMotion: (v) => ipcRenderer.invoke('settings:reportReducedMotion', v),
  surfaceInfo: () => ipcRenderer.invoke('settings:surfaceInfo'),
  signalReady: () => ipcRenderer.send('ui:ready-main'),
  relaunch: () => ipcRenderer.invoke('app:relaunch'),
  appVersion: () => ipcRenderer.invoke('app:version'),
  updateState: () => ipcRenderer.invoke('update:state'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateDownload: () => ipcRenderer.invoke('update:download'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  onUpdateChanged: (cb) => ipcRenderer.on('update:changed', (e, st) => cb(st)),
  keybindingsStatus: () => ipcRenderer.invoke('keybindings:status'),
  installKeybindings: () => ipcRenderer.invoke('keybindings:install'),

  hideComposer: () => ipcRenderer.invoke('composer:hide'),
  resizeComposer: (h) => ipcRenderer.invoke('composer:resize', h),
  openComposerFor: (payload) => ipcRenderer.invoke('composer:openFor', {
    id: str((payload || {}).id), title: str((payload || {}).title), hue: str((payload || {}).hue),
  }),
  openComposer: () => ipcRenderer.invoke('composer:toggle'),
  hideMain: () => ipcRenderer.invoke('main:hide'),
  minimizeMain: () => ipcRenderer.invoke('main:minimize'),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),

  onSessionsChanged: (cb) => ipcRenderer.on('sessions:changed', cb),
  onComposerReset: (cb) => ipcRenderer.on('composer:reset', cb),
  onComposerSetTarget: (cb) => ipcRenderer.on('composer:setTarget', (e, payload) => cb(payload)),
  onSettingsChanged: (cb) => ipcRenderer.on('settings:changed', (e, s) => cb(s)),
});
