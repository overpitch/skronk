/**
 * Synthesized sound effects (Web Audio, no sound files). Browsers only allow
 * audio after a user gesture, so call unlock() from a click or button press.
 */
import type { PlayerId, SimEvent } from "../sim/events";
import type { Vec3 } from "../math/vec3";

const HEARING_DISTANCE = 1600;

export class Sfx {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private noise!: AudioBuffer;

  unlock() {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.45;
      this.master.connect(this.ctx.destination);
      const len = Math.floor(this.ctx.sampleRate * 0.5);
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  /** Plays sounds for a frame's events, heard from the listener's position and facing. */
  play(events: readonly SimEvent[], localId: PlayerId, ear: Vec3, yaw: number) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return;
    const at = (pos: Vec3) => this.place(pos, ear, yaw);
    for (const e of events) {
      switch (e.type) {
        case "fire":
          if (e.player === localId) this.shot(1, 0);
          else this.shot(...at(e.origin));
          break;
        case "dryFire":
          if (e.player === localId) this.tone("square", 2200, 2000, 0.015, 0.12);
          break;
        case "impact":
          this.impact(...at(e.pos));
          break;
        case "hit":
          if (e.attacker === localId) this.tone("sine", 1500, 1300, 0.06, 0.25); // hit marker
          if (e.victim === localId) this.hurt();
          break;
        case "kill":
          if (e.attacker === localId && e.victim !== localId) {
            this.tone("triangle", 880, 880, 0.09, 0.3);
            this.tone("triangle", 1320, 1320, 0.14, 0.3, 0.08);
          }
          if (e.victim === localId) this.tone("sawtooth", 220, 55, 0.6, 0.35);
          break;
        case "pickup":
          if (e.player === localId) this.tone("sine", 520, 1250, 0.14, 0.3);
          break;
        case "respawn":
          if (e.player === localId) this.tone("sine", 300, 600, 0.25, 0.2);
          break;
      }
    }
  }

  /** [gain, pan] for a sound at pos: quieter with distance, panned by direction. */
  private place(pos: Vec3, ear: Vec3, yaw: number): [number, number] {
    const dx = pos.x - ear.x;
    const dy = pos.y - ear.y;
    const dist = Math.hypot(dx, dy, pos.z - ear.z);
    const gain = Math.max(0, 1 - dist / HEARING_DISTANCE) ** 2;
    // Right vector for yaw is (sin yaw, -cos yaw).
    const pan = dist > 1 ? (dx * Math.sin(yaw) - dy * Math.cos(yaw)) / (Math.hypot(dx, dy) || 1) : 0;
    return [gain, Math.max(-1, Math.min(1, pan * 0.8))];
  }

  private out(gain: number, pan: number): AudioNode {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    g.gain.value = gain;
    if (pan !== 0 && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      g.connect(p).connect(this.master);
    } else {
      g.connect(this.master);
    }
    return g;
  }

  private shot(gain: number, pan: number) {
    if (gain <= 0.01) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const pitch = 0.94 + Math.random() * 0.12; // slight variety so rapid fire doesn't drone
    const dest = this.out(gain, pan);

    const crack = ctx.createBufferSource();
    crack.buffer = this.noise;
    crack.playbackRate.value = pitch;
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.setValueAtTime(2600 * pitch, t);
    band.frequency.exponentialRampToValueAtTime(700, t + 0.08);
    band.Q.value = 0.9;
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.9, t);
    cg.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    crack.connect(band).connect(cg).connect(dest);
    crack.start(t, Math.random() * 0.3, 0.1);

    const thump = ctx.createOscillator();
    thump.type = "sine";
    thump.frequency.setValueAtTime(170 * pitch, t);
    thump.frequency.exponentialRampToValueAtTime(45, t + 0.09);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.8, t);
    tg.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    thump.connect(tg).connect(dest);
    thump.start(t);
    thump.stop(t + 0.11);
  }

  private impact(gain: number, pan: number) {
    if (gain <= 0.01) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 2500 + Math.random() * 1500;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.35, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
    src.connect(hp).connect(g).connect(this.out(gain, pan));
    src.start(t, Math.random() * 0.4, 0.05);
  }

  private hurt() {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    this.tone("square", 140, 70, 0.12, 0.22);
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 600;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    src.connect(lp).connect(g).connect(this.master);
    src.start(t, Math.random() * 0.3, 0.13);
  }

  private tone(type: OscillatorType, from: number, to: number, seconds: number, gain: number, delay = 0) {
    const ctx = this.ctx!;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t + seconds);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + seconds);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + seconds + 0.02);
  }
}
