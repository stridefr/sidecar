// Minimal PNG encoder (no deps) — draws the "Twin Pane" mark: two overlapping
// rounded squares, a cool slate one behind a clay one, echoing the app's own
// duality (reading one session, sending to another) rather than being just a
// single colored square. Just enough PNG to satisfy Electron.
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

// Point-in-rounded-rect test, in a normalized 0–100 design space so the same
// logic works at any output size.
function insideRoundedRect(px, py, rx, ry, rw, rh, rr) {
  if (px < rx || px > rx + rw || py < ry || py > ry + rh) return false;
  const inXBand = px >= rx + rr && px <= rx + rw - rr;
  const inYBand = py >= ry + rr && py <= ry + rh - rr;
  if (inXBand || inYBand) return true;
  const cx = px < rx + rr ? rx + rr : rx + rw - rr;
  const cy = py < ry + rr ? ry + rr : ry + rh - rr;
  const dx = px - cx, dy = py - cy;
  return dx * dx + dy * dy <= rr * rr;
}

function drawIcon(size) {
  const [cr, cg, cb] = hex('#D97757');   // clay — front pane
  const [br, bg, bb] = hex('#3D4257');   // slate — back pane

  // back pane: upper-left-biased. front pane: lower-right-biased, drawn on
  // top so the overlap resolves to clay. Sized so both stay legible once the
  // whole thing shrinks to a 16px tray icon.
  const back  = { x: 8,  y: 16, w: 56, h: 56, r: 15 };
  const front = { x: 34, y: 26, w: 58, h: 58, r: 15 };

  return (x, y) => {
    const px = (x / size) * 100, py = (y / size) * 100;
    if (insideRoundedRect(px, py, front.x, front.y, front.w, front.h, front.r)) return [cr, cg, cb, 255];
    if (insideRoundedRect(px, py, back.x, back.y, back.w, back.h, back.r)) return [br, bg, bb, 255];
    return [0, 0, 0, 0];
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
