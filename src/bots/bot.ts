/**
 * A bot that fights (milestone 4, step 2). Each tick it:
 *
 * - Perceives: enemies in its field of view with a clear line of sight. Being
 *   shot makes it aware of the shooter wherever they are.
 * - Decides: fight a visible enemy; otherwise chase to where it last saw one;
 *   otherwise roam the map.
 * - Aims like a person, not a turret: it reacts after a delay, turns at a
 *   limited rate, leads moving targets only partly, and its aim wanders. It
 *   fires only when its aim is on (what it believes is) the target.
 * - Moves: strafes side to side while fighting, keeping a sensible distance and
 *   never stepping off a drop; uses the walk graph to chase and roam.
 *
 * One skill number (0..1) sets how quick and accurate it is. Like every
 * participant it only produces PlayerCommands; it reads the world, never writes it.
 */
import { vec3, type Vec3 } from "../math/vec3";
import { emptyCommand, type PlayerCommand } from "../sim/command";
import { EYE_HEIGHT, MOVE, PLAYER_MAXS, PLAYER_MINS } from "../sim/movement";
import { TICK_DT, TICK_RATE } from "../sim/tick";
import { WEAPON } from "../sim/weapon";
import type { PlayerId, PlayerState, World } from "../sim/world";
import type { NavGraph } from "./nav";
import { Navigator, type Steer } from "./navigator";
import { hash, signedHash } from "./random";

export interface BotSkill {
  /** Ticks from first seeing an enemy to the first shot. */
  reactionTicks: number;
  /** Fastest turn, radians per second. */
  turnRate: number;
  /** Typical aim wander, radians. */
  aimError: number;
  /** How much of a moving target's travel it allows for (0 none, 1 perfect). */
  lead: number;
  /** Half the field of view it notices enemies in, radians. */
  fovHalf: number;
}

export const DEFAULT_BOT_SKILL = 0.5;

const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** 0 is a beginner, 1 is sharp. */
export function botSkill(level: number): BotSkill {
  const s = Math.max(0, Math.min(1, level));
  return {
    reactionTicks: Math.round(mix(0.6, 0.15, s) * TICK_RATE),
    turnRate: mix(3.5, 12, s),
    aimError: mix(0.1, 0.015, s),
    lead: mix(0.2, 0.9, s),
    fovHalf: (mix(55, 80, s) * Math.PI) / 180,
  };
}

/** How long it keeps chasing an enemy it can no longer see. */
const MEMORY_TICKS = 5 * TICK_RATE;
/** Fighting distance: closes in beyond FAR, backs off inside NEAR. */
const NEAR = 180;
const FAR = 650;
/**
 * Before strafing a way, check for ground under a spot ahead: further ahead the faster
 * it's going (it takes a while to stop). A drop deeper than SAFE_DROP is off limits.
 */
const PROBE = 32;
const PROBE_PER_SPEED = 0.3;
const SAFE_DROP = 48;
/** Ground has to be under the middle of the body, not just under a corner of the box. */
const FOOT_MINS = vec3(-4, -4, PLAYER_MINS.z);
const FOOT_MAXS = vec3(4, 4, PLAYER_MAXS.z);
/** Aim point above the origin: the middle of the body. */
const CHEST = (PLAYER_MINS.z + PLAYER_MAXS.z) / 2;
const TAU = Math.PI * 2;

const wrap = (a: number) => a - TAU * Math.floor((a + Math.PI) / TAU);

export class Bot {
  private nav: Navigator;
  private skill: BotSkill;
  private yaw = 0;
  private pitch = 0;
  private started = false;
  private target: PlayerId | null = null;
  private targetVisible = false;
  /** Height above the target's origin it can see (chest, or just the head over a low wall). */
  private aimHeight = CHEST;
  private spottedTick = 0;
  private seenTick = -Infinity;
  private lastSeen: Vec3 | null = null;
  private errYaw = 0;
  private errPitch = 0;
  private strafe = 1;
  private strafeUntil = 0;
  private blocked = 0;

  constructor(
    readonly id: PlayerId,
    nav: NavGraph,
    skill = DEFAULT_BOT_SKILL,
  ) {
    this.nav = new Navigator(id, nav);
    this.skill = botSkill(skill);
  }

  /** The route it's following, for the debug view. */
  get currentRoute(): readonly number[] {
    return this.nav.currentRoute;
  }

