/**
 * Personal portals. Each owner has at most two, linked once both exist; a new
 * shot replaces the oldest. A portal only sticks where it fits: wholly on
 * flagged, flat surface, with nothing in front of it and no other portal
 * under it. Near an edge or an obstacle it slides over to fit, like a
 * picture being nudged onto a wall, and gives up if there is no room.
 */
import { add, addScaled, clone, cross, dot, length, normalize, scale, sub, vec3, type Vec3 } from "../math/vec3";
import type { CollisionBrush, CollisionPlane, LevelData } from "../level/types";
import type { CollisionWorld } from "./collision";
import type { PlayerId } from "./events";

export const PORTAL = {
  /** Oval half extents. The player box is 32 wide and 56 tall. */
  halfWidth: 32,
  halfHeight: 56,
  range: 8192,
  /** Minimum ticks between portal shots. */
  cooldownTicks: 15,
  /** Keep the oval at least this far inside the surface's edges. */
  edgeMargin: 2,
  /** How far placement may slide the portal away from an obstacle. */
  maxSlide: 128,
};

/**
 * Who a portal pair belongs to. A player now; a team key later, for shared
 * team portals. Code that pairs portals compares owners, never player ids.
 */
export type PortalOwner = string;
export const playerPortalOwner = (id: PlayerId): PortalOwner => `player:${id}`;

export interface Placement {
  /** Centre, on the surface. */
  origin: Vec3;
  /** Out of the surface, towards whoever placed it. */
  normal: Vec3;
  /** In the surface plane, along the oval's long axis. */
  up: Vec3;
  /** up × normal, so (right, up, normal) is right-handed. */
  right: Vec3;
}

/** Which end of a pair. Shots alternate 0, 1, 0, 1, so each new portal replaces the older end. */
export type PortalSlot = 0 | 1;

export interface Portal extends Placement {
  id: number;
  owner: PortalOwner;
  slot: PortalSlot;
  placedTick: number;
}

const POINT: Readonly<Vec3> = Object.freeze(vec3());
const RIM_SAMPLES = 16;
const SLIDE_STEP = 4;

/** Oval orientation on a surface. Walls stand upright; on floors and ceilings the top points the way the shooter faces. */
export function portalBasis(normal: Vec3, yaw: number): { up: Vec3; right: Vec3 } {
  const ref = Math.abs(normal.z) < 0.7 ? vec3(0, 0, 1) : vec3(Math.cos(yaw), Math.sin(yaw), 0);
  const up = normalize(addScaled(ref, normal, -dot(ref, normal)));
  return { up, right: cross(up, normal) };
}

export interface PortalShot {
  /** Where the beam ended (range limit if it hit nothing). */
  end: Vec3;
  /** Surface normal at the end, zero if nothing was hit. */
  normal: Vec3;
  placement: Placement | null;
}

/**
 * Traces a portal shot and works out where the portal would go.
 * `others` are the portals it must not overlap (not the one it replaces).
 */
export function shootPortal(
  collision: CollisionWorld,
  level: LevelData,
  eye: Vec3,
  dir: Vec3,
  yaw: number,
  others: readonly Portal[],
): PortalShot {
  const tr = collision.traceBox(eye, addScaled(eye, dir, PORTAL.range), POINT, POINT);
  const shot: PortalShot = { end: clone(tr.endPos), normal: clone(tr.normal), placement: null };
  if (tr.fraction >= 1 || !tr.plane || tr.startSolid) return shot;
  if (!level.surfaces[tr.plane.surface]?.portalFriendly) return shot;

  const normal = clone(tr.plane.normal);
  const { up, right } = portalBasis(normal, yaw);
  // The trace stops just short of the wall; put the centre exactly on it.
  const origin = addScaled(tr.endPos, normal, tr.plane.dist - dot(tr.endPos, normal));
  const polygon = level.surfaces[tr.plane.surface].vertices;

  // Shot onto an existing portal: try right beside it instead, nearest side first.
  let candidates = [origin];
  const blocker = others.find((o) => overlaps({ origin, normal, up, right }, o));
  if (blocker) {
    const w = 2 * PORTAL.halfWidth + 1;
    const h = 2 * PORTAL.halfHeight + 1;
    candidates = [
      addScaled(blocker.origin, blocker.right, w),
      addScaled(blocker.origin, blocker.right, -w),
      addScaled(blocker.origin, blocker.up, h),
      addScaled(blocker.origin, blocker.up, -h),
    ].sort((a, b) => length(sub(a, origin)) - length(sub(b, origin)));
  }
  for (const c of candidates) {
    const p: Placement = { origin: c, normal, up, right };
    if (fitAt(collision, level, p, polygon) && !others.some((o) => overlaps(p, o))) {
      shot.placement = p;
      break;
    }
  }
  return shot;
}

