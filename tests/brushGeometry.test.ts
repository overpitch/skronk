import { describe, expect, it } from "vitest";
import { buildBrushPolygons, planeFromPoints } from "../src/level/trenchbroom/brushGeometry";
import { parseMap } from "../src/level/trenchbroom/mapParser";
import { loadTestMap } from "./helpers";

// A 128x128x32 cube exactly as TrenchBroom writes it.
const CUBE = `{
"classname" "worldspawn"
{
( -64 -64 -16 ) ( -64 -63 -16 ) ( -64 -64 -15 ) base/wall 0 0 0 1 1
( -64 -64 -16 ) ( -64 -64 -15 ) ( -63 -64 -16 ) base/wall 0 0 0 1 1
( -64 -64 -16 ) ( -63 -64 -16 ) ( -64 -63 -16 ) base/wall 0 0 0 1 1
( 64 64 16 ) ( 64 65 16 ) ( 65 64 16 ) base/wall 0 0 0 1 1
( 64 64 16 ) ( 65 64 16 ) ( 64 64 17 ) base/wall 0 0 0 1 1
( 64 64 16 ) ( 64 64 17 ) ( 64 65 16 ) base/wall 0 0 0 1 1
}
}`;

describe("brush geometry", () => {
  it("plane normals point out of the brush", () => {
    const p = planeFromPoints({ x: -64, y: -64, z: -16 }, { x: -64, y: -63, z: -16 }, { x: -64, y: -64, z: -15 })!;
    expect(p.normal).toEqual({ x: -1, y: 0, z: 0 });
    expect(p.dist).toBe(64);
  });

  it("builds six quads for a cube with the right corners", () => {
    const faces = parseMap(CUBE)[0].brushes[0].faces;
    const { polygons } = buildBrushPolygons(faces);
    expect(polygons).toHaveLength(6);
    for (const poly of polygons) {
      expect(poly.vertices).toHaveLength(4);
      for (const v of poly.vertices) {
        expect(Math.abs(v.x)).toBe(64);
        expect(Math.abs(v.y)).toBe(64);
        expect(Math.abs(v.z)).toBe(16);
      }
    }
    const top = polygons.find((p) => p.plane.normal.z === 1)!;
    expect(top.plane.dist).toBe(16);
  });

  it("winds polygons counter-clockwise seen from outside", () => {
    const { polygons } = buildBrushPolygons(parseMap(CUBE)[0].brushes[0].faces);
    for (const { vertices: [a, b, c], plane } of polygons) {
      const e1 = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
      const e2 = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
      const n = { x: e1.y * e2.z - e1.z * e2.y, y: e1.z * e2.x - e1.x * e2.z, z: e1.x * e2.y - e1.y * e2.x };
      expect(n.x * plane.normal.x + n.y * plane.normal.y + n.z * plane.normal.z).toBeGreaterThan(0);
    }
  });

  it("loads the test map with spawns, pickups and a portal wall", () => {
    const level = loadTestMap();
    expect(level.brushes.length).toBe(14);
    expect(level.spawns).toHaveLength(4);
    expect(level.spawns[0].yaw).toBeCloseTo(Math.PI / 2);
    expect(level.pickups.map((p) => p.kind).sort()).toEqual(["ammo", "armor", "health"]);
    const portal = level.surfaces.filter((s) => s.portalFriendly);
    expect(portal).toHaveLength(1);
    expect(portal[0].plane.normal).toEqual({ x: -1, y: 0, z: 0 });
    expect(portal[0].texture).toBe("base/portal_panel");
    // The ramp wedge has five faces.
    const slope = level.surfaces.find((s) => s.plane.normal.z > 0.5 && s.plane.normal.z < 0.99)!;
    expect(slope.vertices).toHaveLength(4);
  });
});
