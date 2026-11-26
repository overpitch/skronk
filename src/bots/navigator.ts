/**
 * Gets a bot around on the walk graph: plans a route to a goal (a place, or a
 * random spot when roaming) and says which way to move each tick. It doesn't
 * decide where to look or when to shoot; the bot's brain does, and turns the
 * direction into a command.
 *
 * Following a route: steer at the next node (or further along when the way is
 * straight and clear), jump when blocked (the same rule the graph was built
 * with), and plan again when knocked off course, sent through a portal, or stuck.
 */
import { vec3, type Vec3 } from "../math/vec3";
import { PLAYER_MAXS, PLAYER_MINS } from "../sim/movement";
import type { PlayerId, PlayerState, World } from "../sim/world";
import { closeTo, NAV_REACH_Z, NAV_SPACING, type NavGraph } from "./nav";
import { hash } from "./random";

/** Further than this beyond the length of the current hop (a fall, a portal, a knock): plan again. */
const OFF_ROUTE = 3 * NAV_SPACING;
/** Ticks without getting closer to the next node before giving up on it. */
const STUCK_TICKS = 90;
/** How many nodes ahead to look for a straight run. */
const LOOKAHEAD = 5;
const STALL_SPEED = 40;
const STALL_TICKS = 2;

export interface Steer {
  /** Horizontal unit direction to move in, or null to stand. */
  dir: { x: number; y: number } | null;
  jump: boolean;
}

const STAND: Steer = { dir: null, jump: false };

export class Navigator {
  private route: number[] = [];
  private step = 0;
  private picks = 0;
  private stall = 0;
  private best = Infinity;
  private sinceBetter = 0;
  private failures = 0;
  private aim: Vec3 | null = null;
  /** Where we're heading, or null to roam. */
  private goal: Vec3 | null = null;
  /** No route to the goal: stand until given another. */
  private noRoute = false;

  constructor(
    readonly id: PlayerId,
    private nav: NavGraph,
  ) {}

  /** The route it's on, for the debug view. */
  get currentRoute(): readonly number[] {
    return this.route.slice(this.step);
  }

  /** Head for a place (planned to the nearest walkable spot), or null to roam. */
  goTo(pos: Vec3 | null) {
    const same = pos && this.goal && Math.hypot(pos.x - this.goal.x, pos.y - this.goal.y, pos.z - this.goal.z) < NAV_SPACING;
    if (same || (!pos && !this.goal)) return;
    this.goal = pos ? { ...pos } : null;
    this.route = [];
    this.step = 0;
    this.noRoute = false;
  }

  /** The goal set with goTo can't be reached from here. */
  get unreachable(): boolean {
    return this.noRoute;
  }

  /** Arrived at the goal set with goTo (always false while roaming). */
  get arrived(): boolean {
    return this.goal !== null && this.route.length > 0 && this.step >= this.route.length;
  }

  /** Forget the route (after dying, say). */
  reset() {
    this.route = [];
    this.step = 0;
  }

  steer(world: World, me: PlayerState): Steer {
    if (this.noRoute) return STAND;
    if (this.step >= this.route.length && !this.arrived) this.plan(me, true);
    // Reaching any node a little way ahead (it runs straight past the ones in between) moves us on.
    for (let k = Math.min(this.route.length - 1, this.step + LOOKAHEAD); k >= this.step; k--) {
      if (closeTo(me.origin, this.node(k))) {
        while (this.step <= k) this.advance();
        break;
      }
    }
    if (this.step >= this.route.length) {
      // Arrived: when roaming, a new goal next tick.
      if (!this.goal) this.route = [];
      return STAND;
    }

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
      return STAND;
    }
    if (d < this.best - 1) {
      this.best = d;
      this.sinceBetter = 0;
    } else if (++this.sinceBetter > STUCK_TICKS) {
      // Can't get there from here: another route, and after a few tries, another goal.
      this.plan(me, ++this.failures >= 3);
      return STAND;
    }

    const dx = aim.x - me.origin.x;
    const dy = aim.y - me.origin.y;
    const len = Math.hypot(dx, dy) || 1;
    // Blocked while on the ground (a low wall, a ledge to climb): jump, like the graph's test walks.
    const speed = Math.hypot(me.velocity.x, me.velocity.y);
    this.stall = me.onGround && speed < STALL_SPEED ? this.stall + 1 : 0;
    return { dir: { x: dx / len, y: dy / len }, jump: this.stall >= STALL_TICKS && next.z > me.origin.z - NAV_REACH_Z };
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

  /** New route from where we are: to the goal, or when roaming a fresh spot (or the same one). */
  private plan(me: PlayerState, newGoal: boolean) {
    const start = this.nav.nearest(me.origin);
    let goal = newGoal || this.route.length === 0 ? -1 : this.route[this.route.length - 1];
    if (this.goal) goal = this.nav.nearest(this.goal);
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
    if (this.goal) {
      this.noRoute = true; // can't get there: stand, and the brain will pick something else
      return;
    }
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
