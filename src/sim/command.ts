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
