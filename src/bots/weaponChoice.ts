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
  // Too close and the blast hurts you too.
  rocketlauncher: (d) => (d < 140 ? 0.1 : d < 250 ? 0.8 : d < 900 ? 0.95 : 0.45),
  railgun: (d) => (d > 500 ? 1 : d > 250 ? 0.75 : 0.45),
};

/** Fighting distance per weapon: closes in beyond `far`, backs off inside `near`. */
export const FIGHT_RANGE: Record<WeaponId, { near: number; far: number }> = {
  fists: { near: 0, far: 40 },
  machinegun: { near: 180, far: 650 },
  shotgun: { near: 80, far: 280 },
  rocketlauncher: { near: 250, far: 750 },
  railgun: { near: 350, far: 1400 },
};

/** A change of weapon has to be at least this much better, so it doesn't flick back and forth at a boundary. */
const SWITCH_MARGIN = 0.15;

export function suitability(w: number, distance: number): number {
  return SUITS[WEAPONS[w].id](distance);
}

/** The weapon to hold for a fight at `distance`: the best that has ammo, keeping the current one unless another is clearly better. */
export function chooseWeapon(me: Pick<Armed, "weapon" | "weapons" | "ammo">, distance: number, margin = SWITCH_MARGIN): number {
  let best = canFire(me, me.weapon) ? me.weapon : FISTS;
  let bestScore = suitability(best, distance) + (best === me.weapon ? margin : 0);
  for (let w = 0; w < WEAPONS.length; w++) {
    if (w === best || !canFire(me, w)) continue;
    const score = suitability(w, distance);
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
  rocketlauncher: 1.6,
  railgun: 1.5,
};

export const isWeaponKind = (kind: string) => weaponIndex(kind) > FISTS;
