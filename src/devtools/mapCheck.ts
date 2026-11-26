/**
 * Map checker for people building levels: finds the problems that make a map
 * play badly, in words a map author can act on. Used by the game (dev server
 * only, shown in the menu) and by `npm run maps:check`.
 *
 * Errors break the map (no way to spawn); warnings are things you probably
 * didn't mean (a gap to the outside, a pickup bots can't reach); notes are FYI.
 */
import { KNOWN_PICKUPS } from "../sim/pickups";
import { vec3, type Vec3 } from "../math/vec3";
import type { LevelData, Surface } from "../level/types";
import { buildNavGraph, type NavGraph } from "../bots/nav";
import { CollisionWorld } from "../sim/collision";
import { PLAYER_MAXS, PLAYER_MINS } from "../sim/movement";
import { PORTAL } from "../sim/portals";

export type IssueLevel = "error" | "warning" | "note";

export interface Issue {
  level: IssueLevel;
  message: string;
  /** Where in the map, when there's one place to look. */
  at?: Vec3;
}

export interface CheckOptions {
  /** Whether a texture file exists (the CLI looks on disk, the game asks the server). Skipped if absent. */
  textureExists?: (name: string) => boolean | Promise<boolean>;
  /** A walk graph already built for this level (the game has one when bots are on). */
  nav?: NavGraph;
}

const KNOWN = new Set(KNOWN_PICKUPS);
/** Flood fill cell size for finding gaps to the outside, and the most cells it will try. */
const LEAK_CELL = 32;
const LEAK_MAX_CELLS = 400_000;

