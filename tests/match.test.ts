import { describe, expect, it } from "vitest";
import { set } from "../src/math/vec3";
import { applySnapshot, captureSnapshot } from "../src/net/snapshot";
import { emptyCommand, type PlayerCommand } from "../src/sim/command";
import type { SimEvent } from "../src/sim/events";
import { decideWinner, newMatch, SPAWN_PROTECTION_TICKS, ticksLeft, type MatchRules } from "../src/sim/match";
import { secondsToTicks } from "../src/sim/tick";
import { WEAPON } from "../src/sim/weapon";
import { World, type PlayerState } from "../src/sim/world";
import { loadTestMap } from "./helpers";

const FLOOR_Z = 24.5;

function place(p: PlayerState, x: number, y: number, z = FLOOR_Z) {
  set(p.origin, x, y, z);
  set(p.prevOrigin, x, y, z);
  set(p.velocity, 0, 0, 0);
}

const aim = (yaw: number, fire = true): PlayerCommand => ({ ...emptyCommand(), yaw, fire });

function run(world: World, n: number, cmds: Record<number, PlayerCommand> = {}): SimEvent[] {
  const all: SimEvent[] = [];
  const map = new Map(Object.entries(cmds).map(([id, c]) => [Number(id), c]));
  for (let i = 0; i < n; i++) {
    world.step(map);
    all.push(...world.events);
  }
  return all;
}

/** A looks along +X at B, nothing between them, no spawn protection. */
function duel(rules: MatchRules) {
  const world = new World(loadTestMap(), rules);
  const a = world.addPlayer(1);
  const b = world.addPlayer(2);
  place(a, -300, -300);
  place(b, 0, -300);
  a.protectedUntil = b.protectedUntil = 0;
  a.fireCooldown = b.fireCooldown = 0;
  return { world, a, b };
}

describe("deciding the winner", () => {
  const scores = (...f: number[]) => f.map((frags, i) => ({ id: i + 1, frags }));
  const fragsTo3 = newMatch({ fragLimit: 3, timeLimitTicks: 0 }, 0);
  const fiveMinutes = newMatch({ fragLimit: 0, timeLimitTicks: secondsToTicks(300) }, 100);

  it("goes to the first to the frag limit", () => {
    expect(decideWinner(fragsTo3, 50, scores(2, 1)).winner).toBe(null);
    expect(decideWinner(fragsTo3, 50, scores(1, 3)).winner).toBe(2);
  });

  it("plays on when the clock runs out with the lead tied, until someone is ahead", () => {
    const end = 100 + secondsToTicks(300);
    expect(decideWinner(fiveMinutes, end - 1, scores(4, 4))).toEqual({ winner: null, suddenDeath: false });
    expect(decideWinner(fiveMinutes, end, scores(4, 4, 1))).toEqual({ winner: null, suddenDeath: true });
    expect(decideWinner(fiveMinutes, end + 500, scores(4, 5, 1))).toEqual({ winner: 2, suddenDeath: false });
  });

  it("counts the clock down from the match's start", () => {
    expect(ticksLeft(fiveMinutes, 100)).toBe(secondsToTicks(300));
    expect(ticksLeft(fiveMinutes, 100 + secondsToTicks(300) + 50)).toBe(0);
    expect(ticksLeft(fragsTo3, 1000)).toBe(0);
  });
});

