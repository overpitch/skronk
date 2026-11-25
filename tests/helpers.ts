import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildLevel } from "../src/level/trenchbroom/trenchbroomLoader";
import { parseMap } from "../src/level/trenchbroom/mapParser";

export function loadTestMap(name = "test_box") {
  const text = readFileSync(resolve(import.meta.dirname, `../public/assets/maps/${name}.map`), "utf8");
  return buildLevel(name, parseMap(text));
}
