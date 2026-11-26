import { describe, expect, it } from "vitest";
import { set, vec3 } from "../src/math/vec3";
import { applySnapshot, captureSnapshot } from "../src/net/snapshot";
import { emptyCommand, type PlayerCommand } from "../src/sim/command";
import type { SimEvent } from "../src/sim/events";
import { EYE_HEIGHT } from "../src/sim/movement";
import {
  cycleWeapon,
  FISTS,
  MACHINE_GUN,
  SPAWN_AMMO,
  SWITCH_TICKS,
  weaponById,
  weaponIndex,
  WEAPONS,
} from "../src/sim/weapons";
import { World, type PlayerState } from "../src/sim/world";
import { chooseWeapon } from "../src/bots/weaponChoice";
import { loadTestMap } from "./helpers";

const FLOOR_Z = 24.5;
const SHOTGUN = weaponIndex("shotgun");
const ROCKETS = weaponIndex("rocketlauncher");
const RAILGUN = weaponIndex("railgun");

function place(p: PlayerState, x: number, y: number, z = FLOOR_Z) {
  set(p.origin, x, y, z);
  set(p.prevOrigin, x, y, z);
  set(p.velocity, 0, 0, 0);
}

function run(world: World, n: number, cmds: Record<number, Partial<PlayerCommand>> = {}): SimEvent[] {
  const all: SimEvent[] = [];
  const map = new Map(Object.entries(cmds).map(([id, c]) => [Number(id), { ...emptyCommand(), ...c }]));
  for (let i = 0; i < n; i++) {
    world.step(map);
    all.push(...world.events);
  }
  return all;
}

/** Gives a weapon with ammo and puts it in hand, ready to fire. */
function arm(p: PlayerState, w: number, ammo = WEAPONS[w].maxAmmo) {
  p.weapons |= 1 << w;
  p.ammo[w] = ammo;
  p.weapon = w;
  p.fireCooldown = 0;
}

/** A at (-300, 0) looking along +X; B `gap` units in front of it, open floor between. */
function duel(gap = 300) {
  const world = new World(loadTestMap());
  const a = world.addPlayer(1);
  const b = world.addPlayer(2);
  place(a, -300, 0);
  place(b, -300 + gap, 0);
  a.protectedUntil = b.protectedUntil = 0;
  a.fireCooldown = b.fireCooldown = 0;
  return { world, a, b };
}

const hitsOn = (events: SimEvent[], victim: number) => events.filter((e) => e.type === "hit" && e.victim === victim);

describe("holding and switching weapons", () => {
  it("spawns with fists and the machine gun, machine gun in hand", () => {
    const { a } = duel();
    expect(a.weapon).toBe(MACHINE_GUN);
    expect(a.ammo[MACHINE_GUN]).toBe(SPAWN_AMMO);
    expect(cycleWeapon(a, MACHINE_GUN, 1)).toBe(FISTS); // nothing else held: wraps round to the fists
  });

  it("switches by slot to a weapon it holds, taking a moment to come up", () => {
    const { world, a } = duel();
    a.weapons |= 1 << SHOTGUN;
    a.ammo[SHOTGUN] = 5;
    const events = run(world, 1, { 1: { weapon: SHOTGUN + 1 } });
    expect(events).toContainEqual({ type: "weaponSwitch", player: 1, weapon: "shotgun" });
    expect(a.weapon).toBe(SHOTGUN);
    expect(a.fireCooldown).toBe(SWITCH_TICKS);
    // Can't fire until it's up.
    expect(run(world, SWITCH_TICKS - 1, { 1: { fire: true } }).some((e) => e.type === "fire")).toBe(false);
    expect(run(world, 1, { 1: { fire: true } }).some((e) => e.type === "fire")).toBe(true);
  });

  it("won't switch to a weapon it doesn't hold, or one that's empty", () => {
    const { world, a } = duel();
    run(world, 1, { 1: { weapon: RAILGUN + 1 } });
    expect(a.weapon).toBe(MACHINE_GUN);
    a.weapons |= 1 << RAILGUN;
    a.ammo[RAILGUN] = 0;
    run(world, 1, { 1: { weapon: RAILGUN + 1 } });
    expect(a.weapon).toBe(MACHINE_GUN);
  });

  it("steps through only the weapons it can use", () => {
    const { a } = duel();
    a.weapons |= (1 << SHOTGUN) | (1 << RAILGUN);
    a.ammo[SHOTGUN] = 5;
    a.ammo[RAILGUN] = 0; // empty: skipped
    expect(cycleWeapon(a, MACHINE_GUN, 1)).toBe(SHOTGUN);
    expect(cycleWeapon(a, SHOTGUN, 1)).toBe(FISTS);
    expect(cycleWeapon(a, FISTS, -1)).toBe(SHOTGUN);
  });

  it("switches to something with ammo when the trigger is pulled on an empty one", () => {
    const { world, a } = duel();
    a.weapons |= 1 << SHOTGUN;
    a.ammo[SHOTGUN] = 3;
    a.ammo[MACHINE_GUN] = 0;
    run(world, 1, { 1: { fire: true } });
    expect(a.weapon).toBe(SHOTGUN);
  });

  it("goes back to fists and the machine gun on respawn", () => {
    const { world, a } = duel();
    arm(a, RAILGUN);
    world.respawn(a);
    expect(a.weapon).toBe(MACHINE_GUN);
    expect(a.weapons & (1 << RAILGUN)).toBe(0);
    expect(a.ammo[RAILGUN]).toBe(0);
  });
});

