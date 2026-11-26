import { describe, expect, it } from "vitest";
import { set } from "../src/math/vec3";
import { buildNavGraph } from "../src/bots/nav";
import { Bot } from "../src/bots/bot";
import { TargetDummy } from "../src/bots/targetDummy";
import { DIFFICULTIES } from "../src/client/settings";
import { WEAPONS, weaponIndex } from "../src/sim/weapons";
import { emptyCommand } from "../src/sim/command";
import { World } from "../src/sim/world";
import { loadTestMap } from "./helpers";

const level = loadTestMap("arena");
const nav = buildNavGraph(level, new World(level).collision);

/** Damage a bot deals in a minute to a target strafing at 0.6 of run speed that doesn't shoot back, with only one gun. */
function damage(skill: number, weapon: string, range: number): number {
  const world = new World(level);
  const bot = world.addPlayer(1);
  const dummy = world.addPlayer(2);
  const w = weaponIndex(weapon);
  const brain = new Bot(1, nav, skill);
  const target = new TargetDummy(2, false, 0.6);
  const reset = () => {
    set(bot.origin, -range / 2, 0, 24.03);
    set(bot.prevOrigin, -range / 2, 0, 24.03);
    set(dummy.origin, range / 2, 0, 24.03);
    set(dummy.prevOrigin, range / 2, 0, 24.03);
  };
  reset();
  let dealt = 0;
  for (let t = 0; t < 60 * 60; t++) {
    bot.weapons = (1 << w) | 1;
    bot.ammo = WEAPONS.map((s) => s.maxAmmo);
    bot.weapon = w;
    dummy.health = 100;
    dummy.protectedUntil = bot.protectedUntil = 0;
    world.step(new Map([[1, brain.command(world)], [2, target.command(world)]]));
    for (const e of world.events) if (e.type === "hit" && e.attacker === 1 && e.victim === 2) dealt += e.damage;
    if (t % 300 === 0) reset();
  }
  return dealt;
}

describe("difficulty levels", () => {
  const skills = Object.fromEntries(DIFFICULTIES.map((d) => [d.id, d.skill]));

  it("are clearly apart with the machine gun: Beginner a third of Hard or less, Normal well short of it", () => {
    const [beginner, easy, normal, hard] = ["beginner", "easy", "normal", "hard"].map((id) => damage(skills[id], "machinegun", 500));
    expect(beginner).toBeLessThan(easy);
    expect(easy).toBeLessThan(normal);
    expect(normal).toBeLessThan(hard);
    expect(beginner).toBeLessThan(hard / 3);
    expect(normal).toBeLessThan(hard * 0.75);
  });

  it("make the railgun a Hard bot's weapon: lower levels take their time and miss more", () => {
    const easy = damage(skills.easy, "railgun", 800);
    const hard = damage(skills.hard, "railgun", 800);
    expect(easy).toBeLessThan(hard / 3);
  });
});

/**
 * How easy a bot is to hit: a stand-in for a person with the machine gun, 500 away, aiming
 * where the bot was a fifth of a second ago (people track a moving target that far behind),
 * firing all the time. The bot fights back as usual (the stand-in can't be hurt). Returns
 * the share of the stand-in's shots that hit.
 */
function hitRate(skill: number): number {
  const world = new World(level);
  const shooter = world.addPlayer(1);
  const bot = world.addPlayer(2);
  const brain = new Bot(2, nav, skill);
  const reset = () => {
    set(shooter.origin, -250, 0, 24.03);
    set(shooter.prevOrigin, -250, 0, 24.03);
    set(bot.origin, 250, 0, 24.03);
    set(bot.prevOrigin, 250, 0, 24.03);
  };
  reset();
  const trail: { x: number; y: number; z: number }[] = [];
  let shots = 0;
  let hits = 0;
  for (let t = 0; t < 60 * 60; t++) {
    trail.push({ ...bot.origin });
    const seen = trail[Math.max(0, trail.length - 12)];
    const dx = seen.x - shooter.origin.x;
    const dy = seen.y - shooter.origin.y;
    const dz = seen.z - shooter.origin.z;
    const cmd = { ...emptyCommand(), yaw: Math.atan2(dy, dx), pitch: Math.atan2(dz, Math.hypot(dx, dy)), fire: true };
    shooter.ammo = WEAPONS.map((w) => w.maxAmmo);
    shooter.health = bot.health = 100;
    shooter.protectedUntil = bot.protectedUntil = 0;
    bot.ammo = WEAPONS.map((w) => w.maxAmmo); // it fights back (the stand-in can't be hurt: health reset each tick)
    world.step(new Map([[1, cmd], [2, brain.command(world)]]));
    for (const e of world.events) {
      if (e.type === "fire" && e.player === 1) shots++;
      if (e.type === "hit" && e.attacker === 1 && e.victim === 2) hits++;
    }
    if (t % 300 === 0) {
      reset();
      trail.length = 0;
    }
  }
  return hits / Math.max(1, shots);
}

describe("how hard bots are to hit", () => {
  it("lower levels dodge slower and stand still more: far easier to hit than Hard", () => {
    const [beginner, easy, normal, hard] = DIFFICULTIES.map((d) => hitRate(d.skill));
    expect(beginner).toBeGreaterThan(easy);
    expect(easy).toBeGreaterThan(hard);
    expect(normal).toBeGreaterThan(hard);
    expect(beginner).toBeGreaterThan(hard * 2.5);
  });
});
