import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

const MAP_DIR = resolve(import.meta.dirname, "public/assets/maps");
const MAPS_ID = "virtual:maps";
const RESOLVED_MAPS_ID = "\0" + MAPS_ID;

/** A map's display title: worldspawn's "message" key (set it in TrenchBroom's entity inspector), else its file name. */
function mapTitle(text: string, name: string): string {
  const worldspawn = text.slice(0, text.indexOf("\n{", text.indexOf('"worldspawn"')) >>> 0);
  const message = /"message"\s+"([^"]*)"/.exec(worldspawn)?.[1]?.trim();
  return message || name;
}

/**
 * Every .map file in public/assets/maps, as `import maps from "virtual:maps"`:
 * drop a map in the folder and it's in the game's map list. In dev, saving a map
 * (from TrenchBroom, say) reloads the game so you see the change straight away.
 */
function skronkMaps(): Plugin {
  const list = () =>
    readdirSync(MAP_DIR)
      .filter((f) => f.endsWith(".map"))
      .sort()
      .map((f) => {
        const name = f.slice(0, -4);
        return { name, title: mapTitle(readFileSync(resolve(MAP_DIR, f), "utf8"), name) };
      });
  return {
    name: "skronk-maps",
    resolveId: (id) => (id === MAPS_ID ? RESOLVED_MAPS_ID : null),
    load: (id) => (id === RESOLVED_MAPS_ID ? `export default ${JSON.stringify(list())};` : null),
    configureServer(server) {
      server.watcher.add(MAP_DIR);
      const changed = (file: string) => {
        if (!file.endsWith(".map")) return;
        const mod = server.moduleGraph.getModuleById(RESOLVED_MAPS_ID);
        if (mod) server.moduleGraph.invalidateModule(mod);
        server.ws.send({ type: "full-reload" });
      };
      server.watcher.on("add", changed).on("change", changed).on("unlink", changed);
    },
  };
}

export default defineConfig({
  // Relative base so the build works from any static host path (GitHub Pages, a subfolder, etc).
  base: "./",
  server: { port: 5173 },
  plugins: [skronkMaps()],
  test: { include: ["tests/**/*.test.ts"] },
});
