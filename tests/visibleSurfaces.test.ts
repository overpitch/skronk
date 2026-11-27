import { describe, expect, it } from "vitest";
import { cross, dot, sub, type Vec3 } from "../src/math/vec3";
import { buildLevel } from "../src/level/trenchbroom/trenchbroomLoader";
import { parseMap } from "../src/level/trenchbroom/mapParser";
import type { Surface } from "../src/level/types";
import { visibleSurfaces } from "../src/level/visibleSurfaces";
import { loadTestMap } from "./helpers";

type Box = [[number, number, number], [number, number, number], string];

/** A map of axis-aligned boxes (mins, maxs, texture), in TrenchBroom's format. */
function boxes(...list: Box[]) {
  const brush = ([[x0, y0, z0], [x1, y1, z1], tex]: Box) => `{
( ${x0} ${y0} ${z0} ) ( ${x0} ${y0 + 1} ${z0} ) ( ${x0} ${y0} ${z0 + 1} ) ${tex} 0 0 0 1 1
( ${x0} ${y0} ${z0} ) ( ${x0} ${y0} ${z0 + 1} ) ( ${x0 + 1} ${y0} ${z0} ) ${tex} 0 0 0 1 1
( ${x0} ${y0} ${z0} ) ( ${x0 + 1} ${y0} ${z0} ) ( ${x0} ${y0 + 1} ${z0} ) ${tex} 0 0 0 1 1
( ${x1} ${y1} ${z1} ) ( ${x1} ${y1 + 1} ${z1} ) ( ${x1 + 1} ${y1} ${z1} ) ${tex} 0 0 0 1 1
( ${x1} ${y1} ${z1} ) ( ${x1 + 1} ${y1} ${z1} ) ( ${x1} ${y1} ${z1 + 1} ) ${tex} 0 0 0 1 1
( ${x1} ${y1} ${z1} ) ( ${x1} ${y1} ${z1 + 1} ) ( ${x1} ${y1 + 1} ${z1} ) ${tex} 0 0 0 1 1
}`;
  return buildLevel("test", parseMap(`{\n"classname" "worldspawn"\n${list.map(brush).join("\n")}\n}`));
}

function area(s: Surface): number {
  let total = 0;
  const v = s.vertices;
  for (let i = 1; i < v.length - 1; i++) total += Math.hypot(...Object.values(cross(sub(v[i], v[0]), sub(v[i + 1], v[0])))) / 2;
  return total;
}

const facing = (list: Surface[], n: Vec3, dist: number) =>
  list.filter((s) => dot(s.plane.normal, n) > 0.99 && Math.abs(s.plane.dist - dist) < 0.01);

/** Surfaces (same plane, same facing) covering a point. */
function covering(list: Surface[], s: Surface, p: Vec3): Surface[] {
  return facing(list, s.plane.normal, s.plane.dist).filter((o) => {
    const v = o.vertices;
    for (let i = 0; i < v.length; i++) {
      const edge = sub(v[(i + 1) % v.length], v[i]);
      if (dot(cross(edge, sub(p, v[i])), o.plane.normal) < -1e-6) return false;
    }
    return true;
  });
}

const UP = { x: 0, y: 0, z: 1 };
const WEST = { x: -1, y: 0, z: 0 };

describe("drawn surfaces", () => {
  // Like Portal Gym's chasm edge: a side wall overlapping the floor slab, tops level.
  const edge = boxes([[0, 0, -16], [256, 256, 0], "base/floor"], [[0, 0, -64], [16, 256, 0], "base/trim"]);
  const drawn = visibleSurfaces(edge);

  it("never draws two faces in the same place: the later brush's face wins", () => {
    const tops = facing(drawn, UP, 0);
    expect(tops.reduce((a, s) => a + area(s), 0)).toBeCloseTo(256 * 256, 3);
    const onEdge = covering(drawn, tops[0], { x: 8, y: 100, z: 0 });
    expect(onEdge.map((s) => s.texture)).toEqual(["base/trim"]);
    // The west faces overlap too (the slab's edge on the wall's): one layer only.
    expect(facing(drawn, WEST, 0).reduce((a, s) => a + area(s), 0)).toBeCloseTo(256 * 64, 3);
  });

  it("drops faces buried inside another brush, and faces where two brushes touch", () => {
    const buried = visibleSurfaces(boxes([[0, 0, 0], [100, 100, 100], "base/wall"], [[20, 20, 20], [40, 40, 40], "base/trim"]));
    expect(buried.some((s) => s.texture === "base/trim")).toBe(false);
    const touching = visibleSurfaces(boxes([[0, 0, 0], [64, 64, 64], "base/wall"], [[64, 0, 0], [128, 64, 64], "base/wall"]));
    expect(facing(touching, { x: 1, y: 0, z: 0 }, 64)).toHaveLength(0);
    expect(facing(touching, WEST, -64)).toHaveLength(0);
  });

  it("keeps what's behind a clip brush (it's see-through)", () => {
    const clipped = visibleSurfaces(boxes([[0, 0, -16], [256, 256, 0], "base/floor"], [[0, 0, -64], [64, 256, 32], "base/clip"]));
    expect(facing(clipped, UP, 0).reduce((a, s) => a + area(s), 0)).toBeCloseTo(256 * 256, 3);
  });

  it("keeps texture coordinates lined up on the pieces it cuts", () => {
    // On a flat face, texture coordinates follow position: work them out from the whole face's corners.
    const floor = edge.surfaces.find((f) => f.texture === "base/floor" && f.plane.normal.z > 0.99)!;
    const [p0, p1, p2] = floor.vertices;
    const [t0, t1, t2] = floor.uvs;
    const expected = (p: Vec3) => {
      // p - p0 = a (p1 - p0) + b (p2 - p0), in x and y.
      const ax = p1.x - p0.x, ay = p1.y - p0.y, bx = p2.x - p0.x, by = p2.y - p0.y;
      const det = ax * by - ay * bx;
      const a = ((p.x - p0.x) * by - (p.y - p0.y) * bx) / det;
      const b = (ax * (p.y - p0.y) - ay * (p.x - p0.x)) / det;
      return [t0[0] + a * (t1[0] - t0[0]) + b * (t2[0] - t0[0]), t0[1] + a * (t1[1] - t0[1]) + b * (t2[1] - t0[1])];
    };
    const pieces = facing(drawn, UP, 0).filter((f) => f.texture === "base/floor");
    expect(pieces.length).toBeGreaterThan(0);
    for (const piece of pieces) {
      piece.vertices.forEach((v, i) => {
        const [u, w] = expected(v);
        expect(piece.uvs[i][0]).toBeCloseTo(u, 4);
        expect(piece.uvs[i][1]).toBeCloseTo(w, 4);
      });
    }
  });

  it("leaves no doubled faces in the starter maps", () => {
    for (const name of ["portal_gym", "arena", "test_box"]) {
      const list = visibleSurfaces(loadTestMap(name));
      for (const s of list) {
        const c = s.vertices.reduce((a, v) => ({ x: a.x + v.x / s.vertices.length, y: a.y + v.y / s.vertices.length, z: a.z + v.z / s.vertices.length }), { x: 0, y: 0, z: 0 });
        expect(covering(list, s, c).length, `${name}: ${s.texture} at ${JSON.stringify(c)}`).toBe(1);
      }
    }
  });
});
