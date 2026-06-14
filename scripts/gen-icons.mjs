// Generates PWA/app icons as real PNGs from the Zenith mark — no image libs,
// just zlib. Rasterizes the logo's three polygons onto a brand-dark tile.
import zlib from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'img');
mkdirSync(OUT, { recursive: true });

// CRC32 (PNG chunk checksums).
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(CRC(td), 0);
  return Buffer.concat([len, td, crc]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  // raw with filter byte 0 per scanline
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// Logo polygons in the 120x140 viewBox.
const POLY = {
  top: [[6, 6], [114, 20], [114, 44], [6, 38]],
  diag: [[92, 40], [114, 44], [30, 118], [8, 114]],
  bot: [[6, 108], [114, 122], [114, 134], [6, 134]],
};
const inside = (poly, x, y) => {
  let r = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) r = !r;
  }
  return r;
};

function draw(N, { maskable = false } = {}) {
  const rgba = Buffer.alloc(N * N * 4);
  const bg = [14, 19, 32]; // #0e1320 brand dark
  const barDark = [58, 65, 80]; // #3a4150
  const barLight = [139, 148, 164]; // #8b94a4 signature diagonal
  // Fit the 120x140 art centered; smaller for maskable safe zone.
  const fit = maskable ? 0.52 : 0.62;
  const scale = (N * fit) / 140;
  const offX = (N - 120 * scale) / 2;
  const offY = (N - 140 * scale) / 2;
  const radius = maskable ? 0 : N * 0.22;
  for (let py = 0; py < N; py++) {
    for (let px = 0; px < N; px++) {
      const i = (py * N + px) * 4;
      // rounded-rect alpha (non-maskable); maskable fills the whole tile.
      let a = 255;
      if (!maskable) {
        const dx = Math.max(radius - px, px - (N - radius), 0);
        const dy = Math.max(radius - py, py - (N - radius), 0);
        if (dx > 0 && dy > 0 && Math.hypot(dx, dy) > radius) a = 0;
      }
      let col = bg;
      const ax = (px - offX) / scale;
      const ay = (py - offY) / scale;
      if (inside(POLY.diag, ax, ay)) col = barLight;
      else if (inside(POLY.top, ax, ay) || inside(POLY.bot, ax, ay)) col = barDark;
      rgba[i] = col[0];
      rgba[i + 1] = col[1];
      rgba[i + 2] = col[2];
      rgba[i + 3] = a;
    }
  }
  return encodePNG(N, N, rgba);
}

const files = {
  'icon-192.png': draw(192),
  'icon-512.png': draw(512),
  'icon-maskable-512.png': draw(512, { maskable: true }),
  'apple-touch-icon.png': draw(180, { maskable: true }),
};
for (const [name, buf] of Object.entries(files)) {
  writeFileSync(join(OUT, name), buf);
  console.log('wrote', name, buf.length, 'bytes');
}
