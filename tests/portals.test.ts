import { describe, expect, it } from "vitest";
import { set } from "../src/math/vec3";
import { emptyCommand } from "../src/sim/command";
import type { SimEvent } from "../src/sim/events";
import { overlaps, PORTAL } from "../src/sim/portals";
import { World, type PlayerState } from "../src/sim/world";
import { loadTestMap } from "./helpers";

// test_box: portal-friendly faces on the east (x = 512) and west (x = -512) walls.
// A platform covers the east wall from y -512 to -256, up to z 64.
const FLOOR_Z = 24.5;
const EYE_Z = FLOOR_Z + 22;
const EAST_X = 512;
type PortalShot = Extract<SimEvent, { type: "portalShot" }>;

function setup(x = 0, y = 0) {
  const world = new World(loadTestMap());
  const p = world.addPlayer(1);
  place(p, x, y);
  return { world, p };
}

function place(p: PlayerState, x: number, y: number) {
  set(p.origin, x, y, FLOOR_Z);
  set(p.prevOrigin, x, y, FLOOR_Z);
  set(p.velocity, 0, 0, 0);
}

/** Lets the cooldown run out with the trigger released, then presses it once. */
function shoot(world: World, p: PlayerState, yaw: number, pitch = 0): PortalShot {
  const idle = new Map([[p.id, { ...emptyCommand(), yaw, pitch }]]);
  for (let i = 0; i < PORTAL.cooldownTicks; i++) world.step(idle);
  world.step(new Map([[p.id, { ...emptyCommand(), yaw, pitch, portal: true }]]));
  const shot = world.events.find((e): e is PortalShot => e.type === "portalShot");
  if (!shot) throw new Error("no portal shot");
  return shot;
}

/** Yaw from the player at (x, y) towards a point on the east wall. */
const yawToEast = (y: number, fromY = 0, fromX = 0) => Math.atan2(y - fromY, EAST_X - fromX);

describe("portal placement", () => {
  it("sticks to a portal wall, upright, and slides up clear of the floor", () => {
    const { world, p } = setup();
    const shot = shoot(world, p, 0);
    expect(shot.portal).not.toBeNull();
    const portal = world.portals[0];
    expect(portal.owner).toBe(world.portalOwnerOf(p));
    expect(portal.normal).toEqual({ x: -1, y: 0, z: 0 });
    expect(portal.up.z).toBeCloseTo(1);
    expect(portal.right.y).toBeCloseTo(-1); // facing the wall, right is -y
    expect(portal.origin.x).toBeCloseTo(EAST_X);
    expect(portal.origin.y).toBeCloseTo(0);
    // Aimed at eye height (46.5) the bottom would be under the floor; it fits just above.
    expect(portal.origin.z).toBeCloseTo(PORTAL.halfHeight + PORTAL.edgeMargin, 1);
  });

  it("fizzles on an ordinary wall", () => {
    const { world, p } = setup();
    const shot = shoot(world, p, Math.PI / 2); // north wall, not flagged
    expect(shot.portal).toBeNull();
    expect(shot.end.y).toBeCloseTo(512, 0);
    expect(shot.normal.y).toBeCloseTo(-1);
    expect(world.portals).toHaveLength(0);
  });

  it("links a pair, and a third shot replaces the oldest", () => {
    const { world, p } = setup();
    const first = shoot(world, p, yawToEast(300)).portal!;
    const second = shoot(world, p, yawToEast(100)).portal!;
    expect(world.linkedPortal(world.portals[0])?.id).toBe(second);
    const third = shoot(world, p, yawToEast(-100));
    expect(third.replaced).toBe(first);
    expect(world.portals.map((pt) => pt.id).sort()).toEqual([second, third.portal].sort());
    const ys = world.portals.map((pt) => Math.round(pt.origin.y)).sort((a, b) => a - b);
    expect(ys).toEqual([-100, 100]);
  });

  it("works on the west wall too, facing east", () => {
    const { world, p } = setup();
    shoot(world, p, Math.PI);
    expect(world.portals[0].normal).toEqual({ x: 1, y: 0, z: 0 });
    expect(world.portals[0].origin.x).toBeCloseTo(-512);
  });

  it("puts a portal shot onto another portal right beside it", () => {
    const { world, p } = setup();
    shoot(world, p, 0);
    const shot = shoot(world, p, 0);
    expect(shot.portal).not.toBeNull();
    const [a, b] = world.portals;
    expect(overlaps(a, b)).toBe(false);
    expect(Math.abs(b.origin.y - a.origin.y)).toBeCloseTo(2 * PORTAL.halfWidth + 1, 0);
    expect(b.origin.z).toBeCloseTo(a.origin.z);
  });

  it("slides up off a platform built against the wall", () => {
    const { world, p } = setup(0, -384);
    // Aim at z 100 on the wall, just over the platform's edge (the bottom would sink into it).
    const pitch = Math.atan2(100 - EYE_Z, EAST_X);
    const shot = shoot(world, p, 0, pitch);
    expect(shot.portal).not.toBeNull();
    const portal = world.portals[0];
    expect(portal.origin.z - PORTAL.halfHeight).toBeGreaterThanOrEqual(64);
    expect(portal.origin.y).toBeCloseTo(-384);
  });

  it("fires once per press, not while held", () => {
    const { world, p } = setup();
    const held = new Map([[p.id, { ...emptyCommand(), portal: true }]]);
    let shots = 0;
    for (let i = 0; i < PORTAL.cooldownTicks * 4; i++) {
      world.step(held);
      shots += world.events.filter((e) => e.type === "portalShot").length;
    }
    expect(shots).toBe(1);
  });

  it("removes a player's portals when they leave", () => {
    const { world, p } = setup();
    shoot(world, p, yawToEast(200));
    shoot(world, p, yawToEast(-100));
    expect(world.portals).toHaveLength(2);
    world.removePlayer(p.id);
    expect(world.portals).toHaveLength(0);
  });
});

