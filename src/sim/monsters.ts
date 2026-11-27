/**
 * Monsters (Horde mode): a second kind of enemy, not players. They have no
 * weapons, pickups or frags; they walk (through portals too), swipe whoever
 * they reach, and die. Like players they're driven by commands, here from a
 * MonsterDirector (src/bots/monsterDirector.ts); the sim never decides where
 * they go.
 *
 * First type: the shambler. Slow and weak, but they come in crowds.
 */
import type { MoveState } from "./movement";
import { secondsToTicks } from "./tick";

export type MonsterKind = "shambler";

export interface MonsterSpec {
  kind: MonsterKind;
  /** Shown to players. */
  name: string;
  health: number;
  /** Walking speed, units per second (a player runs at 320). */
  speed: number;
  /** How far past the edge of its body a swipe reaches. */
  reach: number;
  damage: number;
  /** Ticks from starting a swipe to it landing (you can see it coming, and step back). */
  windupTicks: number;
  /** Ticks between swipes. */
  cooldownTicks: number;
  /** A swipe's shove, units per second. */
  knockback: number;
}

export const MONSTERS: Record<MonsterKind, MonsterSpec> = {
  shambler: {
    kind: "shambler",
    name: "Shambler",
    health: 60,
    speed: 110,
    reach: 30,
    damage: 15,
    windupTicks: secondsToTicks(0.45),
    cooldownTicks: secondsToTicks(1.1),
    knockback: 180,
  },
};

/** Monster ids start here, so they never clash with player ids (events name either). */
export const MONSTER_ID_BASE = 100000;
export const isMonsterId = (id: number) => id >= MONSTER_ID_BASE;
/** A dead monster lies there this long before it's gone. */
export const CORPSE_TICKS = secondsToTicks(3);

export interface MonsterState extends MoveState {
  id: number;
  kind: MonsterKind;
  prevOrigin: MoveState["origin"];
  yaw: number;
  pitch: number;
  health: number;
  alive: boolean;
  /** Ticks until it can swipe again. */
  attackCooldown: number;
  /** A swipe on its way: ticks until it lands (0: none). */
  windup: number;
  /** When it died (for the corpse to go). */
  diedTick: number;
  /** Always an enemy to every player; never under spawn protection. Here so code about "someone to fight" reads it like a player's. */
  team: -1;
  protectedUntil: 0;
}

/** What a monster wants to do this tick. */
export interface MonsterCommand {
  /** Walk forward along `yaw`, 0..1 of its own speed. */
  forward: number;
  yaw: number;
  jump: boolean;
  /** Start a swipe (if it can). */
  attack: boolean;
}
