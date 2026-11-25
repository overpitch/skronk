/**
 * The on-screen HUD: health, armor, ammo, frags, hit markers, damage flash and
 * short messages. Plain DOM, updated once per rendered frame.
 */
import type { PlayerId, SimEvent } from "../sim/events";
import { TICK_RATE, type PlayerState, type World } from "../sim/world";
import { portalColorCss } from "../render/portalColors";

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
  private crosshairColor = "";
  private markerTime = 0;
  private flashLevel = 0;
  private centreText = "";
  private centreTime = 0;
  private noteTime = 0;

  constructor(private nameOf: (id: PlayerId) => string) {}

  setVisible(visible: boolean) {
    this.root.classList.toggle("hidden", !visible);
  }

  update(world: World, me: PlayerState, events: readonly SimEvent[], dt: number) {
    for (const e of events) {
      if (e.type === "hit" && e.attacker === me.id && e.victim !== me.id) this.showMarker(HIT_MARKER_SECONDS, false);
      if (e.type === "hit" && e.victim === me.id) this.flashLevel = Math.min(0.55, this.flashLevel + 0.22);
      if (e.type === "kill" && e.attacker === me.id && e.victim !== me.id) {
        this.showMarker(KILL_MARKER_SECONDS, true);
        this.say(`Fragged ${this.nameOf(e.victim)}`, 1.6);
      }
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
    if (!me.alive) {
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

  private showMarker(seconds: number, kill: boolean) {
    this.markerTime = seconds;
    this.marker.classList.toggle("kill", kill);
  }

  private say(text: string, seconds: number) {
    this.centreText = text;
    this.centreTime = seconds;
  }
}

function setText(node: HTMLElement, text: string) {
  if (node.textContent !== text) node.textContent = text;
}
