import { describe, expect, it } from "vitest";
import { set, vec3 } from "../src/math/vec3";
import { Bot, botSkill } from "../src/bots/bot";
import { choosePickup } from "../src/bots/wants";
import type { PlayerCommand } from "../src/sim/command";
import type { SimEvent } from "../src/sim/events";
import { buildNavGraph } from "../src/bots/nav";
import { Navigator } from "../src/bots/navigator";
import { emptyCommand } from "../src/sim/command";
import { World, type PlayerState } from "../src/sim/world";
import { loadTestMap } from "./helpers";

const level = loadTestMap();
const FLOOR = 24.03125;
const LEDGE = 128 + 24.03125;
const nav = buildNavGraph(level, new World(level).collision);
const at = (x: number, y: number, z: number) => nav.nearest(vec3(x, y, z));
/** Just the getting-around part: roam and look where you're going. */
class Roamer {
  private nav: Navigator;
  constructor(readonly id: number) {
    this.nav = new Navigator(id, nav);
  }
  command(world: World) {
    const me = world.players.get(this.id)!;
    const steer = this.nav.steer(world, me);
    const cmd = { ...emptyCommand(), yaw: me.yaw, jump: steer.jump };
    if (steer.dir) {
      cmd.yaw = Math.atan2(steer.dir.y, steer.dir.x);
      cmd.forward = 1;
    }
    return cmd;
  }
}

const heights = (path: number[] | null) => [...new Set((path ?? []).map((i) => Math.round(nav.nodes[i].pos.z)))];

describe("walk graph", () => {
  const floor = at(0, -100, 24);

  it("covers the room and nothing outside it", () => {
    expect(nav.nodes.length).toBeGreaterThan(800);
    // The tops of the ceiling and walls are walkable surfaces, but no spawn can reach them.
    expect(nav.nodes.every((n) => n.pos.z < 384)).toBe(true);
  });

  it("goes up the ramp to the ledge, and back down", () => {
    const up = nav.findPath(floor, at(-416, 400, 152));
    expect(heights(up)).toContain(152);
    expect(heights(up).some((z) => z > 24 && z < 152)).toBe(true); // by the slope, not a leap
    expect(nav.findPath(at(-416, 400, 152), floor)).not.toBeNull();
  });

  it("climbs the steps to the platform", () => {
    expect(heights(nav.findPath(floor, at(352, -384, 88)))).toEqual([24, 40, 56, 72, 88]);
  });

  it("finds jumps onto the low wall and drops off ledges", () => {
    const edges = nav.nodes.flatMap((n) => n.edges.map((e) => ({ from: n.pos, to: nav.nodes[e.to].pos, e })));
    expect(edges.some(({ e, to }) => e.jump && Math.round(to.z) === 64)).toBe(true); // onto the 40-unit wall
    expect(edges.some(({ e, from, to }) => e.drop && from.z > 140 && to.z < 30)).toBe(true); // off the ledge
  });
});

describe("roaming bots", () => {
  it("keep moving and get all over the map, up the ramp and onto the ledge", () => {
    const world = new World(level);
    const bots = [2, 3].map((id) => {
      world.addPlayer(id);
      return new Roamer(id);
    });
    const places = new Set<string>();
    let maxZ = 0;
    let longestStill = 0;
    const still = new Map<number, number>();
    for (let t = 0; t < 90 * 60; t++) {
      const before = bots.map((b) => ({ ...world.players.get(b.id)!.origin }));
      world.step(new Map(bots.map((b) => [b.id, b.command(world)])));
      bots.forEach((b, i) => {
        const p = world.players.get(b.id)!.origin;
        places.add(`${Math.floor(p.x / 128)},${Math.floor(p.y / 128)},${Math.floor(p.z / 48)}`);
        maxZ = Math.max(maxZ, p.z);
        const moved = Math.hypot(p.x - before[i].x, p.y - before[i].y) > 0.5;
        still.set(b.id, moved ? 0 : (still.get(b.id) ?? 0) + 1);
        longestStill = Math.max(longestStill, still.get(b.id)!);
      });
    }
    expect(places.size).toBeGreaterThan(60);
    expect(maxZ).toBeGreaterThan(140); // the ledge
    expect(longestStill).toBeLessThan(30);
  });
});

