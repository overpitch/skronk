/**
 * Aim assist for controller look (never the mouse), the way console shooters do
 * it: it helps you keep on a target you're already aiming at, it doesn't aim
 * for you.
 *
 * - Slow-down ("friction"): the stick turns the view slower while the crosshair
 *   is on or near an enemy, so you don't overshoot.
 * - Pull and follow: while you're moving or aiming (not when the sticks are at
 *   rest), the view drifts a little towards an enemy near the crosshair and
 *   follows some of their sideways movement.
 *
 * The zone round each enemy grows with how close they are (it's about the size
 * of their body on screen) plus a small margin. Only enemies you can see count.
 * This is input, not gameplay: the sim never knows about it.
 */
import type { Vec3 } from "../math/vec3";

export const AIM_ASSIST = {
  /** Stick speed right on a target (1 is no slow-down). */
  slowest: 0.4,
  /** Body half-width the zone is sized from, units, and how many times that the zone reaches. */
  bodyRadius: 18,
  zoneScale: 2.6,
  /** Extra zone margin, radians (so far-off targets still get a little). */
  margin: 0.02,
  /** Fastest pull towards a target, radians per second. */
  pullRate: 0.7,
  /** Share of a target's sideways movement the view follows. */
  follow: 0.45,
  /** Beyond this, no assist. */
  range: 2500,
};

export interface AssistTarget {
  /** Where to aim (their chest). */
  centre: Vec3;
  velocity: Vec3;
}

export interface AssistResult {
  /** Multiplier on the stick's look speed this frame. */
  scale: number;
  /** View change to add this frame, radians. */
  yaw: number;
  pitch: number;
}

const NONE: AssistResult = { scale: 1, yaw: 0, pitch: 0 };
const wrap = (a: number) => a - Math.PI * 2 * Math.floor((a + Math.PI) / (Math.PI * 2));

/**
 * The assist for one frame. `active`: the player is moving or aiming (0 at rest, 1
 * full stick); the pull and follow scale with it, the slow-down doesn't need it.
 */
export function aimAssist(eye: Vec3, yaw: number, pitch: number, targets: readonly AssistTarget[], active: number, dt: number): AssistResult {
  let best: { weight: number; dYaw: number; dPitch: number; omega: number } | null = null;
  for (const t of targets) {
    const dx = t.centre.x - eye.x;
    const dy = t.centre.y - eye.y;
    const dz = t.centre.z - eye.z;
    const flat = Math.hypot(dx, dy);
    const d = Math.hypot(flat, dz);
    if (d > AIM_ASSIST.range || d < 1) continue;
    const dYaw = wrap(Math.atan2(dy, dx) - yaw);
    const dPitch = Math.atan2(dz, flat) - pitch;
    const off = Math.hypot(dYaw, dPitch);
    const zone = Math.atan(AIM_ASSIST.bodyRadius / d) * AIM_ASSIST.zoneScale + AIM_ASSIST.margin;
    if (off >= zone) continue;
    const weight = 1 - off / zone;
    // How fast they're moving across your view (radians per second, counter-clockwise).
    const omega = flat > 1 ? (dx * t.velocity.y - dy * t.velocity.x) / (flat * flat) : 0;
    if (!best || weight > best.weight) best = { weight, dYaw, dPitch, omega };
  }
  if (!best) return NONE;
  const scale = 1 - (1 - AIM_ASSIST.slowest) * best.weight;
  const a = Math.max(0, Math.min(1, active));
  if (a === 0) return { scale, yaw: 0, pitch: 0 };
  const step = AIM_ASSIST.pullRate * best.weight * a * dt;
  const clamp = (v: number, m: number) => Math.max(-m, Math.min(m, v));
  return {
    scale,
    yaw: clamp(best.dYaw, step) + best.omega * AIM_ASSIST.follow * best.weight * a * dt,
    pitch: clamp(best.dPitch, step * 0.6),
  };
}
