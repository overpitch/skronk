/**
 * Match rules: play to a frag limit, a time limit, or both. The first to the
 * frag limit wins; when time runs out the leader wins, and a tie for the lead
 * plays on (sudden death) until someone is ahead. Zero means no limit.
 */
import type { PlayerId } from "./events";
import { secondsToTicks } from "./tick";

export interface MatchRules {
  /** Frags to win; 0 for none. */
  fragLimit: number;
  /** Length of a match in ticks; 0 for none. */
  timeLimitTicks: number;
}

export const FREE_PLAY: MatchRules = { fragLimit: 0, timeLimitTicks: 0 };

export interface MatchState {
  rules: MatchRules;
  /** Playing, or over (everyone frozen, the end screen showing) until a rematch. */
  phase: "playing" | "over";
  /** Tick the match began on. */
  startTick: number;
  /** Tick it ended on (over only). */
  endTick: number;
  /** Who won; null while playing. */
  winner: PlayerId | null;
  /** Time ran out with the lead tied: the next frag that breaks the tie wins. */
  suddenDeath: boolean;
}

/** After a respawn, shots can't hurt you for this long (or until you fire). */
export const SPAWN_PROTECTION_TICKS = secondsToTicks(2);
/** After a respawn the gun takes this long to come up. */
export const SPAWN_RAISE_TICKS = secondsToTicks(0.3);

export function newMatch(rules: MatchRules, tick: number): MatchState {
  return { rules: { ...rules }, phase: "playing", startTick: tick, endTick: 0, winner: null, suddenDeath: false };
}

/** Ticks left on the clock (0 if there's no time limit or it has run out). */
export function ticksLeft(match: MatchState, tick: number): number {
  if (match.rules.timeLimitTicks <= 0) return 0;
  const end = match.startTick + match.rules.timeLimitTicks;
  return Math.max(0, end - (match.phase === "over" ? match.endTick : tick));
}

/**
 * Who has won, given everyone's frags at this tick, or null to play on.
 * `frags` is in a fixed order (by player id), so ties resolve the same way everywhere.
 */
export function decideWinner(match: MatchState, tick: number, frags: readonly { id: PlayerId; frags: number }[]): { winner: PlayerId | null; suddenDeath: boolean } {
  const { fragLimit, timeLimitTicks } = match.rules;
  if (frags.length === 0) return { winner: null, suddenDeath: false };
  const sorted = [...frags].sort((a, b) => b.frags - a.frags || a.id - b.id);
  const lead = sorted[0];
  const tied = sorted.length > 1 && sorted[1].frags === lead.frags;
  if (fragLimit > 0 && lead.frags >= fragLimit && !tied) return { winner: lead.id, suddenDeath: false };
  const timeUp = timeLimitTicks > 0 && tick >= match.startTick + timeLimitTicks;
  if (!timeUp) return { winner: null, suddenDeath: false };
  return tied ? { winner: null, suddenDeath: true } : { winner: lead.id, suddenDeath: false };
}

/** On the end screen, a press asks for a rematch only after this long (so a shot in flight doesn't skip it). */
export const REMATCH_READY_TICKS = secondsToTicks(3);
/** A game server starts the next match by itself after this long on the end screen. */
export const AUTO_REMATCH_TICKS = secondsToTicks(15);

export type MatchPresetId = "first10" | "standard" | "long" | "timed" | "free";

/** The menu's match choices, in order. */
export const MATCH_PRESETS: readonly { id: MatchPresetId; label: string; rules: MatchRules }[] = [
  { id: "first10", label: "First to 10", rules: { fragLimit: 10, timeLimitTicks: 0 } },
  { id: "standard", label: "First to 20 or 10 min", rules: { fragLimit: 20, timeLimitTicks: secondsToTicks(600) } },
  { id: "long", label: "First to 30 or 15 min", rules: { fragLimit: 30, timeLimitTicks: secondsToTicks(900) } },
  { id: "timed", label: "10 min, most frags", rules: { fragLimit: 0, timeLimitTicks: secondsToTicks(600) } },
  { id: "free", label: "No limit", rules: FREE_PLAY },
];

export const matchPreset = (id: string) => MATCH_PRESETS.find((m) => m.id === id) ?? MATCH_PRESETS[1];

/** Rules in words, for the menu and the server's log. */
export function describeRules(rules: MatchRules): string {
  const minutes = Math.round(rules.timeLimitTicks / secondsToTicks(60));
  if (rules.fragLimit > 0 && minutes > 0) return `first to ${rules.fragLimit} or ${minutes} min`;
  if (rules.fragLimit > 0) return `first to ${rules.fragLimit}`;
  if (minutes > 0) return `${minutes} min, most frags`;
  return "no limit";
}
