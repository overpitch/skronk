import { describe, expect, it } from "vitest";
import { vec3, set } from "../src/math/vec3";
import { emptyCommand, type PlayerCommand } from "../src/sim/command";
import type { SimEvent } from "../src/sim/events";
import { segmentVsBox, VITALS, WEAPON } from "../src/sim/weapon";
import { World, type PlayerState } from "../src/sim/world";
import { loadTestMap } from "./helpers";

const FLOOR_Z = 24.5; // origin of a player standing on the z=0 floor (mins.z = -24)

function place(p: PlayerState, x: number, y: number, z = FLOOR_Z) {
  set(p.origin, x, y, z);
  set(p.prevOrigin, x, y, z);
  set(p.velocity, 0, 0, 0);
}

const aim = (yaw: number, pitch = 0, fire = true): PlayerCommand => ({ ...emptyCommand(), yaw, pitch, fire });

/** Steps n ticks with fixed commands and returns every event produced. */
function run(world: World, n: number, cmds: Record<number, PlayerCommand> = {}): SimEvent[] {
  const all: SimEvent[] = [];
  const map = new Map(Object.entries(cmds).map(([id, c]) => [Number(id), c]));
  for (let i = 0; i < n; i++) {
    world.step(map);
    all.push(...world.events);
  }
  return all;
}

function duel() {
  const world = new World(loadTestMap());
  const a = world.addPlayer(1);
  const b = world.addPlayer(2);
  a.protectedUntil = b.protectedUntil = 0; // no spawn protection in these tests
  a.fireCooldown = b.fireCooldown = 0; // gun already up
  // Same row, nothing between them; A looks along +X at B.
  place(a, -300, -300);
  place(b, 0, -300);
  return { world, a, b };
}

describe("segmentVsBox", () => {
  const min = vec3(-1, -1, -1);
  const max = vec3(1, 1, 1);
  it("finds the entry fraction", () => {
    expect(segmentVsBox(vec3(-5, 0, 0), vec3(10, 0, 0), min, max)).toBeCloseTo(0.4);
  });
  it("misses when passing beside or stopping short", () => {
    expect(segmentVsBox(vec3(-5, 3, 0), vec3(10, 0, 0), min, max)).toBe(-1);
    expect(segmentVsBox(vec3(-5, 0, 0), vec3(2, 0, 0), min, max)).toBe(-1);
  });
  it("counts a start inside as a hit at 0", () => {
    expect(segmentVsBox(vec3(0, 0, 0), vec3(10, 0, 0), min, max)).toBe(0);
  });
});

describe("weapon", () => {
  it("fires at the set rate and spends ammo", () => {
    const { world, a } = duel();
    const shots = run(world, WEAPON.fireIntervalTicks + 1, { 1: aim(Math.PI / 2) }).filter((e) => e.type === "fire");
    expect(shots).toHaveLength(2);
    expect(a.ammo).toBe(WEAPON.startAmmo - 2);
  });

  it("stops at walls and reports the impact", () => {
    const world = new World(loadTestMap());
    const a = world.addPlayer(1);
    a.fireCooldown = 0;
    place(a, 0, 0);
    const events = [...run(world, 1, { 1: aim(0) }), ...run(world, 30)];
    const impact = events.find((e) => e.type === "impact");
    expect(impact).toBeDefined();
    if (impact?.type !== "impact") return;
    expect(impact.pos.x).toBeCloseTo(512, 0);
    expect(impact.normal).toEqual({ x: -1, y: 0, z: 0 });
    expect(world.projectiles).toHaveLength(0);
  });

  it("damages the player it hits, with armor soaking two thirds", () => {
    const { world, b } = duel();
    b.armor = 50;
    const events = [...run(world, 1, { 1: aim(0) }), ...run(world, 20)];
    const hits = events.filter((e) => e.type === "hit");
    expect(hits).toHaveLength(1);
    const saved = Math.ceil(WEAPON.damage * VITALS.armorAbsorb);
    expect(b.armor).toBe(50 - saved);
    expect(b.health).toBe(VITALS.startHealth - (WEAPON.damage - saved));
    expect(b.origin.x).toBeGreaterThan(0.5); // nudged along the shot (friction stops it quickly)
  });

  it("never hits its owner", () => {
    const { world, a } = duel();
    const events = [...run(world, 1, { 1: aim(0, -Math.PI / 2 + 0.001) }), ...run(world, 10)];
    expect(events.some((e) => e.type === "hit")).toBe(false);
    expect(events.some((e) => e.type === "impact")).toBe(true);
    expect(a.health).toBe(VITALS.startHealth);
  });

  it("kills, scores and respawns", () => {
    const { world, a, b } = duel();
    b.health = WEAPON.damage;
    const events = [...run(world, 1, { 1: aim(0) }), ...run(world, 20)];
    expect(events).toContainEqual({ type: "kill", attacker: 1, victim: 2 });
    expect(b.alive).toBe(false);
    expect(a.frags).toBe(1);
    expect(b.deaths).toBe(1);
    const later = run(world, VITALS.respawnTicks);
    expect(later).toContainEqual({ type: "respawn", player: 2 });
    expect(b.alive).toBe(true);
    expect(b.health).toBe(VITALS.startHealth);
    expect(b.ammo).toBe(WEAPON.startAmmo);
  });

  it("dry fires when out of ammo", () => {
    const { world, a } = duel();
    a.ammo = 0;
    const events = run(world, 1, { 1: aim(0) });
    expect(events).toContainEqual({ type: "dryFire", player: 1 });
    expect(world.projectiles).toHaveLength(0);
  });
});

describe("pickups", () => {
  it("heals a hurt player, then respawns later", () => {
    const world = new World(loadTestMap());
    const a = world.addPlayer(1);
    const index = world.pickups.findIndex((p) => p.kind === "health");
    const pk = world.pickups[index];
    place(a, pk.origin.x, pk.origin.y, 64 + FLOOR_Z); // the health sits on the 64-high platform
    a.health = 50;
    expect(run(world, 1)).toContainEqual({ type: "pickup", player: 1, kind: "health", index });
    expect(a.health).toBe(50 + pk.amount);

    a.health = 50;
    run(world, pk.respawnTicks - 2);
    expect(a.health).toBe(50);
    run(world, 2);
    expect(a.health).toBe(50 + pk.amount);
  });

  it("is left alone when it wouldn't help", () => {
    const world = new World(loadTestMap());
    const a = world.addPlayer(1);
    const pk = world.pickups.find((p) => p.kind === "ammo")!;
    place(a, pk.origin.x, pk.origin.y);
    a.ammo = WEAPON.maxAmmo;
    expect(run(world, 1).some((e) => e.type === "pickup")).toBe(false);
    a.ammo = 10;
    run(world, 1);
    expect(a.ammo).toBe(10 + pk.amount);
  });
});
