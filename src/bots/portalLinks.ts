/**
 * Portal shortcuts for bots. The walk graph is built once and knows nothing of
 * portals; while a linked pair is open (anyone's: everyone can walk through any
 * portal), this adds an edge from the spot in front of each opening to wherever
 * walking in lands you.
 *
 * Where you land is found the honest way: a stand-in player walks from the spot
 * into the portal with the real movement code (World.movePlayer, portals and all)
 * and falls until it lands. So a portal high on a wall drops you on the ledge
 * below it, a floor portal flings you out of its partner, and a pair that lands
 * nowhere walkable (or loops forever) adds nothing.
 *
 * Worked out again only when the portals change, once per world (all its bots share it).
 */
import { addScaled, clone, vec3, type Vec3 } from "../math/vec3";
import { emptyCommand } from "../sim/command";
import { PLAYER_MAXS, PLAYER_MINS } from "../sim/movement";
import { PORTAL, portalLocal, type Portal } from "../sim/portals";
import type { PlayerState, World } from "../sim/world";
import { NAV_REACH_Z, NAV_SPACING, type ExtraEdges, type NavEdge, type NavGraph } from "./nav";

/** Longest a walk in and the flight out may take. */
const MAX_TICKS = 240;
/** The stand-in starts no further than this from the opening. */
const MAX_APPROACH = 3 * NAV_SPACING;
/** Half the player box's height: the box clears a wall opening if its centre is within this of the middle. */
const BODY_HALF = (PLAYER_MAXS.z - PLAYER_MINS.z) / 2;
const BODY_MIDDLE = (PLAYER_MINS.z + PLAYER_MAXS.z) / 2;
/** How far into a wall portal to steer, so you're still pushing when you cross. */
const AIM_DEPTH = 40;

const cache = new WeakMap<World, { nav: NavGraph; key: string; edges: Map<number, NavEdge[]> }>();

/** Edges through the portals open in this world right now, by the node they start from. */
export function portalLinks(world: World, nav: NavGraph): ExtraEdges {
  const key = world.portals.map((p) => `${p.id}@${p.placedTick}`).join(",");
  const hit = cache.get(world);
  if (hit && hit.nav === nav && hit.key === key) return hit.edges;
  const edges = new Map<number, NavEdge[]>();
  for (const from of world.portals) {
    const to = world.linkedPortal(from);
    if (!to) continue;
    const link = walkThrough(world, nav, from);
    if (!link) continue;
    const list = edges.get(link.entry);
    if (list) list.push(link.edge);
    else edges.set(link.entry, [link.edge]);
  }
  cache.set(world, { nav, key, edges });
  return edges;
}

/** The point to steer at to go into a portal (from a node in front of it, or standing on a floor one). */
export function portalAim(portal: Portal, from: Vec3): Vec3 {
  if (portal.normal.z > 0.7) return clone(portal.origin);
  const p = addScaled(portal.origin, portal.normal, -AIM_DEPTH);
  return vec3(p.x, p.y, from.z);
}

/** Wall portals you can walk into, and floor portals you can step onto. Ceilings and steep slopes: no. */
function walkable(p: Portal): "wall" | "floor" | null {
  if (p.normal.z > 0.7) return "floor";
  if (Math.abs(p.normal.z) < 0.3) return "wall";
  return null;
}

/** The node to set off from: in front of a wall opening at a height the body fits through, or on a floor portal. */
function entryNode(nav: NavGraph, p: Portal): number {
  const kind = walkable(p);
  if (!kind) return -1;
  let best = -1;
  let bestScore = Infinity;
  const near = addScaled(p.origin, p.normal, kind === "wall" ? NAV_SPACING : 0);
  for (const id of nav.nodesNear(near, 3)) {
    const pos = nav.nodes[id].pos;
    const c = portalLocal(vec3(pos.x, pos.y, pos.z + BODY_MIDDLE), p);
    let score: number;
    if (kind === "wall") {
      // Roughly lined up with the opening; the walk-in below is the real test.
      if (c.n < 8 || c.n > MAX_APPROACH || Math.abs(c.r) > PORTAL.halfWidth - 16 || Math.abs(c.u) > PORTAL.halfHeight - 16) continue;
      score = c.n + Math.abs(c.r) * 2;
    } else {
      // Standing on it: the body's middle a little above the opening, near its centre.
      if (c.n < 0 || c.n > BODY_HALF + NAV_REACH_Z || Math.abs(c.r) > PORTAL.halfWidth - 8 || Math.abs(c.u) > PORTAL.halfHeight - 8) continue;
      score = Math.hypot(c.r, c.u);
    }
    if (score < bestScore) {
      bestScore = score;
      best = id;
    }
  }
  return best;
}

/** Walks a stand-in from the entry node into `from` and lets it land: the edge, or null if it doesn't work out. */
function walkThrough(world: World, nav: NavGraph, from: Portal): { entry: number; edge: NavEdge } | null {
  const entry = entryNode(nav, from);
  if (entry < 0) return null;
  const start = nav.nodes[entry].pos;
  const ghost = standIn(start);
  const aim = portalAim(from, start);
  const lowest = world.level.mins.z - 64;
  let through = false;
  for (let tick = 1; tick <= MAX_TICKS; tick++) {
    const cmd = emptyCommand();
    if (!through) {
      cmd.yaw = Math.atan2(aim.y - ghost.origin.y, aim.x - ghost.origin.x);
      // Right on top of a floor portal there's nowhere to walk: just stand and drop in.
      cmd.forward = Math.hypot(aim.x - ghost.origin.x, aim.y - ghost.origin.y) > 2 ? 1 : 0;
    } else {
      // Out of the exit: keep walking the way it faces you, as a bot heading on would.
      cmd.yaw = ghost.yaw;
      cmd.forward = 1;
    }
    copyPrev(ghost);
    if (world.movePlayer(ghost, cmd)) {
      // Into a different portal first (another pair in the way): not this link.
      if (!through && world.lastTeleport?.from !== from.id) return null;
      through = true;
    }
    if (ghost.origin.z < lowest) return null;
    if (!through) {
      if (tick > 90) return null; // never got in
      continue;
    }
    if (!ghost.onGround) continue;
    // On the ground somewhere in the walk graph (not just the lip of the exit): landed.
    const landing = nav.nearest(ghost.origin, 2 * NAV_SPACING);
    if (landing < 0) continue;
    const land = nav.nodes[landing].pos;
    if (Math.hypot(land.x - ghost.origin.x, land.y - ghost.origin.y) > NAV_SPACING || Math.abs(land.z - ghost.origin.z) > NAV_REACH_Z) continue;
    if (landing === entry) return null;
    return { entry, edge: { to: landing, cost: tick, jump: false, drop: true, aim, portal: from.id } };
  }
  return null;
}

/** Just enough of a player for movePlayer: standing still at a node. */
function standIn(at: Vec3): PlayerState {
  return {
    origin: clone(at),
    prevOrigin: clone(at),
    velocity: vec3(),
    onGround: true,
    groundNormal: vec3(0, 0, 1),
    yaw: 0,
    pitch: 0,
  } as PlayerState;
}

function copyPrev(p: PlayerState) {
  p.prevOrigin.x = p.origin.x;
  p.prevOrigin.y = p.origin.y;
  p.prevOrigin.z = p.origin.z;
}
