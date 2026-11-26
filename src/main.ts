import maps from "virtual:maps";
import { buildNavGraph, type NavGraph } from "./bots/nav";
import { Bot } from "./bots/bot";
import { DUMMY_DEFAULT_SPEED, TargetDummy } from "./bots/targetDummy";
import { Sfx } from "./client/audio";
import { Hud } from "./client/hud";
import { LocalInput } from "./client/localInput";
import { DIFFICULTIES, difficultyOf, loadSettings, MAX_BOTS, MOUSE_SENSITIVITY_RANGE, saveSettings } from "./client/settings";
import { TrenchBroomLoader } from "./level/trenchbroom/trenchbroomLoader";
import { lerp, vec3 } from "./math/vec3";
import { GameRenderer } from "./render/renderer";
import type { LevelData } from "./level/types";
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
  const settings = loadSettings();
  // ?map=<name> plays public/assets/maps/<name>.map this visit; otherwise the menu's choice.
  const known = (name: string | null) => !!name && maps.some((m) => m.name === name);
  const mapName = params.get("map") ?? (known(settings.map) ? settings.map : (maps[0]?.name ?? "test_box"));
  const mapTitle = maps.find((m) => m.name === mapName)?.title ?? mapName;
  // Address options override the menu's saved choices for this visit (handy for testing):
  // ?bots=N bots that roam and fight; ?botskill=0..1 instead of the difficulty;
  // ?navdebug draws the bots' walk graph; ?mute plays no sound.
  const botCount = params.has("bots") ? Math.max(0, Math.min(MAX_BOTS, Number(params.get("bots")) || 0)) : settings.bots;
  const skillParam = Number(params.get("botskill"));
  let skillOverride = params.has("botskill") && Number.isFinite(skillParam) ? Math.max(0, Math.min(1, skillParam)) : null;
  const navDebug = params.has("navdebug");
  let muted = params.has("mute");
  // ?dummies=N practice targets (default: one when there are no bots); ?dummyfire makes them shoot back;
  // ?dummyspeed=0..1 sets how fast they strafe (0 stands still).
  const dummiesParam = params.has("dummies") ? Math.max(0, Math.min(8, Number(params.get("dummies")) || 0)) : null;
  const dummiesShoot = params.has("dummyfire");
  const speedParam = Number(params.get("dummyspeed"));
  const dummySpeed = params.has("dummyspeed") && Number.isFinite(speedParam) ? Math.max(0, Math.min(1, speedParam)) : DUMMY_DEFAULT_SPEED;
  const assets = `${import.meta.env.BASE_URL}assets`;
  status.textContent = `Loading ${mapTitle}…`;
  const level = await new TrenchBroomLoader().load(`${assets}/maps/${mapName}.map`);

  const world = new World(level);
  const me = world.addPlayer(LOCAL_PLAYER);
  // Everyone who isn't you: practice dummies and bots, both just command sources.
  const bots: { id: PlayerId; command(world: World): PlayerCommand }[] = [];
  const dummies: TargetDummy[] = [];
  const fighters: Bot[] = [];
  const names = new Map<PlayerId, string>([[LOCAL_PLAYER, "yourself"]]);
  let nextId = LOCAL_PLAYER + 1;
  let nav: NavGraph | null = null;
  if (botCount > 0 || navDebug) {
    status.textContent = `Mapping ${mapTitle} for bots…`;
    await new Promise((r) => setTimeout(r)); // let the status show before the build blocks
    nav = buildNavGraph(level, world.collision);
  }
  const botSkillLevel = () => skillOverride ?? difficultyOf(settings.difficulty).skill;
  /** Adds or removes players so there are n of them, made by `make`. */
  const resize = <T extends { id: PlayerId }>(list: T[], n: number, make: (id: PlayerId) => T) => {
    while (list.length > n) {
      const gone = list.pop()!;
      world.removePlayer(gone.id);
      names.delete(gone.id);
    }
    while (list.length < n) {
      const id = nextId++;
      world.addPlayer(id);
      list.push(make(id));
    }
  };
  /** n bots; with none, a practice dummy (unless ?dummies says otherwise). */
  const setBots = (n: number) => {
    if (n > 0 && !nav) nav = buildNavGraph(level, world.collision);
    resize(fighters, n, (id) => new Bot(id, nav!, botSkillLevel()));
    fighters.forEach((b, i) => names.set(b.id, `Bot ${i + 1}`));
    const dummyCount = dummiesParam ?? (n > 0 ? 0 : 1);
    resize(dummies, dummyCount, (id) => new TargetDummy(id, dummiesShoot, dummySpeed));
    dummies.forEach((d, i) => names.set(d.id, dummyCount > 1 ? `Dummy ${i + 1}` : "the dummy"));
    bots.length = 0;
    bots.push(...dummies, ...fighters);
  };
  setBots(botCount);
  const nameOf = (id: PlayerId) => names.get(id) ?? `Player ${id}`;
  const renderer = new GameRenderer(canvas, `${assets}/textures`);
  renderer.loadLevel(level);
  if (nav && navDebug) renderer.setDebugLines(...navLines(nav));
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

  const invertButton = document.getElementById("invert-look") as HTMLButtonElement;
  const sensSlider = document.getElementById("mouse-sens") as HTMLInputElement;
  const sensValue = document.getElementById("mouse-sens-value")!;
  const botButton = document.getElementById("bot-count") as HTMLButtonElement;
  const mapButton = document.getElementById("map-choice") as HTMLButtonElement;
  const difficultyButton = document.getElementById("difficulty") as HTMLButtonElement;
  const volumeSlider = document.getElementById("volume") as HTMLInputElement;
  const volumeValue = document.getElementById("volume-value")!;
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
    mapButton.textContent = `Map: ${mapTitle}`;
    botButton.textContent = fighters.length > 0 ? `Bots: ${fighters.length}` : "Bots: none (practice dummy)";
    difficultyButton.textContent = `Difficulty: ${skillOverride === null ? difficultyOf(settings.difficulty).label : `custom ${skillOverride}`}`;
    const volume = muted ? 0 : settings.volume;
    sfx.setVolume(volume);
    volumeSlider.value = String(volume);
    volumeValue.textContent = `${Math.round(volume * 100)}%`;
  };
  /** Buttons are clicked with the mouse; take focus off so Space (jump) can't press them again. */
  const onClick = (button: HTMLButtonElement, action: () => void) =>
    button.addEventListener("click", () => {
      action();
      button.blur();
    });
  const changeBots = (n: number) => {
    settings.bots = Math.max(0, Math.min(MAX_BOTS, n));
    saveSettings(settings);
    setBots(settings.bots);
    applySettings();
  };
  // Click goes round 0..MAX; the controller's LB / RB step down and up.
  onClick(botButton, () => changeBots((fighters.length + 1) % (MAX_BOTS + 1)));
  input.onChangeBots = (delta) => changeBots(fighters.length + delta);
  // Another map: saved, then the page reloads with it (a fresh match).
  const changeMap = (delta: number) => {
    if (maps.length < 2) return;
    const i = Math.max(0, maps.findIndex((m) => m.name === mapName));
    const next = maps[(i + delta + maps.length) % maps.length].name;
    settings.map = next;
    saveSettings(settings);
    const url = new URL(location.href);
    if (url.searchParams.has("map")) url.searchParams.set("map", next);
    location.assign(url);
  };
  onClick(mapButton, () => changeMap(1));
  input.onChangeMap = changeMap;
  const cycleDifficulty = () => {
    const i = DIFFICULTIES.findIndex((d) => d.id === settings.difficulty);
    settings.difficulty = DIFFICULTIES[(i + 1) % DIFFICULTIES.length].id;
    skillOverride = null;
    saveSettings(settings);
    for (const b of fighters) b.setSkill(botSkillLevel());
    applySettings();
  };
  onClick(difficultyButton, cycleDifficulty);
  input.onCycleDifficulty = cycleDifficulty;
  volumeSlider.addEventListener("input", () => {
    settings.volume = Number(volumeSlider.value);
    muted = false;
    applySettings();
  });
  volumeSlider.addEventListener("change", () => {
    saveSettings(settings);
    volumeSlider.blur();
  });
  const toggleInvertLook = () => {
    settings.invertLook = !settings.invertLook;
    saveSettings(settings);
    applySettings();
  };
  onClick(invertButton, toggleInvertLook);
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
  status.textContent = `${mapTitle}: ${level.brushes.length} brushes, ${level.spawns.length} spawns`;
  // Building maps: on the dev server, check the map and list what's wrong in the menu.
  if (import.meta.env.DEV) setTimeout(() => void showMapCheck(level, `${assets}/textures`, nav), 100);

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
      commands.set(LOCAL_PLAYER, active ? local : { ...local, forward: 0, right: 0, jump: false, sprint: false, fire: false, portal: false });
      for (const bot of bots) commands.set(bot.id, bot.command(world));
      world.step(commands);
      for (const e of world.events) {
        frameEvents.push(e);
        // Respawning faces you the way the spawn point says; a portal turns you to face out of the exit.
        if (e.type === "respawn" && e.player === LOCAL_PLAYER) {
          input.yaw = me.yaw;
          input.pitch = 0;
        }
        if (e.type === "teleport" && e.player === LOCAL_PLAYER) {
          input.yaw = me.yaw;
          input.pitch = me.pitch;
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
      `controller: ${input.padStatus ?? "none (press a button to connect)"}` +
      (nav ? `\nnav: ${nav.nodes.length} nodes, ${nav.edgeCount} links` : "");
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  if (import.meta.env.DEV) Object.assign(window, { skronk: { world, input, renderer, level, bots, nav } });
}

/** Runs the map checker and shows the results under the menu (dev server only). */
async function showMapCheck(level: LevelData, textureRoot: string, nav: NavGraph | null) {
  const { checkLevel } = await import("./devtools/mapCheck");
  // The dev server answers a missing file with the game page, so look at what came back.
  const textureExists = async (name: string) => {
    const res = await fetch(`${textureRoot}/${name}.png`, { method: "HEAD" });
    return res.ok && (res.headers.get("content-type") ?? "").startsWith("image/");
  };
  const issues = await checkLevel(level, { textureExists, nav: nav ?? undefined });
  const box = document.getElementById("map-check") as HTMLDetailsElement;
  const count = (l: string) => issues.filter((i) => i.level === l).length;
  const parts = [["error", "errors"], ["warning", "warnings"], ["note", "notes"]]
    .map(([l, word]) => (count(l) ? `${count(l)} ${count(l) === 1 ? word.slice(0, -1) : word}` : ""))
    .filter(Boolean);
  box.querySelector("summary")!.textContent = parts.length ? `Map check: ${parts.join(", ")}` : "Map check: all good";
  const list = box.querySelector("ul")!;
  list.replaceChildren(
    ...issues.map((i) => {
      const li = document.createElement("li");
      li.className = i.level;
      li.textContent = `${i.level}: ${i.message}`;
      return li;
    }),
  );
  box.open = count("error") + count("warning") > 0;
  box.hidden = false;
  for (const i of issues) console.warn(`[map check] ${i.level}: ${i.message}`);
}

/** The walk graph as line segments at foot level: walks green, jumps yellow, drops orange. */
function navLines(nav: NavGraph): [number[], number[]] {
  const pos: number[] = [];
  const col: number[] = [];
  const feet = -22; // node positions are player origins; draw just above the floor
  for (const n of nav.nodes) {
    for (const e of n.edges) {
      const t = nav.nodes[e.to].pos;
      pos.push(n.pos.x, n.pos.y, n.pos.z + feet, t.x, t.y, t.z + feet);
      const c = e.jump ? [1, 0.85, 0.2] : e.drop ? [1, 0.5, 0.15] : [0.25, 0.9, 0.45];
      col.push(...c, ...c);
    }
  }
  return [pos, col];
}

start().catch((err) => {
  console.error(err);
  status.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
  overlay.classList.remove("hidden");
});
