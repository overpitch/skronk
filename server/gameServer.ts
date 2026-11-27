/**
 * The game server itself: one world, its bots, and the browsers playing in it.
 * Every browser sends its controls each tick; the server steps the world at
 * TICK_RATE and sends every browser a snapshot. server/main.ts starts it from the
 * command line; tests start it in-process.
 */
import { MonsterDirector } from "../src/bots/monsterDirector";
import { personalityFor } from "../src/bots/personality";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { Bot } from "../src/bots/bot";
import { buildNavGraph } from "../src/bots/nav";
import { buildLevel } from "../src/level/trenchbroom/trenchbroomLoader";
import { parseMap } from "../src/level/trenchbroom/mapParser";
import type { ClientMessage, ServerMessage } from "../src/net/protocol";
import { captureSnapshot } from "../src/net/snapshot";
import { emptyCommand, sanitizeCommand, type PlayerCommand } from "../src/sim/command";
import type { PlayerId } from "../src/sim/events";
import { AUTO_REMATCH_TICKS, FREE_PLAY, type MatchRules } from "../src/sim/match";
import { TICK_DT, World } from "../src/sim/world";

export const MAX_PLAYERS = 8;
/** Commands waiting beyond this many are stale (the browser got ahead): drop the oldest. */
const MAX_QUEUED = 4;
/**
 * Ticks without a command before the player stops (a quarter second): a browser tab in
 * the background or a Wi-Fi hiccup shouldn't leave someone running into a wall.
 */
const IDLE_STOP_TICKS = 15;
/** Biggest message a browser may send (a command is ~200 bytes). */
const MAX_MESSAGE_BYTES = 4096;
/** Connections at once, joined or not: enough for a full game plus a few waiting at the door. */
const MAX_CONNECTIONS = MAX_PLAYERS * 3;
/** A connection that hasn't said hello by then is dropped. */
const HELLO_TIMEOUT_MS = 10_000;

export interface ServerOptions {
  map: string;
  bots: number;
  /** Bot skill 0..1. */
  skill: number;
  /** Frag and time limits; free play if absent. The next match starts by itself after each one ends. */
  rules?: MatchRules;
  /** 0 picks a free port. */
  port: number;
  /** Logs joins and leaves; silent if absent. */
  log?: (line: string) => void;
  /**
   * Also serve the built game (the dist folder) over HTTP on the same port, so a
   * browser can open http://<this machine>:<port>/ and be straight in the game.
   */
  staticDir?: string;
}

export interface RunningServer {
  world: World;
  port: number;
  close(): Promise<void>;
}

interface Client {
  socket: WebSocket;
  id: PlayerId;
  queue: { seq: number; cmd: PlayerCommand }[];
  last: PlayerCommand;
  /** seq of the last command used (-1 before the first). */
  ack: number;
  /** Ticks since a command arrived. */
  idle: number;
}

