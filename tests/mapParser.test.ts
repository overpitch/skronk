import { describe, expect, it } from "vitest";
import { parseMap } from "../src/level/trenchbroom/mapParser";

// Face lines as TrenchBroom writes them for each format.
const STANDARD = `( -64 -64 -16 ) ( -64 -63 -16 ) ( -64 -64 -15 ) base/wall 0 0 0 1 1`;
const VALVE = `( -64 -64 -16 ) ( -64 -63 -16 ) ( -64 -64 -15 ) base/wall [ 0 -1 0 8 ] [ 0 0 -1 4 ] 0 0.5 2`;
const Q2 = `( -64 -64 -16 ) ( -64 -63 -16 ) ( -64 -64 -15 ) base/wall [ 0 -1 0 0 ] [ 0 0 -1 0 ] 0 1 1 0 1 0`;

const wrap = (faceLine: string) => `// Game: Skronk
{
"classname" "worldspawn"
// brush 0
{
${faceLine}
}
}
{
"classname" "player_spawn"
"origin" "0 0 24"
}`;

describe("parseMap", () => {
  it("parses Standard format faces", () => {
    const [world] = parseMap(wrap(STANDARD));
    const f = world.brushes[0].faces[0];
    expect(f.texture).toBe("base/wall");
    expect(f.axes.kind).toBe("standard");
    expect(f.points[1]).toEqual({ x: -64, y: -63, z: -16 });
    expect(f.surfaceFlags).toBe(0);
  });

  it("parses Valve 220 texture axes and scale", () => {
    const f = parseMap(wrap(VALVE))[0].brushes[0].faces[0];
    expect(f.axes).toEqual({ kind: "valve", u: { x: 0, y: -1, z: 0 }, v: { x: 0, y: 0, z: -1 }, offset: [8, 4] });
    expect(f.scale).toEqual([0.5, 2]);
  });

  it("reads Quake 2 surface flags", () => {
    const f = parseMap(wrap(Q2))[0].brushes[0].faces[0];
    expect(f.contentFlags).toBe(0);
    expect(f.surfaceFlags).toBe(1);
  });

  it("reads entity properties", () => {
    const ents = parseMap(wrap(STANDARD));
    expect(ents).toHaveLength(2);
    expect(ents[1].properties).toEqual({ classname: "player_spawn", origin: "0 0 24" });
  });

  it("skips Quake 3 patches", () => {
    const src = `{
"classname" "worldspawn"
{
patchDef2
{
common/caulk
( 3 3 0 0 0 )
(
( ( 0 0 0 0 0 ) ( 0 0 0 0 0 ) ( 0 0 0 0 0 ) )
)
}
}
}`;
    expect(parseMap(src)[0].brushes).toHaveLength(0);
  });

  it("reports the line of a syntax error", () => {
    expect(() => parseMap(`{\n"classname" "worldspawn"\n{\n( 0 0 0 ) ( 1 0 0 ) oops\n}\n}`)).toThrow(/line 4/);
  });
});
