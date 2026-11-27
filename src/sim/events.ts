/**
 * Things that happened during one tick, for presentation (sound, effects, HUD).
 * The sim never reads these back; dropping them changes nothing about the game.
 */
import type { Vec3 } from "../math/vec3";
import type { WeaponId } from "./weapons";

export type PlayerId = number;

export type SimEvent =
  /** A trigger pull that went off. `projectile` is the id of what it launched, or -1 (melee, hitscan). */
  | { type: "fire"; player: PlayerId; weapon: WeaponId; projectile: number; origin: Vec3; dir: Vec3 }
  | { type: "dryFire"; player: PlayerId }
  /** A different weapon came up in someone's hands. */
  | { type: "weaponSwitch"; player: PlayerId; weapon: WeaponId }
  /** An instant shot's path (railgun), from the eye, in pieces where it went through portals. */
  | { type: "trail"; player: PlayerId; weapon: WeaponId; segments: [Vec3, Vec3][] }
  /** A grenade bounced off a wall or floor. */
  | { type: "bounce"; projectile: number; pos: Vec3 }
  /** A rocket or grenade went off. */
  | { type: "explosion"; owner: PlayerId; weapon: WeaponId; pos: Vec3; radius: number }
  /** A shot went into portal `from` at `pos` and came out of `to` at `exit`. */
  | { type: "shotThroughPortal"; projectile: number; from: number; to: number; pos: Vec3; exit: Vec3 }
  /** A shot hit level geometry (`projectile` -1 for an instant shot or a punch). */
  | { type: "impact"; projectile: number; owner: PlayerId; weapon: WeaponId; pos: Vec3; normal: Vec3 }
  /**
   * A shot, blast or punch hurt a player. `damage` is before armor, `saved` what armor took of it.
   * A shotgun blast is one hit, all pellets together. `from`: unit direction back the way it came
   * (towards the shooter, the blast, or the portal the shot came out of).
   */
  | { type: "hit"; projectile: number; attacker: PlayerId; victim: PlayerId; weapon: WeaponId; damage: number; saved: number; pos: Vec3; from: Vec3 }
  /** A shot hit a player under spawn protection: no damage. */
  | { type: "shielded"; projectile: number; attacker: PlayerId; victim: PlayerId; pos: Vec3 }
  /** Someone won (frag limit, or the lead when time ran out). Everything holds still until a rematch. */
  | { type: "matchOver"; winner: PlayerId }
  /** Time ran out with the lead tied: the next frag that breaks the tie wins. */
  | { type: "suddenDeath" }
  /** A new match began: scores reset, everyone respawned. */
  | { type: "matchStart" }
  /** attacker is null for deaths with no killer, like falling out of the world. */
  | { type: "kill"; attacker: PlayerId | null; victim: PlayerId; weapon: WeaponId | null }
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
