/**
 * The weapons: what each one does, and the trigger, switching and ammo rules
 * they share: fists, machine gun, shotgun, grenade launcher, rocket launcher, railgun.
 *
 * The ids are plain names, used in code and in map entities (pickup_shotgun).
 * `name` is what players see; it can change without touching anything else.
 *
 * A player holds a set of weapons (a bitmask by index), ammo per weapon, and
 * one weapon in hand. Fists are always held and need no ammo. Number keys pick
 * by slot (index + 1).
 */
import type { PlayerCommand } from "./command";
import { secondsToTicks } from "./tick";

export type WeaponId = "fists" | "machinegun" | "shotgun" | "grenadelauncher" | "rocketlauncher" | "railgun";

export interface SplashSpec {
  /** Reach of the blast, map units. */
  radius: number;
  /** Damage right at the blast, falling to 0 at the edge. */
  damage: number;
  /** Speed added (away from the blast) right at it, falling off like the damage. Rocket jumps come from this. */
  knockback: number;
  /** Share of the damage you take from your own blast. */
  selfDamage: number;
}

export interface WeaponSpec {
  id: WeaponId;
  /** Shown to players. */
  name: string;
  /** melee: a short reach in front of you; projectile: flies each tick (through portals); hitscan: arrives at once (through portals). */
  shot: "melee" | "projectile" | "hitscan";
  /** Ticks between shots. */
  fireTicks: number;
  /** Per pellet (shotgun), per hit, or on a direct rocket hit. */
  damage: number;
  /** Shots per trigger pull, spread over `spread` radians around the aim. */
  pellets: number;
  spread: number;
  /** Hitscan and melee: how far the shot reaches, portals included. */
  range: number;
  /** Projectile speed, map units per second. */
  speed: number;
  /** Players' hit boxes are grown by this much for the shot. */
  radius: number;
  /** Speed added to whoever is hit, along the shot (horizontal, plus `lift` upwards). */
  knockback: number;
  lift: number;
  /** Melee: speed you get pushed back by when you hit a wall or floor (a punch jump). */
  recoil: number;
  splash: SplashSpec | null;
  /** Projectiles: falls at this rate (units per second per second; 0 flies straight). */
  gravity: number;
  /** Projectiles: bounces off walls and floors keeping this share of its speed into them (0: stops at the first). */
  bounce: number;
  /** Projectiles: goes off by itself this long after firing (0: only when it hits something). */
  fuseTicks: number;
  /** Projectiles: upward speed added at launch, so it arcs (units per second). */
  lob: number;
  /** 0: never runs out. */
  ammoPerShot: number;
  maxAmmo: number;
  /** What its own pickup gives (with the weapon, if you didn't have it). */
  pickupAmmo: number;
  /** What an ammo box gives it, if you hold it. */
  boxAmmo: number;
}

const base = {
  pellets: 1,
  spread: 0,
  range: 0,
  speed: 0,
  radius: 0,
  knockback: 0,
  lift: 0,
  recoil: 0,
  splash: null,
  gravity: 0,
  bounce: 0,
  fuseTicks: 0,
  lob: 0,
  pickupAmmo: 0,
  boxAmmo: 0,
};

/** In slot order: index 0 is key 1. */
export const WEAPONS: readonly WeaponSpec[] = [
  {
    ...base,
    id: "fists",
    name: "Fists",
    shot: "melee",
    fireTicks: secondsToTicks(0.45),
    // A quarter of the machine gun's damage per second, and only at arm's length: a last resort.
    // The shove (and punch-jumping) is what fists are really for.
    damage: 10,
    range: 64,
    radius: 6,
    knockback: 420,
    lift: 160,
    recoil: 330,
    ammoPerShot: 0,
    maxAmmo: 0,
  },
  {
    ...base,
    id: "machinegun",
    name: "Machine gun",
    shot: "projectile",
    fireTicks: Math.max(1, Math.round(secondsToTicks(0.12))),
    damage: 10,
    speed: 3000,
    radius: 3,
    knockback: 30,
    ammoPerShot: 1,
    maxAmmo: 200,
    pickupAmmo: 50,
    boxAmmo: 50,
  },
  {
    ...base,
    id: "shotgun",
    name: "Shotgun",
    shot: "hitscan",
    fireTicks: secondsToTicks(0.95),
    damage: 8,
    pellets: 11,
    spread: 0.085,
    range: 4096,
    radius: 1,
    knockback: 14,
    ammoPerShot: 1,
    maxAmmo: 40,
    pickupAmmo: 10,
    boxAmmo: 10,
  },
  {
    ...base,
    id: "grenadelauncher",
    name: "Grenade launcher",
    shot: "projectile",
    fireTicks: secondsToTicks(0.8),
    damage: 100,
    speed: 700,
    radius: 4,
    splash: { radius: 150, damage: 100, knockback: 620, selfDamage: 0.4 },
    gravity: 800,
    bounce: 0.55,
    fuseTicks: secondsToTicks(2),
    lob: 200,
    ammoPerShot: 1,
    maxAmmo: 30,
    pickupAmmo: 10,
    boxAmmo: 5,
  },
  {
    ...base,
    id: "rocketlauncher",
    name: "Rocket launcher",
    shot: "projectile",
    fireTicks: secondsToTicks(0.8),
    damage: 90,
    speed: 1000,
    radius: 4,
    splash: { radius: 150, damage: 90, knockback: 600, selfDamage: 0.4 },
    ammoPerShot: 1,
    maxAmmo: 40,
    pickupAmmo: 10,
    boxAmmo: 5,
  },
  {
    ...base,
    id: "railgun",
    name: "Railgun",
    shot: "hitscan",
    fireTicks: secondsToTicks(1.5),
    damage: 80,
    range: 8192,
    radius: 1,
    knockback: 150,
    ammoPerShot: 1,
    maxAmmo: 25,
    pickupAmmo: 10,
    boxAmmo: 5,
  },
];

