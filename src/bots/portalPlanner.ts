/**
 * Bots placing portals of their own (bots and portals, step 2): to get somewhere
 * they can't walk to (a high ledge), or much quicker than walking.
 *
 * Spots: once per map, every place a portal fits on the portal-friendly
 * surfaces, sampled on a grid. For each spot: where you land if you come out of
 * it at a walk (found with the real movement code), and for wall spots the node
 * you'd walk in from and the aim that places it from there.
 *
 * A plan is a pair: an exit spot whose landing gets you to the goal, shot from
 * a node you can walk to and see it from; then an entry spot on a wall near
 * there, shot from right in front of it. Two shots make a linked pair (each
 * replaces the older of the bot's two), and portalLinks.ts turns the open pair
 * into a shortcut the bot's route then takes.
 */
import { addScaled, clone, cross, dot, normalize, sub, vec3, type Vec3 } from "../math/vec3";
import { emptyCommand } from "../sim/command";
import { EYE_HEIGHT, MOVE, PLAYER_MAXS, PLAYER_MINS, playerMove, type MoveState } from "../sim/movement";
import { PORTAL, shootPortal, type Placement } from "../sim/portals";
import { TICK_DT } from "../sim/tick";
import { viewDirection } from "../sim/weapon";
import type { PlayerState, World } from "../sim/world";
import { NAV_REACH_Z, NAV_SPACING, type NavGraph } from "./nav";
import { entryNode, portalLinks } from "./portalLinks";

/** Grid spacing for sampling portal-friendly surfaces. */
const SAMPLE_STEP = 96;
/** Spots closer than this (same facing) are one spot. */
const SAME_SPOT = 64;
/** A shot that lands this close to the spot counts as placing it. */
export const SPOT_TOLERANCE = 48;
/** Farthest a bot will shoot a portal from. */
const MAX_SHOT_RANGE = 1600;
/** Candidate shooting nodes looked at per spot, and kept. */
const SHOOTER_SAMPLES = 400;
const SHOOTERS_KEPT = 16;
/** Ticks for turning and firing one portal, and for walking into the entry once it's up. */
const SHOT_TICKS = 40;
const WALK_IN_TICKS = 30;
/** Exit spots looked at closely per plan (the most promising by where they land). */
const EXITS_TRIED = 16;
/** Exit spots whose shooting places are worked out for the first time, per plan: spreads the cost over several plans. */
const NEW_EXITS_PER_PLAN = 3;
/** A portal route has to beat walking by this share and this many ticks to be worth the bother. */
const WORTH_SHARE = 0.7;
const WORTH_TICKS = 180;
const BODY_MIDDLE = (PLAYER_MINS.z + PLAYER_MAXS.z) / 2;
const BODY_HALF = (PLAYER_MAXS.z - PLAYER_MINS.z) / 2;

/** Aim for a portal shot from a node. */
export interface PortalShotAim {
  node: number;
  yaw: number;
  pitch: number;
}

export interface PortalSpot {
  placement: Placement;
  /** Wall spots: the node you walk in from, and the shot that places it from there (else null). */
  entry: PortalShotAim | null;
  /** Coming out of it at a walk you land at this node (-1: nowhere useful), this many ticks after leaving. */
  landing: number;
  exitTicks: number;
  /** Where it can be shot from (worked out when first needed). */
  shooters: PortalShotAim[] | null;
  /** Entry spots: ticks to walk from each node to where you shoot it from (worked out when first needed). */
  walkTo: Float64Array | null;
}

export interface PortalPlan {
  /** Shot first, from `exitShot.node`: where you'll come out. */
  exit: PortalSpot;
  exitShot: PortalShotAim;
  /** Shot second, from right in front of it: where you go in. */
  entry: PortalSpot;
  /** Estimated ticks to the goal this way, and on foot (Infinity if you can't). */
  ticks: number;
  walkTicks: number;
}

const spotCache = new WeakMap<NavGraph, PortalSpot[]>();

