import { describe, expect, it } from "vitest";
import { set } from "../src/math/vec3";
import { buildNavGraph } from "../src/bots/nav";
import { MonsterDirector } from "../src/bots/monsterDirector";
import { Bot } from "../src/bots/bot";
import { applySnapshot, captureSnapshot } from "../src/net/snapshot";
import { emptyCommand, type PlayerCommand } from "../src/sim/command";
import type { SimEvent } from "../src/sim/events";
import { HORDE, waveSize, type MatchRules } from "../src/sim/match";
import { MONSTERS, isMonsterId } from "../src/sim/monsters";
import { WEAPONS, weaponIndex } from "../src/sim/weapons";
import { World, type PlayerState } from "../src/sim/world";
import { loadTestMap } from "./helpers";

const HORDE_RULES: MatchRules = { fragLimit: 0, timeLimitTicks: 0, mode: "horde" };
const arena = loadTestMap("arena");
const nav = buildNavGraph(arena, new World(arena).collision);
const RAILGUN = weaponIndex("railgun");

function place(p: { origin: { x: number; y: number; z: number }; prevOrigin: { x: number; y: number; z: number }; velocity: { x: number; y: number; z: number } }, x: number, y: number) {
  set(p.origin, x, y, 24.5);
  set(p.prevOrigin, x, y, 24.5);
  set(p.velocity, 0, 0, 0);
}

function horde() {
  const world = new World(arena, HORDE_RULES);
  const director = new MonsterDirector(nav);
  const run = (ticks: number, cmds: (t: number) => Map<number, PlayerCommand> = () => new Map(), until?: (e: SimEvent[]) => boolean) => {
    const all: SimEvent[] = [];
    for (let t = 0; t < ticks; t++) {
      world.step(cmds(t), director.commands(world));
      all.push(...world.events);
      if (until?.(all)) break;
    }
    return all;
  };
  return { world, run };
}

const armRail = (p: PlayerState) => {
  p.weapons |= 1 << RAILGUN;
  p.ammo = WEAPONS.map((w) => w.maxAmmo);
  p.weapon = RAILGUN;
};

