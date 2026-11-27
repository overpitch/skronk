/**
 * The on-screen HUD: health, armor, ammo, frags, hit markers, damage flash and
 * short messages. Plain DOM, updated once per rendered frame.
 */
import type { PlayerId, SimEvent } from "../sim/events";
import { TICK_RATE, type PlayerState, type World } from "../sim/world";
import { portalColorCss } from "../render/portalColors";
import { AUTO_REMATCH_TICKS, describeRules, REMATCH_READY_TICKS, ticksLeft } from "../sim/match";
import { canFire, holds, WEAPONS, weaponIndex } from "../sim/weapons";

/** What a pickup is called on screen. */
const pickupName = (kind: string) => WEAPONS[weaponIndex(kind)]?.name ?? kind;

/** The clock turns orange in the last minute, or when someone is this close to the frag limit. */
const URGENT_TICKS = 60 * TICK_RATE;
const URGENT_FRAGS = 3;

const HIT_MARKER_SECONDS = 0.14;
const KILL_MARKER_SECONDS = 0.35;
const HIT_DIR_SECONDS = 1.1;
const HIT_DIRS = 4;
const FEED_SECONDS = 5;
const FEED_LINES = 5;
const ANNOUNCE_SECONDS = 2.2;

/** Something worth a big message (and a sound): returned by update for the audio. */
export type Announcement = "lead" | "tied" | "lostLead" | "fragsLeft" | "rivalFragsLeft" | "minute" | "tenSeconds";

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export class Hud {
  private root = el("hud");
  private health = el("hud-health");
  private armor = el("hud-armor");
  private ammo = el("hud-ammo");
  private weaponName = el("hud-weapon");
  private weaponBar = el("weapon-bar");
  private barText = "";
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
  private announceEl = el("announce");
  private announceTime = 0;
  /** Your standing last time anyone scored: in the lead, tied for it, or behind. */
  private standing: "lead" | "tied" | "behind" = "behind";
  /** Frags-left and time calls already made this match. */
  private called = new Set<string>();
  private arcs: { el: HTMLElement; time: number }[] = [];
  private arcCursor = 0;
  private feed = el("kill-feed");
  private feedLines: { el: HTMLElement; time: number }[] = [];
  /** How you last died, for the respawn message. */
  private killedBy = "";

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

  /** Per frame. Returns the announcements made this frame, for the sounds that go with them. */
  update(world: World, me: PlayerState, events: readonly SimEvent[], dt: number, showScores = false): Announcement[] {
    const over = world.match.phase === "over";
    const said = this.announce(world, me, events);
    this.hitDirections(me, events, dt);
    this.killFeed(me, events, dt);
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
        this.note.textContent = `+ ${pickupName(e.kind)}`;
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
      centre = `${this.killedBy || "You were fragged"}. Respawning in ${seconds}`;
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
    const spec = WEAPONS[me.weapon];
    const ammo = me.ammo[me.weapon];
    setText(this.weaponName, spec.name.toUpperCase());
    setText(this.ammo, spec.ammoPerShot > 0 ? String(ammo) : "");
    this.updateWeaponBar(me);
    setText(this.frags, `FRAGS ${me.frags}`);
    this.health.classList.toggle("low", me.health <= 25);
    this.ammo.classList.toggle("low", spec.ammoPerShot > 0 && ammo <= spec.maxAmmo * 0.1);

    this.announceTime = Math.max(0, this.announceTime - dt);
    this.announceEl.style.opacity = Math.min(1, this.announceTime * 2.5).toFixed(2);
    return said;
  }

  /**
   * The big calls: lead taken, tied or lost (when someone scores), frags left to win,
   * a minute and ten seconds left. Each frags-left and time call once per match.
   */
  private announce(world: World, me: PlayerState, events: readonly SimEvent[]): Announcement[] {
    const said: Announcement[] = [];
    const m = world.match;
    const say = (kind: Announcement, text: string, bad = false) => {
      said.push(kind);
      this.announceEl.textContent = text;
      this.announceEl.classList.toggle("bad", bad);
      this.announceTime = ANNOUNCE_SECONDS;
    };
    for (const e of events) {
      if (e.type === "matchStart") {
        this.called.clear();
        this.standing = "behind";
      }
      if (e.type === "kill" && e.victim === me.id) {
        const how = e.weapon ? ` (${WEAPONS[weaponIndex(e.weapon)].name.toLowerCase()})` : "";
        this.killedBy =
          e.attacker === null ? "You fell" : e.attacker === me.id ? `You fragged yourself${how}` : `Fragged by ${this.nameOf(e.attacker)}${how}`;
      }
    }
    if (m.phase !== "playing" || world.players.size < 2) return said;

    if (events.some((e) => e.type === "kill")) {
      let best = -Infinity;
      let leader: PlayerState | null = null;
      for (const p of world.players.values()) {
        if (p === me) continue;
        if (p.frags > best) {
          best = p.frags;
          leader = p;
        }
      }
      const now = me.frags > best ? "lead" : me.frags === best && me.frags > 0 ? "tied" : "behind";
      if (now !== this.standing) {
        if (now === "lead") say("lead", "You've taken the lead");
        else if (now === "tied") say("tied", "Tied for the lead");
        else if (this.standing === "lead" || this.standing === "tied") say("lostLead", "You've lost the lead", true);
        this.standing = now;
      }
      // Close to the frag limit.
      const limit = m.rules.fragLimit;
      const top = Math.max(me.frags, best);
      const left = limit - top;
      if (limit > 0 && (left === 1 || left === 3) && !this.called.has(`frags${left}`)) {
        this.called.add(`frags${left}`);
        const frags = left === 1 ? "1 frag" : `${left} frags`;
        if (me.frags === top) say("fragsLeft", `${frags} to win`);
        else say("rivalFragsLeft", `${capitalise(this.nameOf(leader!.id))} needs ${frags}`, true);
      }
    }
    if (m.rules.timeLimitTicks > 0 && !m.suddenDeath) {
      const left = ticksLeft(m, world.tick);
      if (left <= 60 * TICK_RATE && left > 59 * TICK_RATE && !this.called.has("minute")) {
        this.called.add("minute");
        say("minute", "1 minute left");
      }
      if (left <= 10 * TICK_RATE && left > 9 * TICK_RATE && !this.called.has("ten")) {
        this.called.add("ten");
        say("tenSeconds", "10 seconds", true);
      }
    }
    return said;
  }

  /** Red arcs round the crosshair pointing back the way each hit came (through portals too). */
  private hitDirections(me: PlayerState, events: readonly SimEvent[], dt: number) {
    if (this.arcs.length === 0) {
      const root = el("hit-dirs");
      for (let i = 0; i < HIT_DIRS; i++) {
        const arc = document.createElement("div");
        arc.className = "arc";
        // An arc at the top of a ring (straight ahead); turned to point the right way.
        arc.innerHTML =
          '<svg viewBox="0 0 260 260" width="260" height="260"><path d="M 75 22 A 120 120 0 0 1 185 22" fill="none" stroke="#ff3b2f" stroke-width="10" stroke-linecap="round"/></svg>';
        root.append(arc);
        this.arcs.push({ el: arc, time: 0 });
      }
    }
    for (const e of events) {
      if (e.type !== "hit" || e.victim !== me.id || e.attacker === me.id) continue;
      // Angle of the hit's direction relative to where you face: 0 ahead, positive to the left.
      const rel = Math.atan2(e.from.y, e.from.x) - me.yaw;
      const a = this.arcs[this.arcCursor];
      this.arcCursor = (this.arcCursor + 1) % this.arcs.length;
      a.time = HIT_DIR_SECONDS;
      a.el.style.transform = `rotate(${(-rel * 180) / Math.PI}deg)`;
    }
    for (const a of this.arcs) {
      a.time = Math.max(0, a.time - dt);
      a.el.style.opacity = Math.min(1, a.time * 1.6).toFixed(2);
    }
  }

  /** "Bot 1 [Railgun] You": one line per frag, top right, fading after a few seconds. */
  private killFeed(me: PlayerState, events: readonly SimEvent[], dt: number) {
    const who = (id: number) => (id === me.id ? "You" : capitalise(this.nameOf(id)));
    for (const e of events) {
      if (e.type !== "kill") continue;
      const line = document.createElement("div");
      line.className = "line";
      if (e.victim === me.id || e.attacker === me.id) line.classList.add("me");
      const weapon = e.weapon ? WEAPONS[weaponIndex(e.weapon)].name : "";
      if (e.attacker === null) line.textContent = `${who(e.victim)} fell`;
      else if (e.attacker === e.victim) {
        const you = e.victim === me.id;
        line.textContent =
          e.weapon === "rocketlauncher"
            ? `${who(e.victim)} ${you ? "were" : "was"} caught in ${you ? "your" : "their"} own blast`
            : `${who(e.victim)} shot ${you ? "yourself" : "themselves"}`;
      }
      else {
        const w = document.createElement("span");
        w.className = "weapon";
        w.textContent = `[${weapon}]`;
        line.append(who(e.attacker), w, who(e.victim));
      }
      this.feed.append(line);
      this.feedLines.push({ el: line, time: FEED_SECONDS });
      while (this.feedLines.length > FEED_LINES) this.feedLines.shift()!.el.remove();
    }
    for (const l of this.feedLines) {
      l.time -= dt;
      l.el.style.opacity = Math.min(1, l.time * 1.5).toFixed(2);
    }
    while (this.feedLines.length && this.feedLines[0].time <= 0) this.feedLines.shift()!.el.remove();
  }

  /** One box per slot: key, name and ammo; the weapon in hand lit, ones you don't hold faint. */
  private updateWeaponBar(me: PlayerState) {
    const parts = WEAPONS.map((w, i) => {
      const held = holds(me, i);
      const cls = ["slot", i === me.weapon ? "current" : "", held ? "" : "missing", held && !canFire(me, i) ? "empty" : ""].filter(Boolean).join(" ");
      const ammo = w.ammoPerShot > 0 && held ? ` ${me.ammo[i]}` : "";
      return `<span class="${cls}"><span class="key">${i + 1}</span>${w.name}${ammo}</span>`;
    });
    const markup = parts.join("");
    if (markup === this.barText) return;
    this.barText = markup;
    this.weaponBar.innerHTML = markup;
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
