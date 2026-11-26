/**
 * Walk graph for bots, built once from the level when it loads: no hand-placed
 * waypoints, so any map drawn in TrenchBroom works.
 *
 * Nodes: points on a grid over every walkable surface (floors, stairs, ramps,
 * ledges), wherever a player fits standing. Edges: tested by running the real
 * movement code from one node towards a neighbour, steering and jumping exactly
 * the way a bot following the edge will. So whatever the sim lets a player do
 * (step up stairs, climb a ramp, jump a low wall, drop off a ledge) becomes an
 * edge, and nothing else does.
 *
 * The graph itself ignores portals: they come and go during play. Routes can take
 * extra edges through whatever portals are open (portalLinks.ts), so places only a
 * portal gets you to (a high ledge) stay in the graph as long as they look out
 * over the part of the map you can walk.
 */
import { clone, vec3, type Vec3 } from "../math/vec3";
import { EYE_HEIGHT } from "../sim/movement";
import type { LevelData } from "../level/types";
import type { Tracer } from "../sim/collision";
import { emptyCommand } from "../sim/command";
import { MOVE, PLAYER_MAXS, PLAYER_MINS, playerMove, type MoveState } from "../sim/movement";
import { TICK_DT, TICK_RATE } from "../sim/tick";

export const NAV_SPACING = 32;
/** A node counts as reached within this distance across the ground... */
export const NAV_REACH_XY = 12;
/** ...and this much up or down (stairs are taken a step at a time). */
export const NAV_REACH_Z = 20;
/** Higher than this above where you stand is out of reach (a jump tops out near 46). */
const MAX_CLIMB = 64;
const MAX_EDGE_TICKS = 90;
/** Grounded and moving less than this per tick: blocked, so jump (bots do the same). */
const STALL_STEP = 1;
const STALL_TICKS = 2;

export interface NavEdge {
  to: number;
  /** Ticks it took in the test walk. */
  cost: number;
  /** A jump was needed. */
  jump: boolean;
  /** Goes down more than a stair step: off a ledge or a wall. */
  drop: boolean;
  /** Where the test walk steered: the neighbour it set off for (differs from `to` on a drop). */
  aim: Vec3;
  /** Through this portal (id): only while it's open. `aim` is then a point inside its opening. */
  portal?: number;
}

/** Extra edges by node, through the portals open right now. */
export type ExtraEdges = ReadonlyMap<number, readonly NavEdge[]>;
const NO_EXTRA: ExtraEdges = new Map();

export interface NavNode {
  /** Player origin standing here. */
  pos: Vec3;
  edges: NavEdge[];
}

export class NavGraph {
  readonly nodes: NavNode[] = [];
  private cells = new Map<string, number[]>();

  add(pos: Vec3): number {
    const id = this.nodes.length;
    this.nodes.push({ pos, edges: [] });
    const key = cellKey(pos.x, pos.y);
    const list = this.cells.get(key);
    if (list) list.push(id);
    else this.cells.set(key, [id]);
    return id;
  }

