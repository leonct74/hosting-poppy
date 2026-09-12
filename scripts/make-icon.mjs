#!/usr/bin/env node
/**
 * Draw HostingPoppy's app icon → frontend/public/hostingpoppy-icon.png.
 *
 * This script is the icon's SOURCE OF TRUTH. A stock macOS box has no SVG rasteriser
 * (no rsvg/cairo/magick), so rather than commit a binary nobody on the team can
 * regenerate, we draw the mark in code and encode the PNG with node's own zlib.
 * Deterministic — same bytes every run. The PNG encoder below is TrafficPoppy's,
 * unchanged; only the drawing differs.
 *
 * The mark: a browser window — a light page under a darker toolbar, with the three
 * window dots and two lines of content. It has to survive being 24px in the sidebar,
 * so it is deliberately thin on detail; the dots blur at that size but the silhouette
 * they belong to still reads.
 *
 * The weights are this way round for a reason: drawn the other way (light band over a
 * dark body) the whole thing reads as a CREDIT CARD — band, then two stripes for the
 * number and the name. A dark toolbar above a light page is the shape only a browser
 * has, and it is what stops the misread at a glance.
 *
 * One colour (the accent the host assigns us) in two weights, on transparency, square —
 * the host draws the rounded corners itself (AGENTS.md §9).
 *
 *   node scripts/make-icon.mjs
 */
import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outPath = join(root, "frontend", "public", "hostingpoppy-icon.png");

const SIZE = 512;
const SS = 4; // supersample factor → anti-aliased edges without a graphics lib

/** The accent the host assigns us: poppyAccent("com.hostingpoppy.desktop") === "#c9b8e8". */
const ACCENT = [0xc9, 0xb8, 0xe8];
/** A dimmer weight of the same hue for the toolbar — one colour in two weights, never two colours. */
const tint = (f) => ACCENT.map((c) => Math.round(c * f));
const PAGE = tint(1.0);
const CHROME = tint(0.42);

/** The window frame: [x, y, w, h] on a 512 grid, centred with a 76px margin all round. */
const WINDOW = [76, 112, 360, 288];
const FRAME_R = 40;
/** Where the toolbar ends. 78px tall → ~3.6px at 24px, about the thinnest band still visible. */
const CHROME_BOTTOM = WINDOW[1] + 78;
/** The three window dots, evenly spaced down the left of the toolbar. */
const DOT_R = 13;
const DOT_Y = WINDOW[1] + 39;
const DOT_XS = [118, 158, 198];
/** Content lines. Elongated on purpose: a stripe survives downscaling, a dot does not. */
const LINE_R = 15;
const LINE_LONG = [116, 244, 208, 30];
const LINE_SHORT = [116, 296, 132, 30];

/** Is (x, y) inside a rounded rectangle? */
function inRoundedRect(x, y, [rx, ry, rw, rh], r) {
  if (x < rx || x > rx + rw || y < ry || y > ry + rh) return false;
  const cx = Math.min(Math.max(x, rx + r), rx + rw - r);
  const cy = Math.min(Math.max(y, ry + r), ry + rh - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/**
 * Shapes front-to-back — the first hit wins, which is what layers the dots over the
 * toolbar and the toolbar over the frame (clipping it to the rounded top corners).
 */
const SHAPES = [
  ...DOT_XS.map((cx) => ({
    hit: (x, y) => (x - cx) ** 2 + (y - DOT_Y) ** 2 <= DOT_R * DOT_R,
    colour: PAGE,
  })),
  { hit: (x, y) => inRoundedRect(x, y, LINE_LONG, LINE_R), colour: CHROME },
  { hit: (x, y) => inRoundedRect(x, y, LINE_SHORT, LINE_R), colour: CHROME },
  { hit: (x, y) => y < CHROME_BOTTOM && inRoundedRect(x, y, WINDOW, FRAME_R), colour: CHROME },
  { hit: (x, y) => inRoundedRect(x, y, WINDOW, FRAME_R), colour: PAGE },
];

/** Render RGBA, supersampled then box-filtered down. */
function render() {
  const px = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = x + (sx + 0.5) / SS;
          const fy = y + (sy + 0.5) / SS;
          const hit = SHAPES.find((shape) => shape.hit(fx, fy));
          if (hit) {
            r += hit.colour[0];
            g += hit.colour[1];
            b += hit.colour[2];
            a += 255;
          }
        }
      }
      const n = SS * SS;
      const i = (y * SIZE + x) * 4;
      // Un-premultiply so partially-covered edge pixels keep full colour.
      if (a > 0) {
        const cov = a / n / 255;
        px[i] = Math.round(r / n / cov);
        px[i + 1] = Math.round(g / n / cov);
        px[i + 2] = Math.round(b / n / cov);
        px[i + 3] = Math.round(a / n);
      }
    }
  }
  return px;
}

/** One PNG chunk: length + type + data + CRC32. */
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

function encodePng(px) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // 8 bits per channel
  ihdr[9] = 6; // truecolour + alpha
  // Each scanline is prefixed with its filter type (0 = none).
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
  for (let y = 0; y < SIZE; y++) {
    raw[y * (SIZE * 4 + 1)] = 0;
    px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const png = encodePng(render());
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, png);
console.log(
  `✅ ${outPath} — ${SIZE}×${SIZE}, ${(png.length / 1024).toFixed(1)} KB, sha256 ${createHash("sha256").update(png).digest("hex").slice(0, 12)}…`,
);
