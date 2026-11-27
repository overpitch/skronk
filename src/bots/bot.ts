/**
 * A bot that fights (milestone 4, step 2). Each tick it:
 *
 * - Perceives: enemies in its field of view with a clear line of sight. Being
 *   shot makes it aware of the shooter wherever they are.
 * - Decides: fight a visible enemy (retreating towards health while it shoots,
 *   if it's hurting) with the weapon that suits the distance; otherwise fetch a
 *   pickup it badly needs (out of ammo, low on health; weapons it lacks are
 *   worth a lot); otherwise chase to where it last saw an enemy; otherwise grab
 *   any pickup worth the trip; otherwise roam the map.
 * - Aims like a person, not a turret: it reacts after a delay, turns at a
 *   limited rate, leads moving targets only partly, and its aim wanders. It
 *   fires only when its aim is on (what it believes is) the target.
 * - Moves: strafes side to side while fighting, keeping a sensible distance and
 *   never stepping off a drop; uses the walk graph to chase and roam, and open
 *   portals as shortcuts.
 * - Places portals of its own (portalPlanner.ts, portalJob.ts) to reach a pickup
 *   it can't walk to, to cut a long trip short, or now and then just to visit
 *   somewhere only portals reach.
 * - Fights with portals: sees (and shoots) enemies through an open pair it's
 *   looking into, follows someone it saw go through one, and when hurt slips away
 *   through a pair that leads away from the enemy. (Normal and Hard: lower levels
 *   don't think of portals in a fight, though they still follow you through.)
 *
 * One skill number (0..1) sets how quick and accurate it is. Like every
 * participant it only produces PlayerCommands; it reads the world, never writes it.
 */
import { addScaled, sub, vec3, type Vec3 } from "../math/vec3";
import { segmentIntoPortal, throughPortalPoint, type Portal } from "../sim/portals";
import { emptyCommand, type PlayerCommand } from "../sim/command";
import { EYE_HEIGHT, MOVE, PLAYER_MAXS, PLAYER_MINS } from "../sim/movement";
import { TICK_DT, TICK_RATE } from "../sim/tick";
import { WEAPONS } from "../sim/weapons";
import type { PlayerId, PlayerState, World } from "../sim/world";
import type { NavGraph } from "./nav";
import { Navigator, type Steer } from "./navigator";
import { hash, signedHash } from "./random";
import { choosePickup, LOW_HEALTH, pickupWorth, pickupAppeal, runningDry } from "./wants";
import { portalLinks } from "./portalLinks";
import { PortalJob } from "./portalJob";
import { planPortals, preparePortalPlanner, type PortalSpot } from "./portalPlanner";
import { chooseWeapon, FIGHT_RANGE, hasGunAmmo } from "./weaponChoice";

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
  /** Share of the time it has the trigger down in a fight (the rest it's re-aiming); 1 never lets up. */
  fireShare: number;
  /** Ticks it holds a slow, heavy shot (shotgun, rockets, railgun) on target before taking it. */
  settleTicks: number;
  /** Aim wander with the railgun, times the usual: a long precise shot is harder. */
  railAimScale: number;
  /** Fires rockets at your feet (the splash is hard to dodge), not at your body. */
  feetRockets: boolean;
  /** How often it reconsiders its weapon, and how much better another must be to switch. */
  weaponRethinkTicks: number;
  switchMargin: number;
  /** Fighting: share of run speed it strafes at, and the chance it stands still for a while instead. */
  strafeSpeed: number;
  standChance: number;
  /** Ticks before it notices being shot from somewhere it isn't looking. */
  noticeHitTicks: number;
  /** Sees enemies through an open portal pair it's looking into, and shoots them through it. */
  portalSight: boolean;
  /** When hurt in a fight, slips away through an open pair that leads away from the enemy. */
  portalEscape: boolean;
}

export const DEFAULT_BOT_SKILL = 0.5;
/** How long one trigger cycle is (fire, then re-aim), ticks. */
const FIRE_CYCLE_TICKS = 60;
/** Weapons this slow to fire again (shotgun, rockets, railgun) make each shot count: bots line them up first. */
const SLOW_SHOT_TICKS = 30;

const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * 0 is a beginner, 1 is sharp. Measured against a target strafing at two thirds
 * of run speed: a Beginner deals about a third of a Hard bot's damage, Easy
 * about half, Normal about two thirds.
 */
