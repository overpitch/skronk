/**
 * Bot personalities: a name and a way of playing. Difficulty (BotSkill) decides
 * how good a bot is; personality decides how it plays: favourite weapons, how
 * close it likes to fight, when it backs off, how far it chases, how keen it is
 * on portals, and whether it holds a spot or roams.
 *
 * Handed out in roster order, so one bot is always Pip, the all-rounder.
 */
import type { WeaponId } from "../sim/weapons";

export interface Personality {
  name: string;
  /** In a few words, for the docs. */
  style: string;
  /** Added to how well each weapon suits a distance (weaponChoice.ts); also makes its pickup more wanted. */
  weaponBias: Partial<Record<WeaponId, number>>;
  /** Times the usual fighting distance: under 1 fights closer, over 1 keeps its distance. */
  rangeScale: number;
  /** Backs off to heal (or out through a portal) below this health. */
  retreatHealth: number;
  /** Times how long it keeps chasing someone it lost sight of. */
  chaseScale: number;
  /** Times how keen it is on placing portals of its own. */
  portalScale: number;
  /** With nothing to do, holds a spot by its favourite pickup instead of roaming. */
  camps: boolean;
}

export const PERSONALITIES: readonly Personality[] = [
  {
    name: "Pip",
    style: "all-rounder",
    weaponBias: {},
    rangeScale: 1,
    retreatHealth: 40,
    chaseScale: 1,
    portalScale: 1,
    camps: false,
  },
  {
    name: "Blitz",
    style: "loves rockets and grenades",
    weaponBias: { rocketlauncher: 0.4, grenadelauncher: 0.35, railgun: -0.15 },
    rangeScale: 1,
    retreatHealth: 35,
    chaseScale: 1.4,
    portalScale: 1,
    camps: false,
  },
  {
    name: "Vesper",
    style: "sniper: railgun, keeps its distance, holds a spot",
    weaponBias: { railgun: 0.4, machinegun: 0.1, shotgun: -0.3 },
    rangeScale: 1.7,
    retreatHealth: 50,
    chaseScale: 0.6,
    portalScale: 1,
    camps: true,
  },
  {
    name: "Rook",
    style: "rusher: shotgun and fists up close, chases hard",
    weaponBias: { shotgun: 0.35, fists: 0.25, rocketlauncher: -0.1, railgun: -0.3 },
    rangeScale: 0.55,
    retreatHealth: 20,
    chaseScale: 2,
    portalScale: 0.5,
    camps: false,
  },
  {
    name: "Juno",
    style: "portal trickster",
    weaponBias: {},
    rangeScale: 1,
    retreatHealth: 40,
    chaseScale: 1.2,
    portalScale: 3,
    camps: false,
  },
  {
    name: "Marlo",
    style: "careful: holds a spot by the armor, backs off early",
    weaponBias: { machinegun: 0.15, railgun: 0.1 },
    rangeScale: 1.2,
    retreatHealth: 60,
    chaseScale: 0.5,
    portalScale: 0.7,
    camps: true,
  },
];

/** The personality for the i-th bot (0-based), round the roster. */
export const personalityFor = (i: number): Personality => PERSONALITIES[i % PERSONALITIES.length];
