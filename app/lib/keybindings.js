// Sidecar drives Antigravity by sending keystrokes, which only works if there
// is a keystroke to send. Three of the commands it needs ship with no default
// shortcut at all, and the one that does have one is gated behind a `when`
// clause that doesn't hold when focus is coming from another application:
//
//   claude-vscode.focus              "Focus input" — bound to ctrl+escape, but
//                                    only `when: editorTextFocus`, so it does
//                                    nothing if the editor isn't focused.
//   claude-vscode.acceptProposedDiff no default binding
//   claude-vscode.rejectProposedDiff no default binding
//
// So Sidecar adds its own bindings, with no `when` clause, to Antigravity's
// keybindings.json — the same file its Keyboard Shortcuts editor writes. This
// edits a real IDE config file, so it only runs when the user asks for it, and
// the existing file is always backed up first.
const fs = require('fs');
const path = require('path');
const os = require('os');

const KEYBINDINGS_PATH = path.join(os.homedir(), 'AppData', 'Roaming', 'Antigravity IDE', 'User', 'keybindings.json');

const FOCUS_KEY = 'ctrl+alt+shift+0';
const ACCEPT_KEY = 'ctrl+alt+shift+y';
const REJECT_KEY = 'ctrl+alt+shift+n';

// No `when` on any of these — that is the entire point. They must fire while
// focus is arriving from outside the IDE.
const OURS = [
  { key: FOCUS_KEY, command: 'claude-vscode.focus', _sidecar: true },
  { key: ACCEPT_KEY, command: 'claude-vscode.acceptProposedDiff', _sidecar: true },
  { key: REJECT_KEY, command: 'claude-vscode.rejectProposedDiff', _sidecar: true },
];
const OUR_COMMANDS = OURS.map((o) => o.command);

// Strips // and /* */ comments well enough for VS Code's usually-simple
// keybindings.json (JSONC). Not a full parser — good enough for a file that
// is, in practice, almost always just an array of small objects.
function stripJsonComments(text) {
  let out = '';
  let inStr = false, inLine = false, inBlock = false, prev = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inLine) { if (c === '\n') { inLine = false; out += c; } continue; }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i++; } continue; }
    if (inStr) { out += c; if (c === '"' && prev !== '\\') inStr = false; prev = c; continue; }
    if (c === '"') { inStr = true; out += c; prev = c; continue; }
    if (c === '/' && n === '/') { inLine = true; i++; continue; }
    if (c === '/' && n === '*') { inBlock = true; i++; continue; }
    out += c; prev = c;
  }
  return out;
}

function readExisting() {
  try {
    const raw = fs.readFileSync(KEYBINDINGS_PATH, 'utf8');
    const trimmed = raw.trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(stripJsonComments(trimmed));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    return null; // exists but unreadable — caller must not blindly overwrite
  }
}

function status() {
  const existing = readExisting();
  if (existing === null) return { installed: false, unreadable: true, fileExists: true };
  const has = (want) => existing.some((e) => e && e.command === want.command && e.key === want.key);
  const installed = OURS.every(has);
  return {
    installed,
    fileExists: fs.existsSync(KEYBINDINGS_PATH),
    focusInstalled: has(OURS[0]),
    diffInstalled: has(OURS[1]) && has(OURS[2]),
  };
}

function install() {
  const existing = readExisting();
  if (existing === null) {
    return { ok: false, error: 'keybindings.json exists but could not be parsed — leaving it untouched. Add the shortcuts by hand instead.' };
  }
  const st = status();
  if (st.installed) return { ok: true, alreadyInstalled: true };

  // Drop any previous Sidecar entries for these commands, then re-add cleanly.
  const withoutOurs = existing.filter((e) => !(e && e._sidecar && OUR_COMMANDS.includes(e.command)));
  const merged = [...withoutOurs, ...OURS];

  fs.mkdirSync(path.dirname(KEYBINDINGS_PATH), { recursive: true });
  if (fs.existsSync(KEYBINDINGS_PATH)) {
    fs.copyFileSync(KEYBINDINGS_PATH, KEYBINDINGS_PATH + `.sidecar-backup-${Date.now()}`);
  }
  fs.writeFileSync(KEYBINDINGS_PATH, JSON.stringify(merged, null, 2));
  return { ok: true, alreadyInstalled: false, path: KEYBINDINGS_PATH };
}

function uninstall() {
  const existing = readExisting();
  if (existing === null) return { ok: false, error: 'keybindings.json could not be parsed.' };
  const remaining = existing.filter((e) => !(e && e._sidecar && OUR_COMMANDS.includes(e.command)));
  fs.writeFileSync(KEYBINDINGS_PATH, JSON.stringify(remaining, null, 2));
  return { ok: true };
}

module.exports = { status, install, uninstall, FOCUS_KEY, ACCEPT_KEY, REJECT_KEY, KEYBINDINGS_PATH };
