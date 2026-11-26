// npm run maps:check [name ...]: checks the maps in public/assets/maps for problems
// (see src/devtools/mapCheck.ts). Runs the game's TypeScript through Vite.
import { resolve } from "node:path";
import { createServer } from "vite";

const root = resolve(import.meta.dirname, "..");
const server = await createServer({ root, server: { middlewareMode: true, hmr: false }, appType: "custom", logLevel: "error" });
try {
  const { checkMapFiles } = await server.ssrLoadModule("/src/devtools/checkMapsCli.ts");
  process.exitCode = await checkMapFiles(root, process.argv.slice(2));
} finally {
  await server.close();
}
