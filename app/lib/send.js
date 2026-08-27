// Delivers a prompt into a session Antigravity is already running.
//
// There is no API for this — the Claude Code extension exposes a "focus input"
// command but nothing that accepts text — so this does what a person would do
// by hand: bring the window forward, put the caret in Claude's input box, paste,
// and press Enter.
//
// Two things this has to get right that are easy to get wrong:
//
//  1. Focusing the *window* is not enough. Focus lands wherever the IDE last
//     had it, so the paste can end up in a source file. The input box is
//     focused explicitly via the keybinding from lib/keybindings.js.
//
//  2. Windows only delivers synthesised keystrokes to the foreground window,
//     so the IDE genuinely must come forward for a moment — there is no way
//     around that with this approach. What we can do is put everything back:
//     remember what was in front, and restore it (and re-minimise Antigravity
//     if it was minimised) the instant the send completes. The whole sequence
//     runs in ONE PowerShell process rather than four, so the window is
//     foreground for a few hundred milliseconds instead of seconds, and
//     nothing can steal focus midway through.
const { clipboard } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const keybindings = require('./keybindings');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function chordToSendKeys(chord) {
  const parts = String(chord).split('+');
  const key = parts.pop();
  const mods = parts.map((p) => ({ ctrl: '^', alt: '%', shift: '+' }[p] || '')).join('');
  const special = '+^%~(){}[]';
  return mods + (special.includes(key) ? `{${key}}` : key);
}

function safeHint(workspacePath) {
  if (!workspacePath) return '';
  const base = String(workspacePath).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
  return base.replace(/[^A-Za-z0-9 ._-]/g, '').slice(0, 60);
}

const psList = (arr) => (arr.length ? arr.map((p) => `'${p.replace(/'/g, "''")}'`).join(',') : '');

// Everything — focus, paste, submit, and putting focus back — in a single
// script. Text and images travel via temp files so no user content is ever
// interpolated into the script body.
function buildSendScript({ targetPid, titleHint, focusChord, textFile, imageFiles, submitKey, restoreFocus }) {
  return `
$TargetPid = ${targetPid}
$TitleHint = '${titleHint}'
$FocusChord = '${focusChord}'
$TextFile = ${textFile ? `'${textFile.replace(/'/g, "''")}'` : "''"}
$ImageFiles = @(${psList(imageFiles || [])})
$SubmitKey = '${submitKey}'
$RestoreFocus = $${restoreFocus ? 'true' : 'false'}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class SidecarSend {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr p);
  public static string TitleOf(IntPtr h) { StringBuilder sb = new StringBuilder(512); GetWindowTextW(h, sb, 512); return sb.ToString(); }
}
"@

$prev = [SidecarSend]::GetForegroundWindow()
$exact = [IntPtr]::Zero
$any = [IntPtr]::Zero
$cb = {
  param($hWnd, $lParam)
  if ([SidecarSend]::IsWindowVisible($hWnd)) {
    $procId = 0
    [SidecarSend]::GetWindowThreadProcessId($hWnd, [ref]$procId) | Out-Null
    if ($procId -eq $TargetPid) {
      $t = [SidecarSend]::TitleOf($hWnd)
      if ($t.Length -gt 0) {
        if ($script:any -eq [IntPtr]::Zero) { $script:any = $hWnd }
        if ($TitleHint.Length -gt 0 -and $t.ToLower().Contains($TitleHint.ToLower())) { $script:exact = $hWnd; return $false }
      }
    }
  }
  return $true
}
[SidecarSend]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
$target = if ($exact -ne [IntPtr]::Zero) { $exact } else { $any }
if ($target -eq [IntPtr]::Zero) { Write-Output "not-found"; exit }

$wasMinimised = [SidecarSend]::IsIconic($target)
if ($wasMinimised) { [SidecarSend]::ShowWindow($target, 9) | Out-Null }
[SidecarSend]::SetForegroundWindow($target) | Out-Null
Start-Sleep -Milliseconds 260

# SetForegroundWindow doesn't guarantee the window STAYS foreground — a
# notification, an alt-tab, even another app's own activation in that window
# can steal it back before the paste fires. If that happens silently, the
# text goes wherever focus actually ended up: the wrong session, or worse,
# some unrelated window. So this is checked before anything is typed, with
# one retry, and the whole send aborts rather than guessing.
$confirmed = $false
for ($i = 0; $i -lt 2; $i++) {
  if ([SidecarSend]::GetForegroundWindow() -eq $target) { $confirmed = $true; break }
  [SidecarSend]::SetForegroundWindow($target) | Out-Null
  Start-Sleep -Milliseconds 200
}
if (-not $confirmed) { Write-Output "focus-lost"; exit }

if ($FocusChord.Length -gt 0) {
  [System.Windows.Forms.SendKeys]::SendWait($FocusChord)
  Start-Sleep -Milliseconds 280
}

# Re-check once more right before anything gets pasted — the gap since the
# first check (focus chord + its sleep) is another window for focus to move.
if ([SidecarSend]::GetForegroundWindow() -ne $target) { Write-Output "focus-lost"; exit }