export function botSkill(level: number): BotSkill {
  const s = Math.max(0, Math.min(1, level));
  // Most of the gain comes towards the top: the low levels are clearly gentler.
  const k = s ** 1.3;
  return {
    reactionTicks: Math.round(mix(0.9, 0.15, s) * TICK_RATE),
    turnRate: mix(3, 12, s),
    aimError: mix(0.17, 0.015, k),
    fireShare: mix(0.45, 1, k),
    settleTicks: Math.round(mix(32, 4, s)),
    railAimScale: mix(1.6, 1, s),
    feetRockets: s >= 0.7,
    weaponRethinkTicks: Math.round(mix(90, 15, s)),
    switchMargin: mix(0.45, 0.15, s),
    strafeSpeed: mix(0.35, 1, k),
    standChance: mix(0.5, 0.05, s),
    noticeHitTicks: Math.round(mix(50, 0, s)),
    portalSight: s >= 0.4,
    portalEscape: s >= 0.4,
    lead: mix(0.2, 0.9, s),
    fovHalf: (mix(55, 80, s) * Math.PI) / 180,
  };
}

/** How long it keeps chasing an enemy it can no longer see. */
const MEMORY_TICKS = 5 * TICK_RATE;
/** With only fists, it takes on someone this close and goes for ammo otherwise. */
const BRAWL_DISTANCE = 300;
/** Distance it readies a weapon for when there's no one to fight. */
const ROAM_DISTANCE = 500;
/** How often it thinks about placing portals of its own. */
const PORTAL_THINK_TICKS = 4 * TICK_RATE;
/** A trip longer than this on foot is worth checking for a portal shortcut. */
const LONG_TRIP_TICKS = 5 * TICK_RATE;
/** Chance, each time it thinks about portals while just roaming, that it goes somewhere only portals reach. */
const EXPLORE_CHANCE = 0.45;
/** Spots that let it down are avoided this long. */
const FAILED_SPOT_TICKS = 30 * TICK_RATE;
/** Farthest it notices someone through a portal. */
const PORTAL_SIGHT_RANGE = 2000;
/** An escape portal has to be this close, and lead at least this far from the enemy. */
const ESCAPE_REACH = 500;
const ESCAPE_DISTANCE = 700;
/** After slipping away through a portal, it doesn't try again for this long (no ping-pong). */
const ESCAPE_COOLDOWN_TICKS = 5 * TICK_RATE;
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
/** How often it reconsiders which pickup to go for. */
const RETHINK_TICKS = 30;

const wrap = (a: number) => a - TAU * Math.floor((a + Math.PI) / TAU);

export class Bot {
  private nav: Navigator;
  private graph: NavGraph;
  private skill: BotSkill;
  /** Pickup it's heading for (index into world.pickups), or -1. */
  private fetch = -1;
  private rethinkTick = 0;
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
  /** Weapon it wants in hand (index), reconsidered every WEAPON_RETHINK_TICKS. */
  private wantWeapon = -1;
  private weaponTick = 0;
  /** Ticks its aim has been on the target. */
  private linedUp = 0;
  /** Shot by someone it hasn't noticed yet: who, and when it will. */
  private shotBy: { id: PlayerId; at: number } | null = null;
  /** Fighting this tick (strafes at its skill's speed). */
  private dodging = false;
  /** The target is seen through this portal pair (into `from`, out of `to`), or null for directly. */
  private via: { from: Portal; to: Portal } | null = null;
  /** Last time it went through a portal to get away. */
  private escapedTick = -Infinity;
  /** Placing a pair of its own portals to get somewhere (null when not). */
  private job: PortalJob | null = null;
  private portalThinkTick = 0;
  /** Portal spots whose shots didn't land, and until when it avoids them. */
  private failedSpots = new Map<PortalSpot, number>();

  constructor(
    readonly id: PlayerId,
    nav: NavGraph,
    skill = DEFAULT_BOT_SKILL,
  ) {
    this.nav = new Navigator(id, nav);
    this.graph = nav;
    this.skill = botSkill(skill);
  }

  /** Change how sharp it is, mid-game (the menu's difficulty). */
  setSkill(level: number) {
    this.skill = botSkill(level);
  }

