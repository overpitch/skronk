import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { startServer, type RunningServer } from "../server/gameServer";
import { Bot } from "../src/bots/bot";
import { buildNavGraph } from "../src/bots/nav";
import type { ServerMessage, WorldSnapshot } from "../src/net/protocol";
import { applySnapshot, captureSnapshot } from "../src/net/snapshot";
import { Predictor } from "../src/client/prediction";
import type { PlayerCommand } from "../src/sim/command";
import { set } from "../src/math/vec3";
import { emptyCommand, sanitizeCommand } from "../src/sim/command";
import { serverAddress } from "../src/client/netClient";
import { World } from "../src/sim/world";
import { loadTestMap } from "./helpers";

describe("joining and commands from outside", () => {
  it("cleans up commands from the network", () => {
    const c = sanitizeCommand({ forward: 5, right: -Infinity, yaw: "x", pitch: 9, jump: "yes", fire: true, weapon: 3.7, extra: 1 });
    expect(c).toEqual({ forward: 1, right: 0, yaw: 0, pitch: (89 * Math.PI) / 180, jump: false, sprint: false, fire: true, portal: false, weapon: 3 });
    expect(sanitizeCommand({ weapon: -4 }).weapon).toBe(0);
    expect(sanitizeCommand(null)).toEqual(emptyCommand());
    expect(Number.isFinite(sanitizeCommand({ yaw: 1e300 }).yaw)).toBe(true);
  });

  it("works out the address to join", () => {
    const home = { protocol: "http:", hostname: "192.168.1.98" };
    const live = { protocol: "https:", hostname: "overpitch.github.io" };
    expect(serverAddress("", home)).toBe("ws://192.168.1.98:5175");
    expect(serverAddress("other-mac", home)).toBe("ws://other-mac:5175");
    expect(serverAddress("other-mac:9000", home)).toBe("ws://other-mac:9000");
    expect(serverAddress("", live, "wss://skronk.example.com")).toBe("wss://skronk.example.com");
    expect(serverAddress("skronk.example.com", live)).toBe("wss://skronk.example.com");
    expect(serverAddress("ws://test:1", live, "wss://skronk.example.com")).toBe("ws://test:1");
  });
});

describe("snapshots", () => {
  it("copy a world mid-game into a fresh one, through JSON", () => {
    const level = loadTestMap();
    const server = new World(level);
    const nav = buildNavGraph(level, server.collision);
    const bots = [1, 2, 3].map((id) => {
      server.addPlayer(id);
      return new Bot(id, nav);
    });
    // Play until there are shots in the air, then add portals for player 1.
    let ticks = 0;
    while (server.projectiles.length === 0 && ticks++ < 3000) server.step(new Map(bots.map((b) => [b.id, b.command(server)])));
    const p1 = server.players.get(1)!;
    server.step(new Map([[1, { ...emptyCommand(), yaw: 0, portal: true }]]));
    for (let i = 0; i < 20; i++) server.step(new Map([[1, { ...emptyCommand(), yaw: Math.PI }]]));
    server.step(new Map([[1, { ...emptyCommand(), yaw: Math.PI, portal: true }]]));

    const snap: WorldSnapshot = JSON.parse(JSON.stringify(captureSnapshot(server)));
    const client = new World(level);
    applySnapshot(client, snap);

    expect(client.tick).toBe(server.tick);
    expect([...client.players.keys()].sort()).toEqual([1, 2, 3]);
    const c1 = client.players.get(1)!;
    expect(c1.origin).toEqual(p1.origin);
    expect(c1.health).toBe(p1.health);
    expect(client.projectiles.map((p) => p.id)).toEqual(server.projectiles.map((p) => p.id));
    expect(client.portals.map((p) => p.id)).toEqual(server.portals.map((p) => p.id));
    expect(client.linkedPortal(client.portals[0])?.id).toBe(server.linkedPortal(server.portals[0])?.id);
    expect(client.pickups.map((p) => p.availableAtTick)).toEqual(server.pickups.map((p) => p.availableAtTick));

    // A player who left is gone from the copy too.
    server.removePlayer(3);
    applySnapshot(client, JSON.parse(JSON.stringify(captureSnapshot(server))));
    expect(client.players.has(3)).toBe(false);
  });
});

