/**
 * The one weapon: primary fire shoots fast projectiles. They are simulated
 * every tick rather than hitscan, so they can cross portals the same way
 * players do (milestone 3).
 */
import { set, type Vec3 } from "../math/vec3";
import { secondsToTicks, TICK_RATE } from "./tick";

export const WEAPON = {
  damage: 10,
  /** Ticks between shots: 7 at 60 Hz, about 8.6 shots per second. */
  fireIntervalTicks: Math.max(1, Math.round(0.12 * TICK_RATE)),
  /** Map units per second. */
  projectileSpeed: 3000,
  projectileLifeTicks: secondsToTicks(2),
  /** Players' hit boxes are grown by this much, so near misses by a hair still count. */
  projectileRadius: 3,
  /** Horizontal speed added to a player per hit, along the shot direction. */
  knockback: 30,
  startAmmo: 100,
  maxAmmo: 200,
};

export const VITALS = {
  startHealth: 100,
  maxHealth: 100,
  maxArmor: 100,
  /** Share of incoming damage armor soaks up while it lasts. */
  armorAbsorb: 2 / 3,
  respawnTicks: secondsToTicks(2),
};

export interface Projectile {
  id: number;
  owner: number;
  origin: Vec3;
  /** Position at the start of the last tick, for render interpolation. */
  prevOrigin: Vec3;
  velocity: Vec3;
  expireTick: number;
  /** Portals passed through. After the first, the shot can hit whoever fired it. */
  hops: number;
}

/** Unit vector for yaw (0 = +X, counter-clockwise) and pitch (positive = up). */
export function viewDirection(yaw: number, pitch: number, out: Vec3): Vec3 {
  const cp = Math.cos(pitch);
  return set(out, Math.cos(yaw) * cp, Math.sin(yaw) * cp, Math.sin(pitch));
}

/**
 * Where the segment start -> start + delta first enters the box, as a fraction
 * 0..1, or -1 for a miss. A start inside the box counts as a hit at 0.
 */
export function segmentVsBox(start: Vec3, delta: Vec3, min: Vec3, max: Vec3): number {
  let tEnter = 0;
  let tExit = 1;
  const axes = ["x", "y", "z"] as const;
  for (const a of axes) {
    const s = start[a];
    const d = delta[a];
    if (Math.abs(d) < 1e-9) {
      if (s < min[a] || s > max[a]) return -1;
      continue;
    }
    let t0 = (min[a] - s) / d;
    let t1 = (max[a] - s) / d;
    if (t0 > t1) [t0, t1] = [t1, t0];
    if (t0 > tEnter) tEnter = t0;
    if (t1 < tExit) tExit = t1;
    if (tEnter > tExit) return -1;
  }
  return tEnter;
}