  /** Node ids in the grid cells within `radius` cells of pos (any height). */
  nodesNear(pos: Vec3, radius = 1): number[] {
    const cx = cellIndex(pos.x);
    const cy = cellIndex(pos.y);
    const out: number[] = [];
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        const list = this.cells.get(`${cx + dx},${cy + dy}`);
        if (list) out.push(...list);
      }
    }
    return out;
  }

  /** The node a player at `pos` is standing at or nearest to, or -1 if none is close. */
  nearest(pos: Vec3, maxDistance = 6 * NAV_SPACING): number {
    let best = -1;
    let bestScore = Infinity;
    for (let radius = 1; radius <= Math.ceil(maxDistance / NAV_SPACING); radius++) {
      for (const id of this.nodesNear(pos, radius)) {
        const n = this.nodes[id].pos;
        const dz = n.z - pos.z;
        if (dz > MAX_CLIMB) continue; // above you: not where you are
        // Height counts extra, so a ledge overhead never beats the floor you're on.
        const score = Math.hypot(n.x - pos.x, n.y - pos.y) + Math.abs(dz) * 2;
        if (score < bestScore) {
          bestScore = score;
          best = id;
        }
      }
      if (best >= 0) return best;
    }
    return best;
  }

  edge(from: number, to: number, extra: ExtraEdges = NO_EXTRA): NavEdge | null {
    return extra.get(from)?.find((e) => e.to === to) ?? this.nodes[from].edges.find((e) => e.to === to) ?? null;
  }

  /**
   * Cheapest route from one node to another (A*), as node ids including both ends, or null.
   * `extra`: edges through open portals, which a route may take too.
   */
  findPath(from: number, to: number, extra: ExtraEdges = NO_EXTRA): number[] | null {
    if (from < 0 || to < 0) return null;
    if (from === to) return [from];
    const goal = this.nodes[to].pos;
    // Ticks at well over run speed: never more than the real cost, so the route is the cheapest.
    const h = (id: number) => {
      const p = this.nodes[id].pos;
      return (Math.hypot(p.x - goal.x, p.y - goal.y, p.z - goal.z) / (MOVE.maxSpeed * 2)) * TICK_RATE;
    };
    const cost = new Map<number, number>([[from, 0]]);
    const cameFrom = new Map<number, number>();
    const open = new MinHeap();
    open.push(from, h(from));
    const closed = new Set<number>();
    while (open.size > 0) {
      const id = open.pop();
      if (id === to) {
        const path = [id];
        for (let at = id; cameFrom.has(at); ) path.push((at = cameFrom.get(at)!));
        return path.reverse();
      }
      if (closed.has(id)) continue;
      closed.add(id);
      const base = cost.get(id)!;
      const through = extra.get(id);
      for (const e of through ? [...this.nodes[id].edges, ...through] : this.nodes[id].edges) {
        const c = base + e.cost;
        if (c >= (cost.get(e.to) ?? Infinity)) continue;
        cost.set(e.to, c);
        cameFrom.set(e.to, id);
        open.push(e.to, c + h(e.to));
      }
    }
    return null;
  }

  /** Ticks to get from `from` to every node (Infinity where you can't), taking `extra` edges too. */
  costsFrom(from: number, extra: ExtraEdges = NO_EXTRA): Float64Array {
    const cost = new Float64Array(this.nodes.length).fill(Infinity);
    if (from < 0) return cost;
    cost[from] = 0;
    const open = new MinHeap();
    open.push(from, 0);
    while (open.size > 0) {
      const id = open.pop();
      const base = cost[id];
      const through = extra.get(id);
      for (const e of through ? [...this.nodes[id].edges, ...through] : this.nodes[id].edges) {
        const c = base + e.cost;
        if (c >= cost[e.to]) continue;
        cost[e.to] = c;
        open.push(e.to, c);
      }
    }
    return cost;
  }

  /** Ticks to get from every node to `to` on foot (Infinity where you can't). */
  costsTo(to: number): Float64Array {
    if (!this.reverse) {
      this.reverse = this.nodes.map(() => []);
      this.nodes.forEach((n, a) => n.edges.forEach((e) => this.reverse![e.to].push({ from: a, cost: e.cost })));
    }
    const cost = new Float64Array(this.nodes.length).fill(Infinity);
    if (to < 0) return cost;
    cost[to] = 0;
    const open = new MinHeap();
    open.push(to, 0);
    while (open.size > 0) {
      const id = open.pop();
      const base = cost[id];
      for (const e of this.reverse[id]) {
        const c = base + e.cost;
        if (c >= cost[e.from]) continue;
        cost[e.from] = c;
        open.push(e.from, c);
      }
    }
    return cost;
  }

  /** Edges into each node, for costsTo (built when first needed). */
  private reverse: { from: number; cost: number }[][] | null = null;

  /** Ticks to run a route from findPath. */
  routeCost(path: readonly number[], extra: ExtraEdges = NO_EXTRA): number {
    let ticks = 0;
    for (let i = 1; i < path.length; i++) ticks += this.edge(path[i - 1], path[i], extra)?.cost ?? 0;
    return ticks;
  }

  get edgeCount(): number {
    return this.nodes.reduce((n, node) => n + node.edges.length, 0);
  }
}

