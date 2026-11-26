import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startServer, type RunningServer } from "../server/gameServer";
import { Bot } from "../src/bots/bot";
import { buildNavGraph } from "../src/bots/nav";
import type { ServerMessage, WorldSnapshot } from "../src/net/protocol";
import { applySnapshot, captureSnapshot } from "../src/net/snapshot";
import { emptyCommand } from "../src/sim/command";
import { World } from "../src/sim/world";
import { loadTestMap } from "./helpers";

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
    expect(Math.hypot(quiet.velocity.x, quiet.velocity.y)).toBeLessThan(5);

    // A leaves: gone from the world.
    a.socket.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(running.world.players.has(wa.id)).toBe(false);
    b.socket.close();
  });
});
