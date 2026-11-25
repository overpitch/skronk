/**
 * The simulation. Owns all game state and advances it one fixed tick at a time
 * from player commands. No rendering, DOM or network code belongs here.
 */
import { add, clone, copy, normalize, scale, vec3, type Vec3 } from "../math/vec3";
import type { LevelData, SpawnPoint } from "../level/types";
import { CollisionWorld } from "./collision";
import { emptyCommand, type PlayerCommand } from "./command";
import type { PlayerId, SimEvent } from "./events";
import { EYE_HEIGHT, PLAYER_MAXS, PLAYER_MINS, playerMove, type MoveState } from "./movement";
import { applyPickup, createPickups, PICKUP_HALF_SIZE, type PickupState } from "./pickups";
import { TICK_DT } from "./tick";
import { segmentVsBox, viewDirection, VITALS, WEAPON, type Projectile } from "./weapon";

export { TICK_DT, TICK_RATE } from "./tick";
export type { PlayerId } from "./events";

/** Anything below this is treated as fallen out of the world. */
const KILL_Z_MARGIN = 2048;
const POINT: Readonly<Vec3> = Object.freeze(vec3());

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
}

export class World {
  readonly collision: CollisionWorld;
  readonly players = new Map<PlayerId, PlayerState>();
  readonly projectiles: Projectile[] = [];
  readonly pickups: PickupState[];
  /** What happened during the last step(). Replaced every tick. */
  events: SimEvent[] = [];
  tick = 0;
  private spawnCursor = 0;
  private nextProjectileId = 1;

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
    };
    this.players.set(id, p);
    this.respawn(p);
    return p;
  }

  removePlayer(id: PlayerId) {
    this.players.delete(id);
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
      p.yaw = cmd.yaw;
      p.pitch = cmd.pitch;
      playerMove(this.collision, p, cmd, TICK_DT);
      if (p.origin.z < killZ) {
        this.kill(p, null);
        continue;
      }
      this.updateWeapon(p, cmd);
    }

    this.stepProjectiles();
    this.collectPickups();
    this.tick++;
  }

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
      expireTick: this.tick + WEAPON.projectileLifeTicks,
    };
    this.projectiles.push(projectile);
    this.events.push({ type: "fire", player: p.id, projectile: projectile.id, origin: clone(eye), dir });
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
      scale(pr.velocity, TICK_DT, delta);
      add(pr.origin, delta, end);

      const tr = this.collision.traceBox(pr.origin, end, POINT, POINT);
      const wallT = tr.startSolid ? 0 : tr.fraction;
      let hitT = wallT;
      let victim: PlayerState | null = null;
      for (const p of this.players.values()) {
        if (p.id === pr.owner || !p.alive) continue;
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

      if (victim) {
        const pos = vec3(pr.origin.x + delta.x * hitT, pr.origin.y + delta.y * hitT, pr.origin.z + delta.z * hitT);
        this.damage(victim, pr.owner, WEAPON.damage, pos, pr);
        continue;
      }
      if (wallT < 1) {
        this.events.push({ type: "impact", projectile: pr.id, owner: pr.owner, pos: clone(tr.endPos), normal: clone(tr.normal) });
        continue;
      }
      if (this.tick >= pr.expireTick) continue;
      copy(pr.origin, end);
      this.projectiles[kept++] = pr;
    }
    this.projectiles.length = kept;
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
