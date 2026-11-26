/**
 * The browser's side of a network game: connects to the game server, sends this
 * player's controls every tick and hands back the server's snapshots at a steady
 * one per tick. A couple of snapshots wait in a buffer so the odd late packet
 * doesn't make the game stutter.
 */
import { GAME_PORT, type ClientMessage, type ServerMessage, type WorldSnapshot } from "../net/protocol";
import type { PlayerCommand } from "../sim/command";
import type { PlayerId } from "../sim/events";

/** Snapshots to hold back before playing them: smooths out uneven arrival. */
const BUFFER_TARGET = 2;
/** More than this waiting and we've fallen behind: skip ahead. */
const BUFFER_MAX = 6;

export interface Welcome {
  id: PlayerId;
  map: string;
}

/** A snapshot, with the seq of the last of our commands the server had used by then. */
export interface ReceivedSnapshot {
  snap: WorldSnapshot;
  ack: number;
}

/** ws:// address for a ?join value: empty joins the machine the page came from; "host" or "host:port" another. */
export function serverAddress(join: string): string {
  const host = join.trim() || location.hostname;
  return `ws://${host.includes(":") ? host : `${host}:${GAME_PORT}`}`;
}

export class NetClient {
  readonly names = new Map<PlayerId, string>();
  /** Called when the connection drops, with a reason to show. */
  onClose: (reason: string) => void = () => {};
  private buffer: ReceivedSnapshot[] = [];
  private playing = false;
  private seq = 0;
  private id: PlayerId = -1;

  private constructor(
    private socket: WebSocket,
    /** Pretend round trip, ms (?lag=): half on the way out, half on the way back. For trying out prediction. */
    private lag: number,
  ) {}

  /** Connects and waits for the server's welcome. */
  static connect(url: string, name?: string, lag = 0): Promise<{ net: NetClient; welcome: Welcome }> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const net = new NetClient(socket, lag);
      let welcomed = false;
      socket.addEventListener("open", () => net.send({ t: "hello", name }));
      socket.addEventListener("message", (ev) => {
        if (lag > 0) setTimeout(() => receive(ev), lag / 2);
        else receive(ev);
      });
      const receive = (ev: MessageEvent) => {
        const msg = JSON.parse(String(ev.data)) as ServerMessage;
        switch (msg.t) {
          case "welcome":
            welcomed = true;
            net.id = msg.id;
            net.setNames(msg.names);
            resolve({ net, welcome: { id: msg.id, map: msg.map } });
            break;
          case "roster":
            net.setNames(msg.names);
            break;
          case "snap":
            net.buffer.push({ snap: msg.snap, ack: msg.acks.find(([id]) => id === net.id)?.[1] ?? -1 });
            break;
          case "refused":
            reject(new Error(`the server said no: ${msg.reason}`));
            break;
        }
      };
      socket.addEventListener("close", () => {
        if (!welcomed) reject(new Error(`couldn't reach the game server at ${url}. Is it running (npm run server)?`));
        else net.onClose("Lost connection to the game server.");
      });
    });
  }

  /** Resolves once a game server answers at `url`, trying every couple of seconds. */
  static waitForServer(url: string): Promise<void> {
    return new Promise((resolve) => {
      const attempt = () => {
        const probe = new WebSocket(url);
        probe.addEventListener("open", () => {
          probe.close();
          resolve();
        });
        probe.addEventListener("error", () => setTimeout(attempt, 2000));
      };
      attempt();
    });
  }

  /** Sends this tick's controls; returns their seq. */
  sendCommand(cmd: PlayerCommand): number {
    const seq = this.seq++;
    this.send({ t: "cmd", seq, cmd });
    return seq;
  }

  /**
   * Snapshots to apply this tick, oldest first: usually one; none while the buffer
   * fills; several (skipping ahead) if we've fallen behind.
   */
  take(): ReceivedSnapshot[] {
    if (!this.playing) {
      if (this.buffer.length < BUFFER_TARGET) return [];
      this.playing = true;
    }
    if (this.buffer.length === 0) {
      // Ran dry: wait for the buffer to refill rather than play each one the moment it lands.
      this.playing = false;
      return [];
    }
    const count = this.buffer.length > BUFFER_MAX ? this.buffer.length - BUFFER_TARGET : 1;
    return this.buffer.splice(0, count);
  }

  private setNames(names: [PlayerId, string][]) {
    this.names.clear();
    for (const [id, name] of names) this.names.set(id, name);
  }

  private send(msg: ClientMessage) {
    const go = () => {
      if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(msg));
    };
    if (this.lag > 0 && msg.t === "cmd") setTimeout(go, this.lag / 2);
    else go();
  }
}
