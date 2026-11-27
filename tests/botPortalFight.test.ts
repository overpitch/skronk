import { describe, expect, it } from "vitest";
import { set, vec3, type Vec3 } from "../src/math/vec3";
import { Bot } from "../src/bots/bot";
import { buildNavGraph } from "../src/bots/nav";
import { emptyCommand, type PlayerCommand } from "../src/sim/command";
import type { SimEvent } from "../src/sim/events";
import { EYE_HEIGHT } from "../src/sim/movement";
import { World, type PlayerState } from "../src/sim/world";
import { loadTestMap } from "./helpers";

// test_box: portal walls east (x 512) and west (x -512; a ramp against it for y 0..256).
const level = loadTestMap();
level.pickups = []; // nothing to fetch: these are about fighting
const nav = buildNavGraph(level, new World(level).collision);
const FLOOR_Z = 24.03125;
const HARD = 0.85;
const NORMAL = 0.5;
const EASY = 0.25;

function place(p: PlayerState, x: number, y: number, yaw = 0) {
  set(p.origin, x, y, FLOOR_Z);
  set(p.prevOrigin, x, y, FLOOR_Z);
  set(p.velocity, 0, 0, 0);
  p.yaw = yaw;
}

/** A pair (owned by player 9, out of the game): east wall at y 200, west wall at y -150. */
function withPortals() {
  const world = new World(level);
  const owner = world.addPlayer(9);
  const shoot = (from: [number, number], at: Vec3) => {
    place(owner, from[0], from[1]);
    const eye = vec3(from[0], from[1], FLOOR_Z + EYE_HEIGHT);
    const yaw = Math.atan2(at.y - eye.y, at.x - eye.x);
    const pitch = Math.atan2(at.z - eye.z, Math.hypot(at.x - eye.x, at.y - eye.y));
    owner.portalCooldown = 0;
    world.step(new Map([[9, { ...emptyCommand(), yaw, pitch, portal: true }]]));
    world.step(new Map([[9, { ...emptyCommand(), yaw, pitch }]]));
  };
  shoot([300, 200], vec3(512, 200, 60));
  shoot([-300, -150], vec3(-512, -150, 60));
  expect(world.portals).toHaveLength(2);
  place(owner, -300, -450); // out of the way, out of sight round the room's corner
  owner.alive = false; // and out of the fight
  owner.respawnTick = Infinity;
  return { world, east: world.portals.find((p) => p.origin.x > 0)!, west: world.portals.find((p) => p.origin.x < 0)! };
}

/** Runs the bot (2) against a target (3) driven by `drive`; returns everything that happened. */
function fight(world: World, bot: Bot, seconds: number, drive: (t: number) => PlayerCommand = () => emptyCommand(), until?: (e: SimEvent[]) => boolean) {
  const all: SimEvent[] = [];
  const target = world.players.get(3)!;
  for (let t = 0; t < seconds * 60; t++) {
    target.protectedUntil = world.players.get(2)!.protectedUntil = 0;
    target.health = 100; // the target never goes down: the test is about what the bot does
    world.step(new Map([[2, bot.command(world)], [3, drive(t)]]));
    all.push(...world.events);
    if (until?.(all)) break;
  }
  return all;
}

describe("bots fighting with portals", () => {
  it("see someone through a portal they're looking into, and shoot them through it", () => {
    const { world } = withPortals();
    // The bot faces the east portal; the target is behind it, in front of the west portal.
    const me = world.addPlayer(2);
    place(me, 300, 200, 0);
    place(world.addPlayer(3), -420, -150, 0);
    const events = fight(world, new Bot(2, nav, HARD), 3);
    expect(events.some((e) => e.type === "hit" && e.attacker === 2 && e.victim === 3)).toBe(true);
    expect(events.some((e) => e.type === "shotThroughPortal")).toBe(true);
  });

  it("not on Easy: lower levels don't think of portals in a fight", () => {
    const { world } = withPortals();
    const me = world.addPlayer(2);
    place(me, 300, 200, 0);
    place(world.addPlayer(3), -420, -150, 0);
    const events = fight(world, new Bot(2, nav, EASY), 1);
    expect(events.some((e) => e.type === "shotThroughPortal")).toBe(false);
  });

  it("know where someone they saw go through a portal came out (even on Easy), so the chase goes on from there", () => {
    const { world } = withPortals();
    const me = world.addPlayer(2);
    place(me, 300, 200, 0);
    const target = world.addPlayer(3);
    place(target, 430, 200, 0);
    const bot = new Bot(2, nav, EASY);
    // The target walks into the east portal and comes out of the west one.
    const events = fight(world, bot, 3, () => ({ ...emptyCommand(), yaw: 0, forward: 1 }), (all) => all.some((e) => e.type === "teleport" && e.player === 3));
    expect(events.some((e) => e.type === "teleport" && e.player === 3)).toBe(true);
    fight(world, bot, 1 / 60);
    expect(bot.lastSeenAt!.x).toBeLessThan(-400); // out of the west wall, not where it went in
  });

  it("slip away through a portal when hurt, if it leads away from the enemy (Normal and up)", () => {
    const { world } = withPortals();
    const me = world.addPlayer(2);
    place(me, 350, 300, -Math.PI / 2);
    place(world.addPlayer(3), 300, -100, Math.PI / 2);
    const bot = new Bot(2, nav, NORMAL);
    const hurt = () => (me.health = 20);
    const events: SimEvent[] = [];
    for (let t = 0; t < 4 * 60 && !events.some((e) => e.type === "teleport" && e.player === 2); t++) {
      hurt();
      events.push(...fight(world, bot, 1 / 60));
    }
    expect(events.some((e) => e.type === "teleport" && e.player === 2)).toBe(true);
  });
});