/** Builds the walk graph for a level. `collision` is the level's own collision world. */
export function buildNavGraph(level: LevelData, collision: Tracer): NavGraph {
  const all = new NavGraph();
  placeNodes(level, collision, all);
  for (let a = 0; a < all.nodes.length; a++) linkNode(all, collision, a);
  return keepReachable(all, level.spawns.map((sp) => sp.origin), collision);
}

/** Nodes sampled per unreachable patch, and walkable nodes checked from each, when deciding if it's inside the map. */
const PATCH_SAMPLES = 32;
const VIEW_CHECKS = 12;
/** How far (in grid cells) a patch looks for walkable nodes it can see. */
const VIEW_CELLS = 5;

/**
 * Drops nodes nobody can get to: the tops of the ceiling and walls are walkable
 * surfaces too, but outside the playable space. Kept: everything a spawn point can
 * walk to, and any patch you can't walk to but which looks out over somewhere you
 * can (a ledge only a portal reaches). The outside of a sealed map sees nothing inside.
 */
function keepReachable(all: NavGraph, spawns: readonly Vec3[], collision: Tracer): NavGraph {
  const seen = new Set<number>();
  const stack = spawns.map((sp) => all.nearest(sp)).filter((id) => id >= 0);
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of all.nodes[id].edges) stack.push(e.to);
  }
  const walkable = new Set(seen);
  for (const patch of patches(all, walkable)) {
    if (overlooks(all, patch, walkable, collision)) for (const id of patch) seen.add(id);
  }
  const out = new NavGraph();
  const remap = new Map<number, number>();
  all.nodes.forEach((n, id) => {
    if (seen.has(id)) remap.set(id, out.add(n.pos));
  });
  for (const [oldId, newId] of remap) {
    for (const e of all.nodes[oldId].edges) {
      const to = remap.get(e.to);
      if (to !== undefined) out.nodes[newId].edges.push({ ...e, to });
    }
  }
  return out;
}

/** The nodes outside `known`, in patches linked by edges either way. */
function patches(all: NavGraph, known: ReadonlySet<number>): number[][] {
  const links = all.nodes.map(() => [] as number[]);
  all.nodes.forEach((n, a) => {
    for (const e of n.edges) {
      links[a].push(e.to);
      links[e.to].push(a);
    }
  });
  const done = new Set<number>();
  const out: number[][] = [];
  for (let start = 0; start < all.nodes.length; start++) {
    if (known.has(start) || done.has(start)) continue;
    const patch: number[] = [];
    const stack = [start];
    done.add(start);
    while (stack.length) {
      const id = stack.pop()!;
      patch.push(id);
      for (const n of links[id]) {
        if (known.has(n) || done.has(n)) continue;
        done.add(n);
        stack.push(n);
      }
    }
    out.push(patch);
  }
  return out;
}

/** Some node of the patch has a clear view (eye to eye) of a walkable node nearby. */
function overlooks(all: NavGraph, patch: readonly number[], walkable: ReadonlySet<number>, collision: Tracer): boolean {
  const zero = vec3();
  const eye = (p: Vec3) => vec3(p.x, p.y, p.z + EYE_HEIGHT);
  const step = Math.max(1, Math.floor(patch.length / PATCH_SAMPLES));
  for (let i = 0; i < patch.length; i += step) {
    const from = all.nodes[patch[i]].pos;
    const near = all.nodesNear(from, VIEW_CELLS).filter((id) => walkable.has(id));
    const every = Math.max(1, Math.floor(near.length / VIEW_CHECKS));
    for (let k = 0; k < near.length; k += every) {
      if (collision.traceBox(eye(from), eye(all.nodes[near[k]].pos), zero, zero).fraction === 1) return true;
    }
  }
  return false;
}

