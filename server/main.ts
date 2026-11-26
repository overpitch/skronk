/**
 * Skronk game server, from the command line:
 *
 *   npm run server -- --map arena --bots 2 --difficulty easy
 *
 * Browsers on the same network join with ?join on the game's address (the dev
 * server's, for now): http://<this machine>:5173/?join
 */
import { networkInterfaces } from "node:os";
import { DIFFICULTIES } from "../src/client/settings";
import { GAME_PORT } from "../src/net/protocol";
import { MAX_PLAYERS, startServer } from "./gameServer";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const map = arg("map", "arena");
const bots = Math.max(0, Math.min(MAX_PLAYERS - 1, Number(arg("bots", "0")) || 0));
const difficulty = DIFFICULTIES.find((d) => d.id === arg("difficulty", "normal")) ?? DIFFICULTIES[2];
const port = Number(arg("port", String(GAME_PORT)));

await startServer({ map, bots, skill: difficulty.skill, port, log: (line) => console.log(line) });

const addresses = Object.values(networkInterfaces())
  .flat()
  .filter((a) => a && a.family === "IPv4" && !a.internal)
  .map((a) => a!.address);
console.log(`Skronk server: map ${map}, ${bots} bots (${difficulty.label}), port ${port}`);
for (const a of addresses) console.log(`  join from another device: http://${a}:5173/?join`);
console.log(`  join from this machine:   http://localhost:5173/?join`);