/** Every portal spot on the map, worked out once per walk graph. */
export function portalSpots(world: World, nav: NavGraph): PortalSpot[] {
  const hit = spotCache.get(nav);
  if (hit) return hit;
  const spots: PortalSpot[] = [];
  const { level, collision } = world;
  for (const s of level.surfaces) {
    if (!s.portalFriendly) continue;
    const normal = s.plane.normal;
    // In-plane axes: up for walls, any pair for floors and ceilings.
    const up = Math.abs(normal.z) < 0.7 ? normalize(addScaled(vec3(0, 0, 1), normal, -normal.z)) : normalize(cross(normal, vec3(0, 1, 0)));
    const right = cross(up, normal);
    let r0 = Infinity, r1 = -Infinity, u0 = Infinity, u1 = -Infinity;
    for (const v of s.vertices) {
      r0 = Math.min(r0, dot(v, right)); r1 = Math.max(r1, dot(v, right));
      u0 = Math.min(u0, dot(v, up)); u1 = Math.max(u1, dot(v, up));
    }
    const centre = s.vertices.reduce((c, v) => addScaled(c, v, 1 / s.vertices.length), vec3());
    const n0 = dot(centre, normal);
    for (let r = r0 + PORTAL.halfWidth; r <= r1 - PORTAL.halfWidth + 1; r += SAMPLE_STEP) {
      for (let u = u0 + PORTAL.halfHeight; u <= u1 - PORTAL.halfHeight + 1; u += SAMPLE_STEP) {
        const point = addScaled(addScaled(addScaled(vec3(), right, r), up, u), normal, n0);
        // Shoot it square on from a little way out, as the placement rules would.
        const eye = addScaled(point, normal, 48);
        const yaw = Math.atan2(-normal.y, -normal.x);
        const shot = shootPortal(collision, level, eye, scaleNeg(normal), Math.abs(normal.z) < 0.7 ? yaw : 0, []);
        const p = shot.placement;
        if (!p) continue;
        if (spots.some((o) => dot(o.placement.normal, p.normal) > 0.99 && dist(o.placement.origin, p.origin) < SAME_SPOT)) continue;
        spots.push({ placement: p, entry: null, landing: -1, exitTicks: 0, shooters: null, walkTo: null });
      }
    }
  }
  for (const spot of spots) {
    spot.entry = entryShot(world, nav, spot.placement);
    const out = landingFrom(world, nav, spot.placement);
    if (out) {
      spot.landing = out.node;
      spot.exitTicks = out.ticks;
    }
  }
  spotCache.set(nav, spots);
  return spots;
}

/**
 * Does the up-front work (spots, walking times to every entry wall) now, so the
 * first plan in the middle of a fight doesn't stall a frame. Cheap after the first call.
 */
export function preparePortalPlanner(world: World, nav: NavGraph) {
  for (const spot of portalSpots(world, nav)) if (spot.entry) spot.walkTo ??= nav.costsTo(spot.entry.node);
  walkableNodes(world, nav);
}

/**
 * The best portal pair for getting from where `me` is to `goal`, or null if
 * walking is as good (or there's no pair that works). `avoid`: spots that
 * failed recently.
 */
