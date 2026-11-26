/**
 * The game server itself: one world, its bots, and the browsers playing in it.
 * Every browser sends its controls each tick; the server steps the world at
 * TICK_RATE and sends every browser a snapshot. server/main.ts starts it from the
 * command line; tests start it in-process.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { Bot } from "../src/bots/bot";
import { buildNavGraph } from "../src/bots/nav";
import { buildLevel } from "../src/level/trenchbroom/trenchbroomLoader";
import { parseMap } from "../src/level/trenchbroom/mapParser";
import type { ClientMessage, ServerMessage } from "../src/net/protocol";
import { captureSnapshot } from "../src/net/snapshot";
import { emptyCommand, type PlayerCommand } from "../src/sim/command";
import type { PlayerId } from "../src/sim/events";
import { TICK_DT, World } from "../src/sim/world";

export const MAX_PLAYERS = 8;
/** Commands waiting beyond this many are stale (the browser got ahead): drop the oldest. */
const MAX_QUEUED = 4;
/**
 * Ticks without a command before the player stops (a quarter second): a browser tab in
 * the background or a Wi-Fi hiccup shouldn't leave someone running into a wall.
 */
const IDLE_STOP_TICKS = 15;

export interface ServerOptions {
  map: string;
  bots: number;
  /** Bot skill 0..1. */
  skill: number;
  /** 0 picks a free port. */
  port: number;
  /** Logs joins and leaves; silent if absent. */
  log?: (line: string) => void;
}

export interface RunningServer {
  world: World;
  port: number;
  close(): Promise<void>;
}

interface Client {
  socket: WebSocket;
  id: PlayerId;
  queue: PlayerCommand[];
  last: PlayerCommand;
  /** Ticks since a command arrived. */
  idle: number;
}

export function startServer(options: ServerOptions): Promise<RunningServer> {
  const log = options.log ?? (() => {});
  const mapFile = resolve(import.meta.dirname, `../public/assets/maps/${options.map}.map`);
  const level = buildLevel(options.map, parseMap(readFileSync(mapFile, "utf8")));
  const world = new World(level);
  const names = new Map<PlayerId, string>();
  let nextId = 1;

  const bots: Bot[] = [];
  const botCount = Math.max(0, Math.min(MAX_PLAYERS - 1, options.bots));
  if (botCount > 0) {
    const nav = buildNavGraph(level, world.collision);
    for (let i = 0; i < botCount; i++) {
      const id = nextId++;
      world.addPlayer(id);
      bots.push(new Bot(id, nav, options.skill));
      names.set(id, `Bot ${i + 1}`);
    }
  }

  const clients = new Set<Client>();
  const send = (socket: WebSocket, msg: ServerMessage) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
  };
  const roster = (): [PlayerId, string][] => [...names];
  const broadcast = (msg: ServerMessage) => {
    const text = JSON.stringify(msg);
    for (const c of clients) if (c.socket.readyState === c.socket.OPEN) c.socket.send(text);
  };

  const wss = new WebSocketServer({ port: options.port });
  wss.on("connection", (socket) => {
    let client: Client | null = null;
    socket.on("message", (data) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (msg.t === "hello" && !client) {
        if (world.players.size >= MAX_PLAYERS) {
          send(socket, { t: "refused", reason: `the game is full (${MAX_PLAYERS} players)` });
          socket.close();
          return;
        }
        const id = nextId++;
        world.addPlayer(id);
        names.set(id, (msg.name ?? "").trim().slice(0, 20) || `Player ${clients.size + 1}`);
        client = { socket, id, queue: [], last: emptyCommand(), idle: 0 };
        clients.add(client);
        send(socket, { t: "welcome", id, map: options.map, names: roster() });
        broadcast({ t: "roster", names: roster() });
        log(`${names.get(id)} joined (${clients.size} connected)`);
      } else if (msg.t === "cmd" && client) {
        client.queue.push(msg.cmd);
        if (client.queue.length > MAX_QUEUED) client.queue.splice(0, client.queue.length - MAX_QUEUED);
      }
    });
    socket.on("close", () => {
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
      if (next) c.last = next;
      // Nothing arrived this tick: keep doing what they were doing (a portal press is a one-off),
      // and after a while, stand still looking the same way.
      else if (c.idle > IDLE_STOP_TICKS) c.last = { ...emptyCommand(), yaw: c.last.yaw, pitch: c.last.pitch };
      else c.last = { ...c.last, portal: false };
      commands.set(c.id, c.last);
    }
    for (const b of bots) commands.set(b.id, b.command(world));
    world.step(commands);
    if (clients.size > 0) broadcast({ t: "snap", snap: captureSnapshot(world) });
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
    wss.once("error", rejectStart);
    wss.once("listening", () => {
      loop();
      const address = wss.address();
      resolveStart({
        world,
        port: typeof address === "object" && address ? address.port : options.port,
        close: () =>
          new Promise<void>((done) => {
            if (timer) clearTimeout(timer);
            for (const c of clients) c.socket.terminate();
            wss.close(() => done());
          }),
      });
    });
  });
}
