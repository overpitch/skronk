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

/** ws:// address for a ?join value: empty joins the machine the page came from; "host" or "host:port" another. */
export function serverAddress(join: string): string {
  const host = join.trim() || location.hostname;
  return `ws://${host.includes(":") ? host : `${host}:${GAME_PORT}`}`;
}

export class NetClient {
  readonly names = new Map<PlayerId, string>();
  /** Called when the connection drops, with a reason to show. */
  onClose: (reason: string) => void = () => {};
  private buffer: WorldSnapshot[] = [];
  private playing = false;
  private seq = 0;

  private constructor(private socket: WebSocket) {}

  /** Connects and waits for the server's welcome. */
  static connect(url: string, name?: string): Promise<{ net: NetClient; welcome: Welcome }> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const net = new NetClient(socket);
      let welcomed = false;
      socket.addEventListener("open", () => net.send({ t: "hello", name }));
      socket.addEventListener("message", (ev) => {
        const msg = JSON.parse(String(ev.data)) as ServerMessage;
        switch (msg.t) {
          case "welcome":
            welcomed = true;
            net.setNames(msg.names);
            resolve({ net, welcome: { id: msg.id, map: msg.map } });
            break;
          case "roster":
            net.setNames(msg.names);
            break;
          case "snap":
            net.buffer.push(msg.snap);
            break;
          case "refused":
            reject(new Error(`the server said no: ${msg.reason}`));
            break;
        }
      });
      socket.addEventListener("close", () => {
        if (!welcomed) reject(new Error(`couldn't reach the game server at ${url}. Is it running (npm run server)?`));
        else net.onClose("Lost connection to the game server.");
      });
    });
  }

  sendCommand(cmd: PlayerCommand) {
    this.send({ t: "cmd", seq: this.seq++, cmd });
  }

  /**
   * Snapshots to apply this tick, oldest first: usually one; none while the buffer
   * fills; several (skipping ahead) if we've fallen behind.
   */
  take(): WorldSnapshot[] {
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
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(msg));
  }
}
