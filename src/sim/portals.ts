/**
 * Personal portals. Each owner has at most two, linked once both exist; a new
 * shot replaces the oldest. A portal only sticks where it fits: wholly on
 * flagged, flat surface, with nothing in front of it and no other portal
 * under it. Near an edge or an obstacle it slides over to fit, like a
 * picture being nudged onto a wall, and gives up if there is no room.
 */
import { addScaled, clone, cross, dot, length, normalize, scale, sub, vec3, type Vec3 } from "../math/vec3";
import type { LevelData } from "../level/types";
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

export interface Portal extends Placement {
  id: number;
  owner: PortalOwner;
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
