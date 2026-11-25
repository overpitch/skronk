import { describe, expect, it } from "vitest";
import { emptyCommand, type PlayerCommand } from "../src/sim/command";
import { TICK_RATE, World } from "../src/sim/world";
import { loadTestMap } from "./helpers";

const level = loadTestMap();

function setup(x: number, y: number, z = 25) {
  const world = new World(level);
  const p = world.addPlayer(1);
  p.origin.x = x;
  p.origin.y = y;
  p.origin.z = z;
  return { world, p };
}

function run(world: World, seconds: number, cmd: Partial<PlayerCommand>) {
  const full = { ...emptyCommand(), ...cmd };
  for (let i = 0; i < seconds * TICK_RATE; i++) world.step(new Map([[1, full]]));
}

describe("movement", () => {
  it("falls and comes to rest on the floor", () => {
    const { world, p } = setup(0, 0, 200);
    run(world, 2, {});
    expect(p.onGround).toBe(true);
    expect(p.origin.z).toBeCloseTo(24, 1); // feet (origin - 24) on z = 0
    expect(p.velocity.z).toBe(0);
  });

  it("accelerates to max speed and no further", () => {
    const { world, p } = setup(-300, -300);
    run(world, 0.5, {});
    run(world, 1, { forward: 1, yaw: Math.PI / 4 });
    expect(Math.hypot(p.velocity.x, p.velocity.y)).toBeCloseTo(320, 0);
  });

  it("sprints faster going forward, but not backward", () => {
    const { world, p } = setup(-300, -300);
    run(world, 0.5, {});
    run(world, 1, { forward: 1, sprint: true, yaw: Math.PI / 4 });
    expect(Math.hypot(p.velocity.x, p.velocity.y)).toBeCloseTo(320 * 1.75, 0);
    run(world, 1.5, { forward: -1, sprint: true, yaw: Math.PI / 4 });
    expect(Math.hypot(p.velocity.x, p.velocity.y)).toBeCloseTo(320, 0);
  });

  it("stops at a wall and stays inside the room", () => {
    const { world, p } = setup(0, -300);
    run(world, 3, { forward: 1, yaw: -Math.PI / 2 }); // walk -Y into the south wall
    expect(p.origin.y).toBeGreaterThan(-512 + 16 - 0.1);
    expect(p.origin.y).toBeLessThan(-512 + 16 + 1);
  });

  it("slides along a wall when walking into it at an angle", () => {
    const { world, p } = setup(0, -400);
    const startX = p.origin.x;
    run(world, 1.5, { forward: 1, yaw: -Math.PI / 2 + 0.5 }); // mostly -Y, a bit +X
    expect(p.origin.x - startX).toBeGreaterThan(50);
  });

  it("climbs 16-unit stairs onto the 64-unit platform", () => {
    const { world, p } = setup(320, -60);
    run(world, 0.3, {});
    run(world, 2, { forward: 1, yaw: -Math.PI / 2 });
    expect(p.origin.z).toBeCloseTo(64 + 24, 0);
    expect(p.onGround).toBe(true);
  });

  it("cannot walk over a 40-unit wall but can jump it", () => {
    const blocked = setup(0, 200);
    run(blocked.world, 2, { forward: 1, yaw: Math.PI / 2 });
    expect(blocked.p.origin.y).toBeLessThan(300);

    const jumper = setup(0, 200);
    run(jumper.world, 0.3, { forward: 1, yaw: Math.PI / 2 });
    run(jumper.world, 1.5, { forward: 1, yaw: Math.PI / 2, jump: true });
    expect(jumper.p.origin.y).toBeGreaterThan(316);
  });

  it("walks up the ramp onto the ledge", () => {
    const { world, p } = setup(-448, -60);
    run(world, 0.3, {});
    run(world, 2.5, { forward: 1, yaw: Math.PI / 2 });
    expect(p.origin.y).toBeGreaterThan(256);
    expect(p.origin.z).toBeCloseTo(128 + 24, 0);
  });

  it("stays on the ground walking down the ramp", () => {
    const { world, p } = setup(-448, 300, 128 + 25);
    run(world, 0.3, {});
    let airborneTicks = 0;
    const cmd = { ...emptyCommand(), forward: 1, yaw: -Math.PI / 2 };
    for (let i = 0; i < 1.2 * TICK_RATE; i++) {
      world.step(new Map([[1, cmd]]));
      if (!p.onGround) airborneTicks++;
    }
    expect(p.origin.z).toBeLessThan(60);
    expect(airborneTicks).toBe(0);
  });

  it("is deterministic for the same commands", () => {
    const a = setup(0, 0);
    const b = setup(0, 0);
    const cmds = Array.from({ length: 300 }, (_, i) => ({
      ...emptyCommand(),
      forward: Math.sin(i / 10),
      right: Math.cos(i / 7),
      yaw: i / 50,
      jump: i % 40 === 0,
    }));
    for (const c of cmds) {
      a.world.step(new Map([[1, c]]));
      b.world.step(new Map([[1, c]]));
    }
    expect(a.p.origin).toEqual(b.p.origin);
    expect(a.p.velocity).toEqual(b.p.velocity);
  });
});
