// Glues the three read-only pieces (sessions, windows, store) into the shape
// the UI actually wants, and is the only place that decides policy: which
// sessions are shown, how they're grouped, what counts as "unread."
const path = require('path');
const { listLiveWindows, focusPid } = require('./windows');
const { tailScan, fullUsageScan, listAllSessionFiles, recentEdits, PROJECTS_DIR } = require('./sessions');
const { sendToSession, focusOnly, sendChordToSession } = require('./send');
const keybindings = require('./keybindings');

function norm(p) {
  return (p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

// A session's recorded `cwd` is wherever its last tool call happened to run —
// it can drift into a subdirectory mid-session (a Bash command with `cd`, a
// nested project) rather than staying pinned to the folder Antigravity
// actually opened. So a session belongs to a window if its cwd is *that
// workspace or somewhere under it*, not only on an exact match — and when a
// cwd sits under more than one open workspace, the most specific one wins.
function findOwningWindow(sessionCwd, liveWindows) {
  const c = norm(sessionCwd);
  if (!c) return null;
  let best = null;
  for (const w of liveWindows) {
    const root = norm(w.workspacePath);
    if (!root) continue;
    if (c === root || c.startsWith(root + '/')) {
      if (!best || root.length > norm(best.workspacePath).length) best = w;
    }
  }
  return best;
}

function titleFor(scan) {
  if (scan.aiTitle) return scan.aiTitle;
  if (scan.lastPrompt) return scan.lastPrompt.length > 80 ? scan.lastPrompt.slice(0, 80) + '…' : scan.lastPrompt;
  return '(untitled session)';
}

class Controller {
  constructor(store) {
    this.store = store;
    this._lastGroups = new Map(); // sessionId -> {pid, workspacePath} — for focus/send lookups between full rebuilds
  }

  async getSessions() {
    const [liveWindows, files] = await Promise.all([listLiveWindows(), Promise.resolve(listAllSessionFiles())]);

    const scanned = [];
    for (const file of files) {
      let scan;
      try { scan = tailScan(file); } catch (e) { continue; }
      scanned.push({ file, scan });
    }

    const windows = new Map(); // key: pid -> {pid, port, workspacePath, sessions:[]}
    const pinned = [];
    let hiddenCount = 0;

    for (const { file, scan } of scanned) {
      const win = findOwningWindow(scan.cwd, liveWindows);
      const id = file;
      const isPinned = this.store.isPinned(id);

      if (!win && !isPinned) { hiddenCount++; continue; }

      // Key the hue off the *window's* workspace, not the session's own
      // (possibly drifted) cwd — otherwise two sessions in the same open
      // workspace could get different colours just because one of them ran
      // a command in a subdirectory.
      const projectKey = (win && norm(win.workspacePath)) || norm(scan.cwd) || path.dirname(file);
      const hue = this.store.hueFor(projectKey);
      const unread = scan.mtimeMs > this.store.lastReadSeq(id);

      const session = {
        id,
        title: titleFor(scan),
        lastPrompt: scan.lastPrompt,
        status: scan.status,
        ask: scan.ask,
        mtimeMs: scan.mtimeMs,
        sizeBytes: scan.sizeBytes,
        hue,
        pinned: isPinned,
        unread,
        windowLive: !!win,
        pid: win ? win.pid : null,
        port: win ? win.port : null,
        cwd: scan.cwd,
      };

      if (win) {
        this._lastGroups.set(id, { pid: win.pid, workspacePath: win.workspacePath });  // workspacePath disambiguates same-pid windows
      }

      if (isPinned) pinned.push(session);

      if (win) {
        // Keyed by workspace, NOT pid: Antigravity is Electron and runs every
        // window in one process, so pid-keyed groups collapsed all open
        // folders into one.
        const key = norm(win.workspacePath) || String(win.port);
        if (!windows.has(key)) windows.set(key, { pid: win.pid, port: win.port, workspacePath: win.workspacePath, projectKey, sessions: [] });
        windows.get(key).sessions.push(session);
      }
    }

    for (const w of windows.values()) w.sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
    pinned.sort((a, b) => b.mtimeMs - a.mtimeMs);

    // A window can host many sessions, but Sidecar can only bring the *window*
    // forward and focus *whatever Claude conversation is currently active
    // inside it* — there's no command to select a specific session tab. If
    // more than one session shares a window, sending to any of them but the
    // one Antigravity actually has open delivers into the wrong conversation
    // silently. Flagging it here so the UI can warn before that happens,
    // rather than after.
    for (const w of windows.values()) {
      const shared = w.sessions.length > 1;
      for (const s of w.sessions) s.sharesWindowWith = shared ? w.sessions.length - 1 : 0;
    }
    for (const s of pinned) {
      if (s.windowLive) {
        const w = [...windows.values()].find((w2) => w2.sessions.some((x) => x.id === s.id));
        if (w) s.sharesWindowWith = w.sessions.length - 1;
      }
    }

    const windowList = [...windows.values()].sort((a, b) => {
      const am = Math.max(...a.sessions.map((s) => s.mtimeMs));
      const bm = Math.max(...b.sessions.map((s) => s.mtimeMs));
      return bm - am;
    });

    return {
      windows: windowList,
      pinned,
      hiddenCount,
      totalOnDisk: scanned.length,
    };
  }

  getTranscript(sessionId, depth = 1) {
    const scan = tailScan(sessionId, depth);
    return {
      id: sessionId,
      title: titleFor(scan),
      cwd: scan.cwd,
      status: scan.status,
      ask: scan.ask,
      turns: scan.turns,
      hasMore: scan.hasMore,
      depth,
      mtimeMs: scan.mtimeMs,
    };
  }

  markRead(sessionId) {
    const scan = tailScan(sessionId);
    this.store.markRead(sessionId, scan.mtimeMs);
  }

  setPinned(sessionId, pinned) { this.store.setPinned(sessionId, pinned); }
  setHue(projectKey, hue) { this.store.setHue(projectKey, hue); }

  async getUsage(hours = 24) {
    const files = listAllSessionFiles();
    const cutoff = Date.now() - hours * 3600 * 1000;
    const fs = require('fs');
    const liveWindows = await listLiveWindows(); // so a still-open session gets the same hue here as in the rail

    const perSession = [];
    const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0, costUSD: 0 };
    let touched = 0;

    for (const file of files) {
      let stat; try { stat = fs.statSync(file); } catch (e) { continue; }
      if (stat.mtimeMs < cutoff) continue; // cheap pre-filter: file untouched since the window can't have anything in it
      touched++;
      const usage = fullUsageScan(file, cutoff); // scoped to records whose OWN timestamp is in the window
      if (usage.input + usage.output + usage.cacheRead + usage.cacheWrite === 0) continue;

      totals.input += usage.input;
      totals.output += usage.output;
      totals.cacheRead += usage.cacheRead;
      totals.cacheWrite += usage.cacheWrite;
      totals.thinking += usage.thinking;
      totals.costUSD += usage.costUSD;

      let scan; try { scan = tailScan(file); } catch (e) { scan = {}; }
      const win = findOwningWindow(scan.cwd, liveWindows);
      const projectKey = (win && norm(win.workspacePath)) || norm(scan.cwd) || path.dirname(file);
      perSession.push({
        id: file,
        title: titleFor(scan),
        hue: this.store.hueFor(projectKey),
        tokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
        costUSD: usage.costUSD,
      });
    }

    perSession.sort((a, b) => b.tokens - a.tokens);
    const totalTokens = totals.input + totals.output + totals.cacheRead + totals.cacheWrite;

    return { totals, totalTokens, sessionsTouched: touched, perSession: perSession.slice(0, 12) };
  }

  async send({ sessionId, text, images, submit }) {
    const g = this._lastGroups.get(sessionId);
    if (!g) return { ok: false, error: 'That session is not in a currently-open Antigravity window.' };
    return sendToSession({ pid: g.pid, workspacePath: g.workspacePath, text, images, submit,
      restoreFocus: this.store.getSettings().returnFocusAfterSend });
  }

  async focusSession(sessionId) {
    const g = this._lastGroups.get(sessionId);
    if (!g) return { ok: false, error: 'That session is not in a currently-open Antigravity window.' };
    return focusOnly(g.pid, g.workspacePath);
  }

  // A relative markdown link in a transcript ([docs/x.md](docs/x.md)) is
  // rooted at the project folder, not wherever a stray Bash command last
  // `cd`'d to — so this resolves against the *window's* workspace, the same
  // ground truth used for sending, and refuses anything that resolves
  // outside it. `path.relative` starting with '..' is the escape signal,
  // and it catches an absolute path handed in place of a relative one too,
  // since path.resolve(root, absolutePath) just returns that absolute path
  // unchanged — which then legitimately fails the same containment check.
  readProjectFile(sessionId, relPath) {
    const path = require('path');
    const fs = require('fs');

    const g = this._lastGroups.get(sessionId);
    let root = g && g.workspacePath;
    if (!root) {
      try { root = tailScan(sessionId).cwd; } catch (e) { /* fall through */ }
    }
    if (!root) return { ok: false, error: "Could not determine this session's project folder." };

    const normalizedRoot = path.resolve(root);
    const resolved = path.resolve(normalizedRoot, relPath);
    const rel = path.relative(normalizedRoot, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return { ok: false, error: 'That link points outside the project folder — refusing to open it.' };
    }

    let stat;
    try { stat = fs.statSync(resolved); } catch (e) { return { ok: false, error: `File not found: ${relPath}` }; }
    if (!stat.isFile()) return { ok: false, error: 'That path is not a file.' };

    const MAX_BYTES = 2 * 1024 * 1024;
    if (stat.size > MAX_BYTES) {
      return { ok: false, error: `Too large to preview (${(stat.size / 1024 / 1024).toFixed(1)} MB) — open it in your editor instead.` };
    }

    let content;
    try { content = fs.readFileSync(resolved, 'utf8'); }
    catch (e) { return { ok: false, error: 'Could not read that file (it may not be text).' }; }

    return { ok: true, content, isMarkdown: /\.(md|markdown)$/i.test(resolved) };
  }

  // Answering a question isn't a special action — it's the same send pipeline
  // as any other prompt, with the picked option's label as the text.
  async answerQuestion({ sessionId, answerText }) {
    return this.send({ sessionId, text: answerText, images: [], submit: true });
  }

  getEdits(sessionId) {
    try { return recentEdits(sessionId, 12); } catch (e) { return []; }
  }

  diffShortcutStatus() { return keybindings.status(); }
  installDiffShortcuts() {
    const r = keybindings.install();
    if (r.ok) this.store.setSettings({ diffShortcutsInstalled: true });
    return r;
  }

  async acceptDiff(sessionId) {
    const g = this._lastGroups.get(sessionId);
    if (!g) return { ok: false, error: 'That session is not in a currently-open Antigravity window.' };
    if (!keybindings.status().diffInstalled) return { ok: false, error: 'needs-setup' };
    return sendChordToSession({ pid: g.pid, workspacePath: g.workspacePath, chord: keybindings.ACCEPT_KEY,
      restoreFocus: this.store.getSettings().returnFocusAfterSend });
  }

  async rejectDiff(sessionId) {
    const g = this._lastGroups.get(sessionId);
    if (!g) return { ok: false, error: 'That session is not in a currently-open Antigravity window.' };
    if (!keybindings.status().diffInstalled) return { ok: false, error: 'needs-setup' };
    return sendChordToSession({ pid: g.pid, workspacePath: g.workspacePath, chord: keybindings.REJECT_KEY,
      restoreFocus: this.store.getSettings().returnFocusAfterSend });
  }
}

module.exports = { Controller, PROJECTS_DIR };