describe("fists", () => {
  it("punch someone right in front of you: damage and a shove", () => {
    const { world, a, b } = duel(40);
    arm(a, FISTS);
    const events = run(world, 1, { 1: { fire: true } });
    const [hit] = hitsOn(events, 2);
    expect(hit?.type === "hit" && hit.damage).toBe(weaponById("fists").damage);
    expect(b.velocity.x).toBeGreaterThan(200);
    expect(b.velocity.z).toBeGreaterThan(100);
  });

  it("don't reach far", () => {
    const { world, a } = duel(110);
    arm(a, FISTS);
    expect(hitsOn(run(world, 1, { 1: { fire: true } }), 2)).toHaveLength(0);
  });

  it("punch off the floor for a jump", () => {
    const { world, a } = duel();
    arm(a, FISTS);
    run(world, 1, { 1: { fire: true, pitch: -Math.PI / 2 + 0.01 } });
    expect(a.velocity.z).toBeGreaterThan(300);
    expect(a.health).toBe(100);
  });
});

describe("shotgun", () => {
  it("lands every pellet up close, as one hit", () => {
    const { world, a } = duel(60);
    arm(a, SHOTGUN, 10);
    const events = run(world, 1, { 1: { fire: true } });
    const hits = hitsOn(events, 2);
    expect(hits).toHaveLength(1);
    const spec = weaponById("shotgun");
    expect(hits[0].type === "hit" && hits[0].damage).toBe(spec.damage * spec.pellets);
    expect(a.ammo[SHOTGUN]).toBe(9);
  });

  it("spreads out with distance", () => {
    const { world, a } = duel(700);
    arm(a, SHOTGUN, 10);
    const events = run(world, 1, { 1: { fire: true } });
    const hit = hitsOn(events, 2)[0];
    const spec = weaponById("shotgun");
    expect(hit?.type === "hit" && hit.damage).toBeGreaterThan(0);
    expect(hit?.type === "hit" && hit.damage).toBeLessThan(spec.damage * spec.pellets);
    expect(events.some((e) => e.type === "impact")).toBe(true); // the rest hit the wall behind
  });
});

describe("railgun", () => {
  it("hits at once, hard, and leaves a trail", () => {
    const { world, a, b } = duel(700);
    arm(a, RAILGUN);
    const events = run(world, 1, { 1: { fire: true } });
    expect(b.health).toBe(100 - weaponById("railgun").damage);
    const trail = events.find((e) => e.type === "trail");
    expect(trail?.type === "trail" && trail.segments).toHaveLength(1);
    expect(a.fireCooldown).toBe(weaponById("railgun").fireTicks);
  });

  it("goes through your portals, in the same instant", () => {
    const { world, a, b } = duel();
    place(a, 0, 25);
    // East wall portal at y 200 and west wall portal at y -150 (both portal walls in test_box).
    const portal = (yaw: number) => {
      a.portalCooldown = 0;
      run(world, 1, { 1: { yaw, portal: true } });
      run(world, 1, { 1: { yaw } });
    };
    portal(Math.atan2(200, 512));
    portal(Math.atan2(-150, -512));
    expect(world.portals).toHaveLength(2);
    // Out of the west portal heading (512, 175): b waits on that line.
    place(b, -400, -150 + (175 / 512) * 112);
    arm(a, RAILGUN);
    const events = run(world, 1, { 1: { fire: true, yaw: Math.atan2(175, 512) } });
    expect(hitsOn(events, 2)).toHaveLength(1);
    const trail = events.find((e) => e.type === "trail");
    expect(trail?.type === "trail" && trail.segments).toHaveLength(2);
  });
});