  /** Where it last saw (or knows) its target is, for the debug view and tests. */
  get lastSeenAt(): Readonly<Vec3> | null {
    return this.lastSeen;
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
      this.fetch = -1;
      this.rethinkTick = 0;
      this.wantWeapon = -1;
      this.weaponTick = 0;
      this.job = null;
      return cmd;
    }
    if (!this.started) {
      this.started = true;
      preparePortalPlanner(world, this.graph); // once per map: at the start, not mid-fight
      this.yaw = me.yaw;
      this.pitch = 0;
    }

    this.perceive(world, me);
    this.chooseFetch(world, me);
    this.thinkAboutPortals(world, me);
    const pickup = this.fetch >= 0 ? world.pickups[this.fetch] : null;
    const urgent = !!pickup && (runningDry(me) || me.health < LOW_HEALTH);
    const eye = vec3(me.origin.x, me.origin.y, me.origin.z + EYE_HEIGHT);
    const target = this.target === null ? null : (world.players.get(this.target) ?? null);
    let lookYaw = this.yaw;
    let lookPitch = 0;
    let steer: Steer;
    // Seen through a portal: where it appears to be, on this side of the opening (the same distance away as the way through).
    const via = this.targetVisible ? this.via : null;
    const apparent = (p: Vec3) => (via ? throughPortalPoint(p, via.to, via.from) : p);
    const seenAt = target ? apparent(target.origin) : null;
    const range = seenAt ? Math.hypot(seenAt.x - me.origin.x, seenAt.y - me.origin.y, seenAt.z - me.origin.z) : Infinity;
    const fighting = !!target && this.targetVisible && (hasGunAmmo(me) || range < BRAWL_DISTANCE);
    this.readyWeapon(world, me, fighting ? range : ROAM_DISTANCE);
    if (this.wantWeapon >= 0 && this.wantWeapon !== me.weapon) cmd.weapon = this.wantWeapon + 1;
    const spec = WEAPONS[me.weapon];
    this.dodging = false;