describe("walking through portals", () => {
  type Teleport = Extract<SimEvent, { type: "teleport" }>;

  /** East wall portal at y 200, west wall portal at y -150 (clear of the ramp), both at z 58. */
  function linkedWalls() {
    const { world, p } = setup();
    shoot(world, p, yawToEast(200));
    shoot(world, p, Math.atan2(-150, -512));
    return { world, p };
  }

  /** Runs ticks with one command and returns the teleports, with the player's yaw right after each. */
  function walk(world: World, p: PlayerState, cmd: Partial<ReturnType<typeof emptyCommand>>, ticks: number) {
    const full = new Map([[p.id, { ...emptyCommand(), ...cmd }]]);
    const out: { e: Teleport; yaw: number; vel: { x: number; y: number; z: number } }[] = [];
    for (let i = 0; i < ticks; i++) {
      world.step(full);
      for (const e of world.events) if (e.type === "teleport") out.push({ e, yaw: p.yaw, vel: { ...p.velocity } });
    }
    return out;
  }

  it("walks in one wall portal and out of the other, facing out", () => {
    const { world, p } = linkedWalls();
    const [east, west] = world.portals;
    place(p, 400, 200);
    const hops = walk(world, p, { forward: 1, yaw: 0 }, 60);
    expect(hops).toHaveLength(1);
    expect(hops[0].e.from).toBe(east.id);
    expect(hops[0].e.to).toBe(west.id);
    expect(hops[0].yaw).toBeCloseTo(0); // out of the west wall is +x again
    expect(hops[0].vel.x).toBeGreaterThan(200);
    // Carried on walking into the room from the west wall, level with the exit.
    expect(p.origin.x).toBeGreaterThan(-512 + 16);
    expect(p.origin.y).toBeCloseTo(-150, 0);
    expect(p.onGround).toBe(true);
  });

  it("turns you round when both portals face the same way", () => {
    const { world, p } = setup();
    shoot(world, p, yawToEast(250));
    shoot(world, p, yawToEast(-50));
    place(p, 400, 250);
    // The fixed test command keeps walking +x, so stop soon after the first hop.
    const hops = walk(world, p, { forward: 1, yaw: 0 }, 30);
    expect(hops.length).toBeGreaterThanOrEqual(1);
    expect(Math.abs(hops[0].yaw)).toBeCloseTo(Math.PI); // came back out of the east wall facing west
    expect(hops[0].vel.x).toBeLessThan(-200);
  });

  it("keeps the wall solid until the pair is linked", () => {
    const { world, p } = setup();
    shoot(world, p, yawToEast(200));
    place(p, 400, 200);
    expect(walk(world, p, { forward: 1, yaw: 0 }, 60)).toHaveLength(0);
    expect(p.origin.x).toBeLessThanOrEqual(EAST_X - 16 + 0.1);
  });

  it("keeps the wall solid beside the opening", () => {
    const { world, p } = linkedWalls();
    place(p, 400, 200 + PORTAL.halfWidth + 20);
    expect(walk(world, p, { forward: 1, yaw: 0 }, 60)).toHaveLength(0);
    expect(p.origin.x).toBeLessThanOrEqual(EAST_X - 16 + 0.1);
  });

  it("drops through a floor portal and flies out of a wall", () => {
    const { world, p } = setup();
    shoot(world, p, 0); // east wall, y 0
    // Stand on the floor pad (top at z 2) and shoot the floor at your feet.
    set(p.origin, -416, -416, FLOOR_Z + 2);
    set(p.prevOrigin, -416, -416, FLOOR_Z + 2);
    const shot = shoot(world, p, 0, -1.5);
    expect(shot.portal).not.toBeNull();
    expect(world.portals[1].normal.z).toBeCloseTo(1);
    const hops = walk(world, p, {}, 60);
    expect(hops.length).toBeGreaterThanOrEqual(1);
    // Falling speed comes out sideways, out of the east wall, facing out of it.
    expect(hops[0].vel.x).toBeLessThan(-150);
    expect(Math.abs(hops[0].yaw)).toBeCloseTo(Math.PI);
  });

  it("keeps a floor portal solid when its exit is blocked, so you can't sink into it", () => {
    const { world, p } = setup();
    shoot(world, p, Math.PI); // west wall at y 0, just beside the foot of the ramp
    set(p.origin, -416, -416, FLOOR_Z + 2);
    set(p.prevOrigin, -416, -416, FLOOR_Z + 2);
    expect(shoot(world, p, 0, -1.5).portal).not.toBeNull(); // floor pad under your feet, its up along +x
    // Stand near the floor portal's back edge: that comes out low on the wall, into the ramp.
    const floor = world.portals[1];
    set(p.origin, floor.origin.x - 27, floor.origin.y + 10, FLOOR_Z + 2);
    set(p.prevOrigin, floor.origin.x - 27, floor.origin.y + 10, FLOOR_Z + 2);
    expect(walk(world, p, {}, 60)).toHaveLength(0);
    expect(p.origin.z).toBeCloseTo(FLOOR_Z + 2, 0); // standing on it
    expect(p.onGround).toBe(true);
    walk(world, p, { forward: 1, yaw: Math.PI / 4 }, 60);
    expect(p.origin.x).toBeGreaterThan(-300); // and can walk off
  });

  it("pushes you out if a portal closes while you're half inside it", () => {
    const { world, p } = linkedWalls();
    place(p, 505, 200); // box reaches 9 units into the east opening
    set(p.origin, 505, 200, FLOOR_Z + 2); // standing on the opening's bottom edge, 2 up
    set(p.prevOrigin, 505, 200, FLOOR_Z + 2);
    walk(world, p, {}, 5);
    expect(p.origin.x).toBeCloseTo(505);
    shoot(world, p, Math.atan2(-300, 7)); // replaces the east portal you're standing in
    expect(world.portals.some((pt) => Math.round(pt.origin.y) === 200)).toBe(false);
    expect(p.origin.x).toBeLessThanOrEqual(EAST_X - 16 + 0.2);
    walk(world, p, { forward: -1, yaw: 0 }, 30);
    expect(p.origin.x).toBeLessThan(EAST_X - 100); // free to move again
  });

  it("removes the opening when a portal is replaced", () => {
    const { world, p } = linkedWalls();
    shoot(world, p, yawToEast(-100)); // replaces the east portal at y 200
    place(p, 400, 200);
    expect(walk(world, p, { forward: 1, yaw: 0 }, 60)).toHaveLength(0);
    expect(p.origin.x).toBeLessThanOrEqual(EAST_X - 16 + 0.1);
  });
});