/** Adjusts p.origin until the portal sits wholly on clear, flagged surface. False if it can't. */
function fitAt(collision: CollisionWorld, level: LevelData, p: Placement, polygon: readonly Vec3[]): boolean {
  if (failingSamples(collision, level, p) === null) return true;
  const fitted = fitInPolygon(p, polygon);
  if (!fitted) return false;
  p.origin = fitted;
  return slideClear(collision, level, p);
}

/** Two ovals on the same plane overlap. Treats both as aligned to `o`, which is exact for wall portals. */
export function overlaps(p: Placement, o: Placement): boolean {
  if (dot(p.normal, o.normal) < 0.999) return false;
  const d = sub(p.origin, o.origin);
  if (Math.abs(dot(d, o.normal)) > 1) return false;
  const du = dot(d, o.right) / (2 * PORTAL.halfWidth);
  const dv = dot(d, o.up) / (2 * PORTAL.halfHeight);
  return du * du + dv * dv < 1 - 1e-6;
}

/** Sample points: the centre, then around the rim. */
function samplePoint(p: Placement, i: number): Vec3 {
  if (i === 0) return clone(p.origin);
  const a = ((i - 1) / RIM_SAMPLES) * Math.PI * 2;
  const out = addScaled(p.origin, p.right, Math.cos(a) * PORTAL.halfWidth);
  return addScaled(out, p.up, Math.sin(a) * PORTAL.halfHeight, out);
}

/**
 * Checks that every sample has flagged surface on the portal's plane right
 * behind it and open space in front. Returns the summed in-plane offsets of
 * the failing rim samples (which way the trouble is), or null if all pass.
 */
function failingSamples(collision: CollisionWorld, level: LevelData, p: Placement): { u: number; v: number } | null {
  const planeDist = dot(p.origin, p.normal);
  let u = 0;
  let v = 0;
  let failed = false;
  for (let i = 0; i <= RIM_SAMPLES; i++) {
    const s = samplePoint(p, i);
    const tr = collision.traceBox(addScaled(s, p.normal, 4), addScaled(s, p.normal, -4), POINT, POINT);
    const ok =
      !tr.startSolid &&
      tr.fraction < 1 &&
      tr.plane !== null &&
      dot(tr.plane.normal, p.normal) > 0.999 &&
      Math.abs(dot(tr.endPos, p.normal) - planeDist) < 0.5 &&
      !!level.surfaces[tr.plane.surface]?.portalFriendly;
    if (ok) continue;
    if (i === 0) return { u: 0, v: 0 };
    failed = true;
    const d = sub(s, p.origin);
    u += dot(d, p.right);
    v += dot(d, p.up);
  }
  return failed ? { u, v } : null;
}

/** Slides the portal away from whatever its rim is touching until it is clear. */
function slideClear(collision: CollisionWorld, level: LevelData, p: Placement): boolean {
  const fail = failingSamples(collision, level, p);
  if (fail === null) return true;
  const len = Math.hypot(fail.u, fail.v);
  if (len < 1e-6) return false;
  const dir = normalize(addScaled(scale(p.right, -fail.u / len), p.up, -fail.v / len));
  const start = p.origin;
  for (let t = SLIDE_STEP; t <= PORTAL.maxSlide; t += SLIDE_STEP) {
    p.origin = addScaled(start, dir, t);
    if (failingSamples(collision, level, p) === null) return true;
  }
  p.origin = start;
  return false;
}

/**
 * Moves the oval's centre so the oval lies inside the convex polygon (the
 * surface it was shot onto), keeping edgeMargin clear. Null if it can't fit.
 */
