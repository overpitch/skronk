/**
 * Milestone 4, step 1: a bot that gets around. It picks somewhere on the walk
 * graph, plans a route there and runs it, then picks somewhere else. No
 * fighting yet. Like every participant it only produces PlayerCommands.
 *
 * Following a route: steer at the next node (or further along when the way is
 * straight and clear), jump when blocked (the same rule the graph was built
 * with), and plan again when knocked off course, sent through a portal, or stuck.
 */
import { vec3, type Vec3 } from "../math/vec3";
import { emptyCommand, type PlayerCommand } from "../sim/command";
import { PLAYER_MAXS, PLAYER_MINS } from "../sim/movement";
import type { PlayerId, PlayerState, World } from "../sim/world";
import { closeTo, NAV_REACH_Z, NAV_SPACING, type NavGraph } from "./nav";

/** Further than this beyond the length of the current hop (a fall, a portal, a knock): plan again. */
const OFF_ROUTE = 3 * NAV_SPACING;
/** Ticks without getting closer to the next node before giving up on it. */
const STUCK_TICKS = 90;
/** How many nodes ahead to look for a straight run. */
const LOOKAHEAD = 5;
const STALL_SPEED = 40;
const STALL_TICKS = 2;

/** Small deterministic hash, so bots vary without Math.random. */
function hash(n: number): number {
  let x = Math.imul(n | 0, 0x9e3779b1);
  x ^= x >>> 15;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  return (x >>> 0) / 4294967296; // 0..1
}

export class RoamBot {
  private route: number[] = [];
  private step = 0;
  private picks = 0;
  private stall = 0;
  private best = Infinity;
  private sinceBetter = 0;
  private failures = 0;
  private aim: Vec3 | null = null;

  constructor(
    readonly id: PlayerId,
    private nav: NavGraph,
  ) {}

  /** The route it's on, for the debug view. */
  get currentRoute(): readonly number[] {
    return this.route.slice(this.step);
  }

  command(world: World): PlayerCommand {
    const me = world.players.get(this.id);
    const cmd = emptyCommand();
    if (!me || !me.alive) {
      this.route = [];
      return cmd;
    }
    cmd.yaw = me.yaw;

    if (this.step >= this.route.length) this.plan(me, true);
    // Reaching any node a little way ahead (it runs straight past the ones in between) moves us on.
    for (let k = Math.min(this.route.length - 1, this.step + LOOKAHEAD); k >= this.step; k--) {
      if (closeTo(me.origin, this.node(k))) {
        while (this.step <= k) this.advance();
        break;
      }
    }
    if (this.step >= this.route.length) return cmd; // arrived: a new goal next tick

    const next = this.node(this.step);
    const aim = this.steerTarget(world, me);
    if (aim !== this.aim) {
      // A new point to steer at: measure progress towards it from scratch.
      this.aim = aim;
      this.best = Infinity;
      this.sinceBetter = 0;
    }
    const d = Math.hypot(aim.x - me.origin.x, aim.y - me.origin.y) + Math.abs(aim.z - me.origin.z);
    // A drop off a ledge can land a long way out, so the allowance grows with the hop.
    const prev = this.step > 0 ? this.node(this.step - 1) : next;
    const hop = Math.hypot(next.x - prev.x, next.y - prev.y) + Math.abs(next.z - prev.z);
    const toNext = Math.hypot(next.x - me.origin.x, next.y - me.origin.y) + Math.abs(next.z - me.origin.z);
    if (toNext > hop + OFF_ROUTE) {
      this.plan(me, false);
      return cmd;
    }
    if (d < this.best - 1) {
      this.best = d;
      this.sinceBetter = 0;
    } else if (++this.sinceBetter > STUCK_TICKS) {
      // Can't get there from here: another route, and after a few tries, another goal.
      this.plan(me, ++this.failures >= 3);
      return cmd;
    }

    cmd.yaw = Math.atan2(aim.y - me.origin.y, aim.x - me.origin.x);
    cmd.forward = 1;
    // Blocked while on the ground (a low wall, a ledge to climb): jump, like the graph's test walks.
    const speed = Math.hypot(me.velocity.x, me.velocity.y);
    this.stall = me.onGround && speed < STALL_SPEED ? this.stall + 1 : 0;
    cmd.jump = this.stall >= STALL_TICKS && next.z > me.origin.z - NAV_REACH_Z;
    return cmd;
  }

  private node(i: number): Vec3 {
    return this.nav.nodes[this.route[i]].pos;
  }

  private advance() {
    this.step++;
    this.best = Infinity;
    this.sinceBetter = 0;
    this.failures = 0;
  }

  /** New route from where we are: to a fresh goal, or the same one. */
  private plan(me: PlayerState, newGoal: boolean) {
    const start = this.nav.nearest(me.origin);
    const goal = newGoal || this.route.length === 0 ? -1 : this.route[this.route.length - 1];
    this.route = [];
    this.step = 0;
    this.best = Infinity;
    this.sinceBetter = 0;
    if (start < 0) return;
    if (goal >= 0) {
      const path = this.nav.findPath(start, goal);
      if (path) {
        this.route = path;
        return;
      }
    }
    this.failures = 0;
    for (let tries = 0; tries < 8; tries++) {
      const pick = Math.floor(hash(this.id * 7919 + this.picks++) * this.nav.nodes.length);
      const path = this.nav.findPath(start, pick);
      if (path && path.length > 3) {
        this.route = path;
        return;
      }
    }
  }

  /**
   * The furthest node a few steps ahead that's on the same level and in a clear
   * straight line, so the bot runs straight instead of zigzagging along the grid.
   * Jumps and drops are taken node by node.
   */
  private steerTarget(world: World, me: PlayerState): Vec3 {
    const last = Math.min(this.route.length - 1, this.step + LOOKAHEAD);
    for (let k = last; k > this.step; k--) {
      if (!this.plainRun(this.step, k)) continue;
      const p = this.node(k);
      if (Math.abs(p.z - me.origin.z) > 4) continue;
      const end = vec3(p.x, p.y, me.origin.z);
      if (world.collision.traceBox(me.origin, end, PLAYER_MINS, PLAYER_MAXS).fraction === 1) return p;
    }
    return this.node(this.step);
  }

  /** Every edge from route[i] up to route[k] is a plain level walk. */
  private plainRun(i: number, k: number): boolean {
    for (let j = i; j < k; j++) {
      const e = this.nav.edge(this.route[j], this.route[j + 1]);
      if (!e || e.jump || e.drop || Math.abs(this.node(j + 1).z - this.node(j).z) > 4) return false;
    }
    return true;
  }
}