  command(world: World): PlayerCommand {
    const me = world.players.get(this.id);
    const cmd = emptyCommand();
    if (!me || !me.alive) {
      this.nav.reset();
      this.target = null;
      this.lastSeen = null;
      this.targetVisible = false;
      this.started = false;
      return cmd;
    }
    if (!this.started) {
      this.started = true;
      this.yaw = me.yaw;
      this.pitch = 0;
    }

    this.perceive(world, me);
    const eye = vec3(me.origin.x, me.origin.y, me.origin.z + EYE_HEIGHT);
    const target = this.target === null ? null : (world.players.get(this.target) ?? null);
    let lookYaw = this.yaw;
    let lookPitch = 0;
    let steer: Steer;

    if (target && this.targetVisible && me.ammo > 0) {
      // Fight: aim where it will be (partly), plus wander.
      const dx = target.origin.x - eye.x;
      const dy = target.origin.y - eye.y;
      const flight = Math.hypot(dx, dy, target.origin.z + this.aimHeight - eye.z) / WEAPON.projectileSpeed;
      const lead = flight * this.skill.lead;
      const ax = target.origin.x + target.velocity.x * lead - eye.x;
      const ay = target.origin.y + target.velocity.y * lead - eye.y;
      const az = target.origin.z + this.aimHeight + target.velocity.z * lead * 0.5 - eye.z;
      this.wander(world);
      lookYaw = Math.atan2(ay, ax) + this.errYaw;
      lookPitch = Math.atan2(az, Math.hypot(ax, ay)) + this.errPitch;
      // Start turning after half the reaction time, shoot after all of it.
      const since = world.tick - this.spottedTick;
      if (since < this.skill.reactionTicks / 2) {
        lookYaw = this.yaw;
        lookPitch = this.pitch;
      }
      steer = this.fightMove(world, me, target);
      this.turn(lookYaw, lookPitch);
      const dist = Math.hypot(ax, ay, az);
      const onTarget = Math.atan2(PLAYER_MAXS.x, dist);
      cmd.fire =
        since >= this.skill.reactionTicks &&
        Math.abs(wrap(lookYaw - this.yaw)) < onTarget &&
        Math.abs(lookPitch - this.pitch) < onTarget * 1.5;
    } else {
      if (target && this.lastSeen && world.tick - this.seenTick < MEMORY_TICKS) {
        // Chase: run to where it was last seen, looking that way.
        this.nav.goTo(this.lastSeen);
        if (this.nav.arrived || this.nav.unreachable) this.forget();
        lookYaw = Math.atan2(this.lastSeen.y - me.origin.y, this.lastSeen.x - me.origin.x);
      } else {
        this.forget();
        this.nav.goTo(null);
      }
      steer = this.nav.steer(world, me);
      // Roaming (or chasing round corners): look where you're going.
      if (steer.dir && !this.lastSeen) lookYaw = Math.atan2(steer.dir.y, steer.dir.x);
      this.turn(lookYaw, lookPitch);
    }

    cmd.yaw = this.yaw;
    cmd.pitch = this.pitch;
    if (steer.dir) {
      // World direction to forward/right relative to where it's looking.
      const c = Math.cos(this.yaw);
      const s = Math.sin(this.yaw);
      cmd.forward = steer.dir.x * c + steer.dir.y * s;
      cmd.right = steer.dir.x * s - steer.dir.y * c;
    }
    cmd.jump = steer.jump;
    return cmd;
  }

  private forget() {
    this.target = null;
    this.lastSeen = null;
    this.targetVisible = false;
  }

  /** Who it can see, and who just shot it. */
  private perceive(world: World, me: PlayerState) {
    // Shot from anywhere: it knows roughly where from, and turns to look.
    for (const e of world.events) {
      if (e.type !== "hit" || e.victim !== me.id || e.attacker === me.id) continue;
      const attacker = world.players.get(e.attacker);
      if (!attacker || !attacker.alive) continue;
      if (this.target === null || !this.targetVisible) {
        this.target = attacker.id;
        this.lastSeen = { ...attacker.origin };
        this.seenTick = world.tick;
      }
    }

    let best: PlayerState | null = null;
    let bestDist = Infinity;
    let bestHeight = CHEST;
    let currentHeight: number | null = null;
    for (const p of world.players.values()) {
      if (p === me || !p.alive || (me.team !== 0 && p.team === me.team)) continue;
      const h = this.canSee(world, me, p);
      if (h === null) continue;
      if (p.id === this.target) currentHeight = h;
      const d = Math.hypot(p.origin.x - me.origin.x, p.origin.y - me.origin.y, p.origin.z - me.origin.z);
      if (d < bestDist) {
        bestDist = d;
        best = p;
        bestHeight = h;
      }
    }
    const pick = currentHeight !== null ? world.players.get(this.target!)! : best;
    if (pick) {
      this.aimHeight = currentHeight ?? bestHeight;
      if (pick.id !== this.target || !this.targetVisible) this.spottedTick = world.tick;
      this.target = pick.id;
      this.targetVisible = true;
      this.lastSeen = { ...pick.origin };
      this.seenTick = world.tick;
    } else {
      this.targetVisible = false;
      const t = this.target === null ? null : world.players.get(this.target);
      if (t && !t.alive) this.forget();
    }
  }

