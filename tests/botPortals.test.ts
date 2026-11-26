import { describe, expect, it } from "vitest";
import { set, vec3, type Vec3 } from "../src/math/vec3";
import { buildNavGraph } from "../src/bots/nav";
import { Navigator } from "../src/bots/navigator";
import { portalLinks } from "../src/bots/portalLinks";
import { choosePickup } from "../src/bots/wants";
import { emptyCommand } from "../src/sim/command";
import { EYE_HEIGHT } from "../src/sim/movement";
import { World, type PlayerState } from "../src/sim/world";
import { loadTestMap } from "./helpers";

// Portal Gym: hall floor at z 0; a ledge 256 up in the north-east corner (x 768..1024,
// y 256..640) that only portals reach; the east wall above it and the west wall take portals.
const level = loadTestMap("portal_gym");
const nav = buildNavGraph(level, new World(level).collision);
const FLOOR_Z = 24.03125;
const LEDGE = vec3(896, 448, 256 + FLOOR_Z);

function place(p: PlayerState, x: number, y: number, z = FLOOR_Z) {
  set(p.origin, x, y, z);
  set(p.prevOrigin, x, y, z);
  set(p.velocity, 0, 0, 0);
}

/** Player `id` stands at `from` and fires a portal at `target`. */
function portalAt(world: World, id: number, from: [number, number], target: Vec3) {
  const p = world.players.get(id)!;
  place(p, from[0], from[1]);
  const eye = vec3(from[0], from[1], FLOOR_Z + EYE_HEIGHT);
  const yaw = Math.atan2(target.y - eye.y, target.x - eye.x);
  const pitch = Math.atan2(target.z - eye.z, Math.hypot(target.x - eye.x, target.y - eye.y));
  p.portalCooldown = 0;
  world.step(new Map([[id, { ...emptyCommand(), yaw, pitch, portal: true }]]));
  world.step(new Map([[id, { ...emptyCommand(), yaw, pitch }]]));
}

/** A west-wall portal on the hall floor, and its partner high on the east wall above the ledge. */
function ledgePortals() {
  const world = new World(level);
  world.addPlayer(9);
  portalAt(world, 9, [-700, 450], vec3(-1024, 450, 60));
  portalAt(world, 9, [0, 448], vec3(1024, 448, 400));
  expect(world.portals).toHaveLength(2);
  place(world.players.get(9)!, -600, -500); // out of the way
  return world;
}

/** Follows a navigator, like a bot that only gets around. */
function follow(world: World, id: number, goal: Vec3, seconds: number): boolean {
  const navigator = new Navigator(id, nav);
  navigator.goTo(goal);
  const me = world.players.get(id)!;
  for (let t = 0; t < seconds * 60; t++) {
    const steer = navigator.steer(world, me);
    const cmd = { ...emptyCommand(), yaw: me.yaw, jump: steer.jump };
    if (steer.dir) {
      cmd.yaw = Math.atan2(steer.dir.y, steer.dir.x);
      cmd.forward = 1;
    }
    world.step(new Map([[id, cmd]]));
    if (Math.hypot(me.origin.x - goal.x, me.origin.y - goal.y) < 48 && Math.abs(me.origin.z - goal.z) < 24) return true;
  }
  return false;
}

describe("bots and portals", () => {
  it("keep the ledge in the walk graph though nobody can walk there", () => {
    const ledge = nav.nearest(LEDGE);
    expect(ledge).toBeGreaterThanOrEqual(0);
    expect(nav.nodes[ledge].pos.z).toBeCloseTo(LEDGE.z, 0);
    const floor = nav.nearest(vec3(-600, -300, FLOOR_Z));
    expect(nav.findPath(floor, ledge)).toBeNull();
  });

  it("don't keep the outside of the map (the roof)", () => {
    expect(nav.nodes.every((n) => n.pos.z < 512)).toBe(true);
  });

  it("see a shortcut through an open pair: into the west wall, out above the ledge", () => {
    const world = ledgePortals();
    const links = portalLinks(world, nav);
    const all = [...links.values()].flat();
    const toLedge = all.find((e) => nav.nodes[e.to].pos.z > 200);
    expect(toLedge).toBeDefined();
    const floor = nav.nearest(vec3(-600, -300, FLOOR_Z));
    expect(nav.findPath(floor, nav.nearest(LEDGE), links)).not.toBeNull();
  });

  it("walk through it to get onto the ledge", () => {
    const world = ledgePortals();
    const bot = world.addPlayer(2);
    place(bot, -600, -300);
    expect(follow(world, 2, LEDGE, 15)).toBe(true);
  });

  it("can't get there once the portals are gone", () => {
    const world = ledgePortals();
    world.removePlayer(9); // their portals go with them
    expect(portalLinks(world, nav).size).toBe(0);
    const bot = world.addPlayer(2);
    place(bot, -600, -300);
    expect(follow(world, 2, LEDGE, 3)).toBe(false);
  });

  it("go for a pickup up there through the portals", () => {
    const withArmor = loadTestMap("portal_gym");
    // Only an armor on the ledge (not the one at the bottom of the chasm, which is closer).
    withArmor.pickups = [{ kind: "armor", origin: vec3(896, 448, 273), properties: {} }];
    const world = new World(withArmor);
    world.addPlayer(9);
    portalAt(world, 9, [-700, 450], vec3(-1024, 450, 60));
    portalAt(world, 9, [0, 448], vec3(1024, 448, 400));
    place(world.players.get(9)!, -600, -500);
    const me = world.addPlayer(2);
    place(me, -600, -300);
    me.armor = 0;
    expect(choosePickup(world, me, nav)?.index).toBe(0);
    world.removePlayer(9);
    expect(choosePickup(world, me, nav)).toBeNull(); // portals gone: out of reach
  });

  it("drop into a floor portal: out of the fling pit's floor and out of the west wall", () => {
    const world = new World(level);
    world.addPlayer(9);
    // Stand at the pit's edge and fire down onto its floor; then a west wall portal.
    portalAt(world, 9, [448, -236], vec3(448, -448, -256));
    portalAt(world, 9, [-700, 450], vec3(-1024, 450, 60));
    expect(world.portals).toHaveLength(2);
    place(world.players.get(9)!, -600, -500);
    const links = [...portalLinks(world, nav).entries()];
    const fromPit = links.find(([from]) => nav.nodes[from].pos.z < -200);
    expect(fromPit).toBeDefined();
    const landing = nav.nodes[fromPit![1][0].to].pos;
    expect(landing.x).toBeLessThan(-600); // came out of the west wall onto the hall floor
    expect(landing.z).toBeCloseTo(FLOOR_Z, 0);
  });
});