describe("fighting bots", () => {
  /** A bot (id 2) and a target (id 3) that does nothing unless told. */
  function duel(botAt: [number, number, number], botYaw: number, targetAt: [number, number, number], skill = 0.5) {
    const world = new World(level);
    const bot = new Bot(2, nav, skill);
    const b = world.addPlayer(2);
    const t = world.addPlayer(3);
    set(b.origin, ...botAt);
    set(b.prevOrigin, ...botAt);
    b.yaw = botYaw;
    set(t.origin, ...targetAt);
    set(t.prevOrigin, ...targetAt);
    return { world, bot, b, t };
  }
  const run = (world: World, bot: Bot, ticks: number, target: () => PlayerCommand = emptyCommand) => {
    const events: SimEvent[] = [];
    for (let i = 0; i < ticks; i++) {
      world.step(new Map([[2, bot.command(world)], [3, target()]]));
      events.push(...world.events);
    }
    return events;
  };

  it("spots an enemy in front, waits its reaction time, then shoots it down", () => {
    const { world, bot, t } = duel([-300, -300, FLOOR], Math.PI / 4, [200, 200, FLOOR]);
    const events: SimEvent[] = [];
    let firstShot = -1;
    for (let i = 0; i < 8 * 60 && t.alive; i++) {
      events.push(...run(world, bot, 1));
      if (firstShot < 0 && events.some((e) => e.type === "fire")) firstShot = i;
    }
    expect(firstShot).toBeGreaterThanOrEqual(botSkill(0.5).reactionTicks - 1);
    expect(events.some((e) => e.type === "kill" && e.attacker === 2 && e.victim === 3)).toBe(true);
  });

  it("is sharper at higher skill", () => {
    const killTime = (skill: number) => {
      const { world, bot, t } = duel([-300, -300, FLOOR], Math.PI / 4, [200, 200, FLOOR], skill);
      let i = 0;
      while (t.alive && i < 20 * 60) {
        run(world, bot, 1);
        i++;
      }
      return i;
    };
    expect(killTime(1)).toBeLessThan(killTime(0));
  });

  it("turns on whoever shoots it from behind", () => {
    // Bot faces away (+x); the target, behind it, shoots it in the back.
    const { world, bot, b, t } = duel([0, 0, FLOOR], 0, [-400, 0, FLOOR]);
    let hitBack = false;
    for (let i = 0; i < 4 * 60 && !hitBack; i++) {
      for (const e of run(world, bot, 1, () => ({ ...emptyCommand(), yaw: 0, fire: i % 7 === 0 }))) {
        if (e.type === "hit" && e.attacker === 2) hitBack = true;
      }
    }
    expect(hitBack).toBe(true);
    // Facing the shooter from wherever it has moved to.
    const toShooter = Math.atan2(t.origin.y - b.origin.y, t.origin.x - b.origin.x);
    expect(Math.abs(Math.atan2(Math.sin(b.yaw - toShooter), Math.cos(b.yaw - toShooter)))).toBeLessThan(0.3);
  });

  it("chases to where it last saw an enemy who ducked out of sight", () => {
    const { world, bot, b, t } = duel([-300, -300, FLOOR], Math.PI / 4, [0, 0, FLOOR]);
    run(world, bot, 20); // seen
    // The target slips behind the pillar (north side of it), out of view.
    set(t.origin, -200, 320, FLOOR);
    set(t.prevOrigin, -200, 320, FLOOR);
    const start = Math.hypot(b.origin.x, b.origin.y);
    run(world, bot, 60);
    expect(Math.hypot(b.origin.x, b.origin.y)).toBeLessThan(start - 100); // ran towards (0, 0)
  });

  it("doesn't strafe off the ledge while fighting someone below (walking down the ramp is fine)", () => {
    // Target out on the floor, in clear view of the ledge (not behind the pillar).
    const { world, bot, b, t } = duel([-416, 400, LEDGE], Math.atan2(-700, 316), [-100, -300, FLOOR]);
    let shots = 0;
    // Every time it leaves the ground, how far below the take-off point it lands.
    let takeoff: number | null = null;
    let biggestDrop = 0;
    // Only while the fight is on: once the target is down, a route to a pickup may drop off the ledge.
    for (let i = 0; i < 5 * 60 && t.alive; i++) {
      shots += run(world, bot, 1).filter((e) => e.type === "fire").length;
      if (!b.onGround && takeoff === null) takeoff = b.prevOrigin.z;
      if (b.onGround && takeoff !== null) {
        biggestDrop = Math.max(biggestDrop, takeoff - b.origin.z);
        takeoff = null;
      }
    }
    expect(shots).toBeGreaterThan(10); // it was fighting, not roaming
    expect(biggestDrop).toBeLessThan(48);
  });

  it("never fires without a clear line to someone", () => {
    const world = new World(level);
    const bots = [2, 3, 4].map((id) => {
      world.addPlayer(id);
      return new Bot(id, nav, 0.5);
    });
    let fires = 0;
    let blind = 0;
    let kills = 0;
    for (let i = 0; i < 60 * 60; i++) {
      world.step(new Map(bots.map((x) => [x.id, x.command(world)])));
      for (const e of world.events) {
        if (e.type === "kill") kills++;
        if (e.type !== "fire") continue;
        fires++;
        const others = [...world.players.values()].filter((p) => p.id !== e.player && p.alive);
        // Chest or head in clear view of the shooter's eye.
        const seen = others.some((p) =>
          [4, 22].some((h) => world.collision.traceBox(e.origin, vec3(p.origin.x, p.origin.y, p.origin.z + h), vec3(), vec3()).fraction === 1),
        );
        if (!seen) blind++;
      }
    }
    expect(fires).toBeGreaterThan(50);
    expect(kills).toBeGreaterThan(3);
    // A bot decides from where it stands at the start of a tick; the shot leaves from where it
    // is after moving that tick, so now and then it has just stepped behind cover.
    expect(blind).toBeLessThan(fires * 0.02);
  });
});

