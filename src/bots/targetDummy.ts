/**
 * Practice target: strafes back and forth facing the nearest player and
 * optionally fires sloppy bursts back. Speed is a fraction of run speed; at
 * full speed it also hops now and then. Like every participant it
 * only produces PlayerCommands; real bots (milestone 4) replace it.
 */
import { vec3 } from "../math/vec3";
import { emptyCommand, type PlayerCommand } from "../sim/command";
import { EYE_HEIGHT } from "../sim/movement";
import type { PlayerId, PlayerState, World } from "../sim/world";

const STRAFE_PERIOD = 110; // ticks for one left-right cycle
/** Default speed: an easy walking target (a third of run speed). */
export const DUMMY_DEFAULT_SPEED = 0.35;
const HOP_EVERY = 230;
const BURST_EVERY = 150;
const BURST_LENGTH = 24;

/** Small deterministic hash, so each cycle varies without Math.random. */
function hash(n: number): number {
  let x = (n * 2654435761) >>> 0;
  x ^= x >>> 15;
  return (x % 1000) / 1000;
}

export class TargetDummy {
  constructor(
    readonly id: PlayerId,
    private shoots = false,
    /** 0 stands still, 1 strafes at full run speed. */
    private speed = DUMMY_DEFAULT_SPEED,
  ) {}

  command(world: World): PlayerCommand {
    const me = world.players.get(this.id);
    const cmd = emptyCommand();
    if (!me || !me.alive) return cmd;
    const target = nearestEnemy(world, me);
    cmd.yaw = me.yaw;
    if (target) {
      const dx = target.origin.x - me.origin.x;
      const dy = target.origin.y - me.origin.y;
      const dz = target.origin.z - me.origin.z;
      // Sloppy aim: a slow wobble so it misses a fair share.
      const wobble = Math.sin(world.tick * 0.07) * 0.08;
      cmd.yaw = Math.atan2(dy, dx) + wobble;
      cmd.pitch = Math.atan2(dz, Math.hypot(dx, dy)) + wobble * 0.5;
      cmd.fire = this.shoots && world.tick % BURST_EVERY < BURST_LENGTH && canSee(world, me, target);
    }

    const cycle = Math.floor(world.tick / STRAFE_PERIOD);
    const phase = (world.tick % STRAFE_PERIOD) / STRAFE_PERIOD;
    const pause = 0.1 + hash(cycle) * 0.2; // brief stop when changing direction
    const dir = phase < 0.5 - pause / 2 ? 1 : phase > 0.5 && phase < 1 - pause / 2 ? -1 : 0;
    cmd.right = dir * this.speed;
    cmd.forward = hash(cycle + 7) < 0.3 ? 0.5 * this.speed : 0;
    cmd.jump = this.speed >= 0.7 && world.tick % HOP_EVERY === 0;
    return cmd;
  }
}

function nearestEnemy(world: World, me: PlayerState): PlayerState | null {
  let best: PlayerState | null = null;
  let bestDist = Infinity;
  for (const p of world.players.values()) {
    if (p === me || !p.alive || (me.team !== 0 && p.team === me.team)) continue;
    const d = Math.hypot(p.origin.x - me.origin.x, p.origin.y - me.origin.y, p.origin.z - me.origin.z);
    if (d < bestDist) {
      bestDist = d;
      best = p;
    }
  }
  return best;
}

function canSee(world: World, from: PlayerState, to: PlayerState): boolean {
  const a = vec3(from.origin.x, from.origin.y, from.origin.z + EYE_HEIGHT);
  const b = vec3(to.origin.x, to.origin.y, to.origin.z + EYE_HEIGHT);
  const zero = vec3();
  return world.collision.traceBox(a, b, zero, zero).fraction === 1;
}