function fitInPolygon(p: Placement, vertices: readonly Vec3[]): Vec3 | null {
  const a = PORTAL.halfWidth;
  const b = PORTAL.halfHeight;
  const pts = vertices.map((v) => {
    const d = sub(v, p.origin);
    return [dot(d, p.right), dot(d, p.up)] as const;
  });
  const n = pts.length;
  if (n < 3) return null;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % n];
    area += x0 * y1 - x1 * y0;
  }
  const sign = area >= 0 ? 1 : -1;

  // Push the centre in from any edge it is too close to; corners take a few passes.
  let cx = 0;
  let cy = 0;
  const slack = (i: number) => {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % n];
    const len = Math.hypot(x1 - x0, y1 - y0) || 1;
    const mx = (-(y1 - y0) / len) * sign;
    const my = ((x1 - x0) / len) * sign;
    const need = Math.sqrt(a * a * mx * mx + b * b * my * my) + PORTAL.edgeMargin;
    return { gap: (cx - x0) * mx + (cy - y0) * my - need, mx, my };
  };
  for (let pass = 0; pass < 12; pass++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      const { gap, mx, my } = slack(i);
      if (gap < -1e-6) {
        cx -= gap * mx;
        cy -= gap * my;
        moved = true;
      }
    }
    if (!moved) break;
  }
  for (let i = 0; i < n; i++) if (slack(i).gap < -0.01) return null;
  return addScaled(addScaled(p.origin, p.right, cx), p.up, cy);
}

// ---------------------------------------------------------------------------
// Passing through. Near a linked portal, a player's movement ignores the wall
// the portal is on and collides with a short tunnel behind the opening
// instead, so they can step into the wall up to their centre. Once the centre
// crosses the surface they come out of the other portal.

/** How deep the tunnel behind an opening goes, and how thick its walls are. */
export const PASSAGE_DEPTH = 64;
const FRAME_THICKNESS = 32;
/** Start opening the wall when a box centre is this close in front of a portal. */
const PASSAGE_REACH = 80;

export interface PortalPassage {
  /** Level brushes the portal is cut into; ignored while passing through. */
  backing: Set<number>;
  /** Tunnel walls behind the opening, so nobody slides sideways into the wall. */
  frame: CollisionBrush[];
}

export function buildPassage(level: LevelData, p: Placement): PortalPassage {
  const a = PORTAL.halfWidth;
  const b = PORTAL.halfHeight;
  const t = FRAME_THICKNESS;
  const d = PASSAGE_DEPTH;

  // Everything inside the tunnel's space: the wall itself, and anything layered
  // behind it (a thin panel on a thicker wall, a pad on the floor).
  const corners = boxCorners(p, -a, a, -b, b, -d, -0.25);
  const lo = vec3(Infinity, Infinity, Infinity);
  const hi = vec3(-Infinity, -Infinity, -Infinity);
  for (const c of corners) {
    lo.x = Math.min(lo.x, c.x); lo.y = Math.min(lo.y, c.y); lo.z = Math.min(lo.z, c.z);
    hi.x = Math.max(hi.x, c.x); hi.y = Math.max(hi.y, c.y); hi.z = Math.max(hi.z, c.z);
  }
  const backing = new Set<number>();
  level.brushes.forEach((brush, i) => {
    if (brush.mins.x > hi.x || brush.maxs.x < lo.x || brush.mins.y > hi.y || brush.maxs.y < lo.y || brush.mins.z > hi.z || brush.maxs.z < lo.z) return;
    // Separated if every tunnel corner is outside one of the brush's planes.
    const separated = brush.planes.some((pl) => corners.every((c) => dot(pl.normal, c) - pl.dist > 0.01));
    if (!separated) backing.add(i);
  });

  const frame = [
    orientedBox(p, -a - t, -a, -b - t, b + t, -d, 0), // left
    orientedBox(p, a, a + t, -b - t, b + t, -d, 0), // right
    orientedBox(p, -a, a, -b - t, -b, -d, 0), // bottom
    orientedBox(p, -a, a, b, b + t, -d, 0), // top
    orientedBox(p, -a - t, a + t, -b - t, b + t, -d - t, -d), // back
  ];
  return { backing, frame };
}

/** Box centre offset from a player's origin (the box is taller above the origin than below). */
const centreOffset = (mins: Vec3, maxs: Vec3) => scale(add(mins, maxs), 0.5);
const halfExtents = (mins: Vec3, maxs: Vec3) => scale(sub(maxs, mins), 0.5);
/** How far an axis-aligned box with these half extents reaches along a unit direction. */
const reach = (half: Vec3, dir: Vec3) => Math.abs(dir.x) * half.x + Math.abs(dir.y) * half.y + Math.abs(dir.z) * half.z;