export async function checkLevel(level: LevelData, options: CheckOptions = {}): Promise<Issue[]> {
  const issues: Issue[] = level.warnings.map((message) => ({ level: "warning" as const, message }));
  const collision = new CollisionWorld(level.brushes);
  const fmt = (v: Vec3) => `(${Math.round(v.x)} ${Math.round(v.y)} ${Math.round(v.z)})`;

  // Spawns: there must be some, each with room to stand and a floor under it.
  if (level.spawns.length === 0) {
    issues.push({ level: "error", message: "No player_spawn entities: add at least one (two or more for bots to have somewhere to come back in)." });
  } else if (level.spawns.length === 1) {
    issues.push({ level: "note", message: "Only one player_spawn: everyone comes back in at the same spot. Add a few more around the map." });
  }
  level.spawns.forEach((sp, i) => {
    if (collision.traceBox(sp.origin, sp.origin, PLAYER_MINS, PLAYER_MAXS).startSolid) {
      issues.push({ level: "error", message: `Spawn ${i + 1} at ${fmt(sp.origin)} is inside a wall or floor: move it up or out (the player is 32 wide and 56 tall, origin 24 above the feet).`, at: sp.origin });
      return;
    }
    const down = collision.traceBox(sp.origin, vec3(sp.origin.x, sp.origin.y, sp.origin.z - 128), PLAYER_MINS, PLAYER_MAXS);
    if (down.fraction === 1) {
      issues.push({ level: "warning", message: `Spawn ${i + 1} at ${fmt(sp.origin)} has no floor within 128 units below it.`, at: sp.origin });
    }
  });

  // Pickups: known kinds, not buried.
  for (const pk of level.pickups) {
    if (!KNOWN.has(pk.kind)) {
      issues.push({ level: "warning", message: `pickup_${pk.kind} at ${fmt(pk.origin)} isn't a kind the game knows (${KNOWN_PICKUPS.join(", ")}); it's shown but can't be picked up.`, at: pk.origin });
    }
    const box = vec3(16, 16, 16);
    if (collision.traceBox(pk.origin, pk.origin, vec3(-box.x, -box.y, -box.z), box).startSolid) {
      issues.push({ level: "warning", message: `pickup_${pk.kind} at ${fmt(pk.origin)} is partly inside a wall or floor; players may not be able to touch it.`, at: pk.origin });
    }
  }

  // Bots: every spawn and pickup reachable on foot.
  const nav = options.nav ?? buildNavGraph(level, collision);
  if (level.spawns.length > 0) {
    const home = nav.nearest(level.spawns[0].origin);
    const fromHome = reachableFrom(nav, home);
    level.spawns.forEach((sp, i) => {
      if (i === 0) return;
      const node = nav.nearest(sp.origin);
      if (node < 0 || !fromHome.has(node)) {
        issues.push({ level: "warning", message: `Spawn ${i + 1} at ${fmt(sp.origin)} can't be walked to from spawn 1. Bots won't find their way there, and players there may be cut off.`, at: sp.origin });
      } else if (!nav.findPath(node, home)) {
        issues.push({ level: "warning", message: `From spawn ${i + 1} at ${fmt(sp.origin)} there's no way back on foot to spawn 1 (a one-way drop?).`, at: sp.origin });
      }
    });
    for (const pk of level.pickups) {
      // A walkable spot close enough to touch it from (pickups are 32-unit boxes, players 32 wide).
      const node = nav.nearest(pk.origin, 3 * 32);
      const spot = node >= 0 ? nav.nodes[node].pos : null;
      const touchable = !!spot && Math.hypot(spot.x - pk.origin.x, spot.y - pk.origin.y) < 32 && Math.abs(spot.z - pk.origin.z) < 48;
      if (!touchable || !fromHome.has(node)) {
        issues.push({ level: "warning", message: `Bots can't reach pickup_${pk.kind} at ${fmt(pk.origin)} on foot. Put it on a floor someone can walk to, no higher than about 30 units above it.`, at: pk.origin });
      }
    }
  }

  // Portals: somewhere to put them, big enough to hold one.
  const portalFaces = level.surfaces.filter((s) => s.portalFriendly && s.visible);
  if (portalFaces.length === 0) {
    issues.push({ level: "warning", message: "No portal-friendly faces: portals will fizzle everywhere. In TrenchBroom, select faces and tick 'portal' under surface flags." });
  }
  for (const s of portalFaces) {
    if (!fitsPortal(s)) {
      issues.push({ level: "note", message: `A portal-friendly face (${s.texture}) near ${fmt(centre(s))} is smaller than a portal (${PORTAL.halfWidth * 2} wide, ${PORTAL.halfHeight * 2} tall), so a portal can never go there.`, at: centre(s) });
    }
  }

  // Textures: every one named in the map exists.
  if (options.textureExists) {
    const names = [...new Set(level.surfaces.filter((s) => s.visible).map((s) => s.texture))].sort();
    for (const name of names) {
      if (!(await options.textureExists(name))) {
        issues.push({ level: "warning", message: `Texture '${name}' isn't in public/assets/textures (looked for ${name}.png). It shows as a checkerboard.` });
      }
    }
  }

  // Gaps to the outside: from each spawn, can you get out of the map?
  const leak = findLeak(level, collision);
  if (leak === "too big") {
    issues.push({ level: "note", message: "The map is too big to check for gaps to the outside." });
  } else if (leak) {
    issues.push({ level: "warning", message: `There's a gap to the outside near ${fmt(leak)}. Players and shots can leave the map there. Seal it with a brush (a clip brush if it should stay see-through).`, at: leak });
  }

  if (level.lights.length === 0) issues.push({ level: "note", message: "No light entities: the map uses the default lighting only." });
  return issues;
}

function reachableFrom(nav: NavGraph, start: number): Set<number> {
  const seen = new Set<number>();
  if (start < 0) return seen;
  const stack = [start];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of nav.nodes[id].edges) stack.push(e.to);
  }
  return seen;
}

function centre(s: Surface): Vec3 {
  const c = vec3();
  for (const v of s.vertices) {
    c.x += v.x / s.vertices.length;
    c.y += v.y / s.vertices.length;
    c.z += v.z / s.vertices.length;
  }
  return c;
}