describe("prediction", () => {
  /**
   * A server world and a client mirror joined by a delay of `delay` ticks each way.
   * Runs `commands`, returns where the client predicted itself and where the server had it,
   * after each command, plus the largest correction the client had to smooth over.
   */
  function play(commands: PlayerCommand[], delay: number, setup?: (server: World) => void) {
    const level = loadTestMap();
    const server = new World(level);
    const client = new World(level);
    server.addPlayer(1);
    setup?.(server);
    // Let the player settle onto the floor first: a spawn sits a unit up, and the server moves
    // it during the ticks before the first command arrives, which the client can't predict.
    for (let i = 0; i < 10; i++) server.step(new Map());
    const me = client.addPlayer(1);
    applySnapshot(client, captureSnapshot(server));
    const predictor = new Predictor();
    const toServer: { at: number; seq: number; cmd: PlayerCommand }[] = [];
    const toClient: { at: number; snap: ReturnType<typeof captureSnapshot>; ack: number }[] = [];
    const predicted = new Map<number, number[]>();
    const actual = new Map<number, number[]>();
    let ack = -1;
    let worst = 0;
    for (let t = 0; t < commands.length + 3 * delay; t++) {
      // Client: send this tick's command and predict.
      const cmd = commands[Math.min(t, commands.length - 1)];
      if (t < commands.length) {
        predictor.sent(t, cmd);
        toServer.push({ at: t + delay, seq: t, cmd });
      }
      let gotAck: number | null = null;
      while (toClient.length && toClient[0].at <= t) {
        const m = toClient.shift()!;
        applySnapshot(client, m.snap);
        gotAck = m.ack;
      }
      if (t < commands.length) {
        predictor.tick(client, me, gotAck);
        predictor.writeTo(me);
        predicted.set(t, [me.origin.x, me.origin.y, me.origin.z]);
        worst = Math.max(worst, Math.hypot(predictor.offset.x, predictor.offset.y, predictor.offset.z));
      }
      // Server: use the command that's arrived (one a tick), step, send a snapshot back.
      const arrived = toServer.length && toServer[0].at <= t ? toServer.shift()! : null;
      if (arrived) ack = arrived.seq;
      server.step(new Map(arrived ? [[1, arrived.cmd]] : []));
      if (arrived) {
        const p = server.players.get(1)!;
        actual.set(arrived.seq, [p.origin.x, p.origin.y, p.origin.z]);
      }
      toClient.push({ at: t + delay, snap: JSON.parse(JSON.stringify(captureSnapshot(server))), ack });
    }
    return { predicted, actual, worst, server };
  }

  it("predicts walking exactly, so nothing needs correcting", () => {
    const walk = Array.from({ length: 120 }, (_, i) => ({ ...emptyCommand(), forward: 1, yaw: i * 0.02 }));
    const { predicted, actual, worst } = play(walk, 5);
    for (const [seq, at] of actual) {
      const p = predicted.get(seq)!;
      expect(Math.hypot(p[0] - at[0], p[1] - at[1], p[2] - at[2])).toBeLessThan(1e-6);
    }
    expect(worst).toBeLessThan(1e-6);
  });

  it("predicts a trip through a portal at the same moment the server makes it", () => {
    const toEast = Array.from({ length: 90 }, () => ({ ...emptyCommand(), forward: 1, yaw: 0 }));
    const { predicted, actual } = play(toEast, 5, (server) => {
      // A linked pair on the east and west walls, and player 1 walking into the east one.
      const p = server.players.get(1)!;
      set(p.origin, 0, 0, 24.5);
      server.step(new Map([[1, { ...emptyCommand(), yaw: Math.atan2(200, 512), portal: true }]]));
      for (let i = 0; i < 20; i++) server.step(new Map([[1, emptyCommand()]]));
      server.step(new Map([[1, { ...emptyCommand(), yaw: Math.atan2(-150, -512), portal: true }]]));
      for (let i = 0; i < 20; i++) server.step(new Map([[1, emptyCommand()]]));
      set(p.origin, 400, 200, 24.5);
      set(p.prevOrigin, 400, 200, 24.5);
      set(p.velocity, 0, 0, 0);
    });
    const hop = [...actual].find(([, at]) => at[0] < 0)![0]; // first command that put it on the west side
    expect(predicted.get(hop)![0]).toBeLessThan(0);
    expect(predicted.get(hop - 1)![0]).toBeGreaterThan(0);
    for (const [seq, at] of actual) expect(predicted.get(seq)![0]).toBeCloseTo(at[0], 6);
  });

  it("smooths over a knock it couldn't have predicted, and ends up where the server says", () => {
    const stand = Array.from({ length: 60 }, () => emptyCommand());
    const { predicted, actual, worst } = play(stand, 5, (server) => {
      // Something the client can't know about: the server shoves the player halfway through.
      const step = server.step.bind(server);
      server.step = (c) => {
        if (server.tick === 30) server.players.get(1)!.velocity.x += 300;
        step(c);
      };
    });
    expect(worst).toBeGreaterThan(1); // there was a correction to smooth
    const last = Math.max(...actual.keys());
    expect(predicted.get(last)![0]).toBeCloseTo(actual.get(last)![0], 6);
  });
});