/** Small shifts tried when a grid point doesn't fit (a box exactly as deep as a stair step touches both risers). */
const NUDGES: readonly [number, number][] = [[0, 0], [4, 0], [-4, 0], [0, 4], [0, -4], [8, 0], [-8, 0], [0, 8], [0, -8]];

function placeNodes(level: LevelData, collision: Tracer, graph: NavGraph) {
  const half = NAV_SPACING / 2;
  for (const s of level.surfaces) {
    const n = s.plane.normal;
    if (n.z < MOVE.minWalkNormal) continue;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const v of s.vertices) {
      x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x);
      y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y);
    }
    for (let gx = Math.ceil((x0 - half) / NAV_SPACING); half + gx * NAV_SPACING <= x1; gx++) {
      for (let gy = Math.ceil((y0 - half) / NAV_SPACING); half + gy * NAV_SPACING <= y1; gy++) {
        const x = half + gx * NAV_SPACING;
        const y = half + gy * NAV_SPACING;
        if (!insideXY(s.vertices, x, y)) continue;
        // On a slope the box's uphill corner is higher than its centre: lift by that much.
        const lift = 2 + (PLAYER_MAXS.x * (Math.abs(n.x) + Math.abs(n.y))) / n.z;
        for (const [nx, ny] of NUDGES) {
          const px = x + nx;
          const py = y + ny;
          const z = (s.plane.dist - n.x * px - n.y * py) / n.z;
          // Stand a little above the surface, check the player fits, then settle onto it.
          const start = vec3(px, py, z - PLAYER_MINS.z + lift);
          if (collision.traceBox(start, start, PLAYER_MINS, PLAYER_MAXS).startSolid) continue;
          const down = collision.traceBox(start, vec3(px, py, start.z - lift - 8), PLAYER_MINS, PLAYER_MAXS);
          if (down.fraction === 1 || down.normal.z < MOVE.minWalkNormal) continue;
          const pos = clone(down.endPos);
          const dup = graph.nodesNear(pos, 0).some((id) => Math.abs(graph.nodes[id].pos.z - pos.z) < 8);
          if (!dup) graph.add(pos);
          break;
        }
      }
    }
  }
}

function linkNode(graph: NavGraph, collision: Tracer, a: number) {
  const from = graph.nodes[a];
  for (const b of graph.nodesNear(from.pos, 1)) {
    if (b === a) continue;
    const target = graph.nodes[b].pos;
    if (target.z - from.pos.z > MAX_CLIMB) continue;
    const run = testWalk(collision, from.pos, target);
    if (!run) continue;
    let to = b;
    if (!run.reached) {
      // Only a real drop to somewhere lower, or a jump up onto something, counts.
      const dz = run.end.z - from.pos.z;
      if (dz > -NAV_REACH_Z && !(run.jumped && dz > 8)) continue;
      // Landings fall anywhere between grid points: take the node you came down next to.
      to = graph.nearest(run.end, 2 * NAV_SPACING);
      if (to < 0 || to === a) continue;
      const land = graph.nodes[to].pos;
      if (Math.hypot(land.x - run.end.x, land.y - run.end.y) > NAV_SPACING || Math.abs(land.z - run.end.z) > NAV_REACH_Z) continue;
    }
    if (from.edges.some((e) => e.to === to)) continue;
    const drop = from.pos.z - graph.nodes[to].pos.z > NAV_REACH_Z;
    from.edges.push({ to, cost: run.ticks + (run.jumped ? 6 : 0), jump: run.jumped, drop, aim: clone(target) });
  }
}

interface WalkResult {
  /** Got to the target. Otherwise it fell and landed at `end`. */
  reached: boolean;
  end: Vec3;
  jumped: boolean;
  ticks: number;
}

