// Generates simple original placeholder textures as PNGs (no dependencies).
// Real art can replace these files later without touching code.
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { crc32, deflateSync } from "node:zlib";

const OUT = resolve(import.meta.dirname, "../public/assets/textures/base");
const SIZE = 64;

function png(width, height, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Deterministic per-pixel noise in [-1, 1].
const noise = (x, y, seed) => {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (((h ^ (h >>> 16)) >>> 0) / 0xffffffff) * 2 - 1;
};

function make(name, pixel) {
  const buf = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const [r, g, b, a = 255] = pixel(x, y);
      const i = (y * SIZE + x) * 4;
      buf[i] = Math.max(0, Math.min(255, r));
      buf[i + 1] = Math.max(0, Math.min(255, g));
      buf[i + 2] = Math.max(0, Math.min(255, b));
      buf[i + 3] = a;
    }
  }
  writeFileSync(resolve(OUT, `${name}.png`), png(SIZE, SIZE, buf));
}

const shade = (base, k) => base.map((c) => c + k);

mkdirSync(OUT, { recursive: true });

// Floor: 32-unit tiles with dark grout.
make("floor", (x, y) => {
  const grout = x % 32 === 0 || y % 32 === 0;
  return shade(grout ? [52, 54, 58] : [104, 108, 112], noise(x, y, 1) * 8);
});

// Ceiling: dark panels.
make("ceiling", (x, y) => {
  const seam = x % 64 === 0 || y % 64 === 0;
  return shade(seam ? [30, 32, 36] : [62, 64, 70], noise(x, y, 2) * 5);
});

// Wall: offset blocks in slate blue.
make("wall", (x, y) => {
  const row = Math.floor(y / 16);
  const xo = (x + (row % 2) * 16) % 32;
  const mortar = y % 16 === 0 || xo === 0;
  return shade(mortar ? [40, 44, 56] : [78, 86, 104], noise(x, y, 3) * 10);
});

// Trim: warm orange with a stripe, for stairs, ledges, pillars.
make("trim", (x, y) => {
  const edge = y < 4 || y >= 60;
  return shade(edge ? [150, 80, 28] : [190, 116, 52], noise(x, y, 4) * 8);
});

// Portal panel: bright, clean, clearly different from other walls.
make("portal_panel", (x, y) => {
  const seam = x % 32 === 0 || y % 32 === 0;
  return shade(seam ? [170, 178, 186] : [226, 232, 236], noise(x, y, 5) * 3);
});

// Editor-only textures (never drawn in game).
make("clip", (x, y) => (((x + y) >> 3) % 2 ? [160, 40, 160, 160] : [90, 20, 90, 160]));
make("nodraw", (x, y) => (((x + y) >> 3) % 2 ? [220, 200, 40] : [30, 30, 30]));

console.log(`textures written to ${OUT}`);
