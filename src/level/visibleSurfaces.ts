/**
 * The level's surfaces as they should be drawn: faces (and parts of faces)
 * buried inside another brush are dropped, and where two brushes have faces in
 * the same place, only one is kept. Without this, overlapping brushes (common
 * while building in TrenchBroom) show two textures in one spot that flicker as
 * you move ("z-fighting"), and hidden faces cost drawing time for nothing.
 * Quake's map compiler does the same.
 *
 * For drawing only: collision, portals and bots use LevelData.surfaces as it is
 * (the planes there point at those surfaces by index).
 *
 * Rules, for a face of brush A against each other brush B:
 * - the parts of the face outside B stay;
 * - a part inside B goes;
 * - a part lying on one of B's faces: facing the other way, the two brushes touch
 *   there and neither face can be seen, so it goes; facing the same way, it's a
 *   duplicate and the earlier brush's face gives way to the later one's.
 * Only brushes drawn on every side cut others: a clip or nodraw brush is
 * see-through, so what's behind it must stay.
 */
import { add, dot, scale, vec3, type Vec3 } from "../math/vec3";
import type { LevelData, Plane, Surface } from "./types";

const EPS = 0.01;
/** Pieces smaller than this (square units) are dropped as slivers. */
const MIN_AREA = 0.5;

interface Corner {
  p: Vec3;
  uv: [number, number];
}

/** Drawable surfaces with hidden and doubled parts removed. Each is a convex polygon, as before. */
export function visibleSurfaces(level: LevelData): Surface[] {
  // Which brush each surface belongs to.
  const owner = new Array<number>(level.surfaces.length).fill(-1);
  level.brushes.forEach((b, i) => b.planes.forEach((pl) => pl.surface >= 0 && (owner[pl.surface] = i)));
  // Brushes drawn on every side: the ones that hide what's inside them.
  const cutters = level.brushes.map((b) => {
    const faces = b.planes.filter((pl) => pl.surface >= 0);
    return faces.length > 0 && faces.every((pl) => level.surfaces[pl.surface].visible);
  });

  const out: Surface[] = [];
  level.surfaces.forEach((s, si) => {
    if (!s.visible) return;
    const a = owner[si];
    let pieces: Corner[][] = [s.vertices.map((p, i) => ({ p, uv: s.uvs[i] }))];
    const box = bounds(s.vertices);
    level.brushes.forEach((b, bi) => {
      if (bi === a || !cutters[bi] || pieces.length === 0) return;
      if (box.max.x < b.mins.x - EPS || box.min.x > b.maxs.x + EPS) return;
      if (box.max.y < b.mins.y - EPS || box.min.y > b.maxs.y + EPS) return;
      if (box.max.z < b.mins.z - EPS || box.min.z > b.maxs.z + EPS) return;
      const keepDuplicate = a > bi; // on a tie, the later brush's face is the one drawn
      pieces = pieces.flatMap((piece) => clipAgainstBrush(piece, s.plane.normal, b.planes, keepDuplicate));
    });
    for (const piece of pieces) {
      if (area(piece) < MIN_AREA) continue;
      out.push({ ...s, vertices: piece.map((c) => c.p), uvs: piece.map((c) => c.uv) });
    }
  });
  return out;
}

/** The parts of a polygon (with face normal n) that stay visible next to a brush with these planes. */
function clipAgainstBrush(poly: Corner[], n: Vec3, planes: readonly Plane[], keepDuplicate: boolean): Corner[][] {
  const outside: Corner[][] = [];
  let rest = poly;
  let onFace: Plane | null = null;
  for (const pl of planes) {
    const d = rest.map((c) => dot(pl.normal, c.p) - pl.dist);
    if (d.every((v) => Math.abs(v) <= EPS)) {
      onFace = pl; // lies on this face of the brush
      continue;
    }
    if (d.every((v) => v >= -EPS)) return [poly]; // wholly outside this plane: the brush doesn't touch it
    if (d.every((v) => v <= EPS)) continue; // wholly inside this plane: on to the next
    const [front, back] = split(rest, d);
    if (front.length >= 3) outside.push(front);
    rest = back;
    if (rest.length < 3) return outside;
  }
  // `rest` is inside the brush, or on one of its faces.
  if (onFace && dot(onFace.normal, n) > 0.99 && keepDuplicate) outside.push(rest);
  return outside;
}

/** Splits a convex polygon by a plane (d: each corner's distance in front of it) into front and back parts. */
function split(poly: Corner[], d: number[]): [Corner[], Corner[]] {
  const front: Corner[] = [];
  const back: Corner[] = [];
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    const a = poly[i];
    const da = d[i];
    if (da >= -EPS) front.push(a);
    if (da <= EPS) back.push(a);
    const db = d[j];
    if ((da > EPS && db < -EPS) || (da < -EPS && db > EPS)) {
      const t = da / (da - db);
      const b = poly[j];
      const c: Corner = {
        p: add(a.p, scale(add(b.p, scale(a.p, -1)), t)),
        uv: [a.uv[0] + (b.uv[0] - a.uv[0]) * t, a.uv[1] + (b.uv[1] - a.uv[1]) * t],
      };
      front.push(c);
      back.push(c);
    }
  }
  return [front, back];
}

function area(poly: Corner[]): number {
  let x = 0, y = 0, z = 0;
  for (let i = 1; i < poly.length - 1; i++) {
    const a = poly[0].p, b = poly[i].p, c = poly[i + 1].p;
    const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
    const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
    x += uy * vz - uz * vy;
    y += uz * vx - ux * vz;
    z += ux * vy - uy * vx;
  }
  return Math.hypot(x, y, z) / 2;
}

function bounds(vs: readonly Vec3[]) {
  const min = vec3(Infinity, Infinity, Infinity);
  const max = vec3(-Infinity, -Infinity, -Infinity);
  for (const v of vs) {
    min.x = Math.min(min.x, v.x); min.y = Math.min(min.y, v.y); min.z = Math.min(min.z, v.z);
    max.x = Math.max(max.x, v.x); max.y = Math.max(max.y, v.y); max.z = Math.max(max.z, v.z);
  }
  return { min, max };
}
