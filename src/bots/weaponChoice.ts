/**
 * Which weapon a bot wants in hand for a fight at a given distance, and how
 * close it likes to be with it. Plain judgement, no cheating: it only weighs
 * what it holds and its ammo.
 */
import { canFire, FISTS, WEAPONS, weaponIndex, type Armed, type WeaponId } from "../sim/weapons";

/** How good each weapon is at a distance, about 0..1. */
const SUITS: Record<WeaponId, (d: number) => number> = {
  fists: (d) => (d < 90 ? 0.3 : 0.02),
  machinegun: (d) => (d < 1200 ? 0.5 : 0.35),
  shotgun: (d) => (d < 250 ? 1.25 : d < 450 ? 0.75 : 0.15),
  // Lobbed: good at middle range, round corners; up close it lands at your own feet.
  grenadelauncher: (d) => (d < 160 ? 0.1 : d < 650 ? 0.8 : 0.3),
  // Too close and the blast hurts you too.
  rocketlauncher: (d) => (d < 140 ? 0.1 : d < 250 ? 0.8 : d < 900 ? 0.95 : 0.45),
  railgun: (d) => (d > 500 ? 1 : d > 250 ? 0.75 : 0.45),
};

/** Fighting distance per weapon: closes in beyond `far`, backs off inside `near`. */
export const FIGHT_RANGE: Record<WeaponId, { near: number; far: number }> = {
  fists: { near: 0, far: 40 },
  machinegun: { near: 180, far: 650 },
  shotgun: { near: 80, far: 280 },
  grenadelauncher: { near: 220, far: 600 },
  rocketlauncher: { near: 250, far: 750 },
  railgun: { near: 350, far: 1400 },
};

/** A change of weapon has to be at least this much better, so it doesn't flick back and forth at a boundary. */
const SWITCH_MARGIN = 0.15;

export function suitability(w: number, distance: number): number {
  return SUITS[WEAPONS[w].id](distance);
}

/** The weapon to hold for a fight at `distance`: the best that has ammo, keeping the current one unless another is clearly better. */
export function chooseWeapon(
  me: Pick<Armed, "weapon" | "weapons" | "ammo">,
  distance: number,
  margin = SWITCH_MARGIN,
  /** A personality's favourites, added to how well each suits the distance. */
  bias: Partial<Record<WeaponId, number>> = {},
): number {
  const scoreOf = (w: number) => suitability(w, distance) + (bias[WEAPONS[w].id] ?? 0);
  let best = canFire(me, me.weapon) ? me.weapon : FISTS;
  let bestScore = scoreOf(best) + (best === me.weapon ? margin : 0);
  for (let w = 0; w < WEAPONS.length; w++) {
    if (w === best || !canFire(me, w)) continue;
    const score = scoreOf(w);
    if (score > bestScore) {
      best = w;
      bestScore = score;
    }
  }
  return best;
}

/** Holds anything that shoots (not just fists). */
export function hasGunAmmo(me: Pick<Armed, "weapons" | "ammo">): boolean {
  return WEAPONS.some((_, i) => i !== FISTS && canFire(me, i));
}

/** How much a weapon pickup is worth to a bot that doesn't hold it yet. */
export const WEAPON_WANT: Record<string, number> = {
  machinegun: 0.2,
  shotgun: 1.2,
  grenadelauncher: 1.3,
  rocketlauncher: 1.6,
  railgun: 1.5,
};

export const isWeaponKind = (kind: string) => weaponIndex(kind) > FISTS;

/**
 * Aim for a lobbed shot (grenades): the pitch that lands it `dz` above or below and
 * `horizontal` away, and how long it takes, for a weapon with this speed, lob and
 * gravity. The flattest arc that gets there (quickest, hardest to dodge); if nothing
 * reaches, the 45-degree-ish throw that goes furthest.
 */
export function lobAim(horizontal: number, dz: number, spec: { speed: number; lob: number; gravity: number }): { pitch: number; time: number } {
  let best = { pitch: 0.7, time: 1, err: Infinity };
  for (let pitch = -0.6; pitch <= 1.2; pitch += 0.01) {
    const vx = spec.speed * Math.cos(pitch);
    const vz = spec.speed * Math.sin(pitch) + spec.lob;
    const time = horizontal / Math.max(1, vx);
    const z = vz * time - (spec.gravity * time * time) / 2;
    const err = Math.abs(z - dz);
    if (err < best.err - 0.5) best = { pitch, time, err };
  }
  return { pitch: best.pitch, time: best.time };
}
