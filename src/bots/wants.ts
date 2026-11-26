/**
 * What a bot wants from the pickups on the map: how much each one is worth to it
 * right now, weighed against how long it takes to get there.
 */
import type { PickupState } from "../sim/pickups";
import { TICK_RATE } from "../sim/tick";
import { VITALS, WEAPON } from "../sim/weapon";
import type { PlayerState, World } from "../sim/world";
import type { NavGraph } from "./nav";

/** Below this health it's hurting: health is worth a lot more, and it retreats to it in a fight. */
export const LOW_HEALTH = 40;
/** Below this ammo it's running dry: ammo is worth a lot more. */
export const LOW_AMMO = 25;
/** A pickup loses half its appeal for every this many ticks of travel. */
const HALF_APPEAL_TICKS = 4 * TICK_RATE;
/** Not worth a detour below this. */
const MIN_APPEAL = 0.12;

/** How much a pickup would help, about 0..3: what it adds, scaled up when that's what's running out. */
export function pickupWorth(me: PlayerState, pk: PickupState): number {
  switch (pk.kind) {
    case "health": {
      const gain = Math.min(pk.amount, VITALS.maxHealth - me.health) / VITALS.maxHealth;
      return gain * (me.health < LOW_HEALTH ? 3 : 1);
    }
    case "armor":
      return (Math.min(pk.amount, VITALS.maxArmor - me.armor) / VITALS.maxArmor) * 0.7;
    case "ammo": {
      const gain = Math.min(pk.amount, WEAPON.maxAmmo - me.ammo) / WEAPON.maxAmmo;
      return gain * (me.ammo === 0 ? 6 : me.ammo < LOW_AMMO ? 3 : 1);
    }
    default:
      return 0;
  }
}

export interface PickupChoice {
  index: number;
  appeal: number;
  /** Ticks to get there. */
  ticks: number;
}

/**
 * The pickup most worth going for, or null if none is worth the trip. One that
 * has been taken counts if it will be back by the time we arrive.
 */
export function choosePickup(world: World, me: PlayerState, nav: NavGraph, only?: string): PickupChoice | null {
  const start = nav.nearest(me.origin);
  if (start < 0) return null;
  let best: PickupChoice | null = null;
  world.pickups.forEach((pk, index) => {
    if (!pk.known || (only && pk.kind !== only)) return;
    const worth = pickupWorth(me, pk);
    if (worth <= 0) return;
    const goal = nav.nearest(pk.origin);
    const path = nav.findPath(start, goal);
    if (!path) return;
    const ticks = nav.routeCost(path);
    if (pk.availableAtTick > world.tick + ticks) return; // still gone when we'd get there
    const appeal = worth / (1 + ticks / HALF_APPEAL_TICKS);
    if (appeal >= MIN_APPEAL && (!best || appeal > best.appeal)) best = { index, appeal, ticks };
  });
  return best;
}
