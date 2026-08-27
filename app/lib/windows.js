// Finds Antigravity windows that are genuinely open right now, and can bring
// one to the foreground. Two things make this less trivial than it looks:
//
//   - A lock file in ~/.claude/ide/*.lock names a pid, but pids get recycled.
//     A stale lock can point at some unrelated process that happens to be
//     running now (we saw this on this machine: a stale lock's pid had been
//     reassigned to conhost.exe). So liveness needs the pid *and* a matching
//     process image name, not the pid alone.
//   - The lock only proves a *workspace* is open, not which session inside
//     it a window is actively driving. Callers should treat "open" as a
//     workspace-level fact, not a per-session guarantee.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const IDE_DIR = path.join(os.homedir(), '.claude', 'ide');
const EXPECTED_IMAGE = 'Antigravity IDE.exe';

function readLocks() {
  let files = [];
  try { files = fs.readdirSync(IDE_DIR).filter(f => f.endsWith('.lock')); }
  catch (e) { return []; }

  const locks = [];
  for (const f of files) {
    try {
      const raw = fs.readFileSync(path.join(IDE_DIR, f), 'utf8');
      const j = JSON.parse(raw);
      locks.push({
        port: f.replace(/\.lock$/, ''),
        pid: j.pid,
        ideName: j.ideName,
        workspaceFolders: j.workspaceFolders || [],
      });
    } catch (e) { /* corrupt or half-written lock file — skip it */ }
  }
  return locks;
}

// One tasklist call for every pid at once, rather than one process spawn per
// lock file — a machine can accumulate dozens of stale locks over time (56
// were found on the one this was built against), and checking them one at a
// time made a single scan take seconds.
function bulkTasklistImages() {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      const map = new Map();
      if (!err && stdout) {
        for (const line of stdout.split(/\r?\n/)) {
          const m = line.match(/^"([^"]+)","(\d+)"/);
          if (m) map.set(Number(m[2]), m[1]);
        }
      }
      resolve(map);
    });
  });
}

// Live Antigravity windows only — pid alive AND owned by the right exe.
async function listLiveWindows() {
  const locks = readLocks();
  const images = await bulkTasklistImages();
  return locks
    .filter((l) => (images.get(l.pid) || '').toLowerCase() === EXPECTED_IMAGE.toLowerCase())
    .map((l) => ({ ...l, workspacePath: l.workspaceFolders[0] || null }));
}

// Two traps bit this script, both of which made every focus and send fail
// while looking like "the window disappeared":
//
//  1. The parameter must not be called $Pid — PowerShell defines $PID as a
//     read-only automatic variable, so `param([int]$Pid)` dies with "Cannot
//     overwrite variable Pid because it is read-only or constant".
//  2. `powershell -Command <script>` does not bind named parameters at all;
//     `-TargetPid 123` is parsed as a separate command, not an argument.
//     param() only binds via -File.
//
// So the pid is validated as an integer and written straight into the script
// text. It can only ever be a number, so there is nothing to inject.
// Antigravity is Electron: every one of its windows shares a single process,
// so a pid alone cannot tell two open workspaces apart. Window titles can —
// VS Code-derived editors put the folder name in the title bar — so the
// workspace name is used to pick the right window, with any window of that
// process as the fallback.
const FOCUS_PS = (targetPid, probeOnly, titleHint) => `
$TargetPid = ${targetPid}
$ProbeOnly = $${probeOnly ? 'true' : 'false'}
$TitleHint = '${titleHint}'
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class SidecarWin32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder s, int n);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  public static string TitleOf(IntPtr h) {
    StringBuilder sb = new StringBuilder(512);
    GetWindowTextW(h, sb, 512);
    return sb.ToString();
  }
}
"@
$exact = [IntPtr]::Zero
$any = [IntPtr]::Zero
$cb = {
  param($hWnd, $lParam)
  if ([SidecarWin32]::IsWindowVisible($hWnd)) {
    $procId = 0
    [SidecarWin32]::GetWindowThreadProcessId($hWnd, [ref]$procId) | Out-Null
    if ($procId -eq $TargetPid) {
      $t = [SidecarWin32]::TitleOf($hWnd)
      if ($t.Length -gt 0) {
        if ($script:any -eq [IntPtr]::Zero) { $script:any = $hWnd }
        if ($TitleHint.Length -gt 0 -and $t.ToLower().Contains($TitleHint.ToLower())) {
          $script:exact = $hWnd
          return $false
        }
      }
    }
  }
  return $true
}
[SidecarWin32]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
$target = if ($exact -ne [IntPtr]::Zero) { $exact } else { $any }
if ($target -ne [IntPtr]::Zero) {
  if (-not $ProbeOnly) {
    if ([SidecarWin32]::IsIconic($target)) { [SidecarWin32]::ShowWindow($target, 9) | Out-Null }
    [SidecarWin32]::SetForegroundWindow($target) | Out-Null
  }
  if ($exact -ne [IntPtr]::Zero) { Write-Output "ok-exact" } else { Write-Output "ok-any" }
} else {
  Write-Output "not-found"
}
`;

// Only a folder name ever reaches the script, and anything exotic is stripped
// — it is embedded in a single-quoted PowerShell string.
function safeHint(workspacePath) {
  if (!workspacePath) return '';
  const base = String(workspacePath).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
  return base.replace(/[^A-Za-z0-9 ._-]/g, '').slice(0, 60);
}

function runFocusScript(pid, probeOnly, workspacePath) {
  return new Promise((resolve) => {
    const target = Number.parseInt(pid, 10);
    if (!Number.isFinite(target) || target <= 0) return resolve(false);

    const args = ['-NoProfile', '-NonInteractive', '-Command',
      FOCUS_PS(target, probeOnly, safeHint(workspacePath))];
    execFile('powershell.exe', args, { windowsHide: true, timeout: 8000 }, (err, stdout, stderr) => {
      if (err) {
        // Surface the real reason rather than a bare rejection — a broken
        // script here used to look like "the window vanished".
        console.error('[sidecar] focus script failed:', (stderr || err.message || '').trim().split('\n')[0]);
        return resolve(false);
      }
      const out = String(stdout).trim();
      resolve(out === 'ok-exact' || out === 'ok-any');
    });
  });
}

const focusPid = (pid, workspacePath) => runFocusScript(pid, false, workspacePath);
// Checks a window can be found without stealing focus — used to verify the
// plumbing works before anything is typed.
const canFindWindow = (pid, workspacePath) => runFocusScript(pid, true, workspacePath);
// Reports whether the workspace's own window could be singled out by title,
// rather than falling back to "any window of this process".
function probeWindowMatch(pid, workspacePath) {
  return new Promise((resolve) => {
    const target = Number.parseInt(pid, 10);
    if (!Number.isFinite(target) || target <= 0) return resolve('not-found');
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', FOCUS_PS(target, true, safeHint(workspacePath))],
      { windowsHide: true, timeout: 8000 },
      (err, stdout) => resolve(err ? 'error' : String(stdout).trim()));
  });
}

module.exports = { listLiveWindows, focusPid, canFindWindow, probeWindowMatch, EXPECTED_IMAGE };