describe("game server", () => {
  let running: RunningServer | null = null;
  afterEach(async () => {
    await running?.close();
    running = null;
  });

  /** A test client: collects every message, and can wait for one that matches. */
  function connect(port: number) {
    const socket = new WebSocket(`ws://localhost:${port}`);
    const messages: ServerMessage[] = [];
    const waiters: (() => void)[] = [];
    socket.on("message", (data) => {
      messages.push(JSON.parse(String(data)));
      for (const w of waiters.splice(0)) w();
    });
    const waitFor = async <T extends ServerMessage>(match: (m: ServerMessage) => m is T, ms = 3000): Promise<T> => {
      const deadline = Date.now() + ms;
      for (;;) {
        const found = messages.find(match);
        if (found) return found;
        if (Date.now() > deadline) throw new Error("timed out waiting for a message");
        await new Promise<void>((r) => {
          waiters.push(r);
          setTimeout(r, 50);
        });
      }
    };
    const opened = new Promise<void>((r) => socket.on("open", () => r()));
    return { socket, messages, waitFor, opened };
  }
  const isWelcome = (m: ServerMessage): m is Extract<ServerMessage, { t: "welcome" }> => m.t === "welcome";
  const isSnap = (m: ServerMessage): m is Extract<ServerMessage, { t: "snap" }> => m.t === "snap";

  it("keeps names unique", async () => {
    running = await startServer({ map: "test_box", bots: 0, skill: 0.5, port: 0 });
    const a = connect(running.port);
    const b = connect(running.port);
    await Promise.all([a.opened, b.opened]);
    a.socket.send(JSON.stringify({ t: "hello", name: "Grandpa" }));
    await a.waitFor(isWelcome);
    b.socket.send(JSON.stringify({ t: "hello", name: "  Grandpa  " }));
    const wb = await b.waitFor(isWelcome);
    expect(new Map(wb.names).get(wb.id)).toBe("Grandpa 2");
    a.socket.close();
    b.socket.close();
  });

  it("serves the built game on the same port, and nothing outside it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "skronk-dist-"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>Skronk</title>");
    running = await startServer({ map: "test_box", bots: 0, skill: 0.5, port: 0, staticDir: dir });
    const base = `http://localhost:${running.port}`;
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("Skronk");
    expect((await fetch(`${base}/missing.js`)).status).toBe(404);
    expect((await fetch(`${base}/%2e%2e/%2e%2e/etc/passwd`)).status).toBe(404);
  });

  it("shrugs off nonsense from a browser", async () => {
    running = await startServer({ map: "test_box", bots: 0, skill: 0.5, port: 0 });
    const health = await fetch(`http://localhost:${running.port}/health`);
    expect(await health.text()).toBe("ok");
    const a = connect(running.port);
    await a.opened;
    a.socket.send("not json");
    a.socket.send(JSON.stringify(null));
    a.socket.send(JSON.stringify({ t: "hello", name: { evil: true } }));
    const w = await a.waitFor(isWelcome);
    for (let i = 0; i < 30; i++) {
      a.socket.send(JSON.stringify({ t: "cmd", seq: i, cmd: { forward: 1e9, yaw: "north", pitch: null, fire: "always" } }));
      a.socket.send(JSON.stringify({ t: "cmd", seq: "x", cmd: {} }));
      await new Promise((r) => setTimeout(r, 1000 / 60));
    }
    await new Promise((r) => setTimeout(r, 100));
    const p = running.world.players.get(w.id)!;
    expect([p.origin.x, p.origin.y, p.origin.z, p.yaw].every(Number.isFinite)).toBe(true);
    expect(Math.hypot(p.velocity.x, p.velocity.y)).toBeLessThanOrEqual(321); // ordinary run speed at most
    expect(new Map(w.names).get(w.id)).toBe("Player 1");
    a.socket.close();
  });

  it("lets two browsers join, and each sees the other move", async () => {
    running = await startServer({ map: "test_box", bots: 1, skill: 0.5, port: 0 });
    const a = connect(running.port);
    const b = connect(running.port);
    await Promise.all([a.opened, b.opened]);
    a.socket.send(JSON.stringify({ t: "hello", name: "Grandpa" }));
    b.socket.send(JSON.stringify({ t: "hello" }));
    const wa = await a.waitFor(isWelcome);
    const wb = await b.waitFor(isWelcome);
    expect(wa.map).toBe("test_box");
    expect(wa.id).not.toBe(wb.id);
    // B learns A's name, from its welcome or a roster update.
    const named = (m: ServerMessage): m is Extract<ServerMessage, { t: "welcome" | "roster" }> =>
      (m.t === "welcome" || m.t === "roster") && new Map(m.names).get(wa.id) === "Grandpa";
    await b.waitFor(named);

    // A walks forward for half a second; B's snapshots show A moving.
    const start = (await b.waitFor(isSnap)).snap.players.find((p) => p.id === wa.id)!.origin;
    for (let i = 0; i < 30; i++) {
      a.socket.send(JSON.stringify({ t: "cmd", seq: i, cmd: { ...emptyCommand(), forward: 1, yaw: 0 } }));
      await new Promise((r) => setTimeout(r, 1000 / 60));
    }
    await new Promise((r) => setTimeout(r, 100));
    const snaps = b.messages.filter(isSnap);
    const now = snaps[snaps.length - 1].snap.players.find((p) => p.id === wa.id)!.origin;
    expect(Math.hypot(now[0] - start[0], now[1] - start[1])).toBeGreaterThan(60);
    // The bot is in the game too.
    expect(snaps[snaps.length - 1].snap.players).toHaveLength(3);

    // A goes quiet while running (a tab in the background, say): it stops instead of running on.
    for (let i = 0; i < 5; i++) {
      a.socket.send(JSON.stringify({ t: "cmd", seq: 100 + i, cmd: { ...emptyCommand(), forward: 1, yaw: 0 } }));
      await new Promise((r) => setTimeout(r, 1000 / 60));
    }
    await new Promise((r) => setTimeout(r, 700));
    const quiet = running.world.players.get(wa.id)!;
    // (Well below run speed: the bot may have knocked it about a little with a hit.)
    expect(Math.hypot(quiet.velocity.x, quiet.velocity.y)).toBeLessThan(100);

    // A leaves: gone from the world.
    a.socket.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(running.world.players.has(wa.id)).toBe(false);
    b.socket.close();
  });
});
