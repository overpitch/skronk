/**
 * The simulation. Owns all game state and advances it one fixed tick at a time
 * from player commands. No rendering, DOM or network code belongs here.
 */
import { add, addScaled, clone, copy, cross, dot, normalize, scale, sub, vec3, type Vec3 } from "../math/vec3";
import type { CollisionBrush, LevelData, SpawnPoint } from "../level/types";
import { CollisionWorld, type Tracer } from "./collision";
import { emptyCommand, type PlayerCommand } from "./command";
import type { PlayerId, SimEvent } from "./events";
import { EYE_HEIGHT, PLAYER_MAXS, PLAYER_MINS, playerMove, type MoveState } from "./movement";
import { decideWinner, FREE_PLAY, newMatch, SPAWN_PROTECTION_TICKS, SPAWN_RAISE_TICKS, type MatchRules, type MatchState } from "./match";
import { applyPickup, createPickups, PICKUP_HALF_SIZE, type PickupState } from "./pickups";
import {
  buildPassage,
  exitOrigin,
  segmentIntoPortal,
  throughPortalPoint,
  PASSAGE_DEPTH,
  nearOpening,
  playerPortalOwner,
  PORTAL,
  portalLocal,
  shootPortal,
  throughPortalDir,
  type Portal,
  type PortalOwner,
  type PortalPassage,
  type PortalSlot,
} from "./portals";
import { TICK_DT } from "./tick";
import { segmentVsBox, viewDirection, VITALS, type Projectile } from "./weapon";
import { pelletOffsets, startingArms, switchWeapon, triggerTick, weaponById, WEAPONS, type Armed, type WeaponSpec, type WeaponId } from "./weapons";

export { TICK_DT, TICK_RATE } from "./tick";
export type { PlayerId } from "./events";

/** Anything below this is treated as fallen out of the world. */
const KILL_Z_MARGIN = 2048;
const POINT: Readonly<Vec3> = Object.freeze(vec3());
/** Speed cap when coming out of a portal, so falling between a floor and ceiling pair can't run away. */
const MAX_PORTAL_EXIT_SPEED = 2400;
/**
 * Safeguard only, far above anything play produces: a shot travels about 50 units a tick, so
 * real portal spacing allows a hop or two per tick. If the hop maths ever failed to end, this
 * stops one tick from hanging the game; the shot just waits at that exit until the next tick.
 */
const MAX_SHOT_HOPS_PER_TICK = 256;
/** How far past the level's bounds a shot may go before it's treated as lost. */
const OUTSIDE_LEVEL_MARGIN = 256;
const PITCH_LIMIT = (89 * Math.PI) / 180;
/** A spawn an enemy can see counts as this much closer to them. */
const SEEN_SPAWN_FACTOR = 0.25;
/** Spawns scoring at least this share of the best one are all fair picks (so the choice isn't predictable). */
const GOOD_SPAWN_SHARE = 0.6;
/** An instant shot goes through at most this many portals. */
const MAX_HITSCAN_HOPS = 8;
const BODY_MIDDLE = (PLAYER_MINS.z + PLAYER_MAXS.z) / 2;

/** What a shot moving in a straight line reaches first. */
type Sweep =
  | { kind: "portal"; t: number; from: Portal; to: Portal }
  | { kind: "player"; t: number; victim: PlayerState }
  | { kind: "wall"; t: number; pos: Vec3; normal: Vec3 }
  | { kind: "none" };

/** An instant shot's path, in pieces where it went through portals. */
interface ShotPath {
  segments: [Vec3, Vec3][];
  end: Vec3;
  /** Direction at the end (turned by any portals). */
  dir: Vec3;
  victim: PlayerState | null;
  /** Set if it stopped at a wall. */
  wallNormal: Vec3 | null;
}

export interface PlayerState extends MoveState, Armed {
  id: PlayerId;
  yaw: number;
  pitch: number;
  team: number;
  /** Position at the start of the last tick, for render interpolation. Teleports set it too. */
  prevOrigin: Vec3;
  alive: boolean;
  health: number;
  armor: number;
  /** Trigger held last tick. */
  firing: boolean;
  /** While dead: the tick to respawn on. */
  respawnTick: number;
  frags: number;
  deaths: number;
  /** Ticks until another portal shot is allowed. */
  portalCooldown: number;
  /** Portal trigger state last tick: a shot needs a fresh press. */
  portalHeld: boolean;
  /** Spawn protection: shots don't hurt until this tick (firing ends it early). */
  protectedUntil: number;
}

export class World {
  readonly collision: CollisionWorld;
  readonly players = new Map<PlayerId, PlayerState>();
  readonly projectiles: Projectile[] = [];
  readonly pickups: PickupState[];
  /** Every placed portal, all owners. At most two per owner. */
  readonly portals: Portal[] = [];
  /** What happened during the last step(). Replaced every tick. */
  events: SimEvent[] = [];
  tick = 0;
  /** The match being played: its rules, whether it's over, who won. */
  match: MatchState;
  /** Rules for a rematch asked for with rematch(); it starts on the next step. */
  private pendingRematch: MatchRules | null = null;
  private spawnCursor = 0;
  private nextProjectileId = 1;
  private nextPortalId = 1;
  /** Collision changes for walking through each portal, by portal id. */
  private passages = new Map<number, PortalPassage>();

