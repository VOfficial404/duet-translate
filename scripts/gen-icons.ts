// Renders icons/icon-{16,32,48,128}.png without external dependencies.
// Usage: bun scripts/gen-icons.ts
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

type RGBA = [number, number, number, number];

// Signed distance to a rounded box centred at (cx, cy) with half-size (hw, hh) and radius r.
function roundBox(x: number, y: number, cx: number, cy: number, hw: number, hh: number, r: number) {
  const qx = Math.abs(x - cx) - hw + r;
  const qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

// Shapes in a 0..1 unit square, painted in order.
function shade(x: number, y: number): RGBA | null {
  if (roundBox(x, y, 0.5, 0.5, 0.5, 0.5, 0.22) > 0) return null;
  const t = (x + y) / 2; // diagonal gradient #5b7cfa -> #3f4fe0
  const bg: RGBA = [91 - 28 * t, 124 - 45 * t, 250 - 26 * t, 255];
  const bar = (cx: number, cy: number, hw: number) => roundBox(x, y, cx, cy, hw, 0.055, 0.055) <= 0;
  if (bar(0.42, 0.33, 0.22)) return [255, 255, 255, 255]; // original line
  if (bar(0.35, 0.5, 0.15)) return [255, 255, 255, 255];
  if (bar(0.58, 0.68, 0.22)) return [255, 255, 255, 150]; // translated line
  return bg;
}

function render(size: number) {
  const ss = 4;
  const px = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = shade((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size);
          if (!c) continue;
          // composite white-alpha bars over the background colour
          let [cr, cg, cb, ca] = c;
          if (ca < 255) {
            const base = shade((x + 0.5) / size, 0.95) ?? [70, 90, 235, 255];
            const k = ca / 255;
            cr = cr * k + base[0] * (1 - k);
            cg = cg * k + base[1] * (1 - k);
            cb = cb * k + base[2] * (1 - k);
          }
          r += cr; g += cg; b += cb; a += 255;
        }
      }
      const n = ss * ss;
      const i = (y * size + x) * 4;
      const cov = a / 255;
      px[i] = cov ? Math.round(r / cov) : 0;
      px[i + 1] = cov ? Math.round(g / cov) : 0;
      px[i + 2] = cov ? Math.round(b / cov) : 0;
      px[i + 3] = Math.round(a / n);
    }
  }
  return png(size, px);
}

function crc32(buf: Uint8Array) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function png(size: number, rgba: Uint8Array) {
  const raw = new Uint8Array(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) raw.set(rgba.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1);
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, size);
  v.setUint32(4, size);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array()),
  ];
  return Buffer.concat(parts);
}

const dir = new URL('../icons/', import.meta.url);
mkdirSync(dir, { recursive: true });
for (const size of [16, 32, 48, 128]) writeFileSync(new URL(`icon-${size}.png`, dir), render(size));
console.log('icons written');