  /**
   * In its field of view with nothing solid in between: the height above p's origin
   * it can see (chest first, else head), or null.
   */
  private canSee(world: World, me: PlayerState, p: PlayerState): number | null {
    const eye = vec3(me.origin.x, me.origin.y, me.origin.z + EYE_HEIGHT);
    const dx = p.origin.x - eye.x;
    const dy = p.origin.y - eye.y;
    const dz = p.origin.z + CHEST - eye.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    const cp = Math.cos(this.pitch);
    const facing = (dx * Math.cos(this.yaw) * cp + dy * Math.sin(this.yaw) * cp + dz * Math.sin(this.pitch)) / len;
    if (facing < Math.cos(this.skill.fovHalf)) return null;
    const zero = vec3();
    for (const h of [CHEST, EYE_HEIGHT]) {
      const to = vec3(p.origin.x, p.origin.y, p.origin.z + h);
      if (world.collision.traceBox(eye, to, zero, zero).fraction === 1) return h;
    }
    return null;
  }

  /** Aim wander: drifts to a new random offset every third of a second or so. */
  private wander(world: World) {
    const slot = Math.floor((world.tick + this.id * 7) / 20);
    const goalYaw = signedHash(this.id * 1009 + slot * 2) * this.skill.aimError;
    const goalPitch = signedHash(this.id * 1009 + slot * 2 + 1) * this.skill.aimError * 0.6;
    this.errYaw += (goalYaw - this.errYaw) * 0.1;
    this.errPitch += (goalPitch - this.errPitch) * 0.1;
  }

  /** Turn towards a view direction, no faster than the skill allows. */
  private turn(yaw: number, pitch: number) {
    const max = this.skill.turnRate * TICK_DT;
    const dy = wrap(yaw - this.yaw);
    this.yaw = wrap(this.yaw + Math.max(-max, Math.min(max, dy * 0.5)));
    const dp = pitch - this.pitch;
    this.pitch += Math.max(-max, Math.min(max, dp * 0.5));
  }

  /** Strafe side to side, closing in or backing off, never off a drop. */
  private fightMove(world: World, me: PlayerState, target: PlayerState): Steer {
    const dx = target.origin.x - me.origin.x;
    const dy = target.origin.y - me.origin.y;
    const dist = Math.hypot(dx, dy) || 1;
    const ux = dx / dist;
    const uy = dy / dist;
    if (world.tick >= this.strafeUntil) {
      this.strafe = hash(this.id * 31 + world.tick) < 0.5 ? -1 : 1;
      this.strafeUntil = world.tick + 25 + Math.floor(hash(this.id * 37 + world.tick) * 50);
    }
    const range = dist > FAR ? 0.8 : dist < NEAR ? -0.8 : 0;
    const speed = Math.hypot(me.velocity.x, me.velocity.y);
    this.blocked = me.onGround && speed < MOVE.maxSpeed * 0.2 ? this.blocked + 1 : 0;
    if (this.blocked > 6) {
      this.strafe = -this.strafe;
      this.blocked = 0;
    }
    for (const side of [this.strafe, -this.strafe]) {
      const x = -uy * side + ux * range;
      const y = ux * side + uy * range;
      const len = Math.hypot(x, y);
      const dir = { x: x / len, y: y / len };
      if (this.safe(world, me, dir)) {
        this.strafe = side;
        return { dir, jump: false };
      }
    }
    // Both sides drop away: only close in or back off, if that's safe.
    if (range !== 0) {
      const dir = { x: ux * Math.sign(range), y: uy * Math.sign(range) };
      if (this.safe(world, me, dir)) return { dir, jump: false };
    }
    return { dir: null, jump: false };
  }

  /** Ground within SAFE_DROP below a spot ahead in this direction. */
  private safe(world: World, me: PlayerState, dir: { x: number; y: number }): boolean {
    if (!me.onGround) return true;
    const reach = PROBE + Math.hypot(me.velocity.x, me.velocity.y) * PROBE_PER_SPEED;
    const ahead = vec3(me.origin.x + dir.x * reach, me.origin.y + dir.y * reach, me.origin.z);
    const tr = world.collision.traceBox(ahead, vec3(ahead.x, ahead.y, ahead.z - SAFE_DROP), FOOT_MINS, FOOT_MAXS);
    return tr.startSolid || tr.fraction < 1; // a wall ahead is fine (it just stops you); thin air isn't
  }
}
