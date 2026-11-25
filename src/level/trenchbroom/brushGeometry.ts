/**
 * Turns plane-defined brushes into polygons, texture coordinates and collision planes.
 */
import { cross, dot, normalize, sub, vec3, type Vec3 } from "../../math/vec3";
import type { Plane } from "../types";
import type { MapFace } from "./mapParser";

const ON_EPSILON = 0.01;
const BASE_WINDING_SIZE = 1 << 17;

/**
 * Quake convention: normal = cross(p0 - p1, p2 - p1). For TrenchBroom output this
 * points out of the brush, so the brush interior is dot(n, x) <= dist for all faces.
 */
export function planeFromPoints(p0: Vec3, p1: Vec3, p2: Vec3): Plane | null {
  const n = cross(sub(p0, p1), sub(p2, p1));
  if (dot(n, n) < 1e-12) return null;
  const normal = normalize(n);
  // Adding 0 turns -0 into 0, so axial normals compare cleanly.
  normal.x += 0;
  normal.y += 0;
  normal.z += 0;
  return { normal, dist: dot(normal, p1) + 0 };
}

/** A huge quad lying on the plane, counter-clockwise seen from the front. */
function baseWinding(plane: Plane): Vec3[] {
  const n = plane.normal;
  const ax = Math.abs(n.x);
  const ay = Math.abs(n.y);
  const az = Math.abs(n.z);
  // Pick an "up" vector not parallel to the normal.
  let up: Vec3 = az >= ax && az >= ay ? vec3(1, 0, 0) : vec3(0, 0, 1);
  const d = dot(up, n);
  up = normalize(vec3(up.x - n.x * d, up.y - n.y * d, up.z - n.z * d));
  const right = cross(up, n);
  const org = vec3(n.x * plane.dist, n.y * plane.dist, n.z * plane.dist);
  const s = BASE_WINDING_SIZE;
  const p = (r: number, u: number) =>
    vec3(org.x + right.x * r + up.x * u, org.y + right.y * r + up.y * u, org.z + right.z * r + up.z * u);
  const w = [p(-s, s), p(s, s), p(s, -s), p(-s, -s)];
  return ensureWinding(w, n);
}

/** Make the polygon counter-clockwise around `normal` (Newell's method). */
function ensureWinding(w: Vec3[], normal: Vec3): Vec3[] {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < w.length; i++) {
    const a = w[i];
    const b = w[(i + 1) % w.length];
    nx += (a.y - b.y) * (a.z + b.z);
    ny += (a.z - b.z) * (a.x + b.x);
    nz += (a.x - b.x) * (a.y + b.y);
  }
  return nx * normal.x + ny * normal.y + nz * normal.z < 0 ? w.reverse() : w;
}

/** Keep the part of the polygon behind the plane (dot(n,p) <= dist). */
function clipWinding(w: Vec3[], plane: Plane): Vec3[] {
  const dists = w.map((p) => dot(plane.normal, p) - plane.dist);
  const out: Vec3[] = [];
  for (let i = 0; i < w.length; i++) {
    const a = w[i];
    const b = w[(i + 1) % w.length];
    const da = dists[i];
    const db = dists[(i + 1) % w.length];
    if (da <= ON_EPSILON) out.push(a);
    if ((da < -ON_EPSILON && db > ON_EPSILON) || (da > ON_EPSILON && db < -ON_EPSILON)) {
      const t = da / (da - db);
      out.push(vec3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t));
    }
  }
  return out;
}

/** Snap values within 1/1000 of an integer, so a box brush gives exact integer vertices. */
const snap = (v: number) => {
  const r = Math.round(v);
  return Math.abs(v - r) < 1e-3 ? r : v;
};

export interface BrushPolygon {
  faceIndex: number;
  plane: Plane;
  vertices: Vec3[];
}

