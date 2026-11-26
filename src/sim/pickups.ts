/**
 * Pickups placed in the level: health, armor, the ammo box, and weapons
 * (pickup_shotgun and so on, named by weapon id). A pickup is only taken when
 * it would help (no grabbing health at full health), then respawns.
 */
import { vec3, type Vec3 } from "../math/vec3";
import type { PickupMarker } from "../level/types";
import { secondsToTicks } from "./tick";
import { VITALS } from "./weapon";
import { FISTS, holds, WEAPONS, weaponIndex, type Armed } from "./weapons";

/** Half-size of a pickup's touch box, matching the editor's 32-unit box. */
export const PICKUP_HALF_SIZE = 16;

/** Weapons that can lie on the map (not fists: you always have them). */
export const WEAPON_PICKUPS = WEAPONS.filter((_, i) => i !== FISTS).map((w) => w.id as string);

const RULES: Record<string, { amount: number; respawnSeconds: number }> = {
  health: { amount: 25, respawnSeconds: 20 },
  armor: { amount: 50, respawnSeconds: 25 },
  /** An ammo box gives every gun you hold its share (WeaponSpec.boxAmmo); `amount` isn't used. */
  ammo: { amount: 0, respawnSeconds: 15 },
  ...Object.fromEntries(WEAPON_PICKUPS.map((id) => [id, { amount: WEAPONS[weaponIndex(id)].pickupAmmo, respawnSeconds: 15 }])),
};

/** Every kind the game knows, for the map checker. */
export const KNOWN_PICKUPS: readonly string[] = Object.keys(RULES);

export interface PickupState {
  kind: string;
  origin: Vec3;
  amount: number;
  respawnTicks: number;
  /** Tick at which it can be taken again; 0 means available from the start. */
  availableAtTick: number;
  /** False for kinds the sim doesn't know; they are drawn but never taken. */
  known: boolean;
}

/** Same order as the level's markers, so index i matches level.pickups[i]. */
export function createPickups(markers: PickupMarker[]): PickupState[] {
  return markers.map((m) => {
    const rule = RULES[m.kind];
    const amount = Number(m.properties.amount);
    return {
      kind: m.kind,
      origin: vec3(m.origin.x, m.origin.y, m.origin.z),
      amount: m.kind !== "ammo" && Number.isFinite(amount) && amount > 0 ? amount : (rule?.amount ?? 0),
      respawnTicks: secondsToTicks(rule?.respawnSeconds ?? 30),
      availableAtTick: 0,
      known: !!rule,
    };
  });
}

export interface Vitals extends Pick<Armed, "weapons" | "ammo"> {
  health: number;
  armor: number;
}

/** Would an ammo box give this player anything? */
export function ammoBoxHelps(p: Vitals): boolean {
  return WEAPONS.some((w, i) => holds(p, i) && w.boxAmmo > 0 && p.ammo[i] < w.maxAmmo);
}

/**
 * Applies the pickup if it helps. Returns whether it was taken, and for a
 * weapon you didn't have, its index (else -1).
 */
export function applyPickup(p: Vitals, pickup: PickupState): { taken: boolean; newWeapon: number } {
  const no = { taken: false, newWeapon: -1 };
  const yes = { taken: true, newWeapon: -1 };
  switch (pickup.kind) {
    case "health":
      if (p.health >= VITALS.maxHealth) return no;
      p.health = Math.min(VITALS.maxHealth, p.health + pickup.amount);
      return yes;
    case "armor":
      if (p.armor >= VITALS.maxArmor) return no;
      p.armor = Math.min(VITALS.maxArmor, p.armor + pickup.amount);
      return yes;
    case "ammo":
      if (!ammoBoxHelps(p)) return no;
      WEAPONS.forEach((w, i) => {
        if (holds(p, i)) p.ammo[i] = Math.min(w.maxAmmo, p.ammo[i] + w.boxAmmo);
      });
      return yes;
  }
  const w = weaponIndex(pickup.kind);
  if (w <= FISTS) return no;
  const had = holds(p, w);
  if (had && p.ammo[w] >= WEAPONS[w].maxAmmo) return no;
  p.weapons |= 1 << w;
  p.ammo[w] = Math.min(WEAPONS[w].maxAmmo, p.ammo[w] + pickup.amount);
  return { taken: true, newWeapon: had ? -1 : w };
}
