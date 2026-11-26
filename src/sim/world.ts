/**
 * The simulation. Owns all game state and advances it one fixed tick at a time
 * from player commands. No rendering, DOM or network code belongs here.
 */
import { add, addScaled, clone, copy, dot, normalize, scale, vec3, type Vec3 } from "../math/vec3";
import type { CollisionBrush, LevelData, SpawnPoint } from "../level/types";
import { CollisionWorld, type Tracer } from "./collision";
import { emptyCommand, type PlayerCommand } from "./command";
import type { PlayerId, SimEvent } from "./events";
import { EYE_HEIGHT, PLAYER_MAXS, PLAYER_MINS, playerMove, type MoveState } from "./movement";
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
import { segmentVsBox, viewDirection, VITALS, WEAPON, type Projectile } from "./weapon";

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

export interface PlayerState extends MoveState {
  id: PlayerId;
  yaw: number;
  pitch: number;
  team: number;
  /** Position at the start of the last tick, for render interpolation. Teleports set it too. */
  prevOrigin: Vec3;
  alive: boolean;
  health: number;
  armor: number;
  ammo: number;
  /** Ticks until the weapon can fire again. */
  fireCooldown: number;
  /** While dead: the tick to respawn on. */
  respawnTick: number;
  frags: number;
  deaths: number;
  /** Ticks until another portal shot is allowed. */
  portalCooldown: number;
  /** Portal trigger state last tick: a shot needs a fresh press. */
  portalHeld: boolean;
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
  private spawnCursor = 0;
  private nextProjectileId = 1;
  private nextPortalId = 1;
  /** Collision changes for walking through each portal, by portal id. */
  private passages = new Map<number, PortalPassage>();

  constructor(readonly level: LevelData) {
    this.collision = new CollisionWorld(level.brushes);
    this.pickups = createPickups(level.pickups);
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
      ammo: 0,
      fireCooldown: 0,
      respawnTick: 0,
      frags: 0,
      deaths: 0,
      portalCooldown: 0,
      portalHeld: false,
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
    p.ammo = WEAPON.startAmmo;
    p.fireCooldown = 0;
    this.events.push({ type: "respawn", player: p.id });
  }

