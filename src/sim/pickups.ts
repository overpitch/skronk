/**
 * Health, armor and ammo pickups placed in the level. A pickup is only taken
 * when it would help (no grabbing health at full health), then respawns.
 */
import { vec3, type Vec3 } from "../math/vec3";
import type { PickupMarker } from "../level/types";
import { secondsToTicks } from "./tick";
import { VITALS, WEAPON } from "./weapon";

/** Half-size of a pickup's touch box, matching the editor's 32-unit box. */
export const PICKUP_HALF_SIZE = 16;

const RULES: Record<string, { amount: number; respawnSeconds: number }> = {
  health: { amount: 25, respawnSeconds: 20 },
  armor: { amount: 50, respawnSeconds: 25 },
  ammo: { amount: 50, respawnSeconds: 15 },
};

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
      amount: Number.isFinite(amount) && amount > 0 ? amount : (rule?.amount ?? 0),
      respawnTicks: secondsToTicks(rule?.respawnSeconds ?? 30),
      availableAtTick: 0,
      known: !!rule,
    };
  });
}

export interface Vitals {
  health: number;
  armor: number;
  ammo: number;
}

/** Applies the pickup if it helps. Returns whether it was taken. */
export function applyPickup(p: Vitals, pickup: PickupState): boolean {
  switch (pickup.kind) {
    case "health":
      if (p.health >= VITALS.maxHealth) return false;
      p.health = Math.min(VITALS.maxHealth, p.health + pickup.amount);
      return true;
    case "armor":
      if (p.armor >= VITALS.maxArmor) return false;
      p.armor = Math.min(VITALS.maxArmor, p.armor + pickup.amount);
      return true;
    case "ammo":
      if (p.ammo >= WEAPON.maxAmmo) return false;
      p.ammo = Math.min(WEAPON.maxAmmo, p.ammo + pickup.amount);
      return true;
    default:
      return false;
  }
}
