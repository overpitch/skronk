/**
 * Shared shot pieces: vitals, projectiles and the geometry helpers. What each
 * weapon does is in weapons.ts. Projectiles are simulated every tick rather
 * than hitscan, so they can cross portals the same way players do.
 */
import { set, type Vec3 } from "../math/vec3";
import { secondsToTicks } from "./tick";
import type { WeaponId } from "./weapons";

export { WEAPON } from "./weapons";

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
  /** Portals passed through. After the first, the shot can hit whoever fired it. */
  hops: number;
  /** What fired it (the machine gun's bullets, rockets, grenades). */
  weapon: WeaponId;
  /** Grenades: the tick it goes off by itself. */
  fuse?: number;
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
