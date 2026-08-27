// Windows' own "Transparency effects" switch (Settings → Personalization →
// Colors) globally disables the acrylic and mica materials. When it's off, a
// window asking for acrylic just renders opaque — nothing the app does can
// override that, because the blur is composited by DWM, not by us.
//
// So Sidecar reads the switch, tells the user when it's the reason their
// window looks solid, and offers a window mode that doesn't depend on it.
const { execFile } = require('child_process');

const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize';

function readTransparencyEffects() {
  return new Promise((resolve) => {
    execFile('reg', ['query', KEY, '/v', 'EnableTransparency'], { windowsHide: true, timeout: 4000 },
      (err, stdout) => {
        if (err || !stdout) return resolve(null); // unknown — don't claim either way
        const m = stdout.match(/EnableTransparency\s+REG_DWORD\s+0x([0-9a-fA-F]+)/);
        if (!m) return resolve(null);
        resolve(parseInt(m[1], 16) !== 0);
      });
  });
}

module.exports = { readTransparencyEffects };
