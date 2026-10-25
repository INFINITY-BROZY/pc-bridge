'use strict';
// Generates the extension icons (no dependencies).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rows = [];
  for (let y = 0; y < height; y++) {
    rows.push(Buffer.from([0]));
    rows.push(rgba.subarray(y * width * 4, (y + 1) * width * 4));
  }
  const idat = zlib.deflateSync(Buffer.concat(rows), { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function render(size) {
  const SS = 4;
  const W = size * SS;
  const px = new Uint8Array(W * W * 4);

  const set = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= W || y >= W) return;
    const i = (y * W + x) * 4;
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = a;
  };
  const inRound = (x, y, x0, y0, x1, y1, rad) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const cx = Math.max(x0 + rad, Math.min(x, x1 - rad));
    const cy = Math.max(y0 + rad, Math.min(y, y1 - rad));
    return (x - cx) ** 2 + (y - cy) ** 2 <= rad * rad;
  };
  const unit = W;

  // Background rounded square
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      if (inRound(x, y, 0, 0, W - 1, W - 1, 0.22 * W)) {
        set(x, y, 8, 14, 24, 255);
      }
    }
  }
  // Border ring
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const outer = inRound(x, y, 0, 0, W - 1, W - 1, 0.22 * W);
      const inner = inRound(x, y, 3 * SS, 3 * SS, W - 3 * SS, W - 3 * SS, 0.2 * W);
      if (outer && !inner) set(x, y, 30, 58, 95, 255);
    }
  }

  const cx = W / 2;
  const deckY = 0.685 * W;
  const deckThick = 0.045 * W;
  const archR = 0.305 * W;
  const archThick = 0.042 * W;
  const cyan = [34, 211, 238];
  const blue = [56, 189, 248];
  const violet = [129, 140, 248];

  // Deck
  for (let y = Math.floor(deckY - deckThick / 2); y <= deckY + deckThick / 2; y++) {
    const half = 0.325 * W;
    for (let x = Math.floor(cx - half); x <= cx + half; x++) {
      // slight rounded caps
      const edge = Math.abs(x - cx) > half - 3 * SS;
      if (edge && Math.abs(y - deckY) > deckThick / 2 - 2 * SS) continue;
      set(x, y, ...blue);
    }
  }

  // Arch (upper half of a circle centered slightly above the deck)
  const archCY = deckY - 0.015 * W;
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const d = Math.hypot(x - cx, y - archCY);
      if (Math.abs(d - archR) <= archThick / 2 && y <= archCY + 2 * SS) {
        set(x, y, ...cyan);
      }
    }
  }

  // Vertical cables
  const cables = [-0.19, -0.13, 0.13, 0.19];
  for (const c of cables) {
    const x = Math.round(cx + c * W);
    const topY = archCY - Math.sqrt(Math.max(0, archR ** 2 - (c * W) ** 2));
    for (let y = Math.floor(topY); y <= Math.floor(deckY); y++) {
      for (let t = -1; t <= 1; t++) set(x + t * SS * 0.6, y, ...violet);
    }
  }

  // Railings on top of the deck ends
  for (const side of [-0.27, 0.27]) {
    const x = Math.round(cx + side * W);
    for (let y = Math.floor(deckY - 0.11 * W); y <= deckY; y++) {
      for (let t = -1; t <= 1; t++) set(x + t * SS * 0.6, y, ...violet);
    }
  }

  // Downsample
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * W + (x * SS + sx)) * 4;
          r += px[i];
          g += px[i + 1];
          b += px[i + 2];
          a += px[i + 3];
          n++;
        }
      }
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return encodePNG(size, size, out);
}

const dir = path.join(__dirname, '..', 'extension', 'icons');
fs.mkdirSync(dir, { recursive: true });
for (const size of [16, 48, 128]) {
  fs.writeFileSync(path.join(dir, `icon${size}.png`), render(size));
  console.log('wrote', path.join(dir, `icon${size}.png`));
}
