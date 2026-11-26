/**
 * `npm run maps:check [name ...]`: checks maps in public/assets/maps (all of
 * them, or the named ones) and prints what it finds. Exit code 1 if any map has
 * an error. Loaded through Vite by tools/check-maps.mjs, so it can share the
 * game's TypeScript.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildLevel } from "../level/trenchbroom/trenchbroomLoader";
import { parseMap } from "../level/trenchbroom/mapParser";
import { checkLevel, type Issue } from "./mapCheck";

export async function checkMapFiles(root: string, names: string[]): Promise<number> {
  const mapDir = resolve(root, "public/assets/maps");
  const textureDir = resolve(root, "public/assets/textures");
  const all = readdirSync(mapDir).filter((f) => f.endsWith(".map")).map((f) => f.slice(0, -4)).sort();
  const chosen = names.length > 0 ? names.map((n) => n.replace(/\.map$/, "")) : all;
  let errors = 0;
  for (const name of chosen) {
    if (!all.includes(name)) {
      console.log(`\n${name}: no such map in public/assets/maps`);
      errors++;
      continue;
    }
    let issues: Issue[];
    try {
      const level = buildLevel(name, parseMap(readFileSync(resolve(mapDir, `${name}.map`), "utf8")));
      issues = await checkLevel(level, { textureExists: (t) => existsSync(resolve(textureDir, `${t}.png`)) });
    } catch (err) {
      issues = [{ level: "error", message: `Couldn't load: ${err instanceof Error ? err.message : String(err)}` }];
    }
    const count = (l: Issue["level"]) => issues.filter((i) => i.level === l).length;
    errors += count("error");
    const summary = issues.length === 0 ? "all good" : `${count("error")} errors, ${count("warning")} warnings, ${count("note")} notes`;
    console.log(`\n${name}: ${summary}`);
    for (const i of issues) console.log(`  ${i.level.padEnd(7)} ${i.message}`);
  }
  return errors > 0 ? 1 : 0;
}
