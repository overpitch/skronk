import { describe, expect, it } from "vitest";
import { vec3 } from "../src/math/vec3";
import { buildNavGraph } from "../src/bots/nav";
import { RoamBot } from "../src/bots/roamBot";
import { World } from "../src/sim/world";
import { loadTestMap } from "./helpers";

const level = loadTestMap();
const nav = buildNavGraph(level, new World(level).collision);
const at = (x: number, y: number, z: number) => nav.nearest(vec3(x, y, z));
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
      return new RoamBot(id, nav);
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