  constructor(readonly level: LevelData, rules: MatchRules = FREE_PLAY) {
    this.collision = new CollisionWorld(level.brushes);
    this.pickups = createPickups(level.pickups);
    this.match = newMatch(rules, 0);
  }

  /**
   * A fresh match on the next step (same rules unless given): scores to zero,
   * shots and portals gone, pickups back, everyone respawned.
   */
  rematch(rules: MatchRules = this.match.rules) {
    this.pendingRematch = { ...rules };
  }

  private startMatch(rules: MatchRules) {
    this.projectiles.length = 0;
    this.removePortals(() => true);
    for (const pk of this.pickups) pk.availableAtTick = 0;
    this.match = newMatch(rules, this.tick);
    // Spawn one by one in id order, so each picks a spot away from those already in.
    const everyone = [...this.players.values()].sort((a, b) => a.id - b.id);
    for (const p of everyone) p.alive = false;
    for (const p of everyone) {
      p.frags = 0;
      p.deaths = 0;
      p.portalCooldown = 0;
      this.respawn(p);
    }
    this.events.push({ type: "matchStart" });
  }

  addPlayer(id: PlayerId, team = 0): PlayerState {
    const p: PlayerState = {
      id,
      team,
      origin: vec3(),
      prevOrigin: vec3(),
      velocity: vec3(),
      onGround: false,
      groundNormal: vec3(0, 0, 1),
      yaw: 0,
      pitch: 0,
      alive: true,
      health: 0,
      armor: 0,
      ...startingArms(),
      fireCooldown: 0,
      firing: false,
      respawnTick: 0,
      frags: 0,
      deaths: 0,
      portalCooldown: 0,
      portalHeld: false,
      protectedUntil: 0,
    };
    this.players.set(id, p);
    this.respawn(p);
    return p;
  }