/**
 * Build the polygon for every face of a brush. Faces with degenerate planes, or
 * whose polygon is clipped away entirely (redundant planes), are dropped.
 */
export function buildBrushPolygons(faces: MapFace[]): { planes: (Plane | null)[]; polygons: BrushPolygon[] } {
  const planes = faces.map((f) => planeFromPoints(f.points[0], f.points[1], f.points[2]));
  const polygons: BrushPolygon[] = [];
  planes.forEach((plane, i) => {
    if (!plane) return;
    let w = baseWinding(plane);
    for (let j = 0; j < planes.length && w.length >= 3; j++) {
      const other = planes[j];
      if (j === i || !other) continue;
      // Identical plane appearing twice: keep only the first.
      if (dot(other.normal, plane.normal) > 0.9999 && Math.abs(other.dist - plane.dist) < ON_EPSILON) {
        if (j < i) w = [];
        continue;
      }
      w = clipWinding(w, other);
    }
    if (w.length < 3) return;
    polygons.push({ faceIndex: i, plane, vertices: w.map((p) => vec3(snap(p.x), snap(p.y), snap(p.z))) });
  });
  return { planes, polygons };
}

// Quake's texture projection axes for the Standard format: [normal, u, v] per entry.
const BASE_AXES: [Vec3, Vec3, Vec3][] = [
  [vec3(0, 0, 1), vec3(1, 0, 0), vec3(0, -1, 0)], // floor
  [vec3(0, 0, -1), vec3(1, 0, 0), vec3(0, -1, 0)], // ceiling
  [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, -1)], // west wall
  [vec3(-1, 0, 0), vec3(0, 1, 0), vec3(0, 0, -1)], // east wall
  [vec3(0, 1, 0), vec3(1, 0, 0), vec3(0, 0, -1)], // south wall
  [vec3(0, -1, 0), vec3(1, 0, 0), vec3(0, 0, -1)], // north wall
];

/** Returns u and v projection axes, already divided by scale, plus offsets. */
export function textureProjection(face: MapFace, normal: Vec3): { u: Vec3; v: Vec3; offset: [number, number] } {
  const sx = face.scale[0] || 1;
  const sy = face.scale[1] || 1;
  if (face.axes.kind === "valve") {
    const { u, v } = face.axes;
    return {
      u: vec3(u.x / sx, u.y / sx, u.z / sx),
      v: vec3(v.x / sy, v.y / sy, v.z / sy),
      offset: face.axes.offset,
    };
  }
  let best = 0;
  let bestDot = -Infinity;
  BASE_AXES.forEach(([n], i) => {
    const d = dot(normal, n);
    if (d > bestDot + 1e-6) {
      bestDot = d;
      best = i;
    }
  });
  const axes = [{ ...BASE_AXES[best][1] }, { ...BASE_AXES[best][2] }];
  const ang = (face.rotation / 180) * Math.PI;
  const sinv = face.rotation ? Math.sin(ang) : 0;
  const cosv = face.rotation ? Math.cos(ang) : 1;
  const comp = (a: Vec3) => (a.x ? "x" : a.y ? "y" : "z") as "x" | "y" | "z";
  const sv = comp(axes[0]);
  const tv = comp(axes[1]);
  for (const a of axes) {
    const ns = cosv * a[sv] - sinv * a[tv];
    const nt = sinv * a[sv] + cosv * a[tv];
    a[sv] = ns;
    a[tv] = nt;
  }
  return {
    u: vec3(axes[0].x / sx, axes[0].y / sx, axes[0].z / sx),
    v: vec3(axes[1].x / sy, axes[1].y / sy, axes[1].z / sy),
    offset: face.axes.offset,
  };
}

export function computeUVs(vertices: Vec3[], face: MapFace, normal: Vec3): [number, number][] {
  const { u, v, offset } = textureProjection(face, normal);
  return vertices.map((p) => [dot(p, u) + offset[0], dot(p, v) + offset[1]]);
}
