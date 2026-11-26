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
  private volume = 1;
  private noise!: AudioBuffer;

  /** 0 silent, 1 full. */
  setVolume(volume: number) {
    this.volume = volume;
    if (this.ctx) this.master.gain.value = 0.45 * volume;
  }

  unlock() {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.45 * this.volume;
      this.master.connect(this.ctx.destination);
      const len = Math.floor(this.ctx.sampleRate * 1.5);
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
        case "fire": {
          const [gain, pan] = e.player === localId ? [1, 0] : at(e.origin);
          if (e.weapon === "fists") this.swing(gain, pan);
          else if (e.weapon === "shotgun") this.boom(gain, pan);
          else if (e.weapon === "rocketlauncher") this.launch(gain, pan);
          else if (e.weapon === "railgun") this.zap(gain, pan);
          else this.shot(gain, pan);
          break;
        }
        case "explosion":
          this.blast(...at(e.pos));
          break;
        case "weaponSwitch":
          if (e.player === localId) {
            this.tone("square", 1100, 1000, 0.02, 0.06);
            this.tone("square", 700, 650, 0.03, 0.06, 0.07);
          }
          break;
        case "dryFire":
          if (e.player === localId) this.tone("square", 2200, 2000, 0.015, 0.12);
          break;
        case "impact":
          this.impact(...at(e.pos));
          break;
        case "hit":
          if (e.weapon === "fists") this.thud(...at(e.pos));
          if (e.attacker === localId && e.victim !== localId) this.tone("sine", 1500, 1300, 0.06, 0.25); // hit marker
          if (e.victim === localId) this.hurt();
          break;
        case "kill":
          if (e.attacker === localId && e.victim !== localId) {
            this.tone("triangle", 880, 880, 0.09, 0.3);
            this.tone("triangle", 1320, 1320, 0.14, 0.3, 0.08);
          }
          if (e.victim === localId) this.tone("sawtooth", 220, 55, 0.6, 0.35);
          break;
        case "shielded":
          if (e.attacker === localId) this.tone("square", 900, 700, 0.05, 0.08); // a dull tick: no damage
          break;
        case "matchOver":
          // Rising for a win, falling otherwise.
          if (e.winner === localId) [660, 880, 1320].forEach((f, i) => this.tone("triangle", f, f, 0.22, 0.3, i * 0.14));
          else [440, 370, 294].forEach((f, i) => this.tone("triangle", f, f, 0.26, 0.28, i * 0.18));
          break;
        case "matchStart":
          this.tone("square", 440, 440, 0.12, 0.12);
          this.tone("square", 880, 880, 0.2, 0.12, 0.15);
          break;
        case "pickup":
          if (e.player === localId) this.tone("sine", 520, 1250, 0.14, 0.3);
          break;
        case "respawn":
          if (e.player === localId) this.tone("sine", 300, 600, 0.25, 0.2);
          break;
        case "teleport":
          if (e.player === localId) {
            this.tone("sine", 600, 160, 0.22, 0.22);
            this.tone("triangle", 1400, 500, 0.15, 0.06);
          }
          break;
        case "portalShot":
          if (e.player !== localId) break;
          if (e.portal !== null) {
            // A rising whoosh as it opens.
            this.tone("sine", 180, 520, 0.2, 0.28);
            this.tone("triangle", 700, 1500, 0.12, 0.07, 0.03);
          } else {
            this.tone("square", 320, 110, 0.12, 0.08);
          }
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

  /** Noise through a filter with a falling cutoff, for the bangs and whooshes below. */
  private noiseBurst(dest: AudioNode, type: BiquadFilterType, from: number, to: number, seconds: number, gain: number, q = 0.8, delay = 0) {
    const ctx = this.ctx!;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(from, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + seconds);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + seconds);
    src.connect(f).connect(g).connect(dest);
    src.start(t, Math.random() * 0.2, Math.min(1.2, seconds + 0.02));
  }

  /** A sine that drops in pitch: the body of a shot or a blast. */
  private drop(dest: AudioNode, from: number, to: number, seconds: number, gain: number, type: OscillatorType = "sine") {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t + seconds);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + seconds);
    osc.connect(g).connect(dest);
    osc.start(t);
    osc.stop(t + seconds + 0.02);
  }

  /** Fists: a quick whoosh. */
  private swing(gain: number, pan: number) {
    if (gain <= 0.01) return;
    this.noiseBurst(this.out(gain, pan), "bandpass", 500, 1800, 0.12, 0.5, 1.4);
  }

  /** A punch landing. */
  private thud(gain: number, pan: number) {
    if (gain <= 0.01) return;
    const dest = this.out(gain, pan);
    this.drop(dest, 140, 50, 0.12, 0.9);
    this.noiseBurst(dest, "lowpass", 900, 200, 0.08, 0.6);
  }

  /** Shotgun: a heavy bang with a low thump under it. */
  private boom(gain: number, pan: number) {
    if (gain <= 0.01) return;
    const dest = this.out(gain, pan);
    this.noiseBurst(dest, "lowpass", 3500, 300, 0.3, 1.1);
    this.drop(dest, 120, 35, 0.22, 1);
  }

  /** Rocket launcher: a hollow thunk and a rushing whoosh. */
  private launch(gain: number, pan: number) {
    if (gain <= 0.01) return;
    const dest = this.out(gain, pan);
    this.drop(dest, 90, 45, 0.18, 0.9);
    this.noiseBurst(dest, "bandpass", 300, 1400, 0.45, 0.7, 1.2);
  }

  /** Railgun: a bright electric crack with a ringing tail. */
  private zap(gain: number, pan: number) {
    if (gain <= 0.01) return;
    const dest = this.out(gain, pan);
    this.noiseBurst(dest, "highpass", 5000, 1500, 0.12, 0.6);
    this.drop(dest, 2400, 260, 0.45, 0.35, "sawtooth");
    this.drop(dest, 1200, 600, 0.6, 0.25);
  }

  /** An explosion: a long low roar. */
  private blast(gain: number, pan: number) {
    if (gain <= 0.01) return;
    const dest = this.out(gain, pan);
    this.noiseBurst(dest, "lowpass", 2400, 90, 0.7, 1.3, 0.7);
    this.drop(dest, 90, 28, 0.6, 1.1);
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