  removePlayer(id: PlayerId) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    // A player's own portals leave with them (team-owned ones won't, later).
    const owner = playerPortalOwner(id);
    this.removePortals((pt) => pt.owner === owner);
  }

  /**
   * Replaces every portal with `list` (a network client copying the server's world).
   * Rebuilds the walk-through openings; does nothing if the list hasn't changed.
   */
  restorePortals(list: readonly Portal[]) {
    const same =
      list.length === this.portals.length && list.every((p, i) => p.id === this.portals[i].id && p.placedTick === this.portals[i].placedTick);
    if (same) return;
    this.portals.length = 0;
    this.passages.clear();
    for (const p of list) {
      this.portals.push(p);
      this.passages.set(p.id, buildPassage(this.level, p));
    }
  }

  /** Whose portal pair this player places into. Team modes can map players to a team key here. */
  portalOwnerOf(p: PlayerState): PortalOwner {
    return playerPortalOwner(p.id);
  }

  /** The end this owner's next portal shot places (and replaces, if both are up). A fizzle doesn't change it. */
  nextPortalSlot(owner: PortalOwner): PortalSlot {
    const mine = this.portals.filter((pt) => pt.owner === owner);
    if (mine.length === 0) return 0;
    if (mine.length === 1) return mine[0].slot === 0 ? 1 : 0;
    const older = mine[0].placedTick < mine[1].placedTick || (mine[0].placedTick === mine[1].placedTick && mine[0].id < mine[1].id);
    return (older ? mine[0] : mine[1]).slot;
  }

  /** The other end of a portal's pair, or null while it is the only one. */
  linkedPortal(portal: Portal): Portal | null {
    return this.portals.find((o) => o.owner === portal.owner && o !== portal) ?? null;
  }

  respawn(p: PlayerState) {
    const spawn = this.pickSpawn(p);
    copy(p.origin, spawn.origin);
    copy(p.prevOrigin, spawn.origin);
    p.velocity.x = p.velocity.y = p.velocity.z = 0;
    p.yaw = spawn.yaw;
    p.pitch = 0;
    p.onGround = false;
    p.alive = true;
    p.health = VITALS.startHealth;
    p.armor = 0;
    Object.assign(p, startingArms());
    // The gun comes up a moment after spawning, so a click held from before (asking for a rematch, say) doesn't fire.
    p.fireCooldown = SPAWN_RAISE_TICKS;
    p.protectedUntil = this.tick + SPAWN_PROTECTION_TICKS;
    this.events.push({ type: "respawn", player: p.id });
  }

  /** Commands missing for a player this tick are treated as "no input". */
  step(commands: ReadonlyMap<PlayerId, PlayerCommand>) {
    this.events = [];
    const killZ = this.level.mins.z - KILL_Z_MARGIN;
    for (const p of this.players.values()) copy(p.prevOrigin, p.origin);
    if (this.pendingRematch) {
      this.startMatch(this.pendingRematch);
      this.pendingRematch = null;
      // This tick's commands were decided before the restart (aiming at where people were): skip them.
      this.tick++;
      return;
    }
    // Match over: everything holds still on the end screen until a rematch.
    if (this.match.phase === "over") {
      this.tick++;
      return;
    }

    for (const p of this.players.values()) {
      if (!p.alive) {
        if (this.tick >= p.respawnTick) this.respawn(p);
        continue;
      }
      const cmd = commands.get(p.id) ?? { ...emptyCommand(), yaw: p.yaw, pitch: p.pitch };
      if (this.movePlayer(p, cmd)) this.events.push(this.lastTeleport!);
      if (p.origin.z < killZ) {
        this.kill(p, null);
        continue;
      }
      this.updateWeapon(p, cmd);
      this.updatePortalGun(p, cmd);
    }

    this.stepProjectiles();
    this.collectPickups();
    this.tick++;
    this.checkMatch();
  }

  /** Ends the match if someone has won (or marks sudden death when time is up with the lead tied). */
  private checkMatch() {
    const m = this.match;
    if (m.phase !== "playing" || (m.rules.fragLimit <= 0 && m.rules.timeLimitTicks <= 0)) return;
    const scores = [...this.players.values()].map((p) => ({ id: p.id, frags: p.frags }));
    const { winner, suddenDeath } = decideWinner(m, this.tick, scores);
    if (suddenDeath && !m.suddenDeath) this.events.push({ type: "suddenDeath" });
    m.suddenDeath = suddenDeath;
    if (winner === null) return;
    m.phase = "over";
    m.winner = winner;
    m.endTick = this.tick;
    m.suddenDeath = false;
    this.events.push({ type: "matchOver", winner });
  }

  /**
   * One tick of one player's movement from its command: look, walk, fall, step
   * through portals. step() uses it for everyone; a network client uses it to
   * predict its own player ahead of the server. Returns whether the player went
   * through a portal (then `lastTeleport` says which); doesn't touch `events`.
   */
  movePlayer(p: PlayerState, cmd: PlayerCommand): boolean {
    p.yaw = cmd.yaw;
    p.pitch = cmd.pitch;
    let open = this.openPortalsNear(p.origin);
    if (this.unstickFromPortals(p, open)) open = this.openPortalsNear(p.origin);
    const before = clone(p.origin);
    playerMove(this.tracerThrough(open), p, cmd, TICK_DT);
    return this.passThroughPortals(p, open, before);
  }

  /** The portal trip from the last movePlayer() that returned true. */
  lastTeleport: Extract<SimEvent, { type: "teleport" }> | null = null;

  /** The trigger: switching, ammo, and the shot itself (melee, a projectile, or an instant shot). */
  private updateWeapon(p: PlayerState, cmd: PlayerCommand) {
    const was = p.weapon;
    const trigger = triggerTick(p, cmd);
    p.firing = cmd.fire;
    if (p.weapon !== was) this.events.push({ type: "weaponSwitch", player: p.id, weapon: WEAPONS[p.weapon].id });
    if (trigger.dry) this.events.push({ type: "dryFire", player: p.id });
    if (!trigger.fired) return;
    p.protectedUntil = 0; // shooting gives up spawn protection
    const spec = WEAPONS[p.weapon];
    const eye = vec3(p.origin.x, p.origin.y, p.origin.z + EYE_HEIGHT);
    const dir = viewDirection(p.yaw, p.pitch, vec3());
    const projectile = spec.shot === "projectile" ? this.launch(p, spec, eye, dir) : -1;
    this.events.push({ type: "fire", player: p.id, weapon: spec.id, projectile, origin: clone(eye), dir: clone(dir) });
    if (spec.shot === "hitscan") this.fireInstant(p, spec, eye, dir);
    else if (spec.shot === "melee") this.punch(p, spec, eye, dir);
  }

  private launch(p: PlayerState, spec: WeaponSpec, eye: Vec3, dir: Vec3): number {
    const projectile: Projectile = {
      id: this.nextProjectileId++,
      owner: p.id,
      origin: clone(eye),
      prevOrigin: clone(eye),
      velocity: scale(dir, spec.speed),
      hops: 0,
      weapon: spec.id,
    };
    this.projectiles.push(projectile);
    return projectile.id;
  }

  /** Shotgun and railgun: every pellet arrives at once, through portals. A blast's pellets on one player count as one hit. */
  private fireInstant(p: PlayerState, spec: WeaponSpec, eye: Vec3, dir: Vec3) {
    const right = vec3(Math.sin(p.yaw), -Math.cos(p.yaw), 0);
    const up = cross(right, dir);
    const turn = (hash3(this.tick, p.id, 7) % 6283) / 1000;
    const struck = new Map<PlayerState, { pellets: number; pos: Vec3; dir: Vec3 }>();
    for (const [r, u] of pelletOffsets(spec, turn)) {
      const d = normalize(vec3(dir.x + right.x * r + up.x * u, dir.y + right.y * r + up.y * u, dir.z + right.z * r + up.z * u));
      const path = this.traceShot(p.id, eye, d, spec.range, spec.radius);
      if (spec.pellets === 1) this.events.push({ type: "trail", player: p.id, weapon: spec.id, segments: path.segments });
      if (path.victim) {
        const s = struck.get(path.victim);
        if (s) s.pellets++;
        else struck.set(path.victim, { pellets: 1, pos: path.end, dir: path.dir });
      } else if (path.wallNormal) {
        this.events.push({ type: "impact", projectile: -1, owner: p.id, weapon: spec.id, pos: path.end, normal: path.wallNormal });
      }
    }
    for (const [victim, s] of struck) this.strike(victim, p.id, spec, spec.damage * s.pellets, s.pos, s.dir, -1, s.pellets);
  }

  /** Fists: a hit up close, or a punch off a wall or floor that pushes you away from it. */
  private punch(p: PlayerState, spec: WeaponSpec, eye: Vec3, dir: Vec3) {
    const path = this.traceShot(p.id, eye, dir, spec.range, spec.radius);
    if (path.victim) {
      this.strike(path.victim, p.id, spec, spec.damage, path.end, path.dir, -1);
    } else if (path.wallNormal) {
      addScaled(p.velocity, dir, -spec.recoil, p.velocity);
      this.events.push({ type: "impact", projectile: -1, owner: p.id, weapon: spec.id, pos: path.end, normal: path.wallNormal });
    }
  }

  /**
   * An instant shot from `start` along `dir`: through linked portals (turning as
   * it goes) until it reaches a player or a wall, or `range` runs out.
   */
  private traceShot(owner: PlayerId, start: Vec3, dir: Vec3, range: number, radius: number): ShotPath {
    const segments: [Vec3, Vec3][] = [];
    let from = clone(start);
    const d = clone(dir);
    let left = range;
    for (let hops = 0; ; hops++) {
      const delta = scale(d, left);
      const s = this.sweep(from, delta, owner, hops, radius);
      if (s.kind === "portal" && hops < MAX_HITSCAN_HOPS) {
        const pos = addScaled(from, delta, s.t);
        segments.push([from, pos]);
        from = addScaled(throughPortalPoint(pos, s.from, s.to), s.to.normal, 0.01);
        throughPortalDir(d, s.from, s.to, d);
        left *= 1 - s.t;
        continue;
      }
      const end = s.kind === "none" ? add(from, delta) : addScaled(from, delta, s.t);
      segments.push([from, end]);
      return {
        segments,
        end,
        dir: d,
        victim: s.kind === "player" ? s.victim : null,
        wallNormal: s.kind === "wall" ? s.normal : null,
      };
    }
  }

  /** Secondary trigger: one portal shot per press into the owner's next slot, replacing the older end if it lands. */
  private updatePortalGun(p: PlayerState, cmd: PlayerCommand) {
    if (p.portalCooldown > 0) p.portalCooldown--;
    const pressed = cmd.portal && !p.portalHeld;
    p.portalHeld = cmd.portal;
    if (!pressed || p.portalCooldown > 0) return;
    p.portalCooldown = PORTAL.cooldownTicks;

    const owner = this.portalOwnerOf(p);
    const slot = this.nextPortalSlot(owner);
    const oldest = this.portals.find((pt) => pt.owner === owner && pt.slot === slot) ?? null;
    // The portal being replaced doesn't block the new one.
    const others = this.portals.filter((pt) => pt !== oldest);
    const eye = vec3(p.origin.x, p.origin.y, p.origin.z + EYE_HEIGHT);
    const shot = shootPortal(this.collision, this.level, eye, viewDirection(p.yaw, p.pitch, vec3()), p.yaw, others);

    let placed: Portal | null = null;
    if (shot.placement) {
      if (oldest) this.removePortals((pt) => pt === oldest);
      placed = { ...shot.placement, id: this.nextPortalId++, owner, slot, placedTick: this.tick };
      this.portals.push(placed);
      this.passages.set(placed.id, buildPassage(this.level, placed));
    }
    this.events.push({
      type: "portalShot",
      player: p.id,
      owner,
      slot,
      origin: eye,
      end: shot.end,
      normal: shot.normal,
      portal: placed?.id ?? null,
      replaced: placed && oldest ? oldest.id : null,
    });
  }

  private removePortals(match: (p: Portal) => boolean) {
    const removed: Portal[] = [];
    let kept = 0;
    for (const pt of this.portals) {
      if (match(pt)) {
        this.passages.delete(pt.id);
        removed.push(pt);
      } else this.portals[kept++] = pt;
    }
    this.portals.length = kept;
    if (removed.length === 0) return;
    // Anyone standing in a closed opening (or its partner's, which closes with it) is now in a wall.
    const candidates = [...removed, ...this.portals];
    for (const p of this.players.values()) {
      if (p.alive) this.unstickFromPortals(p, this.openPortalsNear(p.origin), candidates);
    }
  }

  /**
   * Linked portals a player box at this origin is close enough to step into. A portal
   * whose exit is blocked (the ramp right in front of it, say) stays shut: its surface
   * is solid, so you stand on it or bump into it instead of sinking into the tunnel.
   */
  private openPortalsNear(origin: Vec3): Portal[] {
    return this.portals.filter((pt) => {
      if (!nearOpening(origin, PLAYER_MINS, PLAYER_MAXS, pt)) return false;
      const to = this.linkedPortal(pt);
      return to !== null && this.exitClear(origin, pt, to);
    });
  }

  private exitClear(origin: Vec3, from: Portal, to: Portal): boolean {
    const dest = exitOrigin(origin, PLAYER_MINS, PLAYER_MAXS, from, to);
    return !this.tracerThrough([to]).traceBox(dest, dest, PLAYER_MINS, PLAYER_MAXS).startSolid;
  }

  /** The world as movement sees it with these portals open: their walls gone, tunnels behind them instead. */
  private tracerThrough(open: readonly Portal[]): Tracer {
    if (open.length === 0) return this.collision;
    const skip = new Set<number>();
    const extra: CollisionBrush[] = [];
    for (const pt of open) {
      const passage = this.passages.get(pt.id)!;
      for (const b of passage.backing) skip.add(b);
      extra.push(...passage.frame);
    }
    const world = this.collision;
    return { traceBox: (start, end, mins, maxs) => world.traceBox(start, end, mins, maxs, skip, extra) };
  }

  /** If the player's centre crossed an open portal this tick, carry them out of its partner. */
  private passThroughPortals(p: PlayerState, open: readonly Portal[], before: Vec3): boolean {
    const offset = vec3(0, 0, (PLAYER_MINS.z + PLAYER_MAXS.z) / 2);
    for (const from of open) {
      const was = portalLocal(add(before, offset), from);
      const now = portalLocal(add(p.origin, offset), from);
      if (was.n < 0 || now.n >= 0) continue;
      if (Math.abs(now.r) > PORTAL.halfWidth || Math.abs(now.u) > PORTAL.halfHeight) continue;
      const to = this.linkedPortal(from);
      if (!to) continue;

      const dest = exitOrigin(p.origin, PLAYER_MINS, PLAYER_MAXS, from, to);
      if (this.tracerThrough([to]).traceBox(dest, dest, PLAYER_MINS, PLAYER_MAXS).startSolid) {
        // Exit blocked where you crossed (openPortalsNear checked where you started). Back to
        // the surface with no speed into it; next tick the portal is shut and the unstick pushes you out.
        addScaled(p.origin, from.normal, -now.n, p.origin);
        const into = dot(p.velocity, from.normal);
        if (into < 0) addScaled(p.velocity, from.normal, -into, p.velocity);
        return false;
      }

      copy(p.origin, dest);
      copy(p.prevOrigin, dest);
      throughPortalDir(p.velocity, from, to, p.velocity);
      const speed = Math.hypot(p.velocity.x, p.velocity.y, p.velocity.z);
      if (speed > MAX_PORTAL_EXIT_SPEED) scale(p.velocity, MAX_PORTAL_EXIT_SPEED / speed, p.velocity);
      p.onGround = false;
      this.turnThrough(p, from, to);
      this.lastTeleport = { type: "teleport", player: p.id, from: from.id, to: to.id };
      return true;
    }
    return false;
  }

  /**
   * Safety net: if the player is inside something solid at a portal (it closed or moved
   * while they stood half inside the opening), push them out in front of it.
   * Returns true if they were moved.
   */
  private unstickFromPortals(p: PlayerState, open: readonly Portal[], candidates: readonly Portal[] = this.portals): boolean {
    const here = this.tracerThrough(open);
    if (!here.traceBox(p.origin, p.origin, PLAYER_MINS, PLAYER_MAXS).startSolid) return false;
    const offset = vec3(0, 0, (PLAYER_MINS.z + PLAYER_MAXS.z) / 2);
    const half = vec3((PLAYER_MAXS.x - PLAYER_MINS.x) / 2, (PLAYER_MAXS.y - PLAYER_MINS.y) / 2, (PLAYER_MAXS.z - PLAYER_MINS.z) / 2);
    for (const pt of candidates) {
      const c = portalLocal(add(p.origin, offset), pt);
      if (Math.abs(c.r) > PORTAL.halfWidth || Math.abs(c.u) > PORTAL.halfHeight) continue;
      const depth = Math.abs(pt.normal.x) * half.x + Math.abs(pt.normal.y) * half.y + Math.abs(pt.normal.z) * half.z;
      if (c.n < -PASSAGE_DEPTH - depth || c.n > depth) continue;
      const dest = addScaled(p.origin, pt.normal, depth + 0.1 - c.n);
      if (this.collision.traceBox(dest, dest, PLAYER_MINS, PLAYER_MAXS).startSolid) continue;
      copy(p.origin, dest);
      copy(p.prevOrigin, dest);
      const into = dot(p.velocity, pt.normal);
      if (into < 0) addScaled(p.velocity, pt.normal, -into, p.velocity);
      return true;
    }
    return false;
  }

  /** Turns the view to match the exit. Facing straight up or down out of a floor or ceiling, keep a sensible heading. */
  private turnThrough(p: PlayerState, from: Portal, to: Portal) {
    const look = throughPortalDir(viewDirection(p.yaw, p.pitch, vec3()), from, to);
    const heading = throughPortalDir(vec3(Math.cos(p.yaw), Math.sin(p.yaw), 0), from, to);
    let hx = heading.x;
    let hy = heading.y;
    if (Math.hypot(hx, hy) < 0.3) {
      // Heading turned vertical (floor portal into a wall, say): face out of a wall exit,
      // or towards the top edge of a floor or ceiling exit.
      const out = Math.hypot(to.normal.x, to.normal.y) >= 0.3 ? to.normal : to.up;
      hx = out.x;
      hy = out.y;
      if (Math.hypot(hx, hy) < 0.3) [hx, hy] = [Math.cos(p.yaw), Math.sin(p.yaw)];
    }
    p.yaw = Math.atan2(hy, hx);
    p.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, Math.asin(Math.max(-1, Math.min(1, look.z)))));
  }

  /**
   * What a shot moving from `origin` by `delta` reaches first: a linked portal's
   * opening, a player (boxes grown by `radius`; not the shooter until it has been
   * through a portal), or a wall. `t` is the fraction of `delta` travelled.
   */
  private sweep(origin: Vec3, delta: Vec3, owner: PlayerId, hops: number, radius: number): Sweep {
    const end = add(origin, delta);
    const boxMin = vec3();
    const boxMax = vec3();
    const tr = this.collision.traceBox(origin, end, POINT, POINT);
    const wallT = tr.startSolid ? 0 : tr.fraction;
    let hitT = wallT;
    let victim: PlayerState | null = null;
    for (const p of this.players.values()) {
      if ((p.id === owner && hops === 0) || !p.alive) continue;
      add(p.origin, PLAYER_MINS, boxMin);
      add(p.origin, PLAYER_MAXS, boxMax);
      boxMin.x -= radius; boxMin.y -= radius; boxMin.z -= radius;
      boxMax.x += radius; boxMax.y += radius; boxMax.z += radius;
      const t = segmentVsBox(origin, delta, boxMin, boxMax);
      if (t >= 0 && t <= hitT) {
        hitT = t;
        victim = p;
      }
    }

    // A linked portal opening reached before anything else? The wall behind it is
    // hit at the same spot (the trace stops a hair short), so allow a quarter unit of slack.
    let portalT = Infinity;
    let from: Portal | null = null;
    let to: Portal | null = null;
    const slack = 0.25 / Math.max(1e-6, Math.hypot(delta.x, delta.y, delta.z));
    for (const pt of this.portals) {
      const t = segmentIntoPortal(origin, delta, pt);
      if (t === null || t >= portalT || t > hitT + slack || (victim && t >= hitT)) continue;
      const partner = this.linkedPortal(pt);
      if (!partner) continue;
      portalT = t;
      from = pt;
      to = partner;
    }
    if (from && to) return { kind: "portal", t: portalT, from, to };
    if (victim) return { kind: "player", t: hitT, victim };
    if (wallT < 1) return { kind: "wall", t: wallT, pos: clone(tr.endPos), normal: clone(tr.normal) };
    return { kind: "none" };
  }

  /** Moves every projectile one tick; the first thing it touches, wall or player, stops it (a rocket goes off). */
  private stepProjectiles() {
    const delta = vec3();
    let kept = 0;

    for (const pr of this.projectiles) {
      copy(pr.prevOrigin, pr.origin);
      const spec = weaponById(pr.weapon);
      // Fraction of this tick's travel still to go; a portal hop spends part of it.
      let left = 1;
      let gone = false;
      for (let hop = 0; hop <= MAX_SHOT_HOPS_PER_TICK; hop++) {
        scale(pr.velocity, TICK_DT * left, delta);
        const s = this.sweep(pr.origin, delta, pr.owner, pr.hops, spec.radius);
        if (s.kind === "portal") {
          const pos = addScaled(pr.origin, delta, s.t);
          const exit = addScaled(throughPortalPoint(pos, s.from, s.to), s.to.normal, 0.01);
          copy(pr.origin, exit);
          copy(pr.prevOrigin, exit); // don't draw the tracer across the map
          throughPortalDir(pr.velocity, s.from, s.to, pr.velocity);
          pr.hops++;
          left *= 1 - s.t;
          this.events.push({ type: "shotThroughPortal", projectile: pr.id, from: s.from.id, to: s.to.id, pos, exit: clone(exit) });
          continue;
        }
        if (s.kind === "none") {
          add(pr.origin, delta, pr.origin);
          break;
        }
        gone = true;
        const dir = normalize(pr.velocity);
        if (s.kind === "player") {
          const pos = addScaled(pr.origin, delta, s.t);
          if (spec.splash) this.explode(pr.owner, spec, pos, s.victim, pr.id);
          else this.strike(s.victim, pr.owner, spec, spec.damage, pos, dir, pr.id);
        } else if (spec.splash) {
          // Go off just in front of the wall, so the blast's line of sight starts in the open.
          this.explode(pr.owner, spec, addScaled(s.pos, s.normal, 1), null, pr.id);
        } else {
          this.events.push({ type: "impact", projectile: pr.id, owner: pr.owner, weapon: spec.id, pos: s.pos, normal: s.normal });
        }
        break;
      }
      // Shots have no lifetime: they fly until they hit something. One that leaves the
      // level (an open sky, a leak in the map) would never hit anything, so it's removed.
      if (gone || this.outsideLevel(pr.origin)) continue;
      this.projectiles[kept++] = pr;
    }
    this.projectiles.length = kept;
  }

  /**
   * A rocket going off at `pos`: a direct hit takes the weapon's full damage; everyone
   * else in reach, with nothing solid in between, takes splash falling off with distance
   * and is thrown away from the blast (you too: that's a rocket jump, for less damage).
   */
  private explode(owner: PlayerId, spec: WeaponSpec, pos: Vec3, direct: PlayerState | null, projectile: number) {
    const sp = spec.splash!;
    this.events.push({ type: "explosion", owner, weapon: spec.id, pos: clone(pos), radius: sp.radius });
    for (const p of [...this.players.values()]) {
      if (!p.alive) continue;
      let factor = 1;
      if (p !== direct) {
        const d = distanceToBox(pos, p.origin);
        if (d >= sp.radius || !this.blastReaches(pos, p)) continue;
        factor = 1 - d / sp.radius;
      }
      const centre = vec3(p.origin.x, p.origin.y, p.origin.z + BODY_MIDDLE);
      const away = sub(centre, pos);
      if (Math.hypot(away.x, away.y, away.z) < 1e-3) away.z = 1;
      const push = scale(normalize(away), sp.knockback * factor);
      if (this.tick < p.protectedUntil) {
        this.events.push({ type: "shielded", projectile, attacker: owner, victim: p.id, pos: clone(centre) });
        continue;
      }
      let amount = p === direct ? spec.damage : sp.damage * factor;
      if (p.id === owner) amount *= sp.selfDamage;
      this.damage(p, owner, Math.max(1, Math.round(amount)), p === direct ? pos : centre, push, spec.id, projectile);
    }
  }

  /** Nothing solid between a blast and some part of the player (middle, feet or head). */
  private blastReaches(pos: Vec3, p: PlayerState): boolean {
    for (const z of [BODY_MIDDLE, PLAYER_MINS.z + 2, EYE_HEIGHT]) {
      const to = vec3(p.origin.x, p.origin.y, p.origin.z + z);
      if (this.collision.traceBox(pos, to, POINT, POINT).fraction >= 1) return true;
    }
    return false;
  }

  /** A hit from a bullet, pellets (`pellets` of them together) or a punch: damage, and a shove along the shot. */
  private strike(victim: PlayerState, attacker: PlayerId, spec: WeaponSpec, amount: number, pos: Vec3, dir: Vec3, projectile: number, pellets = 1) {
    if (this.tick < victim.protectedUntil) {
      this.events.push({ type: "shielded", projectile, attacker, victim: victim.id, pos: clone(pos) });
      return;
    }
    const flat = normalize(vec3(dir.x, dir.y, 0));
    const push = vec3(flat.x * spec.knockback * pellets, flat.y * spec.knockback * pellets, spec.lift);
    this.damage(victim, attacker, amount, pos, push, spec.id, projectile);
  }

  private outsideLevel(v: Vec3): boolean {
    const { mins, maxs } = this.level;
    const m = OUTSIDE_LEVEL_MARGIN;
    return v.x < mins.x - m || v.y < mins.y - m || v.z < mins.z - m || v.x > maxs.x + m || v.y > maxs.y + m || v.z > maxs.z + m;
  }

  /** Damage (armor soaks up its share) and a push (`push` is added to their velocity). */
  private damage(victim: PlayerState, attacker: PlayerId, amount: number, pos: Vec3, push: Vec3, weapon: WeaponId, projectile: number) {
    if (!victim.alive) return;
    const saved = Math.min(victim.armor, Math.ceil(amount * VITALS.armorAbsorb));
    victim.armor -= saved;
    victim.health -= amount - saved;
    add(victim.velocity, push, victim.velocity);
    this.events.push({ type: "hit", projectile, attacker, victim: victim.id, weapon, damage: amount, pos: clone(pos) });
    if (victim.health <= 0) this.kill(victim, attacker, weapon);
  }

  private kill(victim: PlayerState, attacker: PlayerId | null, weapon: WeaponId | null = null) {
    victim.alive = false;
    victim.health = Math.min(victim.health, 0);
    victim.velocity.x = victim.velocity.y = victim.velocity.z = 0;
    victim.respawnTick = this.tick + VITALS.respawnTicks;
    victim.deaths++;
    const killer = attacker === null ? undefined : this.players.get(attacker);
    if (killer && killer !== victim) killer.frags++;
    this.events.push({ type: "kill", attacker, victim: victim.id, weapon });
  }

  private collectPickups() {
    this.pickups.forEach((pk, index) => {
      if (!pk.known || this.tick < pk.availableAtTick) return;
      for (const p of this.players.values()) {
        if (!p.alive || !touchesPickup(p.origin, pk.origin)) continue;
        const got = applyPickup(p, pk);
        if (!got.taken) continue;
        pk.availableAtTick = this.tick + pk.respawnTicks;
        this.events.push({ type: "pickup", player: p.id, kind: pk.kind, index });
        // A weapon you didn't have comes straight up, unless you're busy shooting.
        if (got.newWeapon >= 0 && !p.firing && switchWeapon(p, got.newWeapon)) {
          this.events.push({ type: "weaponSwitch", player: p.id, weapon: WEAPONS[p.weapon].id });
        }
        return;
      }
    });
  }

  /**
   * A fair spawn: not on top of anyone, out of enemies' sight if possible, and far
   * from the nearest enemy. Picks at random among the good ones, so where you'll
   * come back isn't predictable. With no enemies about, round robin.
   */
  private pickSpawn(p: PlayerState): SpawnPoint {
    const all = this.level.spawns;
    const candidates = all.filter((s) => s.team === 0 || s.team === p.team);
    const list = candidates.length ? candidates : all;
    if (list.length === 0) {
      const { mins, maxs } = this.level;
      const centre: Vec3 = vec3((mins.x + maxs.x) / 2, (mins.y + maxs.y) / 2, (mins.z + maxs.z) / 2);
      return { origin: centre, yaw: 0, team: 0 };
    }
    const others = [...this.players.values()].filter((o) => o !== p && o.alive);
    const enemies = others.filter((o) => p.team === 0 || o.team !== p.team);
    const free = list.filter((s) => !others.some((o) => boxesOverlap(o.origin, s.origin)));
    const open = free.length ? free : list;
    if (enemies.length === 0) {
      const spawn = open[this.spawnCursor % open.length];
      this.spawnCursor++;
      return spawn;
    }
    const scores = open.map((s) => {
      let score = Infinity;
      for (const o of enemies) {
        const d = Math.hypot(o.origin.x - s.origin.x, o.origin.y - s.origin.y, o.origin.z - s.origin.z);
        score = Math.min(score, this.canSeeSpot(o.origin, s.origin) ? d * SEEN_SPAWN_FACTOR : d);
      }
      return score;
    });
    const best = Math.max(...scores);
    const good = open.filter((_, i) => scores[i] >= best * GOOD_SPAWN_SHARE);
    // The same choice for the same game (a hash, not Math.random), so tests and replays agree.
    return good[hash3(this.tick, p.id, this.spawnCursor++) % good.length];
  }

  /** A clear line from eye height at `from` to eye height at `to` (portals aside). */
  private canSeeSpot(from: Vec3, to: Vec3): boolean {
    const a = vec3(from.x, from.y, from.z + EYE_HEIGHT);
    const b = vec3(to.x, to.y, to.z + EYE_HEIGHT);
    return this.collision.traceBox(a, b, POINT, POINT).fraction >= 1;
  }
}