describe("a match", () => {
  it("ends at the frag limit and holds everything still", () => {
    const { world, a, b } = duel({ fragLimit: 1, timeLimitTicks: 0 });
    b.health = WEAPON.damage;
    const events = [...run(world, 1, { 1: aim(0) }), ...run(world, 20)];
    expect(events).toContainEqual({ type: "matchOver", winner: 1 });
    expect(world.match.phase).toBe("over");
    expect(world.match.winner).toBe(1);

    // Nobody moves, shoots or respawns on the end screen.
    const at = { ...a.origin };
    const later = run(world, 300, { 1: { ...emptyCommand(), forward: 1, fire: true } });
    expect(a.origin).toEqual(at);
    expect(later.filter((e) => e.type === "fire" || e.type === "respawn")).toEqual([]);
    expect(b.alive).toBe(false);
  });

  it("ends when time is up, with the leader winning", () => {
    const { world, a } = duel({ fragLimit: 0, timeLimitTicks: 120 });
    a.frags = 2;
    run(world, 119);
    expect(world.match.phase).toBe("playing");
    expect(run(world, 1)).toContainEqual({ type: "matchOver", winner: 1 });
  });

  it("goes to sudden death on a tie at the time limit", () => {
    const { world, a, b } = duel({ fragLimit: 0, timeLimitTicks: 60 });
    a.frags = b.frags = 1;
    expect(run(world, 60)).toContainEqual({ type: "suddenDeath" });
    expect(world.match.suddenDeath).toBe(true);
    run(world, 600);
    expect(world.match.phase).toBe("playing");
    b.health = WEAPON.damage;
    expect(run(world, 20, { 1: aim(0) })).toContainEqual({ type: "matchOver", winner: 1 });
  });

  it("starts fresh on a rematch: scores zero, shots and portals gone, everyone respawned", () => {
    const { world, a, b } = duel({ fragLimit: 1, timeLimitTicks: 0 });
    a.deaths = 3;
    b.health = WEAPON.damage;
    run(world, 1, { 1: aim(0) });
    run(world, 1, { 1: { ...aim(Math.PI / 2, false), portal: true } }); // a portal (if it lands) to be cleared
    run(world, 20);
    expect(world.match.phase).toBe("over");

    world.rematch();
    const events = run(world, 1);
    expect(events).toContainEqual({ type: "matchStart" });
    expect(events.filter((e) => e.type === "respawn")).toHaveLength(2);
    expect(world.match.phase).toBe("playing");
    expect(world.match.startTick).toBe(world.tick - 1);
    expect([a.frags, a.deaths, b.frags, b.deaths]).toEqual([0, 0, 0, 0]);
    expect(b.alive).toBe(true);
    expect(world.portals).toHaveLength(0);
    expect(world.projectiles).toHaveLength(0);
  });

  it("doesn't let a fire button held through the rematch shoot (or give up protection)", () => {
    const { world, a } = duel({ fragLimit: 1, timeLimitTicks: 0 });
    a.frags = 1;
    run(world, 1);
    world.rematch();
    const events = run(world, 5, { 1: aim(0), 2: aim(Math.PI) });
    expect(events.some((e) => e.type === "fire")).toBe(false);
    expect(a.protectedUntil).toBeGreaterThan(world.tick);
  });

  it("has no limits in free play", () => {
    const { world, a } = duel({ fragLimit: 0, timeLimitTicks: 0 });
    a.frags = 1000;
    run(world, 10);
    expect(world.match.phase).toBe("playing");
  });

  it("travels in snapshots", () => {
    const { world, a, b } = duel({ fragLimit: 1, timeLimitTicks: 600 });
    b.health = WEAPON.damage;
    run(world, 21, { 1: aim(0) });
    const mirror = new World(loadTestMap());
    applySnapshot(mirror, JSON.parse(JSON.stringify(captureSnapshot(world))));
    expect(mirror.match).toEqual(world.match);
    a.protectedUntil = 1234;
    applySnapshot(mirror, captureSnapshot(world));
    expect(mirror.players.get(1)!.protectedUntil).toBe(1234);
  });
});

describe("spawn protection", () => {
  it("soaks up shots for a moment after spawning, then wears off", () => {
    const { world, b } = duel({ fragLimit: 0, timeLimitTicks: 0 });
    b.protectedUntil = world.tick + SPAWN_PROTECTION_TICKS;
    const early = run(world, 10, { 1: aim(0) });
    expect(early.some((e) => e.type === "shielded" && e.victim === 2)).toBe(true);
    expect(early.some((e) => e.type === "hit")).toBe(false);
    expect(b.health).toBe(100);

    run(world, SPAWN_PROTECTION_TICKS);
    place(b, 0, -300);
    const late = run(world, 10, { 1: aim(0) });
    expect(late.some((e) => e.type === "hit" && e.victim === 2)).toBe(true);
    expect(b.health).toBeLessThan(100);
  });

  it("ends as soon as you fire", () => {
    const { world, a } = duel({ fragLimit: 0, timeLimitTicks: 0 });
    a.protectedUntil = world.tick + SPAWN_PROTECTION_TICKS;
    run(world, 1, { 1: aim(Math.PI / 2) });
    expect(a.protectedUntil).toBe(0);
  });

  it("comes with every respawn", () => {
    const world = new World(loadTestMap());
    const p = world.addPlayer(1);
    expect(p.protectedUntil).toBe(world.tick + SPAWN_PROTECTION_TICKS);
  });
});

describe("fair spawns", () => {
  const arena = loadTestMap("arena");

  it("never puts you on top of someone, and keeps you away from the enemy", () => {
    const world = new World(arena);
    const me = world.addPlayer(1);
    const enemy = world.addPlayer(2);
    const spawns = arena.spawns;
    // The enemy camps one spawn.
    const camped = spawns[0].origin;
    place(enemy, camped.x, camped.y, camped.z);
    const dist = (s: { x: number; y: number }) => Math.hypot(s.x - camped.x, s.y - camped.y);
    const farthest = Math.max(...spawns.map((s) => dist(s.origin)));
    const picked = new Set<number>();
    for (let i = 0; i < 40; i++) {
      world.respawn(me);
      world.tick++;
      expect(dist(me.origin)).toBeGreaterThan(0);
      // Counting sight, a fair pick is never right next to the camper.
      expect(dist(me.origin)).toBeGreaterThan(farthest * 0.25);
      picked.add(spawns.findIndex((s) => s.origin.x === me.origin.x && s.origin.y === me.origin.y));
    }
    expect(picked.has(0)).toBe(false);
  });

  it("varies among the good spawns rather than always the same one", () => {
    const world = new World(arena);
    const me = world.addPlayer(1);
    const enemy = world.addPlayer(2);
    place(enemy, 0, 0, arena.spawns[0].origin.z);
    const picked = new Set<string>();
    for (let i = 0; i < 40; i++) {
      world.respawn(me);
      world.tick++;
      picked.add(`${me.origin.x},${me.origin.y}`);
    }
    expect(picked.size).toBeGreaterThan(1);
  });
});