/**
 * Runs the movement code from `a` steering at `b`, already at run speed, jumping
 * when blocked. Null if it neither reaches `b` nor lands somewhere new.
 */
export function testWalk(collision: Tracer, a: Vec3, b: Vec3): WalkResult | null {
  const yaw0 = Math.atan2(b.y - a.y, b.x - a.x);
  const s: MoveState = {
    origin: clone(a),
    velocity: vec3(Math.cos(yaw0) * MOVE.maxSpeed, Math.sin(yaw0) * MOVE.maxSpeed, 0),
    onGround: true,
    groundNormal: vec3(0, 0, 1),
  };
  const cmd = { ...emptyCommand(), forward: 1 };
  let airborne = false;
  let jumped = false;
  let stall = 0;
  const lowest = Math.min(a.z, b.z) - 1024;
  for (let tick = 1; tick <= MAX_EDGE_TICKS; tick++) {
    cmd.yaw = Math.atan2(b.y - s.origin.y, b.x - s.origin.x);
    // Blocked: jump, as a bot would. Not when the target is below you (that needs a drop, not a jump).
    cmd.jump = s.onGround && stall >= STALL_TICKS && b.z > s.origin.z - NAV_REACH_Z;
    if (cmd.jump) jumped = true;
    const x = s.origin.x;
    const y = s.origin.y;
    playerMove(collision, s, cmd, TICK_DT);
    if (s.origin.z < lowest) return null;
    if (s.onGround) {
      if (closeTo(s.origin, b)) return { reached: true, end: clone(s.origin), jumped, ticks: tick };
      if (airborne) {
        // Landed short of the target, or somewhere else after a fall.
        if (Math.hypot(s.origin.x - a.x, s.origin.y - a.y) < NAV_REACH_XY && Math.abs(s.origin.z - a.z) < NAV_REACH_Z) return null;
        return { reached: false, end: clone(s.origin), jumped, ticks: tick };
      }
      stall = Math.hypot(s.origin.x - x, s.origin.y - y) < STALL_STEP ? stall + 1 : 0;
      if (stall > STALL_TICKS + 30) return null; // jumping didn't help: blocked for good
    }
    airborne = !s.onGround;
  }
  return null;
}

export function closeTo(p: Vec3, node: Vec3): boolean {
  return Math.hypot(p.x - node.x, p.y - node.y) < NAV_REACH_XY && Math.abs(p.z - node.z) < NAV_REACH_Z;
}

const cellIndex = (v: number) => Math.floor(v / NAV_SPACING);
const cellKey = (x: number, y: number) => `${cellIndex(x)},${cellIndex(y)}`;

/** Point in a convex polygon, seen from above (the polygon faces up, counter-clockwise). */
function insideXY(vs: readonly Vec3[], x: number, y: number): boolean {
  for (let i = 0; i < vs.length; i++) {
    const a = vs[i];
    const b = vs[(i + 1) % vs.length];
    if ((b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x) < -1e-6) return false;
  }
  return true;
}

/** Binary min-heap of node ids by priority. */
class MinHeap {
  private ids: number[] = [];
  private keys: number[] = [];

  get size() {
    return this.ids.length;
  }

  push(id: number, key: number) {
    let i = this.ids.length;
    this.ids.push(id);
    this.keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= key) break;
      this.ids[i] = this.ids[p];
      this.keys[i] = this.keys[p];
      i = p;
    }
    this.ids[i] = id;
    this.keys[i] = key;
  }

  pop(): number {
    const top = this.ids[0];
    const id = this.ids.pop()!;
    const key = this.keys.pop()!;
    const n = this.ids.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && this.keys[r] < this.keys[l] ? r : l;
        if (this.keys[c] >= key) break;
        this.ids[i] = this.ids[c];
        this.keys[i] = this.keys[c];
        i = c;
      }
      this.ids[i] = id;
      this.keys[i] = key;
    }
    return top;
  }
}