/**
 * Whether the face is at least as big as a portal across both ways. Walls are
 * measured across and up; floors and ceilings both ways (a portal there turns
 * with the shooter).
 */
function fitsPortal(s: Surface): boolean {
  const n = s.plane.normal;
  const wall = Math.abs(n.z) < 0.7;
  // Across: horizontal along the face for walls, world x for floors.
  const a = wall ? normalise(vec3(-n.y, n.x, 0)) : vec3(1, 0, 0);
  const b = wall ? cross(n, a) : vec3(0, 1, 0);
  const span = (axis: Vec3) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of s.vertices) {
      const d = v.x * axis.x + v.y * axis.y + v.z * axis.z;
      lo = Math.min(lo, d);
      hi = Math.max(hi, d);
    }
    return hi - lo;
  };
  const w = PORTAL.halfWidth * 2;
  const h = PORTAL.halfHeight * 2;
  const across = span(a);
  const up = span(b);
  return wall ? across >= w && up >= h : (across >= w && up >= h) || (across >= h && up >= w);
}

const normalise = (v: Vec3) => {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return vec3(v.x / l, v.y / l, v.z / l);
};
const cross = (a: Vec3, b: Vec3) => vec3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);

/**
 * Flood fills the open space from each spawn on a grid, moving between cells
 * only where nothing solid is in the way. Getting outside the map's bounds means
 * there's a gap; returns roughly where, or null if sealed.
 */
function findLeak(level: LevelData, collision: CollisionWorld): Vec3 | null | "too big" {
  const cell = LEAK_CELL;
  // One cell of margin round the map; cell centres are offset so they rarely sit exactly on a brush face.
  const lo = vec3(level.mins.x - cell, level.mins.y - cell, level.mins.z - cell);
  const nx = Math.ceil((level.maxs.x - level.mins.x) / cell) + 2;
  const ny = Math.ceil((level.maxs.y - level.mins.y) / cell) + 2;
  const nz = Math.ceil((level.maxs.z - level.mins.z) / cell) + 2;
  if (nx * ny * nz > LEAK_MAX_CELLS) return "too big";
  const OFF = 3.37;
  const centreOf = (i: number, j: number, k: number) => vec3(lo.x + i * cell + OFF, lo.y + j * cell + OFF, lo.z + k * cell + OFF);
  const index = (i: number, j: number, k: number) => (k * ny + j) * nx + i;
  const seen = new Uint8Array(nx * ny * nz);
  const zero = vec3();
  const queue: number[] = [];
  for (const sp of level.spawns) {
    const i = Math.floor((sp.origin.x - lo.x) / cell);
    const j = Math.floor((sp.origin.y - lo.y) / cell);
    const k = Math.floor((sp.origin.z - lo.z) / cell);
    const c = centreOf(i, j, k);
    if (collision.traceBox(c, c, zero, zero).startSolid) continue;
    if (!seen[index(i, j, k)]) {
      seen[index(i, j, k)] = 1;
      queue.push(i, j, k);
    }
  }
  const steps = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  for (let q = 0; q < queue.length; q += 3) {
    const i = queue[q], j = queue[q + 1], k = queue[q + 2];
    const from = centreOf(i, j, k);
    for (const [di, dj, dk] of steps) {
      const a = i + di, b = j + dj, c = k + dk;
      const to = centreOf(a, b, c);
      if (collision.traceBox(from, to, zero, zero).fraction < 1) continue;
      // The margin cells lie outside every brush: reaching one means we got out.
      if (a <= 0 || b <= 0 || c <= 0 || a >= nx - 1 || b >= ny - 1 || c >= nz - 1) return from;
      const id = index(a, b, c);
      if (seen[id]) continue;
      seen[id] = 1;
      queue.push(a, b, c);
    }
  }
  return null;
}