describe("portal ends", () => {
  it("alternates ends, so each shot replaces the older one, and a fizzle doesn't skip", () => {
    const { world, p } = setup();
    const owner = world.portalOwnerOf(p);
    expect(world.nextPortalSlot(owner)).toBe(0);
    expect(shoot(world, p, yawToEast(300)).slot).toBe(0);
    expect(world.nextPortalSlot(owner)).toBe(1);
    expect(shoot(world, p, Math.PI / 2).portal).toBeNull(); // fizzle on the north wall
    expect(world.nextPortalSlot(owner)).toBe(1);
    expect(shoot(world, p, yawToEast(100)).slot).toBe(1);
    const third = shoot(world, p, yawToEast(-100));
    expect(third.slot).toBe(0);
    const bySlot = world.portals.map((pt) => [pt.slot, Math.round(pt.origin.y)]).sort();
    expect(bySlot).toEqual([[0, -100], [1, 100]]);
    expect(world.nextPortalSlot(owner)).toBe(1);
  });
});

describe("shooting through portals", () => {
  /** East wall portal at y 200 and west wall portal at y -150, both centred at z 58. */
  function linked() {
    const { world, p } = setup();
    shoot(world, p, yawToEast(200));
    shoot(world, p, Math.atan2(-150, -512));
    return { world, p };
  }

  function fireOnce(world: World, p: PlayerState, yaw: number, ticks = 30) {
    const events: SimEvent[] = [];
    world.step(new Map([[p.id, { ...emptyCommand(), yaw, fire: true }]]));
    events.push(...world.events);
    for (let i = 0; i < ticks; i++) {
      world.step(new Map([[p.id, { ...emptyCommand(), yaw }]]));
      events.push(...world.events);
    }
    return events;
  }

  it("goes in one portal and out of the other, and can hit you in the back", () => {
    const { world, p } = linked();
    // From (0, 25) aim level at the east portal: out of the west one, the shot runs back through here.
    place(p, 0, 25);
    const events = fireOnce(world, p, Math.atan2(175, 512));
    const hop = events.find((e) => e.type === "shotThroughPortal");
    expect(hop).toBeDefined();
    if (hop?.type !== "shotThroughPortal") return;
    expect(hop.exit.x).toBeCloseTo(-512, 0);
    expect(hop.exit.y).toBeCloseTo(-150, 0);
    const hit = events.find((e) => e.type === "hit");
    expect(hit?.type === "hit" && hit.victim === p.id && hit.attacker === p.id).toBe(true);
    expect(p.health).toBeLessThan(100);
  });

  it("hits another player on the far side", () => {
    const { world, p } = linked();
    const other = world.addPlayer(2);
    place(p, 0, 25);
    // On the exit path, out of the west portal heading (512, 175).
    place(other, -400, -150 + (175 / 512) * 112);
    const events = fireOnce(world, p, Math.atan2(175, 512));
    const hit = events.find((e) => e.type === "hit");
    expect(hit?.type === "hit" && hit.victim === other.id).toBe(true);
  });

  it("keeps a shot looping between two facing portals as a standing hazard", () => {
    const { world, p } = setup();
    shoot(world, p, 0); // east wall, y 0
    shoot(world, p, Math.PI); // west wall, y 0: straight across from it
    place(p, 400, 0);
    world.step(new Map([[p.id, { ...emptyCommand(), yaw: 0, fire: true }]]));
    place(p, 0, 300); // step out of the line before it comes round
    let hops = 0;
    for (let i = 0; i < 10 * 60; i++) {
      world.step(new Map([[p.id, emptyCommand()]]));
      hops += world.events.filter((e) => e.type === "shotThroughPortal").length;
    }
    expect(world.projectiles).toHaveLength(1); // still going after 10 s: shots have no lifetime
    expect(hops).toBeGreaterThan(20);
    // Walk into its path and it hits you.
    place(p, 0, 0);
    let hit = false;
    for (let i = 0; i < 60 && !hit; i++) {
      world.step(new Map([[p.id, emptyCommand()]]));
      hit = world.events.some((e) => e.type === "hit" && e.victim === p.id);
    }
    expect(hit).toBe(true);
    expect(world.projectiles).toHaveLength(0);
  });

  it("removes a shot that leaves the level, since it could never hit anything", () => {
    const { world, p } = setup();
    world.step(new Map([[p.id, { ...emptyCommand(), yaw: 0, fire: true }]]));
    expect(world.projectiles).toHaveLength(1);
    // As if it had flown out through an open sky.
    set(world.projectiles[0].origin, 0, 0, world.level.maxs.z + 1000);
    world.step(new Map([[p.id, emptyCommand()]]));
    expect(world.projectiles).toHaveLength(0);
  });

  it("hits the wall when the portal isn't linked", () => {
    const { world, p } = setup();
    shoot(world, p, yawToEast(200));
    place(p, 0, 25);
    const events = fireOnce(world, p, Math.atan2(175, 512));
    expect(events.some((e) => e.type === "shotThroughPortal")).toBe(false);
    const impact = events.find((e) => e.type === "impact");
    expect(impact?.type === "impact" && Math.round(impact.pos.x)).toBe(512);
  });
});
