/**
 * The simulation. Owns all game state and advances it one fixed tick at a time
 * from player commands. No rendering, DOM or network code belongs here.
 */
import { copy, vec3, type Vec3 } from "../math/vec3";
import type { LevelData, SpawnPoint } from "../level/types";
import { CollisionWorld } from "./collision";
import { emptyCommand, type PlayerCommand } from "./command";
import { PLAYER_MAXS, PLAYER_MINS, playerMove, type MoveState } from "./movement";

export const TICK_RATE = 60;
export const TICK_DT = 1 / TICK_RATE;

/** Anything below this is treated as fallen out of the world. */
const KILL_Z_MARGIN = 2048;

export type PlayerId = number;

export interface PlayerState extends MoveState {
  id: PlayerId;
  yaw: number;
  pitch: number;
  team: number;
}

export class World {
  readonly collision: CollisionWorld;
  readonly players = new Map<PlayerId, PlayerState>();
  tick = 0;
  private spawnCursor = 0;

  constructor(readonly level: LevelData) {
    this.collision = new CollisionWorld(level.brushes);
  }

  addPlayer(id: PlayerId, team = 0): PlayerState {
    const p: PlayerState = {
      id,
      team,
      origin: vec3(),
      velocity: vec3(),
      onGround: false,
      groundNormal: vec3(0, 0, 1),
      yaw: 0,
      pitch: 0,
    };
    this.players.set(id, p);
    this.respawn(p);
    return p;
  }

  removePlayer(id: PlayerId) {
    this.players.delete(id);
  }

  respawn(p: PlayerState) {
    const spawn = this.pickSpawn(p.team);
    copy(p.origin, spawn.origin);
    p.velocity.x = p.velocity.y = p.velocity.z = 0;
    p.yaw = spawn.yaw;
    p.pitch = 0;
    p.onGround = false;
  }

  /** Commands missing for a player this tick are treated as "no input". */
  step(commands: ReadonlyMap<PlayerId, PlayerCommand>) {
    const killZ = this.level.mins.z - KILL_Z_MARGIN;
    for (const p of this.players.values()) {
      const cmd = commands.get(p.id) ?? { ...emptyCommand(), yaw: p.yaw, pitch: p.pitch };
      p.yaw = cmd.yaw;
      p.pitch = cmd.pitch;
      playerMove(this.collision, p, cmd, TICK_DT);
      if (p.origin.z < killZ) this.respawn(p);
    }
    this.tick++;
  }

  private pickSpawn(team: number): SpawnPoint {
    const all = this.level.spawns;
    const candidates = all.filter((s) => s.team === 0 || s.team === team);
    const list = candidates.length ? candidates : all;
    if (list.length === 0) {
      const { mins, maxs } = this.level;
      const centre: Vec3 = vec3((mins.x + maxs.x) / 2, (mins.y + maxs.y) / 2, (mins.z + maxs.z) / 2);
      return { origin: centre, yaw: 0, team: 0 };
    }
    // Round robin for now; "furthest from enemies" once there are enemies.
    const spawn = list[this.spawnCursor % list.length];
    this.spawnCursor++;
    return spawn;
  }
}

export { PLAYER_MINS, PLAYER_MAXS };
