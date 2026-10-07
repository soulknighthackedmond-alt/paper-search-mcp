// Generates icon.png (256x256) with no image libraries: the shape is rendered
// at 4x and box-downsampled, which gives clean anti-aliased edges.
//
// Design: a deep-blue rounded tile, a white page with a folded corner and text
// lines, and a cyan magnifier over the bottom-right of the page.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const SIZE = 512;
const SS = 4; // supersample factor
const W = SIZE * SS;

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "..", "icon.png");

const buffer = new Uint8Array(W * W * 4);

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

const BG_TOP = hex("#101C33");
const BG_BOTTOM = hex("#1B3A63");
const PAGE = hex("#F8FAFC");
const PAGE_SHADE = hex("#E2E8F0");
const LINE = hex("#8FA3BF");
const LENS = hex("#22D3EE");
const LENS_GLASS = hex("#0E7490");

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

function put(x, y, color, alpha = 1) {
  const i = (y * W + x) * 4;
  const a = Math.max(0, Math.min(1, alpha));
  buffer[i] = Math.round(buffer[i] * (1 - a) + color[0] * a);
  buffer[i + 1] = Math.round(buffer[i + 1] * (1 - a) + color[1] * a);
  buffer[i + 2] = Math.round(buffer[i + 2] * (1 - a) + color[2] * a);
  buffer[i + 3] = Math.round(buffer[i + 3] * (1 - a) + 255 * a);
}

/** Signed distance to a rounded rectangle (negative inside). */
function roundedRect(px, py, x, y, w, h, r) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const dx = Math.abs(px - cx) - (w / 2 - r);
  const dy = Math.abs(py - cy) - (h / 2 - r);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - r;
}

const scale = (v) => v * W;

// --- background tile -------------------------------------------------------
const tile = { x: scale(0.03), y: scale(0.03), w: scale(0.94), h: scale(0.94), r: scale(0.22) };
for (let y = 0; y < W; y += 1) {
  for (let x = 0; x < W; x += 1) {
    const d = roundedRect(x + 0.5, y + 0.5, tile.x, tile.y, tile.w, tile.h, tile.r);
    if (d > 0.5) continue;
    const t = y / W;
    put(x, y, mix(BG_TOP, BG_BOTTOM, t), d < -0.5 ? 1 : 0.5 - d);
  }
}

// --- page with a folded corner --------------------------------------------
const page = { x: scale(0.22), y: scale(0.16), w: scale(0.42), h: scale(0.58), r: scale(0.04) };
const fold = scale(0.12);
for (let y = 0; y < W; y += 1) {
  for (let x = 0; x < W; x += 1) {
    const px = x + 0.5;
    const py = y + 0.5;
    // Cut the top-right corner off diagonally.
    const cut = px + py - (page.x + page.w + page.y - fold);
    if (cut > 0 && py < page.y + fold + (px - (page.x + page.w - fold)) * -1 + fold * 2) {
      // handled by the diagonal test below
    }
    const diagonal = px - (page.x + page.w - fold) + (py - page.y);
    if (diagonal > 0 && px > page.x + page.w - fold && py < page.y + fold) continue;
    const d = roundedRect(px, py, page.x, page.y, page.w, page.h, page.r);
    if (d > 0.5) continue;
    put(x, y, PAGE, d < -0.5 ? 1 : 0.5 - d);
  }
}

// Folded corner triangle (slightly darker).
for (let y = 0; y < W; y += 1) {
  for (let x = 0; x < W; x += 1) {
    const px = x + 0.5;
    const py = y + 0.5;
    const dx = px - (page.x + page.w - fold);
    const dy = py - page.y;
    if (dx >= 0 && dy >= 0 && dx + dy <= fold && dx <= fold && dy <= fold) {
      const edge = Math.min(dx, dy, fold - (dx + dy));
      put(x, y, PAGE_SHADE, edge < 0.5 ? Math.max(0, edge + 0.5) : 1);
    }
  }
}

// --- text lines on the page ------------------------------------------------
const lines = [
  { y: 0.30, w: 0.30 },
  { y: 0.385, w: 0.30 },
  { y: 0.47, w: 0.22 },
  { y: 0.555, w: 0.26 },
];
for (const line of lines) {
  const lx = scale(0.28);
  const ly = scale(line.y);
  const lw = scale(line.w);
  const lh = scale(0.022);
  const r = lh / 2;
  for (let y = Math.floor(ly - 2); y < ly + lh + 2; y += 1) {
    for (let x = Math.floor(lx - 2); x < lx + lw + 2; x += 1) {
      const d = roundedRect(x + 0.5, y + 0.5, lx, ly, lw, lh, r);
      if (d > 0.5) continue;
      put(x, y, LINE, d < -0.5 ? 1 : 0.5 - d);
    }
  }
}

// --- magnifier -------------------------------------------------------------
const lens = { cx: scale(0.665), cy: scale(0.665), r: scale(0.155), stroke: scale(0.048) };
const handle = { x1: scale(0.775), y1: scale(0.775), x2: scale(0.895), y2: scale(0.895), r: scale(0.045) };

for (let y = 0; y < W; y += 1) {
  for (let x = 0; x < W; x += 1) {
    const px = x + 0.5;
    const py = y + 0.5;

    const dist = Math.hypot(px - lens.cx, py - lens.cy);
    const ring = Math.abs(dist - lens.r) - lens.stroke / 2;
    if (ring < 0.5) {
      put(x, y, LENS, ring < -0.5 ? 1 : 0.5 - ring);
      continue;
    }
    if (dist < lens.r - lens.stroke / 2) {
      // Tinted glass inside the lens, so the page shows through.
      const t = Math.min(1, Math.max(0, 1 - dist / lens.r));
      put(x, y, LENS_GLASS, 0.32 + t * 0.12);
      continue;
    }

    // Handle: capsule between the two points.
    const vx = handle.x2 - handle.x1;
    const vy = handle.y2 - handle.y1;
    const t = Math.max(0, Math.min(1, ((px - handle.x1) * vx + (py - handle.y1) * vy) / (vx * vx + vy * vy)));
    const hx = handle.x1 + t * vx;
    const hy = handle.y1 + t * vy;
    const hd = Math.hypot(px - hx, py - hy) - handle.r;
    if (hd < 0.5) put(x, y, LENS, hd < -0.5 ? 1 : 0.5 - hd);
  }
}

// --- downsample and write --------------------------------------------------
const final = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let sy = 0; sy < SS; sy += 1) {
      for (let sx = 0; sx < SS; sx += 1) {
        const i = ((y * SS + sy) * W + (x * SS + sx)) * 4;
        r += buffer[i];
        g += buffer[i + 1];
        b += buffer[i + 2];
        a += buffer[i + 3];
      }
    }
    const n = SS * SS;
    const j = (y * SIZE + x) * 4;
    final[j] = Math.round(r / n);
    final[j + 1] = Math.round(g / n);
    final[j + 2] = Math.round(b / n);
    final[j + 3] = Math.round(a / n);
  }
}

function crc32(buf) {
  let crc = ~0;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y += 1) {
  raw[y * (SIZE * 4 + 1)] = 0; // no filter
  final.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

fs.writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes, ${SIZE}x${SIZE})`);
