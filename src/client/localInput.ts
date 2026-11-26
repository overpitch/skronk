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
const PAD_X = 2;
const PAD_Y = 3;
const PAD_LB = 4;
const PAD_RB = 5;
const PAD_VIEW = 8;
const PAD_UP = 12;
const PAD_DOWN = 13;
const PAD_LEFT = 14;
const PAD_RIGHT = 15;
const PAD_LT = 6;
const PAD_RT = 7;
const PAD_MENU = 9;
const PAD_L3 = 10;

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
  /** Flight-stick style: pulling back (mouse or stick down) looks up. */
  invertLook = false;
  /** Player's multiplier on the base mouse look speed. */
  mouseSensitivity = 1;
  /** Called when the player first engages (click or gamepad button), to hide the menu. */
  onActivate: () => void = () => {};
  /** Called when the mouse is released or the gamepad Menu button pauses. */
  onDeactivate: () => void = () => {};
  /** Gamepad Y while the menu is open. */
  onToggleInvertLook: () => void = () => {};
  /** Gamepad X while the menu is open. */
  onCycleDifficulty: () => void = () => {};
  /** Gamepad LB (-1) / RB (+1) while the menu is open. */
  onChangeBots: (delta: number) => void = () => {};
  /** Gamepad D-pad left (-1) / right (+1) while the menu is open. */
  onChangeMap: (delta: number) => void = () => {};
  /** Gamepad D-pad up while the menu is open: join or leave the network game. */
  onToggleNetwork: () => void = () => {};
  /** Gamepad D-pad down while the menu is open: next graphics setting. */
  onCycleGraphics: () => void = () => {};

  private keys = new Set<string>();
  /**
   * Portal presses (right click, E) since the sim last read a command. Counted as presses,
   * not held state: Chrome on a Mac can skip the mouseup after a right click, which left the
   * button "held" forever and blocked every later shot.
   */
  private portalPresses = 0;
  private mouseButtons = 0;
  private pad = { forward: 0, right: 0, jump: false, sprint: false, fire: false, portal: false };
  /** Left stick click toggles sprint on; it ends when you stop pushing forward. */
  private padSprint = false;
  private padScores = false;
  private padPrev: boolean[] = [];
  /** For the debug HUD: what the browser reports, or null if no pad is visible yet. */
  padStatus: string | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    // Edge on Xbox otherwise turns the controller into a mouse cursor.
    const nav = navigator as Navigator & { gamepadInputEmulation?: string };
    if ("gamepadInputEmulation" in nav) nav.gamepadInputEmulation = "gamepad";

    window.addEventListener("keydown", (e) => {
      // Typing in the menu's name box isn't playing.
      if (e.target instanceof HTMLInputElement && e.target.type === "text") return;
      this.keys.add(e.code);
      if (e.code === "Tab") e.preventDefault(); // held for the scoreboard, not moving focus
      if (e.code === "KeyE" && !e.repeat) this.portalPresses++;
      if (e.code === "Space" || e.code.startsWith("Arrow")) e.preventDefault();
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    window.addEventListener("blur", () => {
      this.keys.clear();
      this.mouseButtons = 0;
      this.portalPresses = 0;
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
      const k = MOUSE_SENSITIVITY * this.mouseSensitivity;
      this.addLook(-e.movementX * k, -e.movementY * k);
    });
    document.addEventListener("mousedown", (e) => {
      if (document.pointerLockElement !== canvas) return;
      this.mouseButtons = e.buttons;
      if (e.button === 2) this.portalPresses++;
    });
    document.addEventListener("mouseup", (e) => (this.mouseButtons = e.buttons));
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  /** Tab or the controller's View button held: show the scoreboard. */
  get scoresHeld(): boolean {
    return this.keys.has("Tab") || this.padScores;
  }

  get pointerLocked() {
    return document.pointerLockElement === this.canvas;
  }

  /**
   * Per rendered frame: poll the gamepad and apply stick look at a rate.
   * While the menu is open, sticks are ignored and buttons drive the menu.
   */
  update(dt: number, menuOpen: boolean) {
    const pads = navigator.getGamepads?.() ?? [];
    const pad = pads.find((p) => p && p.connected) ?? null;
    if (!pad) {
      this.pad = { forward: 0, right: 0, jump: false, sprint: false, fire: false, portal: false };
      this.padSprint = false;
      this.padPrev = [];
      this.padStatus = null;
      return;
    }
    // Ids are long ("Xbox Wireless Controller (STANDARD GAMEPAD Vendor: ...)"); keep the name.
    const name = pad.id.replace(/\s*\(.*$/, "").slice(0, 40) || "gamepad";
    this.padStatus = pad.mapping === "standard" ? name : `${name} (non-standard layout, buttons may be wrong)`;
    const pressed = (i: number) => !!pad.buttons[i]?.pressed;
    const justPressed = (i: number) => pressed(i) && !this.padPrev[i];
    // Menu buttons change settings; any other button starts play.
    const menuButtons = [PAD_X, PAD_Y, PAD_LB, PAD_RB, PAD_LEFT, PAD_RIGHT, PAD_UP, PAD_DOWN, PAD_VIEW];
    const otherJustPressed = () => pad.buttons.some((_, i) => !menuButtons.includes(i) && justPressed(i));
    if (menuOpen) {
      if (justPressed(PAD_Y)) this.onToggleInvertLook();
      else if (justPressed(PAD_X)) this.onCycleDifficulty();
      else if (justPressed(PAD_LB)) this.onChangeBots(-1);
      else if (justPressed(PAD_RB)) this.onChangeBots(1);
      else if (justPressed(PAD_LEFT)) this.onChangeMap(-1);
      else if (justPressed(PAD_RIGHT)) this.onChangeMap(1);
      else if (justPressed(PAD_UP)) this.onToggleNetwork();
      else if (justPressed(PAD_DOWN)) this.onCycleGraphics();
      else if (otherJustPressed()) this.onActivate();
    } else if (justPressed(PAD_MENU)) {
      this.onDeactivate();
    }
    if (!menuOpen && justPressed(PAD_L3)) this.padSprint = !this.padSprint;
    this.padPrev = pad.buttons.map((b) => b.pressed);
    if (menuOpen) dt = 0;

    const [mx, my] = deadzone(pad.axes[0] ?? 0, pad.axes[1] ?? 0);
    const [lx, ly] = deadzone(pad.axes[2] ?? 0, pad.axes[3] ?? 0);
    // Squared response curve: fine aim near centre, fast turns at the edge.
    const curve = (v: number) => Math.sign(v) * v * v;
    this.addLook(-curve(lx) * PAD_YAW_RATE * dt, -curve(ly) * PAD_PITCH_RATE * dt);
    this.padScores = pressed(PAD_VIEW);
    if (-my < 0.2) this.padSprint = false;
    this.pad = {
      forward: -my,
      right: mx,
      jump: pressed(PAD_A),
      sprint: this.padSprint,
      fire: pressed(PAD_RT),
      portal: pressed(PAD_LT),
    };
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
      sprint: k("ShiftLeft", "ShiftRight") === 1 || this.pad.sprint,
      fire: (this.mouseButtons & 1) !== 0 || this.pad.fire,
      // E as well as right click: two-finger clicks are awkward on a trackpad mid-fight.
      portal: this.takePortalPress() || this.pad.portal,
    };
  }

  /** True for one command per press, so the sim sees a press then a release. */
  private takePortalPress(): boolean {
    if (this.portalPresses === 0) return false;
    this.portalPresses = 0;
    return true;
  }

  /** dPitch is the uninverted delta (mouse/stick up = look up). */
  private addLook(dYaw: number, dPitch: number) {
    if (this.invertLook) dPitch = -dPitch;
    this.yaw = (this.yaw + dYaw) % (Math.PI * 2);
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch + dPitch));
  }
}
