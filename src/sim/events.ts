/**
 * Things that happened during one tick, for presentation (sound, effects, HUD).
 * The sim never reads these back; dropping them changes nothing about the game.
 */
import type { Vec3 } from "../math/vec3";

export type PlayerId = number;

export type SimEvent =
  | { type: "fire"; player: PlayerId; projectile: number; origin: Vec3; dir: Vec3 }
  | { type: "dryFire"; player: PlayerId }
  /** A shot went into portal `from` at `pos` and came out of `to` at `exit`. */
  | { type: "shotThroughPortal"; projectile: number; from: number; to: number; pos: Vec3; exit: Vec3 }
  /** A projectile hit level geometry. */
  | { type: "impact"; projectile: number; owner: PlayerId; pos: Vec3; normal: Vec3 }
  /** A projectile hit a player. `damage` is before armor. */
  | { type: "hit"; projectile: number; attacker: PlayerId; victim: PlayerId; damage: number; pos: Vec3 }
  /** A shot hit a player under spawn protection: no damage. */
  | { type: "shielded"; projectile: number; attacker: PlayerId; victim: PlayerId; pos: Vec3 }
  /** Someone won (frag limit, or the lead when time ran out). Everything holds still until a rematch. */
  | { type: "matchOver"; winner: PlayerId }
  /** Time ran out with the lead tied: the next frag that breaks the tie wins. */
  | { type: "suddenDeath" }
  /** A new match began: scores reset, everyone respawned. */
  | { type: "matchStart" }
  /** attacker is null for deaths with no killer, like falling out of the world. */
  | { type: "kill"; attacker: PlayerId | null; victim: PlayerId }
  | { type: "respawn"; player: PlayerId }
  | { type: "pickup"; player: PlayerId; kind: string; index: number }
  /** A player went in through portal `from` and came out of `to`; their view was turned to match. */
  | { type: "teleport"; player: PlayerId; from: number; to: number }
  /**
   * A portal shot. `portal` is the id of the portal it placed, or null if it
   * fizzled (normal is zero if it hit nothing in range). `replaced` is the id
   * of the owner's portal it took the place of, if any.
   */
  | { type: "portalShot"; player: PlayerId; owner: string; slot: 0 | 1; origin: Vec3; end: Vec3; normal: Vec3; portal: number | null; replaced: number | null };