    if (target && fighting) {
      // Fight: aim where it will be (partly), plus wander. Rockets go at the feet of someone on the ground.
      // Through a portal: aim where they appear in the opening; the shot comes out of the other end at them.
      const feet = this.skill.feetRockets && !via && spec.splash !== null && target.onGround && range > 200;
      const aimHeight = feet ? PLAYER_MINS.z + 4 : this.aimHeight;
      const centre = apparent(vec3(target.origin.x, target.origin.y, target.origin.z + aimHeight));
      const flight = spec.shot === "projectile" ? Math.hypot(centre.x - eye.x, centre.y - eye.y, centre.z - eye.z) / spec.speed : 0;
      const lead = flight * this.skill.lead;
      const aimAt = apparent(
        vec3(
          target.origin.x + target.velocity.x * lead,
          target.origin.y + target.velocity.y * lead,
          target.origin.z + aimHeight + (feet ? 0 : target.velocity.z * lead * 0.5),
        ),
      );
      const ax = aimAt.x - eye.x;
      const ay = aimAt.y - eye.y;
      const az = aimAt.z - eye.z;
      this.wander(world);
      const err = spec.id === "railgun" ? this.skill.railAimScale : 1;
      lookYaw = Math.atan2(ay, ax) + this.errYaw * err;
      lookPitch = Math.atan2(az, Math.hypot(ax, ay)) + this.errPitch * err;
      // Start turning after half the reaction time, shoot after all of it.
      const since = world.tick - this.spottedTick;
      if (since < this.skill.reactionTicks / 2) {
        lookYaw = this.yaw;
        lookPitch = this.pitch;
      }
      const away = me.health < LOW_HEALTH ? this.escapeThroughPortal(world, me, target) : null;
      if (pickup && pickup.kind === "health" && me.health < LOW_HEALTH) {
        // Hurting: back off towards health, still shooting.
        this.nav.goTo(pickup.origin);
        steer = this.nav.steer(world, me);
      } else if (away) {
        // Hurting, no health to go for: out through a portal that leads away from them, still shooting.
        this.nav.goTo(away);
        steer = this.nav.steer(world, me);
      } else {
        steer = this.fightMove(world, me, seenAt!, FIGHT_RANGE[spec.id]);
        this.dodging = true;
      }
      this.turn(lookYaw, lookPitch);
      const dist = Math.hypot(ax, ay, az);
      const onTarget = Math.atan2(PLAYER_MAXS.x, dist);
      const lined = Math.abs(wrap(lookYaw - this.yaw)) < onTarget && Math.abs(lookPitch - this.pitch) < onTarget * 1.5;
      // Counted once the gun is ready again: steadying a heavy shot adds to the wait between shots.
      this.linedUp = lined && me.fireCooldown === 0 ? this.linedUp + 1 : 0;
      // Not every moment: lower skill lets go of the trigger to re-aim. A slow, heavy shot is held a moment first.
      const triggerOn = (world.tick + this.id * 17) % FIRE_CYCLE_TICKS < FIRE_CYCLE_TICKS * this.skill.fireShare;
      const settled = spec.fireTicks < SLOW_SHOT_TICKS || this.linedUp >= this.skill.settleTicks;
      cmd.fire = since >= this.skill.reactionTicks && lined && triggerOn && settled;
    } else if (this.job) {
      // Placing portals: walk to each spot, stop, aim, fire; then on through them.
      const t = this.job.tick(world, me, this.nav, this.graph, { yaw: this.yaw, pitch: this.pitch });
      steer = t.steer;
      if (t.look) {
        lookYaw = t.look.yaw;
        lookPitch = t.look.pitch;
      } else if (steer.dir) lookYaw = Math.atan2(steer.dir.y, steer.dir.x);
      cmd.portal = t.portal;
      this.turnPrecisely(lookYaw, lookPitch, !!t.look);
      if (!this.job.active) {
        if (this.job.failedSpot) this.failedSpots.set(this.job.failedSpot, world.tick + FAILED_SPOT_TICKS);
        this.job = null;
      }
    } else {
      const chasing = !!target && !!this.lastSeen && world.tick - this.seenTick < MEMORY_TICKS;
      let lookAhead = true;
      if (pickup && (urgent || !chasing)) {
        // Fetch: a pickup it badly needs beats a chase; otherwise only when there's no one to chase.
        this.nav.goTo(pickup.origin);
      } else if (chasing) {
        // Chase: run to where it was last seen, looking that way.
        this.nav.goTo(this.lastSeen);
        if (this.nav.arrived || this.nav.unreachable) this.forget();
        else {
          lookYaw = Math.atan2(this.lastSeen!.y - me.origin.y, this.lastSeen!.x - me.origin.x);
          lookAhead = false;
        }
      } else {
        this.forget();
        this.nav.goTo(null);
      }
      steer = this.nav.steer(world, me);
      // Roaming, fetching (or chasing round corners): look where you're going.
      if (steer.dir && lookAhead) lookYaw = Math.atan2(steer.dir.y, steer.dir.x);
      this.turn(lookYaw, lookPitch);
    }