describe("bots and pickups", () => {
  // test_box pickups: health on the platform (352, -384), armor on the ledge (-416, 384), ammo on the floor (0, 400).
  const kinds = () => level.pickups.map((p) => p.kind);
  const index = (kind: string) => kinds().indexOf(kind);

  function lone(at: [number, number, number], setup: (p: PlayerState) => void) {
    const world = new World(level);
    const bot = new Bot(2, nav);
    const p = world.addPlayer(2);
    set(p.origin, ...at);
    set(p.prevOrigin, ...at);
    setup(p);
    const runFor = (seconds: number, until: () => boolean) => {
      for (let i = 0; i < seconds * 60 && !until(); i++) world.step(new Map([[2, bot.command(world)]]));
    };
    return { world, bot, p, runFor };
  }

  it("goes and gets ammo when it runs out", () => {
    const { p, runFor } = lone([0, -300, FLOOR], (p) => (p.ammo = 0));
    runFor(10, () => p.ammo > 0);
    expect(p.ammo).toBe(50);
  });

  it("goes and gets health when it's hurt", () => {
    const { p, runFor } = lone([-300, 0, FLOOR], (p) => (p.health = 20));
    runFor(12, () => p.health > 20);
    expect(p.health).toBe(45);
  });

  it("picks up armor in passing when it's close", () => {
    const { p, runFor } = lone([-416, 300, LEDGE], (p) => (p.armor = 0));
    runFor(4, () => p.armor > 0);
    expect(p.armor).toBe(50);
  });

  it("skips a pickup that won't be back by the time it gets there", () => {
    const { world, p } = lone([0, -300, FLOOR], (p) => (p.ammo = 0));
    expect(choosePickup(world, p, nav)?.index).toBe(index("ammo"));
    world.pickups[index("ammo")].availableAtTick = world.tick + 60 * 60;
    expect(choosePickup(world, p, nav)?.index).not.toBe(index("ammo"));
  });

  it("backs off towards health while still shooting when it's hurting in a fight", () => {
    const world = new World(level);
    const bot = new Bot(2, nav);
    const b = world.addPlayer(2);
    const t = world.addPlayer(3);
    // Bot in the open near the platform's steps, the target off to the west.
    set(b.origin, 150, -150, FLOOR);
    set(b.prevOrigin, 150, -150, FLOOR);
    b.yaw = Math.PI;
    b.health = 25;
    set(t.origin, -350, -150, FLOOR);
    set(t.prevOrigin, -350, -150, FLOOR);
    const health = world.pickups[index("health")].origin;
    const dist = () => Math.hypot(b.origin.x - health.x, b.origin.y - health.y);
    const start = dist();
    let shots = 0;
    for (let i = 0; i < 90 && b.health === 25; i++) {
      world.step(new Map([[2, bot.command(world)], [3, emptyCommand()]]));
      shots += world.events.filter((e) => e.type === "fire" && e.player === 2).length;
    }
    expect(shots).toBeGreaterThan(0);
    expect(dist()).toBeLessThan(start - 100);
  });
});
