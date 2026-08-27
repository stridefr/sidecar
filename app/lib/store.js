// Small JSON store for the stuff that has to survive a restart: pinned
// sessions, per-project hues, and what's been read. No dependency — Electron's
// userData directory plus a synchronous JSON file is all this needs.
const fs = require('fs');
const path = require('path');

const HUE_RING = ['violet', 'cyan', 'magenta', 'amber2', 'teal', 'rose'];

const DEFAULT_SETTINGS = {
  // 0 = fully see-through, 1 = solid. The window's acrylic does the blur;
  // this is only the tint painted over it to keep text readable.
  tint: 0.28,
  composerTint: 0.34,
  // Windows composites the blur itself, and exposes materials rather than a
  // blur radius — 'acrylic' is the strongly blurred one, 'mica' is a subtle
  // desktop-tinted wash, 'none' is no show-through at all.
  material: 'acrylic',
  // 'glass'  — Windows composites the blur (acrylic/mica). Real background
  //            blur, but it obeys Windows' own "Transparency effects" switch,
  //            and goes fully opaque when that's off.
  // 'clear'  — a genuinely transparent window; the tint slider is then real
  //            per-pixel alpha that Windows settings can't override. No
  //            background blur, because only the OS compositor can blur what
  //            is behind a window — CSS can't reach it.
  windowMode: 'glass',
  // The prompt box used to vanish the moment it lost focus, which made it
  // useless if you needed to click anything else first. Off by default now.
  composerAutoHide: false,
  // Windows only delivers synthesised keystrokes to the foreground window, so
  // Antigravity has to surface for a moment when sending. With this on, whatever
  // was in front beforehand is put straight back (and Antigravity is re-minimised
  // if it started minimised), so sending doesn't drag you into the IDE.
  returnFocusAfterSend: true,
  hotkeyComposer: 'Control+Alt+Space',
  hotkeyMain: 'Control+Alt+S',
  // 'auto' follows the system's reduced-motion preference (which on Windows is
  // just the "Animation effects" switch), 'on' and 'off' override it. Plenty of
  // people turn Windows animations off for speed rather than for motion
  // sensitivity, and they should still be able to have them here.
  animations: 'auto',
  diffShortcutsInstalled: false,
};

class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      return Object.assign({ pinned: {}, hues: {}, hueOrder: [], readSeq: {}, settings: {} }, parsed);
    } catch (e) {
      return { pinned: {}, hues: {}, hueOrder: [], readSeq: {}, settings: {} };
    }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
    } catch (e) {
      console.error('[store] failed to save', e);
    }
  }

  isPinned(sessionId) { return !!this.data.pinned[sessionId]; }
  setPinned(sessionId, pinned) {
    if (pinned) this.data.pinned[sessionId] = true;
    else delete this.data.pinned[sessionId];
    this._save();
  }

  // Hues are assigned from a fixed ring the first time a project is seen,
  // then remembered — so a project keeps its colour and you learn it.
  hueFor(projectKey) {
    if (this.data.hues[projectKey]) return this.data.hues[projectKey];
    const idx = this.data.hueOrder.length % HUE_RING.length;
    const hue = HUE_RING[idx];
    this.data.hueOrder.push(projectKey);
    this.data.hues[projectKey] = hue;
    this._save();
    return hue;
  }
  setHue(projectKey, hue) {
    this.data.hues[projectKey] = hue;
    if (!this.data.hueOrder.includes(projectKey)) this.data.hueOrder.push(projectKey);
    this._save();
  }

  lastReadSeq(sessionId) { return this.data.readSeq[sessionId] || 0; }
  markRead(sessionId, seq) {
    this.data.readSeq[sessionId] = seq;
    this._save();
  }

  getSettings() {
    const s = Object.assign({}, DEFAULT_SETTINGS, this.data.settings);
    // `animations` used to be a boolean — carry old saved values across.
    if (typeof s.animations === 'boolean') s.animations = s.animations ? 'auto' : 'off';
    if (!['auto', 'on', 'off'].includes(s.animations)) s.animations = 'auto';
    return s;
  }
  setSettings(partial) {
    this.data.settings = Object.assign(this.getSettings(), partial);
    this._save();
    return this.getSettings();
  }
}

module.exports = { Store, HUE_RING, DEFAULT_SETTINGS };