describe("rocket launcher", () => {
  it("a direct hit does the full damage, and the blast leaves the shooter alone at range", () => {
    const { world, a, b } = duel(300);
    arm(a, ROCKETS);
    const events = run(world, 40, { 1: { fire: true } }).slice(0); // one rocket per 0.8 s: just the first matters
    const first = hitsOn(events, 2)[0];
    expect(first?.type === "hit" && first.damage).toBe(weaponById("rocketlauncher").damage);
    expect(events.some((e) => e.type === "explosion")).toBe(true);
    expect(a.health).toBe(100);
    expect(b.velocity.x).not.toBe(0);
  });

  it("splashes someone near the blast, less the further away, and throws them", () => {
    const { world, a, b } = duel(300);
    arm(a, ROCKETS);
    // At the floor 40 short of b.
    const eyeZ = FLOOR_Z + EYE_HEIGHT;
    const pitch = -Math.atan2(eyeZ, 260);
    const events = run(world, 1, { 1: { fire: true, pitch } });
    events.push(...run(world, 30));
    const hit = hitsOn(events, 2)[0];
    expect(hit?.type === "hit" && hit.damage).toBeGreaterThan(30);
    expect(hit?.type === "hit" && hit.damage).toBeLessThan(weaponById("rocketlauncher").damage);
    expect(b.alive).toBe(true);
  });

  it("rocket jumps: firing at your feet throws you up, for some of the damage", () => {
    const { world, a } = duel();
    arm(a, ROCKETS);
    let top = 0;
    for (let i = 0; i < 10; i++) {
      run(world, 1, { 1: { fire: i === 0, pitch: -Math.PI / 2 + 0.01 } });
      top = Math.max(top, a.velocity.z);
    }
    expect(top).toBeGreaterThan(400);
    const self = Math.round(weaponById("rocketlauncher").splash!.damage * weaponById("rocketlauncher").splash!.selfDamage);
    expect(a.health).toBeGreaterThanOrEqual(100 - self);
    expect(a.health).toBeLessThan(100);
  });
});

describe("weapon pickups", () => {
  function withPickups(...kinds: string[]) {
    const level = loadTestMap();
    kinds.forEach((kind, i) => level.pickups.push({ kind, origin: vec3(-200 + i * 120, -100, 17), properties: {} }));
    const world = new World(level);
    const p = world.addPlayer(1);
    p.fireCooldown = 0;
    const index = (kind: string) => world.pickups.findIndex((pk) => pk.kind === kind);
    return { world, p, index };
  }

  it("give you the weapon and its ammo, and bring it up", () => {
    const { world, p, index } = withPickups("railgun");
    const pk = world.pickups[index("railgun")];
    place(p, pk.origin.x, pk.origin.y);
    const events = run(world, 1);
    expect(events).toContainEqual({ type: "pickup", player: 1, kind: "railgun", index: index("railgun") });
    expect(p.weapon).toBe(RAILGUN);
    expect(p.ammo[RAILGUN]).toBe(weaponById("railgun").pickupAmmo);
  });

  it("are left alone once you're full", () => {
    const { world, p, index } = withPickups("shotgun");
    arm(p, SHOTGUN);
    const pk = world.pickups[index("shotgun")];
    place(p, pk.origin.x, pk.origin.y);
    expect(run(world, 1).some((e) => e.type === "pickup")).toBe(false);
  });

  it("an ammo box tops up every gun you hold", () => {
    const { world, p } = withPickups();
    p.weapons |= (1 << SHOTGUN) | (1 << ROCKETS);
    p.ammo[MACHINE_GUN] = 0;
    const box = world.pickups.find((pk) => pk.kind === "ammo")!;
    place(p, box.origin.x, box.origin.y);
    run(world, 1);
    expect(p.ammo[MACHINE_GUN]).toBe(weaponById("machinegun").boxAmmo);
    expect(p.ammo[SHOTGUN]).toBe(weaponById("shotgun").boxAmmo);
    expect(p.ammo[ROCKETS]).toBe(weaponById("rocketlauncher").boxAmmo);
    expect(p.ammo[RAILGUN]).toBe(0); // not held
  });
});

describe("weapons over the network", () => {
  it("travel in snapshots: what's held, what's in hand, ammo, rockets in flight", () => {
    const { world, a } = duel();
    arm(a, ROCKETS, 7);
    run(world, 1, { 1: { fire: true } });
    const mirror = new World(loadTestMap());
    applySnapshot(mirror, JSON.parse(JSON.stringify(captureSnapshot(world))));
    const m = mirror.players.get(1)!;
    expect([m.weapon, m.weapons, m.ammo]).toEqual([a.weapon, a.weapons, a.ammo]);
    expect(m.ammo).not.toBe(a.ammo);
    expect(mirror.projectiles[0].weapon).toBe("rocketlauncher");
  });
});

describe("bots' choice of weapon", () => {
  const holding = (...ws: number[]) => {
    const ammo = WEAPONS.map((w) => w.maxAmmo);
    return { weapon: MACHINE_GUN, weapons: ws.reduce((m, w) => m | (1 << w), (1 << FISTS) | (1 << MACHINE_GUN)), ammo };
  };

  it("suits the distance", () => {
    const all = holding(SHOTGUN, ROCKETS, RAILGUN);
    expect(chooseWeapon(all, 150)).toBe(SHOTGUN);
    expect(chooseWeapon(all, 500)).toBe(ROCKETS);
    expect(chooseWeapon(all, 1500)).toBe(RAILGUN);
  });

  it("doesn't fire rockets at someone right on top of it", () => {
    expect(chooseWeapon(holding(ROCKETS), 60)).not.toBe(ROCKETS);
  });

  it("falls back on its fists with nothing else", () => {
    const empty = holding();
    empty.ammo[MACHINE_GUN] = 0;
    expect(chooseWeapon(empty, 50)).toBe(FISTS);
  });
});
