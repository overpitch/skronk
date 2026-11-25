/**
 * Portal colours: the colour family says whose pair it is, the shade says which end.
 * Team colours replace the families when team modes arrive.
 */
import type { PortalSlot } from "../sim/portals";

/** Your two ends: teal, then gold. */
const MINE: readonly [number, number] = [0x2fe0c8, 0xffcc33];
/** Everyone else's: violet, then rose. */
const OTHERS: readonly [number, number] = [0xa060ff, 0xff5c9a];
export const FIZZLE_COLOR = 0x8a8a8a;

export const portalColor = (mine: boolean, slot: PortalSlot): number => (mine ? MINE : OTHERS)[slot];

export const portalColorCss = (mine: boolean, slot: PortalSlot) => `#${portalColor(mine, slot).toString(16).padStart(6, "0")}`;