foreach ($img in $ImageFiles) {
  if (Test-Path $img) {
    $bmp = [System.Drawing.Image]::FromFile($img)
    [System.Windows.Forms.Clipboard]::SetImage($bmp)
    $bmp.Dispose()
    [System.Windows.Forms.SendKeys]::SendWait('^v')
    Start-Sleep -Milliseconds 340
  }
}

if ($TextFile.Length -gt 0 -and (Test-Path $TextFile)) {
  $txt = [System.IO.File]::ReadAllText($TextFile)
  if ($txt.Length -gt 0) {
    [System.Windows.Forms.Clipboard]::SetText($txt)
    [System.Windows.Forms.SendKeys]::SendWait('^v')
    Start-Sleep -Milliseconds 200
  }
}

if ($SubmitKey.Length -gt 0) {
  [System.Windows.Forms.SendKeys]::SendWait($SubmitKey)
  Start-Sleep -Milliseconds 200
}

if ($RestoreFocus) {
  if ($wasMinimised) { [SidecarSend]::ShowWindow($target, 6) | Out-Null }
  if ($prev -ne [IntPtr]::Zero -and $prev -ne $target) { [SidecarSend]::SetForegroundWindow($prev) | Out-Null }
}
Write-Output "sent"
`;
}

function runPs(script, timeout = 20000) {
  return new Promise((resolve) => {
    // -STA is required for the clipboard APIs used above.
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script],
      { windowsHide: true, timeout },
      (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr || err.message || '').trim().split('\n')[0];
          console.error('[sidecar] send script failed:', msg);
          return resolve({ ok: false, error: msg || 'The send script failed.' });
        }
        resolve({ ok: true, out: String(stdout).trim() });
      });
  });
}

function writeTemp(name, buf) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-send-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, buf);
  return { file, dir };
}

async function sendToSession({ pid, workspacePath, text, images, submit, restoreFocus = true }) {
  const target = Number.parseInt(pid, 10);
  if (!Number.isFinite(target) || target <= 0) return { ok: false, error: 'That session has no live window.' };
  if (!keybindings.status().focusInstalled) return { ok: false, error: 'needs-setup' };

  const temps = [];
  let textFile = '';
  const imageFiles = [];

  try {
    if (text && text.trim()) {
      const t = writeTemp('prompt.txt', Buffer.from(text, 'utf8'));
      textFile = t.file; temps.push(t.dir);
    }
    (images || []).forEach((dataUrl, i) => {
      const m = /^data:image\/[a-zA-Z+]+;base64,(.+)$/.exec(dataUrl || '');
      if (!m) return;
      const t = writeTemp(`shot-${i}.png`, Buffer.from(m[1], 'base64'));
      imageFiles.push(t.file); temps.push(t.dir);
    });

    const saved = clipboard.readText();
    const r = await runPs(buildSendScript({
      targetPid: target,
      titleHint: safeHint(workspacePath),
      focusChord: chordToSendKeys(keybindings.FOCUS_KEY),
      textFile, imageFiles,
      submitKey: submit ? '{ENTER}' : '+{ENTER}',
      restoreFocus,
    }));

    await delay(120);
    if (saved) clipboard.writeText(saved);   // don't eat the user's clipboard

    if (!r.ok) return r;
    if (r.out === 'not-found') return { ok: false, error: 'Could not find that Antigravity window. It may have been closed.' };
    if (r.out === 'focus-lost') return { ok: false, error: 'Something else took focus while sending — stopped before anything was typed, so nothing was sent to the wrong place. Try again.' };
    return { ok: true };
  } finally {
    for (const dir of temps) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} }
  }
}

// Bring a session's window forward on purpose (the "Open in Antigravity"
// button) — here stealing focus is the entire point, so nothing is restored.
async function focusOnly(pid, workspacePath) {
  const { focusPid } = require('./windows');
  const ok = await focusPid(pid, workspacePath);
  return ok ? { ok: true } : { ok: false, error: 'Could not find that Antigravity window. It may have been closed.' };
}

// Accept / Reject the diff Antigravity currently has open, then hand focus back.
async function sendChordToSession({ pid, workspacePath, chord, restoreFocus = true }) {
  const target = Number.parseInt(pid, 10);
  if (!Number.isFinite(target) || target <= 0) return { ok: false, error: 'That session has no live window.' };
  const r = await runPs(buildSendScript({
    targetPid: target,
    titleHint: safeHint(workspacePath),
    focusChord: chordToSendKeys(chord),
    textFile: '', imageFiles: [],
    submitKey: '',                 // the chord itself is the whole action
    restoreFocus,
  }));
  if (!r.ok) return r;
  if (r.out === 'not-found') return { ok: false, error: 'Could not find that Antigravity window. It may have been closed.' };
  if (r.out === 'focus-lost') return { ok: false, error: 'Something else took focus before the shortcut fired. Try again.' };
  return { ok: true };
}

module.exports = { sendToSession, focusOnly, sendChordToSession };
