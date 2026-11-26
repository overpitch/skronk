/**
 * One tick of intent from a participant. Keyboard, gamepad, bot AI and the
 * network all produce these; the simulation only ever consumes them.
 * Plain data, so it can be serialized and sent over the wire unchanged.
 */
export interface PlayerCommand {
  /** -1..1, forward is positive. */
  forward: number;
  /** -1..1, right is positive. */
  right: number;
  /** Radians, absolute (the client owns its view angles). */
  yaw: number;
  /** Radians, positive looks up. */
  pitch: number;
  jump: boolean;
  /** Held: run faster, only while moving forward. */
  sprint: boolean;
  /** Primary trigger: shoot. */
  fire: boolean;
  /** Secondary trigger: fire a portal (one per press). */
  portal: boolean;
}

export const emptyCommand = (): PlayerCommand => ({
  forward: 0,
  right: 0,
  yaw: 0,
  pitch: 0,
  jump: false,
  sprint: false,
  fire: false,
  portal: false,
});

const PITCH_MAX = (89 * Math.PI) / 180;

/**
 * A command from outside (the network) made safe: anything missing or not a
 * finite number becomes 0 or false, movement is kept to -1..1 and pitch to the
 * look limits. One bad value (NaN, say) would otherwise spread through the world.
 */
export function sanitizeCommand(raw: unknown): PlayerCommand {
  const c = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : 0);
  const yaw = num(c.yaw, -1e6, 1e6);
  return {
    forward: num(c.forward, -1, 1),
    right: num(c.right, -1, 1),
    yaw: yaw % (Math.PI * 2),
    pitch: num(c.pitch, -PITCH_MAX, PITCH_MAX),
    jump: c.jump === true,
    sprint: c.sprint === true,
    fire: c.fire === true,
    portal: c.portal === true,
  };
}
