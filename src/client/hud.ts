/**
 * The on-screen HUD: health, armor, ammo, frags, hit markers, damage flash and
 * short messages. Plain DOM, updated once per rendered frame.
 */
import type { PlayerId, SimEvent } from "../sim/events";
import { TICK_RATE, type PlayerState, type World } from "../sim/world";
import { portalColorCss } from "../render/portalColors";
import { AUTO_REMATCH_TICKS, describeRules, REMATCH_READY_TICKS, ticksLeft } from "../sim/match";

/** The clock turns orange in the last minute, or when someone is this close to the frag limit. */
const URGENT_TICKS = 60 * TICK_RATE;
const URGENT_FRAGS = 3;

const HIT_MARKER_SECONDS = 0.14;
const KILL_MARKER_SECONDS = 0.35;

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export class Hud {
  private root = el("hud");
  private health = el("hud-health");
  private armor = el("hud-armor");
  private ammo = el("hud-ammo");
  private frags = el("hud-frags");
  private marker = el("hitmarker");
  private flash = el("damage-flash");
  private centre = el("centre-msg");
  private note = el("pickup-msg");
  private crosshair = el("crosshair");
  private scoreboard = el("scoreboard");
  private scoreRows = this.scoreboard.querySelector("tbody")!;
  private clock = el("match-clock");
  private protectedMsg = el("protected-msg");
  private endBox = el("match-end");
  private winnerText = el("match-winner");
  private rulesText = el("match-rules");
  private nextText = el("match-next");
  private scoreText = "";
  private crosshairColor = "";
  private markerTime = 0;
  private flashLevel = 0;
  private centreText = "";
  private centreTime = 0;
  private noteTime = 0;

  constructor(
    private nameOf: (id: PlayerId) => string,
    /** In a network game the server starts the next match; on your own you ask for it. */
    private networked = false,
  ) {}

  private visible = false;

  setVisible(visible: boolean) {
    this.visible = visible;
    this.root.classList.toggle("hidden", !visible);
  }

  update(world: World, me: PlayerState, events: readonly SimEvent[], dt: number, showScores = false) {
    const over = world.match.phase === "over";
    this.updateScores(world, me, showScores || !me.alive || over);
    this.updateMatch(world, me);
    for (const e of events) {
      if (e.type === "hit" && e.attacker === me.id && e.victim !== me.id) this.showMarker(HIT_MARKER_SECONDS, false);
      if (e.type === "hit" && e.victim === me.id) this.flashLevel = Math.min(0.55, this.flashLevel + 0.22);
      if (e.type === "kill" && e.attacker === me.id && e.victim !== me.id) {
        this.showMarker(KILL_MARKER_SECONDS, true);
        this.say(`Fragged ${this.nameOf(e.victim)}`, 1.6);
      }
      if (e.type === "suddenDeath") this.say("Sudden death: the next frag wins", 3);
      if (e.type === "matchStart") this.say("Fight!", 1.2);
      if (e.type === "pickup" && e.player === me.id) {
        this.note.textContent = `+ ${e.kind}`;
        this.noteTime = 1.2;
      }
    }

    this.markerTime = Math.max(0, this.markerTime - dt);
    this.marker.classList.toggle("on", this.markerTime > 0);
    this.flashLevel *= Math.exp(-5 * dt);
    this.flash.style.opacity = this.flashLevel.toFixed(3);
    this.noteTime = Math.max(0, this.noteTime - dt);
    this.note.style.opacity = Math.min(1, this.noteTime * 3).toFixed(2);

    let centre = "";
    if (over) {
      // The end screen says it all.
    } else if (!me.alive) {
      const seconds = Math.max(0, Math.ceil((me.respawnTick - world.tick) / TICK_RATE));
      centre = `You were fragged. Respawning in ${seconds}`;
    } else if (this.centreTime > 0) {
      this.centreTime -= dt;
      centre = this.centreText;
    }
    if (this.centre.textContent !== centre) this.centre.textContent = centre;

    // The ring round the crosshair is the colour your next portal shot places.
    const next = portalColorCss(true, world.nextPortalSlot(world.portalOwnerOf(me)));
    if (next !== this.crosshairColor) {
      this.crosshairColor = next;
      this.crosshair.style.setProperty("--portal-next", next);
    }

    setText(this.health, String(Math.max(0, me.health)));
    setText(this.armor, String(me.armor));
    setText(this.ammo, String(me.ammo));
    setText(this.frags, `FRAGS ${me.frags}`);
    this.health.classList.toggle("low", me.health <= 25);
    this.ammo.classList.toggle("low", me.ammo <= 20);
  }

  /** The clock and frag race at the top, spawn protection, and the end screen. */
  private updateMatch(world: World, me: PlayerState) {
    const m = world.match;
    const { fragLimit, timeLimitTicks } = m.rules;
    const over = m.phase === "over";
    const limited = fragLimit > 0 || timeLimitTicks > 0;

    // The clock and protection notice belong to play; the menu covers the rest.
    this.clock.classList.toggle("hidden", !limited || over || !this.visible);
    if (limited && !over) {
      const parts: string[] = [];
      const left = ticksLeft(m, world.tick);
      if (m.suddenDeath) parts.push("SUDDEN DEATH");
      else if (timeLimitTicks > 0) {
        const s = Math.ceil(left / TICK_RATE);
        parts.push(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`);
      }
      // You against the best of the rest.
      let rival: PlayerState | null = null;
      for (const p of world.players.values()) {
        if (p !== me && (!rival || p.frags > rival.frags || (p.frags === rival.frags && p.id < rival.id))) rival = p;
      }
      parts.push(`You: ${me.frags}`);
      if (rival) parts.push(`${capitalise(this.nameOf(rival.id))}: ${rival.frags}`);
      if (fragLimit > 0) parts.push(`first to ${fragLimit}`);
      setText(this.clock, parts.join("  ·  "));
      const best = Math.max(me.frags, rival?.frags ?? 0);
      const urgent = m.suddenDeath || (timeLimitTicks > 0 && left <= URGENT_TICKS) || (fragLimit > 0 && fragLimit - best <= URGENT_FRAGS);
      this.clock.classList.toggle("urgent", urgent);
    }

    this.protectedMsg.classList.toggle("hidden", !this.visible || over || !me.alive || world.tick >= me.protectedUntil);

    this.endBox.classList.toggle("hidden", !over);
    this.nextText.classList.toggle("hidden", !over);
    if (!over) return;
    const winner = m.winner === me.id ? "You win!" : m.winner === null ? "Match over" : `${capitalise(this.nameOf(m.winner))} wins`;
    setText(this.winnerText, winner);
    setText(this.rulesText, capitalise(describeRules(m.rules)));
    const since = world.tick - m.endTick;
    const next = this.networked
      ? `Next match in ${Math.max(0, Math.ceil((AUTO_REMATCH_TICKS - since) / TICK_RATE))}`
      : since >= REMATCH_READY_TICKS
        ? "Click, Space or A for a rematch"
        : "";
    setText(this.nextText, next);
  }

  /** Everyone, most frags first (fewest deaths breaks ties); you highlighted. */
  private updateScores(world: World, me: PlayerState, show: boolean) {
    this.scoreboard.classList.toggle("hidden", !show);
    if (!show) return;
    const rows = [...world.players.values()].sort((a, b) => b.frags - a.frags || a.deaths - b.deaths || a.id - b.id);
    const text = rows.map((p) => `${p.id}:${p.frags}:${p.deaths}:${this.nameOf(p.id)}`).join("|");
    if (text === this.scoreText) return;
    this.scoreText = text;
    this.scoreRows.replaceChildren(
      ...rows.map((p) => {
        const tr = document.createElement("tr");
        if (p.id === me.id) tr.className = "me";
        for (const value of [p.id === me.id ? "You" : this.nameOf(p.id), String(p.frags), String(p.deaths)]) {
          const td = document.createElement("td");
          td.textContent = value;
          tr.append(td);
        }
        return tr;
      }),
    );
  }

  private showMarker(seconds: number, kill: boolean) {
    this.markerTime = seconds;
    this.marker.classList.toggle("kill", kill);
  }

  private say(text: string, seconds: number) {
    this.centreText = text;
    this.centreTime = seconds;
  }
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function setText(node: HTMLElement, text: string) {
  if (node.textContent !== text) node.textContent = text;
}