/** In-portal coordinates of a point: along right, up and normal from the centre. */
export function portalLocal(point: Vec3, p: Placement): { r: number; u: number; n: number } {
  const d = sub(point, p.origin);
  return { r: dot(d, p.right), u: dot(d, p.up), n: dot(d, p.normal) };
}

/** A box (given by origin, mins, maxs) is close enough in front of the opening to start passing through. */
export function nearOpening(origin: Vec3, mins: Vec3, maxs: Vec3, p: Placement): boolean {
  const c = portalLocal(add(origin, centreOffset(mins, maxs)), p);
  const depth = reach(halfExtents(mins, maxs), p.normal);
  return c.n >= -depth && c.n <= PASSAGE_REACH && Math.abs(c.r) <= PORTAL.halfWidth && Math.abs(c.u) <= PORTAL.halfHeight;
}

/** Carries a direction in through `from` and out of `to`: in becomes out, and left stays on your left. */
export function throughPortalDir(v: Vec3, from: Placement, to: Placement, out: Vec3 = vec3()): Vec3 {
  const r = dot(v, from.right);
  const u = dot(v, from.up);
  const n = dot(v, from.normal);
  out.x = -r * to.right.x + u * to.up.x - n * to.normal.x;
  out.y = -r * to.right.y + u * to.up.y - n * to.normal.y;
  out.z = -r * to.right.z + u * to.up.z - n * to.normal.z;
  return out;
}

export function throughPortalPoint(point: Vec3, from: Placement, to: Placement): Vec3 {
  return add(to.origin, throughPortalDir(sub(point, from.origin), from, to));
}

/**
 * Where a box comes out of `to` when its centre has just crossed `from`:
 * mirrored through the pair, kept inside the exit opening and just in front
 * of it. Returns the new origin.
 */
export function exitOrigin(origin: Vec3, mins: Vec3, maxs: Vec3, from: Placement, to: Placement): Vec3 {
  const off = centreOffset(mins, maxs);
  const half = halfExtents(mins, maxs);
  const c = portalLocal(throughPortalPoint(add(origin, off), from, to), to);
  // A hair inside the opening's edges, so rounding never leaves the box touching the tunnel frame.
  const maxR = Math.max(0, PORTAL.halfWidth - reach(half, to.right) - 0.125);
  const maxU = Math.max(0, PORTAL.halfHeight - reach(half, to.up) - 0.125);
  const r = Math.max(-maxR, Math.min(maxR, c.r));
  const u = Math.max(-maxU, Math.min(maxU, c.u));
  const n = Math.max(0.1, c.n);
  const centre = addScaled(addScaled(addScaled(to.origin, to.right, r), to.up, u), to.normal, n);
  return sub(centre, off);
}

function boxCorners(p: Placement, r0: number, r1: number, u0: number, u1: number, n0: number, n1: number): Vec3[] {
  const out: Vec3[] = [];
  for (const r of [r0, r1]) for (const u of [u0, u1]) for (const n of [n0, n1]) {
    out.push(addScaled(addScaled(addScaled(p.origin, p.right, r), p.up, u), p.normal, n));
  }
  return out;
}

/** A convex brush that is a box in portal coordinates. */
function orientedBox(p: Placement, r0: number, r1: number, u0: number, u1: number, n0: number, n1: number): CollisionBrush {
  const o = { r: dot(p.origin, p.right), u: dot(p.origin, p.up), n: dot(p.origin, p.normal) };
  const plane = (normal: Vec3, dist: number): CollisionPlane => ({ normal: clone(normal), dist, surface: -1 });
  const planes = [
    plane(p.right, o.r + r1),
    plane(scale(p.right, -1), -(o.r + r0)),
    plane(p.up, o.u + u1),
    plane(scale(p.up, -1), -(o.u + u0)),
    plane(p.normal, o.n + n1),
    plane(scale(p.normal, -1), -(o.n + n0)),
  ];
  const corners = boxCorners(p, r0, r1, u0, u1, n0, n1);
  const mins = vec3(Infinity, Infinity, Infinity);
  const maxs = vec3(-Infinity, -Infinity, -Infinity);
  for (const c of corners) {
    mins.x = Math.min(mins.x, c.x); mins.y = Math.min(mins.y, c.y); mins.z = Math.min(mins.z, c.z);
    maxs.x = Math.max(maxs.x, c.x); maxs.y = Math.max(maxs.y, c.y); maxs.z = Math.max(maxs.z, c.z);
  }
  return { planes, mins, maxs };
}
