// Auto-update against GitHub Releases.
//
// Nothing is downloaded without asking. electron-updater's default is to fetch
// a new version silently the moment it sees one; that's turned off here so the
// app can show you what's coming and let you decide — an update that restarts
// the thing you're mid-sentence in is worse than one that waits.
//
// This is inert in development: there's no installer to swap out when running
// from source, and electron-updater throws if asked to try. Everything below
// no-ops unless the app is packaged.
const { autoUpdater } = require('electron-updater');

let broadcast = () => {};
let state = { status: 'idle', version: null, notes: null, percent: 0, error: null };

function push(patch) {
  state = Object.assign({}, state, patch);
  broadcast(state);
}

function init({ onState, logger }) {
  broadcast = onState || (() => {});
  autoUpdater.autoDownload = false;          // ask first, always
  autoUpdater.autoInstallOnAppQuit = true;   // if downloaded, apply on next quit
  if (logger) autoUpdater.logger = logger;

  autoUpdater.on('checking-for-update', () => push({ status: 'checking', error: null }));

  autoUpdater.on('update-available', (info) => push({
    status: 'available',
    version: info && info.version,
    notes: typeof (info && info.releaseNotes) === 'string' ? info.releaseNotes : null,
    percent: 0,
  }));

  autoUpdater.on('update-not-available', () => push({ status: 'current', percent: 0 }));

  autoUpdater.on('download-progress', (p) => push({
    status: 'downloading',
    percent: Math.max(0, Math.min(100, Math.round((p && p.percent) || 0))),
  }));

  autoUpdater.on('update-downloaded', (info) => push({
    status: 'ready',
    version: info && info.version,
    percent: 100,
  }));

  autoUpdater.on('error', (err) => push({
    status: 'error',
    error: (err && err.message) ? String(err.message).split('\n')[0] : 'Update check failed.',
  }));
}

function isEnabled(app) {
  return !!(app && app.isPackaged);
}

async function check(app, { silent } = {}) {
  if (!isEnabled(app)) {
    // Say so plainly rather than reporting a fake "up to date".
    push({ status: 'dev', error: null });
    return state;
  }
  try {
    await autoUpdater.checkForUpdates();
  } catch (e) {
    if (!silent) push({ status: 'error', error: (e && e.message) || 'Update check failed.' });
  }
  return state;
}

async function download() {
  try {
    push({ status: 'downloading', percent: 0 });
    await autoUpdater.downloadUpdate();
  } catch (e) {
    push({ status: 'error', error: (e && e.message) || 'Download failed.' });
  }
  return state;
}

// Restarts into the new version. Everything Sidecar keeps lives in a JSON file
// outside the install directory, so nothing is lost across the swap.
function installNow() {
  try {
    autoUpdater.quitAndInstall(false, true);
  } catch (e) {
    push({ status: 'error', error: (e && e.message) || 'Could not start the installer.' });
  }
}

function getState() { return state; }

module.exports = { init, check, download, installNow, getState, isEnabled };
