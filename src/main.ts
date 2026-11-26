import maps from "virtual:maps";
import { buildNavGraph, type NavGraph } from "./bots/nav";
import { Bot } from "./bots/bot";
import { DUMMY_DEFAULT_SPEED, TargetDummy } from "./bots/targetDummy";
import { Sfx } from "./client/audio";
import { Hud } from "./client/hud";
import { LocalInput } from "./client/localInput";
import { NetClient, serverAddress } from "./client/netClient";
import { Predictor } from "./client/prediction";
import { cleanName, DIFFICULTIES, difficultyOf, loadSettings, MAX_BOTS, MOUSE_SENSITIVITY_RANGE, saveSettings } from "./client/settings";
import { GAME_PORT } from "./net/protocol";
import { TrenchBroomLoader } from "./level/trenchbroom/trenchbroomLoader";
import { lerp, vec3 } from "./math/vec3";
import { applySnapshot } from "./net/snapshot";
import { browserDevice, chooseQuality, type QualitySetting } from "./render/quality";
import { GameRenderer } from "./render/renderer";
import type { LevelData } from "./level/types";
import type { PlayerCommand } from "./sim/command";
import type { PlayerId, SimEvent } from "./sim/events";
import { FREE_PLAY, MATCH_PRESETS, matchPreset, REMATCH_READY_TICKS, type MatchRules } from "./sim/match";
import { EYE_HEIGHT } from "./sim/movement";
import { secondsToTicks } from "./sim/tick";
import { TICK_DT, World } from "./sim/world";
import { canFire, cycleWeapon, WEAPONS, type Armed, type WeaponId } from "./sim/weapons";

/** The ?allweapons test option: every weapon, full ammo. */
function armFully(p: Armed) {
  p.weapons = (1 << WEAPONS.length) - 1;
  p.ammo = WEAPONS.map((w) => w.maxAmmo);
}