export const WEAPON_COUNT = WEAPONS.length;
export const FISTS = 0;
export const MACHINE_GUN = 1;

export function weaponIndex(id: string): number {
  return WEAPONS.findIndex((w) => w.id === id);
}

export const weaponById = (id: WeaponId): WeaponSpec => WEAPONS[weaponIndex(id)];

/** The machine gun, for code and tests about "the gun" (the one you spawn holding). */
export const WEAPON = WEAPONS[MACHINE_GUN];

/** What you have when you spawn: fists and the machine gun, in hand. */
export const SPAWN_WEAPONS = (1 << FISTS) | (1 << MACHINE_GUN);
export const SPAWN_AMMO = 100;

/** Putting one weapon away and bringing up another. */
export const SWITCH_TICKS = secondsToTicks(0.25);

/** With the trigger pulled on an empty weapon, switch to the first of these that has ammo. */
const EMPTY_SWITCH_ORDER = ["shotgun", "machinegun", "railgun", "rocketlauncher", "grenadelauncher", "fists"].map(weaponIndex);

/** The part of a player the trigger works on. */
export interface Armed {
  /** Index of the weapon in hand. */
  weapon: number;
  /** Bit i set: holds weapon i. */
  weapons: number;
  /** Ammo per weapon, by index. */
  ammo: number[];
  /** Ticks until the weapon in hand can fire. */
  fireCooldown: number;
}

export const holds = (p: Pick<Armed, "weapons">, w: number) => (p.weapons & (1 << w)) !== 0;
/** Holds it and has the ammo for a shot. */
export const canFire = (p: Pick<Armed, "weapons" | "ammo">, w: number) => holds(p, w) && p.ammo[w] >= WEAPONS[w].ammoPerShot;

export function startingArms(): Pick<Armed, "weapon" | "weapons" | "ammo"> {
  const ammo = WEAPONS.map(() => 0);
  ammo[MACHINE_GUN] = SPAWN_AMMO;
  return { weapon: MACHINE_GUN, weapons: SPAWN_WEAPONS, ammo };
}

/** Puts weapon `w` in hand, if you hold it with ammo. Returns whether it changed. */
export function switchWeapon(p: Armed, w: number): boolean {
  if (w < 0 || w >= WEAPON_COUNT || w === p.weapon || !canFire(p, w)) return false;
  p.weapon = w;
  p.fireCooldown = Math.max(p.fireCooldown, SWITCH_TICKS);
  return true;
}

/** The next weapon you could switch to, going up (+1) or down (-1) the slots from `from`. */
export function cycleWeapon(p: Pick<Armed, "weapons" | "ammo">, from: number, delta: number): number {
  for (let k = 1; k <= WEAPON_COUNT; k++) {
    const w = (((from + delta * k) % WEAPON_COUNT) + WEAPON_COUNT) % WEAPON_COUNT;
    if (canFire(p, w)) return w;
  }
  return from;
}

export interface TriggerResult {
  /** A shot went off, from the weapon now in hand. */
  fired: boolean;
  /** The trigger was pulled on an empty weapon. */
  dry: boolean;
  /** The weapon in hand changed (a switch asked for, or out of ammo). */
  switched: boolean;
}

/**
 * One tick of the trigger: cooldown, a switch asked for (`cmd.weapon` is a slot,
 * 0 for none), firing and ammo. The sim and a network client's prediction both
 * run this, so their timing agrees; the sim then makes the shot itself.
 */
export function triggerTick(p: Armed, cmd: Pick<PlayerCommand, "fire" | "weapon">): TriggerResult {
  if (p.fireCooldown > 0) p.fireCooldown--;
  let switched = cmd.weapon > 0 && switchWeapon(p, cmd.weapon - 1);
  if (!cmd.fire || p.fireCooldown > 0) return { fired: false, dry: false, switched };
  const spec = WEAPONS[p.weapon];
  if (p.ammo[p.weapon] < spec.ammoPerShot) {
    // Out: switch to something that still shoots.
    const next = EMPTY_SWITCH_ORDER.find((w) => canFire(p, w)) ?? FISTS;
    if (switchWeapon(p, next)) switched = true;
    else p.fireCooldown = spec.fireTicks * 2;
    return { fired: false, dry: true, switched };
  }
  p.ammo[p.weapon] -= spec.ammoPerShot;
  p.fireCooldown = spec.fireTicks;
  return { fired: true, dry: false, switched };
}

/**
 * Directions of a spread shot's pellets as (right, up) offsets in radians: one in
 * the middle and the rest in two rings, turned by `turn` so the pattern varies
 * from shot to shot without randomness.
 */
export function pelletOffsets(spec: WeaponSpec, turn: number): [number, number][] {
  if (spec.pellets <= 1) return [[0, 0]];
  const out: [number, number][] = [[0, 0]];
  const rest = spec.pellets - 1;
  const inner = Math.floor(rest * 0.4);
  for (let i = 0; i < rest; i++) {
    const ring = i < inner ? 0 : 1;
    const n = ring === 0 ? inner : rest - inner;
    const k = ring === 0 ? i : i - inner;
    const a = turn + ((k + ring * 0.5) / n) * Math.PI * 2;
    const r = spec.spread * (ring === 0 ? 0.45 : 1);
    out.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return out;
}