export function planPortals(world: World, nav: NavGraph, me: PlayerState, goal: Vec3, avoid: ReadonlySet<PortalSpot> = new Set()): PortalPlan | null {
  const start = nav.nearest(me.origin);
  const end = nav.nearest(goal);
  if (start < 0 || end < 0) return null;
  const from = nav.costsFrom(start, portalLinks(world, nav));
  const to = nav.costsTo(end);
  const walk = from[end];
  const spots = portalSpots(world, nav);
  // Exits whose landing gets you there in time to be worth it, most promising first.
  const exits = spots
    .filter((s) => s.landing >= 0 && !avoid.has(s) && Number.isFinite(to[s.landing]) && to[s.landing] + s.exitTicks < walk)
    .sort((a, b) => to[a.landing] + a.exitTicks - (to[b.landing] + b.exitTicks))
    .slice(0, EXITS_TRIED);
  const entries = spots.filter((s) => s.entry && !avoid.has(s) && Number.isFinite(from[s.entry.node]));
  let best: PortalPlan | null = null;
  let fresh = 0;
  for (const exit of exits) {
    if (!exit.shooters && fresh++ >= NEW_EXITS_PER_PLAN) continue; // next time
    for (const shot of shootersOf(world, nav, exit)) {
      if (!Number.isFinite(from[shot.node])) continue;
      for (const entry of entries) {
        if (entry === exit || dist(entry.placement.origin, exit.placement.origin) < 3 * PORTAL.halfHeight) continue;
        entry.walkTo ??= nav.costsTo(entry.entry!.node);
        const across = entry.walkTo[shot.node];
        if (!Number.isFinite(across)) continue;
        // Walk to the shooting spot, shoot the exit, walk to the entry wall, shoot it, walk in, come out, on to the goal.
        const ticks = from[shot.node] + SHOT_TICKS + across + SHOT_TICKS + WALK_IN_TICKS + exit.exitTicks + to[exit.landing];
        if (!best || ticks < best.ticks) best = { exit, exitShot: shot, entry, ticks, walkTicks: walk };
      }
    }
  }
  if (!best) return null;
  const worth = !Number.isFinite(walk) || (best.ticks < walk * WORTH_SHARE && walk - best.ticks > WORTH_TICKS);
  return worth ? best : null;
}

/** Did this shot (a portalShot event's portal) land on the spot? */
export function onSpot(placed: Placement, spot: PortalSpot): boolean {
  return dot(placed.normal, spot.placement.normal) > 0.99 && dist(placed.origin, spot.placement.origin) < SPOT_TOLERANCE;
}

/** Nodes you could stand on and place this spot from (looked for once, kept). */
function shootersOf(world: World, nav: NavGraph, spot: PortalSpot): PortalShotAim[] {
  if (spot.shooters) return spot.shooters;
  const p = spot.placement;
  const found: { aim: PortalShotAim; d: number }[] = [];
  // Only from ground you can walk to: a shot from somewhere a portal reaches is no help getting there.
  const ground = walkableNodes(world, nav);
  const near = nav.nodesNear(p.origin, Math.ceil(MAX_SHOT_RANGE / NAV_SPACING)).filter((id) => ground.has(id));
  const every = Math.max(1, Math.floor(near.length / SHOOTER_SAMPLES));
  for (let i = 0; i < near.length; i += every) {
    const node = near[i];
    const aim = aimFrom(world, nav, node, p, MAX_SHOT_RANGE);
    if (aim) found.push({ aim, d: dist(nav.nodes[node].pos, p.origin) });
  }
  // Not too close (you'd be in your own way), not too far; then a spread.
  found.sort((a, b) => Math.abs(a.d - 500) - Math.abs(b.d - 500));
  spot.shooters = found.slice(0, SHOOTERS_KEPT).map((f) => f.aim);
  return spot.shooters;
}

const groundCache = new WeakMap<NavGraph, Set<number>>();

/** Nodes you can walk to from the first spawn point. */
function walkableNodes(world: World, nav: NavGraph): Set<number> {
  const hit = groundCache.get(nav);
  if (hit) return hit;
  const spawn = world.level.spawns[0];
  const costs = nav.costsFrom(spawn ? nav.nearest(spawn.origin) : -1);
  const set = new Set<number>();
  costs.forEach((c, id) => Number.isFinite(c) && set.add(id));
  groundCache.set(nav, set);
  return set;
}

