// Minimal PNG encoder (no deps) — draws a rounded clay square with a small
// dot, used as the tray/window icon. Just enough PNG to satisfy Electron.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function makePng(size, draw) {
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (1 + size * 4);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = draw(x, y);
      const o = rowStart + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    const crc = zlib.crc32 ? zlib.crc32(Buffer.concat([typeBuf, data])) : crc32(Buffer.concat([typeBuf, data]));
    crcBuf.writeUInt32BE(crc >>> 0, 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  }
  // Node's zlib has no crc32 export in most versions — implement it.
  function crc32(buf) {
    let c, crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
      c = (crc ^ buf[i]) & 0xFF;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      crc = (crc >>> 8) ^ c;
    }
    return (crc ^ 0xFFFFFFFF);
  }

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function hex(h) {
  const n = parseInt(h.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function drawIcon(size) {
  const [cr, cg, cb] = hex('#D97757');
  const [dr, dg, db] = hex('#1A0E08');
  const r = size * 0.22; // corner radius
  return (x, y) => {
    // rounded-square mask
    const inCorner = (cx, cy) => {
      const dx = x - cx, dy = y - cy;
      return dx * dx + dy * dy <= r * r;
    };
    let inside = x >= r && x <= size - r || y >= r && y <= size - r;
    if (!inside) {
      inside = inCorner(r, r) || inCorner(size - r, r) || inCorner(r, size - r) || inCorner(size - r, size - r);
    }
    if (!inside) return [0, 0, 0, 0];

    // small dark dot in the lower-right third, echoing the "send" glyph
    const dotCx = size * 0.68, dotCy = size * 0.68, dotR = size * 0.1;
    const ddx = x - dotCx, ddy = y - dotCy;
    if (ddx * ddx + ddy * ddy <= dotR * dotR) return [dr, dg, db, 255];

    return [cr, cg, cb, 255];
  };
}

const outDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [16, 32, 64, 256]) {
  const buf = makePng(size, drawIcon(size));
  fs.writeFileSync(path.join(outDir, `icon-${size}.png`), buf);
}
fs.copyFileSync(path.join(outDir, 'icon-32.png'), path.join(outDir, 'icon.png'));
console.log('icons written to', outDir);
