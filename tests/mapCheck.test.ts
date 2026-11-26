import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkLevel, type Issue } from "../src/devtools/mapCheck";
import { buildLevel } from "../src/level/trenchbroom/trenchbroomLoader";
import { parseMap } from "../src/level/trenchbroom/mapParser";

const original = readFileSync(resolve(import.meta.dirname, "../public/assets/maps/test_box.map"), "utf8");
const textureExists = (name: string) => existsSync(resolve(import.meta.dirname, `../public/assets/textures/${name}.png`));

/** The test map with an edit applied, checked. */
async function check(edit: (text: string) => string = (t) => t): Promise<Issue[]> {
  const text = edit(original);
  return checkLevel(buildLevel("variant", parseMap(text)), { textureExists });
}
/** Drops brush n (the generator labels them "// brush n"). */
const withoutBrush = (n: number) => (t: string) => t.replace(new RegExp(`// brush ${n}\\n\\{[^}]*\\}\\n`), "");
const find = (issues: Issue[], level: Issue["level"], text: string) => issues.filter((i) => i.level === level && i.message.includes(text));

// test_box brushes: 0 floor, 1 ceiling, 2 west wall, 3 east wall, ... 7 pillar, ... 13 ramp.
describe("map checker", () => {
  it("passes the test map", async () => {
    expect(await check()).toEqual([]);
  });

  it("finds a missing wall as a gap to the outside, and says roughly where", async () => {
    const [leak] = find(await check(withoutBrush(2)), "warning", "gap to the outside");
    expect(leak).toBeDefined();
    expect(leak.at!.x).toBeLessThan(-400); // out through the west side
  });

  it("errors when there are no spawns, or one is inside a wall", async () => {
    expect(find(await check((t) => t.replaceAll('"classname" "player_spawn"', '"classname" "light"')), "error", "No player_spawn")).toHaveLength(1);
    const inPillar = (t: string) => t.replace('"origin" "-300 0 25"', '"origin" "-200 200 25"');
    expect(find(await check(inPillar), "error", "inside a wall")).toHaveLength(1);
  });

  it("warns about a spawn and a pickup bots can't walk to", async () => {
    // Without the ramp, the ledge (128 up) can't be reached: put a spawn there too.
    const noRamp = (t: string) => withoutBrush(13)(t).replace('"origin" "300 300 25"', '"origin" "-416 450 153"');
    const issues = await check(noRamp);
    expect(find(issues, "warning", "can't be walked to from spawn 1")).toHaveLength(1);
    expect(find(issues, "warning", "Bots can't reach pickup_armor")).toHaveLength(1); // armor sits on the ledge
  });

  it("warns about unknown pickups and entities, and missing textures", async () => {
    const issues = await check((t) =>
      t
        .replace('"classname" "pickup_ammo"', '"classname" "pickup_rockets"')
        .replace('"classname" "pickup_health"', '"classname" "monster_thing"')
        .replace(/base\/trim/g, "base/trimm"),
    );
    expect(find(issues, "warning", "pickup_rockets")).not.toHaveLength(0);
    expect(find(issues, "warning", "unknown entity 'monster_thing'")).toHaveLength(1);
    expect(find(issues, "warning", "Texture 'base/trimm'")).toHaveLength(1);
  });

  it("notes a portal-friendly face too small for a portal", async () => {
    // Shrink the floor pad to 48 x 48: too small either way.
    const issues = await check((t) => t.replace(/\( -496 -496 0 \)/g, "( -400 -400 0 )").replace(/-496/g, "-384"));
    expect(find(issues, "note", "smaller than a portal").length).toBeGreaterThan(0);
  });
});