  /** Commands missing for a player this tick are treated as "no input". */
  step(commands: ReadonlyMap<PlayerId, PlayerCommand>) {
    this.events = [];
    const killZ = this.level.mins.z - KILL_Z_MARGIN;
    for (const p of this.players.values()) copy(p.prevOrigin, p.origin);

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

  private updateWeapon(p: PlayerState, cmd: PlayerCommand) {
    if (p.fireCooldown > 0) p.fireCooldown--;
    if (!cmd.fire || p.fireCooldown > 0) return;
    if (p.ammo <= 0) {
      p.fireCooldown = WEAPON.fireIntervalTicks * 2;
      this.events.push({ type: "dryFire", player: p.id });
      return;
    }
    p.ammo--;
    p.fireCooldown = WEAPON.fireIntervalTicks;
    const eye = vec3(p.origin.x, p.origin.y, p.origin.z + EYE_HEIGHT);
    const dir = viewDirection(p.yaw, p.pitch, vec3());
    const projectile: Projectile = {
      id: this.nextProjectileId++,
      owner: p.id,
      origin: eye,
      prevOrigin: clone(eye),
      velocity: scale(dir, WEAPON.projectileSpeed),
      hops: 0,
    };
    this.projectiles.push(projectile);
    this.events.push({ type: "fire", player: p.id, projectile: projectile.id, origin: clone(eye), dir });
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

  /** Moves every projectile one tick; the first thing it touches, wall or player, stops it. */
  private stepProjectiles() {
    const delta = vec3();
    const end = vec3();
    const boxMin = vec3();
    const boxMax = vec3();
    const r = WEAPON.projectileRadius;
    let kept = 0;

    for (const pr of this.projectiles) {
      copy(pr.prevOrigin, pr.origin);
      // Fraction of this tick's travel still to go; a portal hop spends part of it.
      let left = 1;
      let done = false;
      let gone = false;
      for (let hop = 0; hop <= MAX_SHOT_HOPS_PER_TICK && !done; hop++) {
        scale(pr.velocity, TICK_DT * left, delta);
        add(pr.origin, delta, end);

        const tr = this.collision.traceBox(pr.origin, end, POINT, POINT);
        const wallT = tr.startSolid ? 0 : tr.fraction;
        let hitT = wallT;
        let victim: PlayerState | null = null;
        for (const p of this.players.values()) {
          if ((p.id === pr.owner && pr.hops === 0) || !p.alive) continue;
          add(p.origin, PLAYER_MINS, boxMin);
          add(p.origin, PLAYER_MAXS, boxMax);
          boxMin.x -= r; boxMin.y -= r; boxMin.z -= r;
          boxMax.x += r; boxMax.y += r; boxMax.z += r;
          const t = segmentVsBox(pr.origin, delta, boxMin, boxMax);
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
          const t = segmentIntoPortal(pr.origin, delta, pt);
          if (t === null || t >= portalT || t > hitT + slack || (victim && t >= hitT)) continue;
          const partner = this.linkedPortal(pt);
          if (!partner) continue;
          portalT = t;
          from = pt;
          to = partner;
        }

        if (from && to) {
          const pos = addScaled(pr.origin, delta, portalT);
          const exit = addScaled(throughPortalPoint(pos, from, to), to.normal, 0.01);
          copy(pr.origin, exit);
          copy(pr.prevOrigin, exit); // don't draw the tracer across the map
          throughPortalDir(pr.velocity, from, to, pr.velocity);
          pr.hops++;
          left *= 1 - portalT;
          this.events.push({ type: "shotThroughPortal", projectile: pr.id, from: from.id, to: to.id, pos, exit: clone(exit) });
          continue;
        }

        done = true;
        if (victim) {
          const pos = vec3(pr.origin.x + delta.x * hitT, pr.origin.y + delta.y * hitT, pr.origin.z + delta.z * hitT);
          this.damage(victim, pr.owner, WEAPON.damage, pos, pr);
          gone = true;
        } else if (wallT < 1) {
          this.events.push({ type: "impact", projectile: pr.id, owner: pr.owner, pos: clone(tr.endPos), normal: clone(tr.normal) });
          gone = true;
        } else {
          copy(pr.origin, end);
        }
      }
      // Shots have no lifetime: they fly until they hit something. One that leaves the
      // level (an open sky, a leak in the map) would never hit anything, so it's removed.
      if (gone || this.outsideLevel(pr.origin)) continue;
      this.projectiles[kept++] = pr;
    }
    this.projectiles.length = kept;
  }

  private outsideLevel(v: Vec3): boolean {
    const { mins, maxs } = this.level;
    const m = OUTSIDE_LEVEL_MARGIN;
    return v.x < mins.x - m || v.y < mins.y - m || v.z < mins.z - m || v.x > maxs.x + m || v.y > maxs.y + m || v.z > maxs.z + m;
  }

  private damage(victim: PlayerState, attacker: PlayerId, amount: number, pos: Vec3, pr: Projectile) {
    const saved = Math.min(victim.armor, Math.ceil(amount * VITALS.armorAbsorb));
    victim.armor -= saved;
    victim.health -= amount - saved;
    const push = normalize(vec3(pr.velocity.x, pr.velocity.y, 0));
    victim.velocity.x += push.x * WEAPON.knockback;
    victim.velocity.y += push.y * WEAPON.knockback;
    this.events.push({ type: "hit", projectile: pr.id, attacker, victim: victim.id, damage: amount, pos });
    if (victim.health <= 0) this.kill(victim, attacker);
  }

  private kill(victim: PlayerState, attacker: PlayerId | null) {
    victim.alive = false;
    victim.health = Math.min(victim.health, 0);
    victim.velocity.x = victim.velocity.y = victim.velocity.z = 0;
    victim.respawnTick = this.tick + VITALS.respawnTicks;
    victim.deaths++;
    const killer = attacker === null ? undefined : this.players.get(attacker);
    if (killer && killer !== victim) killer.frags++;
    this.events.push({ type: "kill", attacker, victim: victim.id });
  }

  private collectPickups() {
    this.pickups.forEach((pk, index) => {
      if (!pk.known || this.tick < pk.availableAtTick) return;
      for (const p of this.players.values()) {
        if (!p.alive || !touchesPickup(p.origin, pk.origin)) continue;
        if (!applyPickup(p, pk)) continue;
        pk.availableAtTick = this.tick + pk.respawnTicks;
        this.events.push({ type: "pickup", player: p.id, kind: pk.kind, index });
        return;
      }
    });
  }

  /** Away from other live players when there are any; otherwise round robin. */
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
    if (others.length === 0) {
      const spawn = list[this.spawnCursor % list.length];
      this.spawnCursor++;
      return spawn;
    }
    let best = list[0];
    let bestDist = -1;
    for (const s of list) {
      let nearest = Infinity;
      for (const o of others) {
        const d = Math.hypot(o.origin.x - s.origin.x, o.origin.y - s.origin.y, o.origin.z - s.origin.z);
        nearest = Math.min(nearest, d);
      }
      if (nearest > bestDist) {
        bestDist = nearest;
        best = s;
      }
    }
    return best;
  }
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