/** Your player id in a game on this machine (a network game gets one from the server). */
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
  // ?join plays on the game server (npm run server) on the machine this page came from;
  // ?join=host or ?join=host:port another one. The server picks the map and the bots.
  // A page served by the game server itself (npm run lan) joins without being asked; ?solo stops it.
  const servedByGameServer = location.port === String(GAME_PORT);
  const joining = (params.has("join") || servedByGameServer) && !params.has("solo");
  let net: NetClient | null = null;
  let localId = LOCAL_PLAYER;
  let serverMap: string | null = null;
  // The live site is built with VITE_GAME_SERVER set to the online server's address, if there is one.
  const onlineServer: string | undefined = import.meta.env.VITE_GAME_SERVER || undefined;
  const url = serverAddress(params.get("join") ?? (servedByGameServer ? location.host : ""), location, onlineServer);
  if (joining) {
    status.textContent = `Joining ${url}…`;
    // ?lag=ms pretends the connection is that slow (round trip), to try out prediction at home.
    const lag = Math.max(0, Math.min(1000, Number(params.get("lag")) || 0));
    const joined = await NetClient.connect(url, settings.name || undefined, lag);
    net = joined.net;
    localId = joined.welcome.id;
    serverMap = joined.welcome.map;
  }
  // ?map=<name> plays public/assets/maps/<name>.map this visit; otherwise the menu's choice.
  const known = (name: string | null) => !!name && maps.some((m) => m.name === name);
  const mapName = serverMap ?? params.get("map") ?? (known(settings.map) ? settings.map : (maps[0]?.name ?? "test_box"));
  const mapTitle = maps.find((m) => m.name === mapName)?.title ?? mapName;
  // Address options override the menu's saved choices for this visit (handy for testing):
  // ?bots=N bots that roam and fight; ?difficulty=beginner|easy|normal|hard instead of the menu's;
  // ?navdebug draws the bots' walk graph; ?mute plays no sound.
  const botCount = net ? 0 : params.has("bots") ? Math.max(0, Math.min(MAX_BOTS, Number(params.get("bots")) || 0)) : settings.bots;
  const difficultyParam = DIFFICULTIES.find((d) => d.id === params.get("difficulty")) ?? null;
  let difficultyOverride = difficultyParam;
  const navDebug = params.has("navdebug");
  let muted = params.has("mute");
  // ?dummies=N practice targets (default: one when there are no bots); ?dummyfire makes them shoot back;
  // ?dummyspeed=0..1 sets how fast they strafe (0 stands still).
  const dummiesParam = net ? 0 : params.has("dummies") ? Math.max(0, Math.min(8, Number(params.get("dummies")) || 0)) : null;
  const dummiesShoot = params.has("dummyfire");
  // ?allweapons: every spawn comes with every weapon and full ammo (for testing; your own game only).
  const allWeapons = params.has("allweapons");
  const speedParam = Number(params.get("dummyspeed"));
  const dummySpeed = params.has("dummyspeed") && Number.isFinite(speedParam) ? Math.max(0, Math.min(1, speedParam)) : DUMMY_DEFAULT_SPEED;
  const assets = `${import.meta.env.BASE_URL}assets`;
  status.textContent = `Loading ${mapTitle}…`;
  const level = await new TrenchBroomLoader().load(`${assets}/maps/${mapName}.map`);

  // Match rules: the menu's choice when bots play; practice on your own has no limits.
  // ?fraglimit=N and ?timelimit=minutes set them for this visit (handy for testing the end screen).
  const rulesParam: MatchRules | null =
    params.has("fraglimit") || params.has("timelimit")
      ? {
          fragLimit: Math.max(0, Math.floor(Number(params.get("fraglimit")) || 0)),
          timeLimitTicks: secondsToTicks(Math.max(0, Number(params.get("timelimit")) || 0) * 60),
        }
      : null;
  const rulesFor = (botsPlaying: number): MatchRules => rulesParam ?? (botsPlaying > 0 ? matchPreset(settings.match).rules : FREE_PLAY);
  const world = new World(level, rulesFor(botCount));
  // In a network game this is a mirror of the server's world, overwritten by every snapshot.
  const me = world.addPlayer(localId);
  if (allWeapons && !net) armFully(me);
  // Everyone who isn't you: practice dummies and bots, both just command sources.
  const bots: { id: PlayerId; command(world: World): PlayerCommand }[] = [];
  const dummies: TargetDummy[] = [];
  const fighters: Bot[] = [];
  const names = new Map<PlayerId, string>([[localId, "yourself"]]);
  let nextId = LOCAL_PLAYER + 1;
  let nav: NavGraph | null = null;
  if (botCount > 0 || navDebug) {
    status.textContent = `Mapping ${mapTitle} for bots…`;
    await new Promise((r) => setTimeout(r)); // let the status show before the build blocks
    nav = buildNavGraph(level, world.collision);
  }
  const botSkillLevel = () => (difficultyOverride ?? difficultyOf(settings.difficulty)).skill;
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
    // Bots joining practice (or all leaving) changes the rules: a fresh match.
    const rules = rulesFor(n);
    const now = world.match.rules;
    if (!net && (rules.fragLimit !== now.fragLimit || rules.timeLimitTicks !== now.timeLimitTicks)) world.rematch(rules);
  };
  setBots(botCount);
  const nameOf = (id: PlayerId) => (id === localId ? "yourself" : (net?.names.get(id) ?? names.get(id) ?? `Player ${id}`));
  // Graphics quality: ?quality=full|light for this visit, else the menu's setting (Auto picks for this device).
  const qualityParam = params.get("quality");
  const qualitySetting: QualitySetting = qualityParam === "full" || qualityParam === "light" ? qualityParam : settings.quality;
  const quality = chooseQuality(qualitySetting, browserDevice());
  const renderer = new GameRenderer(canvas, `${assets}/textures`, quality.profile);
  renderer.loadLevel(level);
  if (nav && navDebug) renderer.setDebugLines(...navLines(nav));
  window.addEventListener("resize", () => renderer.resize());

  const input = new LocalInput(canvas);
  input.yaw = me.yaw;
  const hud = new Hud(nameOf, !!net);
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
  const matchButton = document.getElementById("match-choice") as HTMLButtonElement;
  const volumeSlider = document.getElementById("volume") as HTMLInputElement;
  const volumeValue = document.getElementById("volume-value")!;
  const networkButton = document.getElementById("network") as HTMLButtonElement;
  const graphicsButton = document.getElementById("graphics") as HTMLButtonElement;
  const nameBox = document.getElementById("player-name") as HTMLInputElement;
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
    difficultyButton.textContent = `Difficulty: ${(difficultyOverride ?? difficultyOf(settings.difficulty)).label}`;
    const preset = matchPreset(settings.match).label;
    matchButton.textContent = rulesParam ? "Match: set in the address" : fighters.length > 0 ? `Match: ${preset}` : `Match: ${preset} (when bots play)`;
    const modeName = quality.profile.mode === "full" ? "Full" : "Light";
    graphicsButton.textContent = qualitySetting === "auto" ? `Graphics: Auto (${modeName})` : `Graphics: ${modeName}`;
    graphicsButton.title = `${modeName}: ${quality.reason}`;
    networkButton.textContent = net ? "Leave network game" : "Join network game";
    // On the live (https) site there's nothing to join until an online server is set up.
    if (!net && location.protocol === "https:" && !onlineServer) {
      networkButton.textContent = "Network game: no online server yet";
      networkButton.disabled = true;
    }
    if (nameBox !== document.activeElement) nameBox.value = settings.name;
    if (net) {
      // The server decides these in a network game.
      mapButton.textContent = `Map: ${mapTitle} (server)`;
      botButton.textContent = "Bots: set on the server";
      difficultyButton.textContent = "Difficulty: set on the server";
      matchButton.textContent = "Match: set on the server";
      for (const b of [mapButton, botButton, difficultyButton, matchButton]) b.disabled = true;
    }
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
    if (net) return;
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
    if (net || maps.length < 2) return;
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
    if (net) return;
    // From what's showing (the address's choice, if it gave one).
    const i = DIFFICULTIES.findIndex((d) => d.id === (difficultyOverride?.id ?? settings.difficulty));
    settings.difficulty = DIFFICULTIES[(i + 1) % DIFFICULTIES.length].id;
    difficultyOverride = null;
    saveSettings(settings);
    for (const b of fighters) b.setSkill(botSkillLevel());
    applySettings();
  };
  onClick(difficultyButton, cycleDifficulty);
  // Match rules: the next choice, and a fresh match with it if bots are playing.
  const cycleMatch = () => {
    if (net) return;
    const i = MATCH_PRESETS.findIndex((m) => m.id === settings.match);
    settings.match = MATCH_PRESETS[(i + 1) % MATCH_PRESETS.length].id;
    saveSettings(settings);
    if (!rulesParam && fighters.length > 0) world.rematch(rulesFor(fighters.length));
    applySettings();
  };
  onClick(matchButton, cycleMatch);
  input.onCycleMatch = cycleMatch;
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
  // Join the game server (or leave it for a game on your own): a fresh page either way.
  const toggleNetwork = () => {
    const next = new URL(location.href);
    if (net) {
      next.searchParams.delete("join");
      if (servedByGameServer) next.searchParams.set("solo", "");
    } else {
      next.searchParams.delete("solo");
      if (!servedByGameServer) next.searchParams.set("join", "");
    }
    location.assign(next);
  };
  onClick(networkButton, toggleNetwork);
  // Graphics: Auto, Full, Light, round again. Edge smoothing is fixed when the graphics start, so reload.
  const cycleGraphics = () => {
    const order: QualitySetting[] = ["auto", "full", "light"];
    settings.quality = order[(order.indexOf(qualitySetting) + 1) % order.length];
    saveSettings(settings);
    const next = new URL(location.href);
    next.searchParams.delete("quality");
    location.assign(next);
  };
  onClick(graphicsButton, cycleGraphics);
  input.onCycleGraphics = cycleGraphics;
  input.onToggleNetwork = toggleNetwork;
  // Your name, for network games. Saved as you type; takes effect next time you join.
  nameBox.addEventListener("input", () => {
    settings.name = cleanName(nameBox.value);
    saveSettings(settings);
  });
  nameBox.addEventListener("keydown", (e) => {
    if (e.key === "Enter") nameBox.blur();
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
  status.textContent = net
    ? `${mapTitle}: on the game server, ${net.names.size} in the game`
    : `${mapTitle}: ${level.brushes.length} brushes, ${level.spawns.length} spawns`;
  if (net) {
    net.onClose = (reason) => {
      input.onDeactivate();
      status.textContent = `${reason} Trying to reconnect…`;
      // Back in as soon as the server answers again (a restart, a Wi-Fi blip).
      void NetClient.waitForServer(url).then(() => location.reload());
    };
  }
  // Building maps: on the dev server, check the map and list what's wrong in the menu.
  if (import.meta.env.DEV && !net) setTimeout(() => void showMapCheck(level, `${assets}/textures`, nav), 100);

  const eye = vec3();
  const frameEvents: SimEvent[] = [];
  // Network game: your own player runs ahead of the server's snapshots.
  const predictor = new Predictor();
  let last = performance.now();
  let acc = 0;
  let fps = 0;
  let fpsFrames = 0;
  let fpsTime = 0;
  /** Fire or jump held last tick: on the end screen, a fresh press asks for a rematch. */
  let rematchHeld = true;
  /**
   * The weapon you last asked for and when: further wheel steps go on from it, even
   * before a network game's server has made the switch.
   */
  let wanted = { weapon: -1, tick: 0 };
  /** A weapon change asked for: the slot to send (1 = fists), or 0. */
  const weaponSlot = (): number => {
    const req = input.takeWeaponRequest();
    if (!req || !me.alive) return 0;
    const recent = wanted.weapon >= 0 && wanted.weapon !== me.weapon && world.tick - wanted.tick < 30;
    const w = "slot" in req ? req.slot - 1 : cycleWeapon(me, recent ? wanted.weapon : me.weapon, req.cycle);
    if (!canFire(me, w)) return 0;
    wanted = { weapon: w, tick: world.tick };
    return w + 1;
  };

  const frame = (now: number) => {
    const dt = Math.min(0.25, (now - last) / 1000);
    last = now;
    input.update(dt, !active);

    // On your own the game waits while the menu is open (a network game can't).
    acc = !net && !active ? 0 : acc + dt;
    let ticks = 0;
    let firedNow = false;
    let firedWeapon: WeaponId = WEAPONS[me.weapon].id;
    frameEvents.length = 0;
    while (acc >= TICK_DT && ticks < MAX_TICKS_PER_FRAME) {
      const local = { ...input.command(), weapon: weaponSlot() };
      const mine = active ? local : { ...local, forward: 0, right: 0, jump: false, sprint: false, fire: false, portal: false, weapon: 0 };
      // This tick's events: from our own step, or from the server's snapshots.
      const tickEvents: SimEvent[] = [];
      if (net) {
        predictor.sent(net.sendCommand(mine), mine);
        let ack: number | null = null;
        for (const received of net.take()) {
          applySnapshot(world, received.snap);
          // Your own portal trips were already shown (and your view turned) by prediction.
          tickEvents.push(...received.snap.events.filter((e) => !(e.type === "teleport" && e.player === localId)));
          ack = received.ack;
        }
        const predicted = predictor.tick(world, me, ack);
        predictor.writeTo(me);
        if (predicted.teleported) {
          input.yaw = me.yaw;
          input.pitch = me.pitch;
        }
        if (predicted.fired) {
          firedNow = true;
          firedWeapon = predicted.weapon;
        }
      } else {
        const press = mine.fire || mine.jump;
        const m = world.match;
        if (m.phase === "over" && press && !rematchHeld && world.tick - m.endTick >= REMATCH_READY_TICKS) world.rematch();
        rematchHeld = press;
        const commands = new Map<PlayerId, PlayerCommand>([[localId, mine]]);
        for (const bot of bots) commands.set(bot.id, bot.command(world));
        world.step(commands);
        tickEvents.push(...world.events);
      }
      for (const e of tickEvents) {
        frameEvents.push(e);
        // Respawning faces you the way the spawn point says; a portal turns you to face out of the exit.
        if (e.type === "respawn" && e.player === localId) {
          if (allWeapons && !net) armFully(me);
          input.yaw = me.yaw;
          input.pitch = 0;
        }
        if (e.type === "teleport" && e.player === localId) {
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
    if (net) {
      // A correction from the server fades in rather than jolting the view.
      predictor.smooth(dt);
      eye.x += predictor.offset.x;
      eye.y += predictor.offset.y;
      eye.z += predictor.offset.z;
    }
    const time = now / 1000;
    renderer.render({ world, localId, alpha, eye, yaw: input.yaw, pitch: input.pitch, timeSeconds: time, dt, predictedFire: !!net }, frameEvents);
    if (firedNow) renderer.localShot(firedWeapon);
    hud.update(world, me, frameEvents, dt, input.scoresHeld);
    // In a network game your shot's sound plays when you fire, not when the server's word comes back.
    const heard = net ? frameEvents.filter((e) => !(e.type === "fire" && e.player === localId)) : frameEvents;
    if (firedNow) heard.push({ type: "fire", player: localId, weapon: firedWeapon, projectile: -1, origin: { ...eye }, dir: { x: 0, y: 0, z: 0 } });
    sfx.play(heard, localId, eye, input.yaw);

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
      (nav ? `\nnav: ${nav.nodes.length} nodes, ${nav.edgeCount} links` : "") +
      (net ? `\nnetwork game: you are player ${localId}` : "") +
      `\ngraphics: ${quality.profile.mode} (${quality.reason})`;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  if (import.meta.env.DEV) Object.assign(window, { skronk: { world, input, renderer, level, bots, nav, net, predictor } });
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
  const joining = new URLSearchParams(location.search).has("join");
  status.textContent = `Error: ${err instanceof Error ? err.message : String(err)}` + (joining ? " (Remove ?join from the address to play on your own.)" : "");
  overlay.classList.remove("hidden");
});
