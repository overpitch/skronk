// Helpers for writing TrenchBroom .map files (Quake2 Valve format) from scripts.
// Used by the make-*.mjs map generators. Coordinates: Z up, 1 unit ~ 1 inch.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

/** Surface flag bits, matching trenchbroom/Skronk/GameConfig.cfg. */
export const SURF_PORTAL = 1;

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const addv = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/** Integer vector perpendicular to integer normal n. */
function perp(n) {
  const abs = n.map(Math.abs);
  const i = abs.indexOf(Math.min(...abs));
  const e = [0, 0, 0];
  e[i] = 1;
  return cross(n, e);
}

function texAxes(n) {
  const [ax, ay, az] = n.map(Math.abs);
  if (az >= ax && az >= ay) return [[1, 0, 0], [0, -1, 0]];
  if (ax >= ay) return [[0, 1, 0], [0, 0, -1]];
  return [[1, 0, 0], [0, 0, -1]];
}

/** One face line. Outward integer normal n, integer point p on the plane. */
export function face(n, p, tex, flags = 0) {
  const a = perp(n);
  const b = cross(n, a);
  // cross(p0 - p1, p2 - p1) = cross(a, b) = n * |a|^2, so the normal points out.
  const pts = [addv(p, a), p, addv(p, b)];
  const [u, v] = texAxes(n);
  const fmt = (q) => `( ${q.join(" ")} )`;
  return `${pts.map(fmt).join(" ")} ${tex} [ ${u.join(" ")} 0 ] [ ${v.join(" ")} 0 ] 0 1 1 0 ${flags} 0`;
}

/** `tex` is a texture name or a function (normal) => [texture, flags]. */
const texFn = (tex) => (typeof tex === "function" ? tex : () => [tex, 0]);

/** Axis-aligned box brush. */
export function box(mins, maxs, tex) {
  const t = texFn(tex);
  const sides = [
    [[-1, 0, 0], mins],
    [[1, 0, 0], maxs],
    [[0, -1, 0], mins],
    [[0, 1, 0], maxs],
    [[0, 0, -1], mins],
    [[0, 0, 1], maxs],
  ];
  return sides.map(([n, p]) => face(n, p, ...t(n)));
}

/**
 * Ramp (wedge) brush over the rectangle x0..x1, y0..y1, its base at z0, rising to
 * z1 towards `up` ("+x", "-x", "+y" or "-y"). The slope face uses `slopeTex`.
 */
export function ramp([x0, y0, z0], [x1, y1, z1], up, tex, slopeTex = tex) {
  const t = texFn(tex);
  const h = z1 - z0;
  const along = { "+x": [1, 0], "-x": [-1, 0], "+y": [0, 1], "-y": [0, -1] }[up];
  const len = along[0] !== 0 ? x1 - x0 : y1 - y0;
  // Low edge of the slope: the side opposite `up`.
  const low = [along[0] > 0 ? x0 : x1, along[1] > 0 ? y0 : y1, z0];
  const high = [along[0] > 0 ? x1 : x0, along[1] > 0 ? y1 : y0, z1];
  const slopeN = [-along[0] * h, -along[1] * h, len];
  return [
    face([0, 0, -1], [x0, y0, z0], ...t([0, 0, -1])),
    // The tall back face, at the high end.
    face([along[0], along[1], 0], high, ...t([along[0], along[1], 0])),
    // The two side faces.
    ...(along[0] !== 0
      ? [face([0, -1, 0], [x0, y0, z0], ...t([0, -1, 0])), face([0, 1, 0], [x1, y1, z0], ...t([0, 1, 0]))]
      : [face([-1, 0, 0], [x0, y0, z0], ...t([-1, 0, 0])), face([1, 0, 0], [x1, y1, z0], ...t([1, 0, 0]))]),
    face(slopeN, low, ...texFn(slopeTex)(slopeN)),
  ];
}

/** Texture function: portal-friendly panel on faces whose normal matches `which`, `tex` elsewhere. */
export const portalOn = (which, tex) => (n) =>
  which.some((w) => w[0] === n[0] && w[1] === n[1] && w[2] === n[2]) ? ["base/portal_panel", SURF_PORTAL] : [tex, 0];

export const N = { east: [1, 0, 0], west: [-1, 0, 0], north: [0, 1, 0], south: [0, -1, 0], up: [0, 0, 1], down: [0, 0, -1] };

/**
 * A sealed room shell: floor, ceiling and four walls `thick` units thick around
 * the interior mins..maxs. `tex` = { floor, ceiling, wall } (each a name or function).
 */
export function shell(mins, maxs, thick, tex) {
  const [x0, y0, z0] = mins;
  const [x1, y1, z1] = maxs;
  const t = thick;
  return [
    box([x0 - t, y0 - t, z0 - t], [x1 + t, y1 + t, z0], tex.floor),
    box([x0 - t, y0 - t, z1], [x1 + t, y1 + t, z1 + t], tex.ceiling),
    box([x0 - t, y0 - t, z0], [x0, y1 + t, z1], tex.westWall ?? tex.wall),
    box([x1, y0 - t, z0], [x1 + t, y1 + t, z1], tex.eastWall ?? tex.wall),
    box([x0, y0 - t, z0], [x1, y0, z1], tex.southWall ?? tex.wall),
    box([x0, y1, z0], [x1, y1 + t, z1], tex.northWall ?? tex.wall),
  ];
}

/**
 * Stairs: `count` steps of `rise` up, each `depth` deep, climbing towards `up`,
 * filling the width w0..w1 across. Starts at `start` (the foot of the first step).
 */
export function stairs({ start, up, count, rise, depth, across, tex }) {
  const out = [];
  const [sx, sy, sz] = start;
  for (let k = 1; k <= count; k++) {
    const a = (k - 1) * depth;
    const b = k * depth;
    const top = sz + k * rise;
    let mins, maxs;
    if (up === "+x") [mins, maxs] = [[sx + a, across[0], sz], [sx + b, across[1], top]];
    else if (up === "-x") [mins, maxs] = [[sx - b, across[0], sz], [sx - a, across[1], top]];
    else if (up === "+y") [mins, maxs] = [[across[0], sy + a, sz], [across[1], sy + b, top]];
    else [mins, maxs] = [[across[0], sy - b, sz], [across[1], sy - a, top]];
    out.push(box(mins, maxs, tex));
  }
  return out;
}

export const entity = (props) => `{\n${Object.entries(props).map(([k, v]) => `"${k}" "${v}"`).join("\n")}\n}`;

/**
 * Writes public/assets/maps/<name>.map: worldspawn with `brushes` (arrays of face
 * lines) and the point `entities` (objects of key/value strings).
 */
export function writeMap(name, { title, generator, brushes, entities, starter = false }) {
  const out = [
    "// Game: Skronk",
    "// Format: Quake2 (Valve)",
    starter
      ? `// Starter map generated by ${generator}. It's yours: edit it in TrenchBroom (running the script again overwrites your changes).`
      : `// Generated by ${generator}. Edit that script, not this file.`,
    "// entity 0",
    "{",
    '"classname" "worldspawn"',
    '"mapversion" "220"',
    ...(title ? [`"message" "${title}"`] : []),
    ...brushes.flatMap((faces, i) => [`// brush ${i}`, "{", ...faces, "}"]),
    "}",
    ...entities.map(entity),
  ].join("\n");
  const dest = resolve(import.meta.dirname, `../public/assets/maps/${name}.map`);
  writeFileSync(dest, out + "\n");
  console.log(`wrote ${dest} (${brushes.length} brushes, ${entities.length} entities)`);
}
