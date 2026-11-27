/**
 * What travels between the game server and browsers, as JSON over a WebSocket.
 *
 * The server runs the one true simulation. Each browser sends its controls (a
 * PlayerCommand) every tick; the server steps the world and sends everyone a
 * snapshot of it every tick. Plain data both ways, shared by server and client.
 */
import type { PlayerCommand } from "../sim/command";
import type { PlayerId, SimEvent } from "../sim/events";
import type { MatchState } from "../sim/match";
import type { Portal } from "../sim/portals";
import type { WeaponId } from "../sim/weapons";

/** The game server's port; browsers on the same network join ws://<host>:GAME_PORT. */
export const GAME_PORT = 5175;

export type V3 = [number, number, number];

export interface PlayerSnap {
  id: PlayerId;
  team: number;
  origin: V3;
  prev: V3;
  velocity: V3;
  yaw: number;
  pitch: number;
  onGround: boolean;
  alive: boolean;
  health: number;
  armor: number;
  /** Weapon in hand (index), weapons held (bitmask), ammo per weapon, trigger held. */
  weapon: number;
  weapons: number;
  ammo: number[];
  firing: boolean;
  frags: number;
  deaths: number;
  respawnTick: number;
  fireCooldown: number;
  portalCooldown: number;
  portalHeld: boolean;
  protectedUntil: number;
}

export interface ProjectileSnap {
  id: number;
  owner: PlayerId;
  origin: V3;
  prev: V3;
  velocity: V3;
  hops: number;
  weapon: WeaponId;
  /** Grenades: the tick it goes off. */
  fuse?: number;
}

/** Everything a client needs to draw one tick of the world. */
export interface WorldSnapshot {
  tick: number;
  /** The match: rules, playing or over, the winner. */
  match: MatchState;
  players: PlayerSnap[];
  projectiles: ProjectileSnap[];
  portals: Portal[];
  /** Each pickup's availableAtTick, in level order. */
  pickups: number[];
  /** What happened this tick (shots, hits, pickups...), for effects, sound and the HUD. */
  events: SimEvent[];
}

export type ClientMessage =
  /** First message after connecting. */
  | { t: "hello"; name?: string }
  /** This tick's controls. `seq` counts up by one per tick. */
  | { t: "cmd"; seq: number; cmd: PlayerCommand };

export type ServerMessage =
  /** Reply to hello: who you are and which map to load. */
  | { t: "welcome"; id: PlayerId; map: string; names: [PlayerId, string][] }
  /** Someone joined or left: everyone's names. */
  | { t: "roster"; names: [PlayerId, string][] }
  /**
   * One tick of the world. `acks`: for each player, the `seq` of the last command the
   * server used, so that player's browser knows which of its commands are still in flight.
   */
  | { t: "snap"; snap: WorldSnapshot; acks: [PlayerId, number][] }
  /** Can't join (server full, say). */
  | { t: "refused"; reason: string };