    cmd.yaw = this.yaw;
    cmd.pitch = this.pitch;
    if (steer.dir) {
      // World direction to forward/right relative to where it's looking; slower dodging at lower skill.
      const c = Math.cos(this.yaw);
      const s = Math.sin(this.yaw);
      const pace = this.dodging ? this.skill.strafeSpeed : 1;
      cmd.forward = (steer.dir.x * c + steer.dir.y * s) * pace;
      cmd.right = (steer.dir.x * s - steer.dir.y * c) * pace;
    }
    cmd.jump = steer.jump;
    return cmd;
  }

  /** Picks the weapon for a fight at this distance (every so often, so it doesn't dither). */
  private readyWeapon(world: World, me: PlayerState, distance: number) {
    if (world.tick < this.weaponTick && this.wantWeapon >= 0) return;
    this.weaponTick = world.tick + this.skill.weaponRethinkTicks;
    this.wantWeapon = chooseWeapon(me, distance, this.skill.switchMargin);
  }

  /**
   * Every few seconds, out of a fight: is there a pickup worth having that only
   * portals reach, or a long trip a pair would cut short? Or (now and then, just
   * roaming) somewhere only portals get to? If so, a portal job.
   */
  private thinkAboutPortals(world: World, me: PlayerState) {
    if (this.job || (this.target && this.targetVisible) || world.tick < this.portalThinkTick) return;
    this.portalThinkTick = world.tick + PORTAL_THINK_TICKS + (this.id % 11) * 3;
    for (const [spot, until] of this.failedSpots) if (until < world.tick) this.failedSpots.delete(spot);
    const avoid = new Set(this.failedSpots.keys());
    const start = this.graph.nearest(me.origin);
    if (start < 0) return;
    const onFoot = this.graph.costsFrom(start, portalLinks(world, this.graph));

    // A pickup it's heading for, a long way round on foot: a shortcut?
    const current = this.fetch >= 0 ? world.pickups[this.fetch] : null;
    if (current) {
      const node = this.graph.nearest(current.origin, 3 * 32);
      if (node >= 0 && onFoot[node] > LONG_TRIP_TICKS) {
        const plan = planPortals(world, this.graph, me, current.origin, avoid);
        if (plan) return void (this.job = new PortalJob(plan, current.origin, world.tick));
      }
    }

    // The best pickup it can't walk to, if it beats what it's after.
    let best: { index: number; appeal: number; goal: Vec3 } | null = null;
    world.pickups.forEach((pk, index) => {
      if (!pk.known || pk.availableAtTick > world.tick) return;
      const worth = pickupWorth(me, pk);
      if (worth < 0.3) return;
      const node = this.graph.nearest(pk.origin, 3 * 32);
      if (node < 0 || Number.isFinite(onFoot[node])) return;
      if (!best || worth > best.appeal) best = { index, appeal: worth, goal: pk.origin };
    });
    const unreachable = best as { index: number; appeal: number; goal: Vec3 } | null;
    if (unreachable) {
      const plan = planPortals(world, this.graph, me, unreachable.goal, avoid);
      const now = current ? pickupAppeal(pickupWorth(me, current), onFoot[this.graph.nearest(current.origin, 3 * 32)] ?? Infinity) : 0;
      if (plan && pickupAppeal(unreachable.appeal, plan.ticks) > now) {
        this.fetch = unreachable.index;
        this.rethinkTick = world.tick + PORTAL_THINK_TICKS; // stick with it
        return void (this.job = new PortalJob(plan, unreachable.goal, world.tick));
      }
    }

    // Nothing it badly needs: now and then, go and see somewhere only portals reach.
    const needy = !!current && (runningDry(me) || me.health < LOW_HEALTH);
    if (needy || hash(this.id * 4099 + world.tick) >= EXPLORE_CHANCE) return;
    const away: number[] = [];
    onFoot.forEach((c, id) => !Number.isFinite(c) && away.push(id));
    if (away.length === 0) return;
    const pick = this.graph.nodes[away[Math.floor(hash(this.id * 31 + world.tick) * away.length)]].pos;
    const plan = planPortals(world, this.graph, me, pick, avoid);
    if (plan) this.job = new PortalJob(plan, pick, world.tick);
  }

  /** Which pickup to go for, reconsidered every RETHINK_TICKS or as soon as the current one is no use. */
  private chooseFetch(world: World, me: PlayerState) {
    const current = this.fetch >= 0 ? world.pickups[this.fetch] : null;
    // Taken (by us or someone else) or no longer any use: drop it now.
    const useless = current && (pickupWorth(me, current) <= 0 || (current.availableAtTick > world.tick && this.nav.arrived));
    if (useless) this.fetch = -1;
    if (world.tick < this.rethinkTick && !useless) return;
    this.rethinkTick = world.tick + RETHINK_TICKS + (this.id % 7); // bots spread their thinking out
    this.fetch = choosePickup(world, me, this.graph)?.index ?? -1;
  }

  private forget() {
    this.target = null;
    this.lastSeen = null;
    this.targetVisible = false;
  }

  /** Who it can see, and who just shot it. */
  private perceive(world: World, me: PlayerState) {
    // Saw them go through a portal: it knows where that leads, so the chase goes on from the far side.
    for (const e of world.events) {
      if (e.type === "teleport" && e.player === this.target && this.targetVisible) {
        const t = world.players.get(e.player);
        if (t) {
          this.lastSeen = { ...t.origin };
          this.seenTick = world.tick;
        }
      }
      if (e.type === "teleport" && e.player === me.id && me.health < LOW_HEALTH) this.escapedTick = world.tick;
    }
    // Shot from anywhere: after a moment (longer at lower skill) it knows roughly where from, and turns to look.
    for (const e of world.events) {
      if (e.type !== "hit" || e.victim !== me.id || e.attacker === me.id || this.shotBy) continue;
      this.shotBy = { id: e.attacker, at: world.tick + this.skill.noticeHitTicks };
    }
    if (this.shotBy && world.tick >= this.shotBy.at) {
      const attacker = world.players.get(this.shotBy.id);
      this.shotBy = null;
      if (attacker && attacker.alive && (this.target === null || !this.targetVisible)) {
        this.target = attacker.id;
        this.lastSeen = { ...attacker.origin };
        this.seenTick = world.tick;
      }
    }

    type Sighting = { p: PlayerState; height: number; via: { from: Portal; to: Portal } | null; d: number };
    let best: Sighting | null = null;
    let current: Sighting | null = null;
    for (const p of world.players.values()) {
      // Someone under spawn protection isn't worth a shot yet.
      if (p === me || !p.alive || (me.team !== 0 && p.team === me.team) || world.tick < p.protectedUntil) continue;
      const direct = this.canSee(world, me, p);
      const seen: Sighting | null =
        direct !== null
          ? { p, height: direct, via: null, d: Math.hypot(p.origin.x - me.origin.x, p.origin.y - me.origin.y, p.origin.z - me.origin.z) }
          : this.canSeeThrough(world, me, p);
      if (!seen) continue;
      if (p.id === this.target) current = seen;
      if (!best || seen.d < best.d) best = seen;
    }
    const chosen = current ?? best;
    const pick = chosen?.p ?? null;
    if (chosen && pick) {
      this.aimHeight = chosen.height;
      this.via = chosen.via;
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

  /**
   * Someone seen through an open portal pair it's looking into: they're in front of
   * the far end, and the line from its eye into this end and out of that one to them
   * is clear. The height above their origin it can see, the pair, and the distance
   * the way through; or null.
   */
  private canSeeThrough(world: World, me: PlayerState, p: PlayerState): { p: PlayerState; height: number; via: { from: Portal; to: Portal }; d: number } | null {
    if (!this.skill.portalSight) return null;
    const eye = vec3(me.origin.x, me.origin.y, me.origin.z + EYE_HEIGHT);
    const zero = vec3();
    const cp = Math.cos(this.pitch);
    const look = vec3(Math.cos(this.yaw) * cp, Math.sin(this.yaw) * cp, Math.sin(this.pitch));
    for (const from of world.portals) {
      const to = world.linkedPortal(from);
      if (!to) continue;
      const toOpening = sub(from.origin, eye);
      // Facing it, near enough.
      if (toOpening.x * from.normal.x + toOpening.y * from.normal.y + toOpening.z * from.normal.z >= 0) continue;
      if (Math.hypot(toOpening.x, toOpening.y, toOpening.z) > PORTAL_SIGHT_RANGE) continue;
      for (const h of [CHEST, EYE_HEIGHT]) {
        const c = vec3(p.origin.x, p.origin.y, p.origin.z + h);
        const rel = sub(c, to.origin);
        if (rel.x * to.normal.x + rel.y * to.normal.y + rel.z * to.normal.z <= 0) continue; // behind the far end
        const ghost = throughPortalPoint(c, to, from);
        const delta = sub(ghost, eye);
        const d = Math.hypot(delta.x, delta.y, delta.z) || 1;
        if (d > PORTAL_SIGHT_RANGE) continue;
        if ((delta.x * look.x + delta.y * look.y + delta.z * look.z) / d < Math.cos(this.skill.fovHalf)) continue;
        const t = segmentIntoPortal(eye, delta, from);
        if (t === null) continue; // the line doesn't go through the opening
        const at = addScaled(eye, delta, t);
        if (world.collision.traceBox(eye, addScaled(at, from.normal, 1), zero, zero).fraction < 1) continue;
        const out = addScaled(throughPortalPoint(at, from, to), to.normal, 1);
        if (world.collision.traceBox(out, c, zero, zero).fraction < 1) continue;
        return { p, height: h, via: { from, to }, d };
      }
    }
    return null;
  }

  /**
   * Hurting in a fight (Normal and up): the far side of an open portal pair close by
   * that lands well away from the enemy, to head for; or null.
   */
  private escapeThroughPortal(world: World, me: PlayerState, enemy: PlayerState): Vec3 | null {
    if (!this.skill.portalEscape || world.tick - this.escapedTick < ESCAPE_COOLDOWN_TICKS) return null;
    let best: Vec3 | null = null;
    let bestDist = ESCAPE_REACH;
    for (const [entry, edges] of portalLinks(world, this.graph)) {
      const start = this.graph.nodes[entry].pos;
      const d = Math.hypot(start.x - me.origin.x, start.y - me.origin.y, start.z - me.origin.z);
      if (d >= bestDist) continue;
      for (const e of edges) {
        const land = this.graph.nodes[e.to].pos;
        if (Math.hypot(land.x - enemy.origin.x, land.y - enemy.origin.y, land.z - enemy.origin.z) < ESCAPE_DISTANCE) continue;
        best = land;
        bestDist = d;
      }
    }
    return best;
  }

  /** Aim wander: drifts to a new random offset every third of a second or so. */
  private wander(world: World) {
    const slot = Math.floor((world.tick + this.id * 7) / 20);
    const goalYaw = signedHash(this.id * 1009 + slot * 2) * this.skill.aimError;
    const goalPitch = signedHash(this.id * 1009 + slot * 2 + 1) * this.skill.aimError * 0.6;
    this.errYaw += (goalYaw - this.errYaw) * 0.1;
    this.errPitch += (goalPitch - this.errPitch) * 0.1;
  }

  /** Like turn, but when lining up a portal shot it settles exactly on the aim (people steady themselves to place a portal). */
  private turnPrecisely(yaw: number, pitch: number, settle: boolean) {
    this.turn(yaw, pitch);
    if (!settle) return;
    if (Math.abs(wrap(yaw - this.yaw)) < 0.02) this.yaw = yaw;
    if (Math.abs(pitch - this.pitch) < 0.02) this.pitch = pitch;
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
  private fightMove(world: World, me: PlayerState, target: Vec3, keep: { near: number; far: number }): Steer {
    const dx = target.x - me.origin.x;
    const dy = target.y - me.origin.y;
    const dist = Math.hypot(dx, dy) || 1;
    const ux = dx / dist;
    const uy = dy / dist;
    if (world.tick >= this.strafeUntil) {
      // Lower skill: now and then it stands still for a moment (easier to hit) instead of dodging.
      const stand = hash(this.id * 41 + world.tick) < this.skill.standChance;
      this.strafe = stand ? 0 : hash(this.id * 31 + world.tick) < 0.5 ? -1 : 1;
      this.strafeUntil = world.tick + 25 + Math.floor(hash(this.id * 37 + world.tick) * 50);
    }
    const range = dist > keep.far ? 0.8 : dist < keep.near ? -0.8 : 0;
    const speed = Math.hypot(me.velocity.x, me.velocity.y);
    this.blocked = me.onGround && speed < MOVE.maxSpeed * 0.2 ? this.blocked + 1 : 0;
    if (this.blocked > 6 && this.strafe !== 0) {
      this.strafe = -this.strafe;
      this.blocked = 0;
    }
    if (this.strafe === 0) {
      // Standing: only closing in or backing off, if the distance is wrong.
      if (range === 0) return { dir: null, jump: false };
      const dir = { x: ux * Math.sign(range), y: uy * Math.sign(range) };
      return this.safe(world, me, dir) ? { dir, jump: false } : { dir: null, jump: false };
    }
    // Preferred: strafe while closing in or backing off. At an edge, strafe along it; failing
    // that, just close in or back off; failing that, any safe way at all rather than freezing.
    const candidates: [number, number, number][] = [
      [this.strafe, range, this.strafe],
      [-this.strafe, range, -this.strafe],
      [this.strafe, 0, this.strafe],
      [-this.strafe, 0, -this.strafe],
    ];
    if (range !== 0) candidates.push([0, range, this.strafe]);
    for (const [side, r, keep] of candidates) {
      const x = -uy * side + ux * r;
      const y = ux * side + uy * r;
      const len = Math.hypot(x, y);
      const dir = { x: x / len, y: y / len };
      if (this.safe(world, me, dir)) {
        this.strafe = keep;
        return { dir, jump: false };
      }
    }
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      const dir = { x: Math.cos(a), y: Math.sin(a) };
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