/** The aim from a node's eye that places this spot, or null if it can't be shot from there. */
function aimFrom(world: World, nav: NavGraph, node: number, p: Placement, range: number): PortalShotAim | null {
  const pos = nav.nodes[node].pos;
  const eye = vec3(pos.x, pos.y, pos.z + EYE_HEIGHT);
  const to = sub(p.origin, eye);
  const d = Math.hypot(to.x, to.y, to.z);
  if (d > range || d < 64) return null;
  // Square enough on: a glancing shot slides about.
  if (-dot(to, p.normal) / d < 0.3) return null;
  const yaw = Math.atan2(to.y, to.x);
  const pitch = Math.atan2(to.z, Math.hypot(to.x, to.y));
  const shot = shootPortal(world.collision, world.level, eye, viewDirection(yaw, pitch, vec3()), yaw, []);
  if (!shot.placement || dot(shot.placement.normal, p.normal) < 0.99 || dist(shot.placement.origin, p.origin) > SPOT_TOLERANCE) return null;
  return { node, yaw, pitch };
}

/** A wall spot you could walk into: the node in front and the shot that places it from there. */
function entryShot(world: World, nav: NavGraph, p: Placement): PortalShotAim | null {
  if (Math.abs(p.normal.z) >= 0.3) return null;
  if (entryNode(nav, p) < 0) return null; // nowhere to walk in from
  // Shot from a few steps back (right up against it is too close to aim), then walked into.
  const back = addScaled(p.origin, p.normal, 3 * NAV_SPACING);
  const near = nav.nodesNear(back, 2).sort((a, b) => dist(nav.nodes[a].pos, back) - dist(nav.nodes[b].pos, back));
  for (const node of near) {
    if (Math.abs(nav.nodes[node].pos.z + BODY_MIDDLE - p.origin.z) > PORTAL.halfHeight) continue;
    const aim = aimFrom(world, nav, node, p, 400);
    if (aim) return aim;
  }
  return null;
}

/**
 * Where you'd land coming out of this spot at a walk (out of a wall heading away
 * from it, or dropping out of a ceiling). Floors fling you up and back into
 * themselves: not used as exits.
 */
function landingFrom(world: World, nav: NavGraph, p: Placement): { node: number; ticks: number } | null {
  if (p.normal.z > 0.3) return null;
  const wall = Math.abs(p.normal.z) < 0.3;
  // Out the way the portals carry you: at the bottom of a wall opening (you walked in at floor level), or the middle of a ceiling's.
  const out = wall ? PLAYER_MAXS.x + 0.5 : BODY_HALF + 0.5;
  const centre = addScaled(addScaled(p.origin, p.normal, out), p.up, wall ? -(PORTAL.halfHeight - BODY_HALF - 0.5) : 0);
  const s: MoveState = {
    origin: vec3(centre.x, centre.y, centre.z - BODY_MIDDLE),
    velocity: addScaled(vec3(), p.normal, MOVE.maxSpeed),
    onGround: false,
    groundNormal: vec3(0, 0, 1),
  };
  if (world.collision.traceBox(s.origin, s.origin, PLAYER_MINS, PLAYER_MAXS).startSolid) return null;
  const cmd = { ...emptyCommand(), yaw: Math.atan2(p.normal.y, p.normal.x), forward: wall ? 1 : 0 };
  const lowest = world.level.mins.z - 64;
  for (let tick = 1; tick <= 240; tick++) {
    playerMove(world.collision, s, cmd, TICK_DT);
    if (s.origin.z < lowest) return null;
    if (!s.onGround) continue;
    const node = nav.nearest(s.origin, 2 * NAV_SPACING);
    if (node < 0) continue;
    const land = nav.nodes[node].pos;
    if (Math.hypot(land.x - s.origin.x, land.y - s.origin.y) > NAV_SPACING || Math.abs(land.z - s.origin.z) > NAV_REACH_Z) continue;
    return { node, ticks: tick };
  }
  return null;
}

const dist = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const scaleNeg = (v: Vec3) => vec3(-v.x, -v.y, -v.z);
export const spotOrigin = (s: PortalSpot) => clone(s.placement.origin);