function boxesOverlap(a: Vec3, b: Vec3): boolean {
  const w = PLAYER_MAXS.x - PLAYER_MINS.x;
  const d = PLAYER_MAXS.y - PLAYER_MINS.y;
  const h = PLAYER_MAXS.z - PLAYER_MINS.z;
  return Math.abs(a.x - b.x) < w && Math.abs(a.y - b.y) < d && Math.abs(a.z - b.z) < h;
}

/** A small integer hash, unsigned (the same in every JS engine). */
function hash3(a: number, b: number, c: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ b ^ (h >>> 13), 0xc2b2ae35);
  h = Math.imul(h ^ c ^ (h >>> 16), 0x27d4eb2f);
  return (h ^ (h >>> 15)) >>> 0;
}

/** Distance from a point to a player's box (0 inside it). */
function distanceToBox(pos: Vec3, origin: Vec3): number {
  const gap = (v: number, lo: number, hi: number) => Math.max(lo - v, 0, v - hi);
  return Math.hypot(
    gap(pos.x, origin.x + PLAYER_MINS.x, origin.x + PLAYER_MAXS.x),
    gap(pos.y, origin.y + PLAYER_MINS.y, origin.y + PLAYER_MAXS.y),
    gap(pos.z, origin.z + PLAYER_MINS.z, origin.z + PLAYER_MAXS.z),
  );
}

function touchesPickup(origin: Vec3, pickup: Vec3): boolean {
  const h = PICKUP_HALF_SIZE;
  return (
    origin.x + PLAYER_MINS.x <= pickup.x + h && origin.x + PLAYER_MAXS.x >= pickup.x - h &&
    origin.y + PLAYER_MINS.y <= pickup.y + h && origin.y + PLAYER_MAXS.y >= pickup.y - h &&
    origin.z + PLAYER_MINS.z <= pickup.z + h && origin.z + PLAYER_MAXS.z >= pickup.z - h
  );
}

export { PLAYER_MINS, PLAYER_MAXS };
