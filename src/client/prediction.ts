/**
 * Client-side prediction for a network game: your own player moves the moment
 * you press a key, instead of a round trip later.
 *
 * Every command sent is kept until the server says it has used it. Each tick the
 * predicted player is moved by the newest command with the same movement code the
 * server runs (portals included). When a snapshot arrives, prediction restarts from
 * the server's word on where you were after the last command it used, and the
 * commands still in flight are replayed on top. If that lands somewhere a little
 * different from what was shown, the difference fades out over a few frames
 * instead of snapping.
 *
 * Firing is predicted only as far as feedback goes (when your gun would go off);
 * the shot itself still comes from the server.
 */
import { clone, copy, set, vec3 } from "../math/vec3";
import type { PlayerCommand } from "../sim/command";
import { WEAPON } from "../sim/weapon";
import type { PlayerState, World } from "../sim/world";

/** Commands kept at most (2 s): more than that in flight and something's badly wrong. */
const MAX_PENDING = 120;
/** A correction bigger than this (a respawn, a knock off a ledge) snaps instead of fading. */
const SNAP_DISTANCE = 64;
/** How fast a correction fades, per second. */
const SMOOTH_RATE = 12;

export interface PredictedTick {
  /** The newest command took the player through a portal. */
  teleported: boolean;
  /** The newest command fired the gun. */
  fired: boolean;
}

function copyPlayer(p: PlayerState): PlayerState {
  return {
    ...p,
    origin: clone(p.origin),
    prevOrigin: clone(p.prevOrigin),
    velocity: clone(p.velocity),
    groundNormal: clone(p.groundNormal),
  };
}

export class Predictor {
  /** Visual correction still to fade out: add to where the camera is drawn. */
  readonly offset = vec3();
  private pending: { seq: number; cmd: PlayerCommand }[] = [];
  private state: PlayerState | null = null;

  /** The predicted player, or null while dead (nothing to predict). */
  get player(): PlayerState | null {
    return this.state;
  }

  /** Remember a command just sent to the server. */
  sent(seq: number, cmd: PlayerCommand) {
    this.pending.push({ seq, cmd });
    if (this.pending.length > MAX_PENDING) this.pending.shift();
  }

  /**
   * Advance one tick. `server` is your player as the server last reported it, and
   * `ack` the seq of the last command it had used then, or null if no snapshot
   * arrived this tick.
   */
  tick(world: World, server: PlayerState, ack: number | null): PredictedTick {
    if (ack !== null) this.pending = this.pending.filter((p) => p.seq > ack);
    // Dead, nothing in flight, or the match is over (everyone frozen): show the server's word as it is.
    if (!server.alive || this.pending.length === 0 || world.match.phase !== "playing") {
      this.state = null;
      set(this.offset, 0, 0, 0);
      return { teleported: false, fired: false };
    }

    const newest = this.pending[this.pending.length - 1];
    if (ack !== null || !this.state) {
      // Start again from the server's word, replay what it hasn't seen yet (all but the newest).
      const shown = this.state ? clone(this.state.origin) : null;
      const s = copyPlayer(server);
      for (let i = 0; i < this.pending.length - 1; i++) this.step(world, s, this.pending[i].cmd);
      if (shown) {
        const dx = shown.x - s.origin.x;
        const dy = shown.y - s.origin.y;
        const dz = shown.z - s.origin.z;
        // Keep showing where we were, and slide to the corrected spot.
        if (Math.hypot(dx, dy, dz) < SNAP_DISTANCE) set(this.offset, this.offset.x + dx, this.offset.y + dy, this.offset.z + dz);
        else set(this.offset, 0, 0, 0);
      }
      this.state = s;
    }
    return this.step(world, this.state, newest.cmd);
  }

  /** Fades the correction; call once per rendered frame. */
  smooth(dt: number) {
    const k = Math.exp(-SMOOTH_RATE * dt);
    set(this.offset, this.offset.x * k, this.offset.y * k, this.offset.z * k);
  }

  /** Copies the predicted movement onto the world's copy of your player, for drawing. */
  writeTo(me: PlayerState) {
    const s = this.state;
    if (!s) return;
    copy(me.origin, s.origin);
    copy(me.prevOrigin, s.prevOrigin);
    copy(me.velocity, s.velocity);
    copy(me.groundNormal, s.groundNormal);
    me.onGround = s.onGround;
    me.yaw = s.yaw;
    me.pitch = s.pitch;
  }

  /** One tick: move like the server does, and keep the gun's timing like the server does. */
  private step(world: World, s: PlayerState, cmd: PlayerCommand): PredictedTick {
    copy(s.prevOrigin, s.origin);
    const teleported = world.movePlayer(s, cmd);
    if (s.fireCooldown > 0) s.fireCooldown--;
    let fired = false;
    if (cmd.fire && s.fireCooldown <= 0) {
      if (s.ammo > 0) {
        s.ammo--;
        s.fireCooldown = WEAPON.fireIntervalTicks;
        fired = true;
      } else {
        s.fireCooldown = WEAPON.fireIntervalTicks * 2;
      }
    }
    return { teleported, fired };
  }
}