export function startServer(options: ServerOptions): Promise<RunningServer> {
  const log = options.log ?? (() => {});
  const mapFile = resolve(import.meta.dirname, `../public/assets/maps/${options.map}.map`);
  const level = buildLevel(options.map, parseMap(readFileSync(mapFile, "utf8")));
  const world = new World(level, options.rules ?? FREE_PLAY);
  const names = new Map<PlayerId, string>();
  let nextId = 1;

  const bots: Bot[] = [];
  const botCount = Math.max(0, Math.min(MAX_PLAYERS - 1, options.bots));
  const horde = options.rules?.mode === "horde";
  const nav = botCount > 0 || horde ? buildNavGraph(level, world.collision) : null;
  // Horde's monsters, moved here like the bots.
  const director = horde && nav ? new MonsterDirector(nav) : null;
  if (botCount > 0 && nav) {
    for (let i = 0; i < botCount; i++) {
      const id = nextId++;
      world.addPlayer(id);
      const bot = new Bot(id, nav, options.skill, personalityFor(i));
      bots.push(bot);
      names.set(id, bot.personality.name);
    }
  }

  const clients = new Set<Client>();
  const send = (socket: WebSocket, msg: ServerMessage) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
  };
  const roster = (): [PlayerId, string][] => [...names];
  /** Two people both called Grandpa become Grandpa and Grandpa 2. */
  const uniqueName = (wanted: string) => {
    const taken = new Set(names.values());
    if (!taken.has(wanted)) return wanted;
    for (let n = 2; ; n++) if (!taken.has(`${wanted} ${n}`)) return `${wanted} ${n}`;
  };
  const broadcast = (msg: ServerMessage) => {
    const text = JSON.stringify(msg);
    for (const c of clients) if (c.socket.readyState === c.socket.OPEN) c.socket.send(text);
  };

  const http = createServer((req, res) => {
    // For hosting services' health checks.
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    void serveStatic(options.staticDir, req, res);
  });
  const wss = new WebSocketServer({ server: http, maxPayload: MAX_MESSAGE_BYTES });
  wss.on("connection", (socket) => {
    let client: Client | null = null;
    if (wss.clients.size > MAX_CONNECTIONS) {
      socket.close();
      return;
    }
    const helloTimer = setTimeout(() => {
      if (!client) socket.close();
    }, HELLO_TIMEOUT_MS);
    socket.on("error", () => socket.terminate());
    socket.on("message", (data) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (typeof msg !== "object" || msg === null) return;
      if (msg.t === "hello" && !client) {
        clearTimeout(helloTimer);
        if (world.players.size >= MAX_PLAYERS) {
          send(socket, { t: "refused", reason: `the game is full (${MAX_PLAYERS} players)` });
          socket.close();
          return;
        }
        const id = nextId++;
        world.addPlayer(id);
        names.set(id, uniqueName((typeof msg.name === "string" ? msg.name : "").replace(/\s+/g, " ").trim().slice(0, 20) || `Player ${clients.size + 1}`));
        client = { socket, id, queue: [], last: emptyCommand(), ack: -1, idle: 0 };
        clients.add(client);
        send(socket, { t: "welcome", id, map: options.map, names: roster() });
        broadcast({ t: "roster", names: roster() });
        log(`${names.get(id)} joined (${clients.size} connected)`);
      } else if (msg.t === "cmd" && client) {
        if (typeof msg.seq !== "number" || !Number.isFinite(msg.seq)) return;
        client.queue.push({ seq: msg.seq, cmd: sanitizeCommand(msg.cmd) });
        if (client.queue.length > MAX_QUEUED) client.queue.splice(0, client.queue.length - MAX_QUEUED);
      }
    });
    socket.on("close", () => {
      clearTimeout(helloTimer);
      if (!client) return;
      clients.delete(client);
      world.removePlayer(client.id);
      log(`${names.get(client.id)} left (${clients.size} connected)`);
      names.delete(client.id);
      broadcast({ t: "roster", names: roster() });
    });
  });

  /** One tick: everyone's next command (or their last, if none arrived), step, send the result. */
  const tick = () => {
    const commands = new Map<PlayerId, PlayerCommand>();
    for (const c of clients) {
      const next = c.queue.shift();
      c.idle = next ? 0 : c.idle + 1;
      if (next) {
        c.last = next.cmd;
        c.ack = next.seq;
      }
      // Nothing arrived this tick: keep doing what they were doing (a portal press is a one-off),
      // and after a while, stand still looking the same way.
      else if (c.idle > IDLE_STOP_TICKS) c.last = { ...emptyCommand(), yaw: c.last.yaw, pitch: c.last.pitch };
      else c.last = { ...c.last, portal: false };
      commands.set(c.id, c.last);
    }
    for (const b of bots) commands.set(b.id, b.command(world));
    // The end screen shows for a while, then the next match starts.
    if (world.match.phase === "over" && world.tick - world.match.endTick >= AUTO_REMATCH_TICKS) world.rematch();
    world.step(commands, director?.commands(world));
    for (const e of world.events) {
      if (e.type === "matchOver") log(e.winner === null ? `match over: the horde won (wave ${world.match.horde?.wave ?? 0})` : `match over: ${names.get(e.winner) ?? `player ${e.winner}`} won`);
      if (e.type === "matchStart") log("new match");
    }
    if (clients.size > 0) broadcast({ t: "snap", snap: captureSnapshot(world), acks: [...clients].map((c) => [c.id, c.ack]) });
  };

  // Fixed-rate loop. setTimeout drifts, so catch up from the clock (never more than a few ticks).
  let next = performance.now();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const loop = () => {
    const now = performance.now();
    let n = 0;
    while (now >= next && n < 5) {
      tick();
      next += TICK_DT * 1000;
      n++;
    }
    if (now - next > 250) next = now; // fell far behind (machine asleep?): don't try to catch up
    timer = setTimeout(loop, Math.max(0, next - performance.now()));
  };

  return new Promise((resolveStart, rejectStart) => {
    http.once("error", rejectStart);
    http.listen(options.port, () => {
      loop();
      const address = http.address();
      resolveStart({
        world,
        port: typeof address === "object" && address ? address.port : options.port,
        close: () =>
          new Promise<void>((done) => {
            if (timer) clearTimeout(timer);
            for (const c of clients) c.socket.terminate();
            wss.close(() => http.close(() => done()));
          }),
      });
    });
  });
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".map": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
};

/** Serves files from `dir` (the built game); anything outside it, or missing, is a 404. */
async function serveStatic(dir: string | undefined, req: IncomingMessage, res: ServerResponse) {
  const notFound = () => {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  };
  if (!dir || (req.method !== "GET" && req.method !== "HEAD")) return notFound();
  let path: string;
  try {
    path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
  } catch {
    return notFound();
  }
  const root = resolve(dir);
  const file = resolve(root, "." + (path.endsWith("/") ? path + "index.html" : path));
  if (file !== root && !file.startsWith(root + sep)) return notFound();
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch {
    notFound();
  }
}