describe("Horde mode", () => {
  it("starts the first wave after a moment, its monsters coming in a few at a time", () => {
    const { world, run } = horde();
    world.addPlayer(1);
    const start = run(HORDE.firstWaveTicks + 1);
    expect(start).toContainEqual({ type: "waveStart", wave: 1 });
    expect(world.monsters.length).toBeLessThanOrEqual(1);
    run(HORDE.spawnEveryTicks * waveSize(1) + 5);
    expect(world.monsters.filter((m) => m.alive)).toHaveLength(waveSize(1));
    expect(world.monsters.every((m) => isMonsterId(m.id))).toBe(true);
  });

  it("sends them after you, slower than you run, and they swipe when they reach you", () => {
    const { world, run } = horde();
    const me = world.addPlayer(1);
    place(me, 0, 0);
    const events = run(30 * 60, () => new Map(), (all) => all.some((e) => e.type === "hit" && e.victim === 1));
    const swipe = events.find((e) => e.type === "hit" && e.victim === 1);
    expect(swipe?.type === "hit" && isMonsterId(swipe.attacker)).toBe(true);
    expect(swipe?.type === "hit" && swipe.damage).toBe(MONSTERS.shambler.damage);
    expect(events.some((e) => e.type === "monsterAttack")).toBe(true);
    const fastest = Math.max(...world.monsters.map((m) => Math.hypot(m.velocity.x, m.velocity.y)));
    expect(fastest).toBeLessThanOrEqual(MONSTERS.shambler.speed + 1);
  });

  it("they die to your shots, and each counts for you", () => {
    const { world, run } = horde();
    const me = world.addPlayer(1);
    run(HORDE.firstWaveTicks + 2);
    const m = world.monsters[0];
    place(me, -400, 0);
    place(m, 0, 0);
    armRail(me);
    me.fireCooldown = 0;
    const events = run(1, () => new Map([[1, { ...emptyCommand(), yaw: 0, fire: true }]]));
    expect(events).toContainEqual({ type: "kill", attacker: 1, victim: m.id, weapon: "railgun" });
    expect(m.alive).toBe(false);
    expect(me.frags).toBe(1);
  });

  it("clears a wave when its monsters are all dead, then brings everyone back for the next", () => {
    const { world, run } = horde();
    const me = world.addPlayer(1);
    const ally = world.addPlayer(2);
    place(me, -500, 0);
    armRail(me);
    // Shoot each monster as it comes (they're slow), until the wave is cleared.
    const aimAtNearest = () => {
      const target = world.monsters.find((m) => m.alive);
      const cmd = { ...emptyCommand(), yaw: me.yaw, fire: false };
      if (target) {
        const dx = target.origin.x - me.origin.x;
        const dy = target.origin.y - me.origin.y;
        cmd.yaw = Math.atan2(dy, dx);
        cmd.fire = true;
      }
      me.ammo[RAILGUN] = 25;
      me.health = 100;
      return new Map([[1, cmd]]);
    };
    run(HORDE.firstWaveTicks + 1);
    ally.alive = false; // down during wave 1: out until the next wave
    ally.respawnTick = Infinity;
    const events = run(60 * 60, aimAtNearest, (all) => all.some((e) => e.type === "waveCleared"));
    expect(events).toContainEqual({ type: "waveCleared", wave: 1 });
    expect(ally.alive).toBe(false);
    const next = run(HORDE.breakTicks + 2);
    expect(next).toContainEqual({ type: "waveStart", wave: 2 });
    expect(ally.alive).toBe(true);
  });

  it("is over when everyone is down at once: the horde wins", () => {
    const { world, run } = horde();
    const me = world.addPlayer(1);
    place(me, 0, 0);
    me.armor = 0;
    me.health = 1;
    const events = run(40 * 60, () => {
      me.protectedUntil = 0;
      return new Map();
    }, (all) => all.some((e) => e.type === "matchOver"));
    expect(events).toContainEqual({ type: "matchOver", winner: null });
    expect(world.match.phase).toBe("over");
    expect(me.respawnTick).toBe(Infinity);
  });

  it("puts players on one side: no friendly fire", () => {
    const world = new World(arena, HORDE_RULES);
    const a = world.addPlayer(1);
    const b = world.addPlayer(2);
    place(a, -300, 0);
    place(b, 0, 0);
    a.protectedUntil = b.protectedUntil = 0;
    armRail(a);
    a.fireCooldown = 0;
    world.step(new Map([[1, { ...emptyCommand(), yaw: 0, fire: true }]]));
    expect(b.health).toBe(100);
    expect(world.areEnemies(a, b)).toBe(false);
    expect(world.areEnemies(a, { id: 100000, team: -1 })).toBe(true);
  });

  it("sends monsters in snapshots", () => {
    const { world, run } = horde();
    world.addPlayer(1);
    run(HORDE.firstWaveTicks + HORDE.spawnEveryTicks * 3);
    const mirror = new World(arena, HORDE_RULES);
    applySnapshot(mirror, JSON.parse(JSON.stringify(captureSnapshot(world))));
    expect(mirror.monsters.map((m) => m.id)).toEqual(world.monsters.map((m) => m.id));
    expect(mirror.match.horde).toEqual(world.match.horde);
  });

  it("has bots fight the horde alongside you, never at you", () => {
    const { world, run } = horde();
    const me = world.addPlayer(1);
    world.addPlayer(2);
    const bot = new Bot(2, nav, 0.6);
    const hits: SimEvent[] = [];
    for (let t = 0; t < 40 * 60 && world.match.phase === "playing"; t++) {
      me.health = 100; // you just stand there; the bot does the work
      hits.push(...run(1, () => new Map([[2, bot.command(world)]])));
    }
    const botKills = hits.filter((e) => e.type === "kill" && e.attacker === 2 && isMonsterId(e.victim));
    expect(botKills.length).toBeGreaterThan(0);
    expect(hits.some((e) => e.type === "hit" && e.attacker === 2 && !isMonsterId(e.victim))).toBe(false);
  });
});
