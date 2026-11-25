import { DUMMY_DEFAULT_SPEED, TargetDummy } from "./bots/targetDummy";
import { Sfx } from "./client/audio";
import { Hud } from "./client/hud";
import { LocalInput } from "./client/localInput";
import { loadSettings, MOUSE_SENSITIVITY_RANGE, saveSettings } from "./client/settings";
import { TrenchBroomLoader } from "./level/trenchbroom/trenchbroomLoader";
import { lerp, vec3 } from "./math/vec3";
import { GameRenderer } from "./render/renderer";
import type { PlayerCommand } from "./sim/command";
import type { PlayerId, SimEvent } from "./sim/events";
import { EYE_HEIGHT } from "./sim/movement";
import { TICK_DT, World } from "./sim/world";

const LOCAL_PLAYER = 1;
/** Lower the view while dead so it reads as being down. */
const DEAD_EYE_DROP = 30;
/** Never simulate more than this many ticks per frame (e.g. after a tab was hidden). */
const MAX_TICKS_PER_FRAME = 8;

const canvas = document.getElementById("game") as HTMLCanvasElement;
const overlay = document.getElementById("overlay")!;
const status = document.getElementById("status")!;
const debug = document.getElementById("debug")!;

async function start() {
  const params = new URLSearchParams(location.search);
  const mapName = params.get("map") ?? "test_box";
  // ?dummies=N practice targets (default 1); ?dummyfire makes them shoot back;
  // ?dummyspeed=0..1 sets how fast they strafe (0 stands still).
  const dummyCount = Math.max(0, Math.min(8, Number(params.get("dummies") ?? 1) || 0));
  const dummiesShoot = params.has("dummyfire");
  const speedParam = Number(params.get("dummyspeed"));
  const dummySpeed = params.has("dummyspeed") && Number.isFinite(speedParam) ? Math.max(0, Math.min(1, speedParam)) : DUMMY_DEFAULT_SPEED;
  const assets = `${import.meta.env.BASE_URL}assets`;
  status.textContent = `Loading ${mapName}…`;
  const level = await new TrenchBroomLoader().load(`${assets}/maps/${mapName}.map`);

  const world = new World(level);
  const me = world.addPlayer(LOCAL_PLAYER);
  const bots: TargetDummy[] = [];
  for (let i = 0; i < dummyCount; i++) {
    const id = LOCAL_PLAYER + 1 + i;
    world.addPlayer(id);
    bots.push(new TargetDummy(id, dummiesShoot, dummySpeed));
  }
  const nameOf = (id: PlayerId) => (id === LOCAL_PLAYER ? "yourself" : dummyCount > 1 ? `Dummy ${id - LOCAL_PLAYER}` : "the dummy");
  const renderer = new GameRenderer(canvas, `${assets}/textures`);
  renderer.loadLevel(level);
  window.addEventListener("resize", () => renderer.resize());

  const input = new LocalInput(canvas);
  input.yaw = me.yaw;
  const hud = new Hud(nameOf);
  const sfx = new Sfx();
  // Audio needs a user gesture; gamepad presses may not count, so take any key or click too.
  for (const type of ["pointerdown", "keydown"]) window.addEventListener(type, () => sfx.unlock());
  let active = false;
  input.onActivate = () => {
    active = true;
    overlay.classList.add("hidden");
    hud.setVisible(true);
    sfx.unlock(); // a click or button press is the user gesture browsers require for audio
  };
  input.onDeactivate = () => {
    active = false;
    overlay.classList.remove("hidden");
    hud.setVisible(false);
    // Gamepad pause while the mouse is still locked: release it so the menu is clickable.
    if (document.pointerLockElement) document.exitPointerLock();
  };

  const settings = loadSettings();
  const invertButton = document.getElementById("invert-look") as HTMLButtonElement;
  const sensSlider = document.getElementById("mouse-sens") as HTMLInputElement;
  const sensValue = document.getElementById("mouse-sens-value")!;
  sensSlider.min = String(MOUSE_SENSITIVITY_RANGE.min);
  sensSlider.max = String(MOUSE_SENSITIVITY_RANGE.max);
  sensSlider.step = String(MOUSE_SENSITIVITY_RANGE.step);
  const applySettings = () => {
    input.invertLook = settings.invertLook;
    input.mouseSensitivity = settings.mouseSensitivity;
    sensSlider.value = String(settings.mouseSensitivity);
    sensValue.textContent = settings.mouseSensitivity.toFixed(2);
    invertButton.textContent = `Invert look: ${settings.invertLook ? "On" : "Off"}`;
    invertButton.setAttribute("aria-pressed", String(settings.invertLook));
  };
  const toggleInvertLook = () => {
    settings.invertLook = !settings.invertLook;
    saveSettings(settings);
    applySettings();
  };
  invertButton.addEventListener("click", () => {
    toggleInvertLook();
    // Otherwise Space (jump) would press the focused button again later.
    invertButton.blur();
  });
  input.onToggleInvertLook = toggleInvertLook;
  sensSlider.addEventListener("input", () => {
    settings.mouseSensitivity = Number(sensSlider.value);
    applySettings();
  });
  sensSlider.addEventListener("change", () => {
    saveSettings(settings);
    // Otherwise arrow keys would keep nudging the slider during play.
    sensSlider.blur();
  });
  applySettings();
  status.textContent = `${level.name}: ${level.brushes.length} brushes, ${level.spawns.length} spawns`;

  const eye = vec3();
  const frameEvents: SimEvent[] = [];
  let last = performance.now();
  let acc = 0;
  let fps = 0;
  let fpsFrames = 0;
  let fpsTime = 0;

  const frame = (now: number) => {
    const dt = Math.min(0.25, (now - last) / 1000);
    last = now;
    input.update(dt, !active);

    acc += dt;
    let ticks = 0;
    frameEvents.length = 0;
    while (acc >= TICK_DT && ticks < MAX_TICKS_PER_FRAME) {
      const commands = new Map<PlayerId, PlayerCommand>();
      const local = input.command();
      commands.set(LOCAL_PLAYER, active ? local : { ...local, forward: 0, right: 0, jump: false, fire: false, portal: false });
      for (const bot of bots) commands.set(bot.id, bot.command(world));
      world.step(commands);
      for (const e of world.events) {
        frameEvents.push(e);
        // Respawning faces you the way the spawn point says.
        if (e.type === "respawn" && e.player === LOCAL_PLAYER) {
          input.yaw = me.yaw;
          input.pitch = 0;
        }
      }
      acc -= TICK_DT;
      ticks++;
    }
    if (ticks === MAX_TICKS_PER_FRAME) acc = 0;

    // Interpolate position between ticks; use the latest view angles for responsiveness.
    const alpha = acc / TICK_DT;
    lerp(me.prevOrigin, me.origin, alpha, eye);
    eye.z += EYE_HEIGHT - (me.alive ? 0 : DEAD_EYE_DROP);
    const time = now / 1000;
    renderer.render({ world, localId: LOCAL_PLAYER, alpha, eye, yaw: input.yaw, pitch: input.pitch, timeSeconds: time, dt }, frameEvents);
    hud.update(world, me, frameEvents, dt);
    sfx.play(frameEvents, LOCAL_PLAYER, eye, input.yaw);

    fpsFrames++;
    fpsTime += dt;
    if (fpsTime >= 0.5) {
      fps = Math.round(fpsFrames / fpsTime);
      fpsFrames = 0;
      fpsTime = 0;
    }
    const speed = Math.round(Math.hypot(me.velocity.x, me.velocity.y));
    debug.textContent =
      `${fps} fps  ${speed} ups  ${me.onGround ? "ground" : "air"}\n` +
      `${me.origin.x.toFixed(0)} ${me.origin.y.toFixed(0)} ${me.origin.z.toFixed(0)}  tick ${world.tick}\n` +
      `controller: ${input.padStatus ?? "none (press a button to connect)"}`;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  if (import.meta.env.DEV) Object.assign(window, { skronk: { world, input, renderer, level, bots } });
}

start().catch((err) => {
  console.error(err);
  status.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
  overlay.classList.remove("hidden");
});
