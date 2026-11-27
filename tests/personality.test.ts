import { describe, expect, it } from "vitest";
import { set, type Vec3 } from "../src/math/vec3";
import { Bot } from "../src/bots/bot";
import { buildNavGraph } from "../src/bots/nav";
import { PERSONALITIES, personalityFor, type Personality } from "../src/bots/personality";
import { TargetDummy } from "../src/bots/targetDummy";
import { chooseWeapon } from "../src/bots/weaponChoice";
import { FISTS, MACHINE_GUN, WEAPONS, weaponIndex } from "../src/sim/weapons";
import { World } from "../src/sim/world";
import { loadTestMap } from "./helpers";

const arena = loadTestMap("arena");
const nav = buildNavGraph(arena, new World(arena).collision);
const named = (name: string) => PERSONALITIES.find((p) => p.name === name)!;
const RAILGUN = weaponIndex("railgun");
const ROCKETS = weaponIndex("rocketlauncher");

function place(p: { origin: Vec3; prevOrigin: Vec3; velocity: Vec3 }, x: number, y: number) {
  set(p.origin, x, y, 24.5);
  set(p.prevOrigin, x, y, 24.5);
  set(p.velocity, 0, 0, 0);
}

describe("bot personalities", () => {
  it("come in roster order, the all-rounder first, each with its own name", () => {
    expect(personalityFor(0).name).toBe("Pip");
    expect(new Set(PERSONALITIES.map((p) => p.name)).size).toBe(PERSONALITIES.length);
    expect(personalityFor(PERSONALITIES.length)).toBe(personalityFor(0));
  });

  it("have favourite weapons: at the same distance the sniper takes the railgun, the all-rounder rockets", () => {
    const holding = { weapon: MACHINE_GUN, weapons: (1 << FISTS) | (1 << MACHINE_GUN) | (1 << RAILGUN) | (1 << ROCKETS), ammo: WEAPONS.map((w) => w.maxAmmo) };
    expect(chooseWeapon(holding, 450, 0.15, named("Pip").weaponBias)).toBe(ROCKETS);
    expect(chooseWeapon(holding, 450, 0.15, named("Vesper").weaponBias)).toBe(RAILGUN);
  });

  /** Average distance a bot keeps from a target standing still, over the last part of a fight. */
  function fightDistance(personality: Personality): number {
    const world = new World(arena);
    const me = world.addPlayer(1);
    const target = world.addPlayer(2);
    place(me, -300, 0);
    place(target, 300, 0);
    const bot = new Bot(1, nav, 0.6, personality);
    const dummy = new TargetDummy(2, false, 0);
    let total = 0;
    let samples = 0;
    for (let t = 0; t < 8 * 60; t++) {
      me.weapons = (1 << FISTS) | (1 << MACHINE_GUN);
      me.ammo = WEAPONS.map((w) => w.maxAmmo);
      target.health = 100;
      me.protectedUntil = target.protectedUntil = 0;
      world.step(new Map([[1, bot.command(world)], [2, dummy.command(world)]]));
      if (t > 4 * 60) {
        total += Math.hypot(me.origin.x - target.origin.x, me.origin.y - target.origin.y);
        samples++;
      }
    }
    return total / samples;
  }

  it("fight at their own distance: the rusher closes in, the sniper keeps back", () => {
    const rook = fightDistance(named("Rook"));
    const vesper = fightDistance(named("Vesper"));
    expect(rook).toBeLessThan(400);
    expect(vesper).toBeGreaterThan(rook + 150);
  });

  /** How far a lone bot wanders over the last 10 of 40 seconds (the size of the area it covers). */
  function wander(personality: Personality): { span: number; at: Vec3 } {
    const world = new World(arena);
    const me = world.addPlayer(1);
    const bot = new Bot(1, nav, 0.5, personality);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let t = 0; t < 40 * 60; t++) {
      world.step(new Map([[1, bot.command(world)]]));
      if (t > 30 * 60) {
        x0 = Math.min(x0, me.origin.x); x1 = Math.max(x1, me.origin.x);
        y0 = Math.min(y0, me.origin.y); y1 = Math.max(y1, me.origin.y);
      }
    }
    return { span: Math.hypot(x1 - x0, y1 - y0), at: { ...me.origin } };
  }

  it("camp or roam: the sniper holds a spot by the railgun, the all-rounder roams", () => {
    const vesper = wander(named("Vesper"));
    const railgun = arena.pickups.find((p) => p.kind === "railgun")!.origin;
    expect(vesper.span).toBeLessThan(120);
    expect(Math.hypot(vesper.at.x - railgun.x, vesper.at.y - railgun.y)).toBeLessThan(120);
    expect(wander(named("Pip")).span).toBeGreaterThan(300);
  });
});
