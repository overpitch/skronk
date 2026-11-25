/**
 * Turns keyboard, mouse and gamepad state into PlayerCommands for the local
 * player. The client owns the view angles; the sim just receives them.
 */
import { emptyCommand, type PlayerCommand } from "../sim/command";

const MOUSE_SENSITIVITY = 0.0022; // radians per pixel
const PAD_DEADZONE = 0.15;
const PAD_YAW_RATE = 4.0; // radians per second at full stick
const PAD_PITCH_RATE = 2.6;
const PITCH_LIMIT = (89 * Math.PI) / 180;

// Standard Gamepad mapping indices.
const PAD_A = 0;
const PAD_LT = 6;
const PAD_RT = 7;

/** Radial deadzone, rescaled so the live range still starts at 0. */
function deadzone(x: number, y: number): [number, number] {
  const mag = Math.hypot(x, y);
  if (mag < PAD_DEADZONE) return [0, 0];
  const scaled = Math.min(1, (mag - PAD_DEADZONE) / (1 - PAD_DEADZONE));
  return [(x / mag) * scaled, (y / mag) * scaled];
}

export class LocalInput {
  yaw = 0;
  pitch = 0;
  /** Called when the player first engages (click or gamepad button), to hide the menu. */
  onActivate: () => void = () => {};
  onDeactivate: () => void = () => {};

  private keys = new Set<string>();
  private mouseButtons = 0;
  private pad = { forward: 0, right: 0, jump: false, fire: false, portal: false };
  private padWasPressed = false;

  constructor(private canvas: HTMLCanvasElement) {
    // Edge on Xbox otherwise turns the controller into a mouse cursor.
    const nav = navigator as Navigator & { gamepadInputEmulation?: string };
    if ("gamepadInputEmulation" in nav) nav.gamepadInputEmulation = "gamepad";

    window.addEventListener("keydown", (e) => {
      this.keys.add(e.code);
      if (e.code === "Space" || e.code.startsWith("Arrow")) e.preventDefault();
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    window.addEventListener("blur", () => {
      this.keys.clear();
      this.mouseButtons = 0;
    });

    canvas.addEventListener("click", () => {
      if (document.pointerLockElement !== canvas) canvas.requestPointerLock?.();
    });
    document.addEventListener("pointerlockchange", () => {
      if (document.pointerLockElement === canvas) this.onActivate();
      else this.onDeactivate();
    });
    document.addEventListener("mousemove", (e) => {
      if (document.pointerLockElement !== canvas) return;
      this.addLook(-e.movementX * MOUSE_SENSITIVITY, -e.movementY * MOUSE_SENSITIVITY);
    });
    document.addEventListener("mousedown", (e) => {
      if (document.pointerLockElement === canvas) this.mouseButtons = e.buttons;
    });
    document.addEventListener("mouseup", (e) => (this.mouseButtons = e.buttons));
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  get pointerLocked() {
    return document.pointerLockElement === this.canvas;
  }

  /** Per rendered frame: poll the gamepad and apply stick look at a rate. */
  update(dt: number) {
    const pads = navigator.getGamepads?.() ?? [];
    const pad = pads.find((p) => p && p.connected) ?? null;
    if (!pad) {
      this.pad = { forward: 0, right: 0, jump: false, fire: false, portal: false };
      return;
    }
    const [mx, my] = deadzone(pad.axes[0] ?? 0, pad.axes[1] ?? 0);
    const [lx, ly] = deadzone(pad.axes[2] ?? 0, pad.axes[3] ?? 0);
    // Squared response curve: fine aim near centre, fast turns at the edge.
    const curve = (v: number) => Math.sign(v) * v * v;
    this.addLook(-curve(lx) * PAD_YAW_RATE * dt, -curve(ly) * PAD_PITCH_RATE * dt);
    const pressed = (i: number) => !!pad.buttons[i]?.pressed;
    this.pad = {
      forward: -my,
      right: mx,
      jump: pressed(PAD_A),
      fire: pressed(PAD_RT),
      portal: pressed(PAD_LT),
    };
    const anyPressed = pad.buttons.some((b) => b.pressed);
    if (anyPressed && !this.padWasPressed) this.onActivate();
    this.padWasPressed = anyPressed;
  }

  command(): PlayerCommand {
    const k = (...codes: string[]) => (codes.some((c) => this.keys.has(c)) ? 1 : 0);
    const clamp = (v: number) => Math.max(-1, Math.min(1, v));
    return {
      ...emptyCommand(),
      forward: clamp(k("KeyW", "ArrowUp") - k("KeyS", "ArrowDown") + this.pad.forward),
      right: clamp(k("KeyD", "ArrowRight") - k("KeyA", "ArrowLeft") + this.pad.right),
      yaw: this.yaw,
      pitch: this.pitch,
      jump: k("Space") === 1 || this.pad.jump,
      fire: (this.mouseButtons & 1) !== 0 || this.pad.fire,
      portal: (this.mouseButtons & 2) !== 0 || this.pad.portal,
    };
  }

  private addLook(dYaw: number, dPitch: number) {
    this.yaw = (this.yaw + dYaw) % (Math.PI * 2);
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch + dPitch));
  }
}
