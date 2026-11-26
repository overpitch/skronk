/**
 * Skronk game server, from the command line:
 *
 *   npm run server -- --map arena --bots 2 --difficulty easy
 *     Browsers join with ?join on the dev server's address: http://<this machine>:5173/?join
 *
 *   npm run lan -- --map arena --bots 2
 *     Builds the game and serves it too (--serve): open http://<this machine>:5175/ on any
 *     device on the same network, the Xbox included, and you're in. No dev server needed.
 */
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";
import { DIFFICULTIES } from "../src/client/settings";
import { GAME_PORT } from "../src/net/protocol";
import { describeRules } from "../src/sim/match";
import { secondsToTicks } from "../src/sim/tick";
import { MAX_PLAYERS, startServer } from "./gameServer";

/** --name value on the command line, else the SKRONK_NAME environment variable (how hosts pass settings), else fallback. */
function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return process.env[`SKRONK_${name.toUpperCase()}`] ?? fallback;
}

const map = arg("map", "arena");
const bots = Math.max(0, Math.min(MAX_PLAYERS - 1, Number(arg("bots", "0")) || 0));
const difficulty = DIFFICULTIES.find((d) => d.id === arg("difficulty", "normal")) ?? DIFFICULTIES[2];
// Hosting services say which port to listen on in PORT.
// Match: --fraglimit N (0 for none) and --timelimit minutes (0 for none).
const fragLimit = Math.max(0, Math.floor(Number(arg("fraglimit", "20")) || 0));
const minutes = Math.max(0, Number(arg("timelimit", "10")) || 0);
const rules = { fragLimit, timeLimitTicks: secondsToTicks(minutes * 60) };
const port = Number(arg("port", process.env.PORT ?? String(GAME_PORT)));
const serve = process.argv.includes("--serve");
const staticDir = serve ? resolve(import.meta.dirname, "../dist") : undefined;

await startServer({ map, bots, skill: difficulty.skill, rules, port, staticDir, log: (line) => console.log(line) });

const addresses = Object.values(networkInterfaces())
  .flat()
  .filter((a) => a && a.family === "IPv4" && !a.internal)
  .map((a) => a!.address);
console.log(`Skronk server: map ${map}, ${bots} bots (${difficulty.label}), ${describeRules(rules)}, port ${port}`);
if (serve) {
  for (const a of addresses) console.log(`  play from another device (Xbox too): http://${a}:${port}/`);
  console.log(`  play on this machine:                http://localhost:${port}/`);
} else {
  for (const a of addresses) console.log(`  join from another device: http://${a}:5173/?join`);
  console.log(`  join from this machine:   http://localhost:5173/?join`);
}
