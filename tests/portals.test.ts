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
