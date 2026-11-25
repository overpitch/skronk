import { LocalInput } from "./client/localInput";
import { TrenchBroomLoader } from "./level/trenchbroom/trenchbroomLoader";
import { clone, copy, lerp, vec3 } from "./math/vec3";
import { GameRenderer } from "./render/renderer";
import { EYE_HEIGHT } from "./sim/movement";
import { TICK_DT, World } from "./sim/world";

const LOCAL_PLAYER = 1;
/** Never simulate more than this many ticks per frame (e.g. after a tab was hidden). */
const MAX_TICKS_PER_FRAME = 8;

const canvas = document.getElementById("game") as HTMLCanvasElement;
const overlay = document.getElementById("overlay")!;
const status = document.getElementById("status")!;
const debug = document.getElementById("debug")!;

async function start() {
  const mapName = new URLSearchParams(location.search).get("map") ?? "test_box";
  const assets = `${import.meta.env.BASE_URL}assets`;
  status.textContent = `Loading ${mapName}…`;
  const level = await new TrenchBroomLoader().load(`${assets}/maps/${mapName}.map`);

  const world = new World(level);
  const me = world.addPlayer(LOCAL_PLAYER);
  const renderer = new GameRenderer(canvas, `${assets}/textures`);
  renderer.loadLevel(level);
  window.addEventListener("resize", () => renderer.resize());

  const input = new LocalInput(canvas);
  input.yaw = me.yaw;
  let active = false;
  input.onActivate = () => {
    active = true;
    overlay.classList.add("hidden");
  };
  input.onDeactivate = () => {
    active = false;
    overlay.classList.remove("hidden");
  };
  status.textContent = `${level.name}: ${level.brushes.length} brushes, ${level.spawns.length} spawns`;

  const prevOrigin = clone(me.origin);
  const eye = vec3();
  let last = performance.now();
  let acc = 0;
  let fps = 0;
  let fpsFrames = 0;
  let fpsTime = 0;

  const frame = (now: number) => {
    const dt = Math.min(0.25, (now - last) / 1000);
    last = now;
    input.update(active ? dt : 0);

    acc += dt;
    let ticks = 0;
    while (acc >= TICK_DT && ticks < MAX_TICKS_PER_FRAME) {
      copy(prevOrigin, me.origin);
      const cmd = active ? input.command() : { ...input.command(), forward: 0, right: 0, jump: false };
      world.step(new Map([[LOCAL_PLAYER, cmd]]));
      acc -= TICK_DT;
      ticks++;
    }
    if (ticks === MAX_TICKS_PER_FRAME) acc = 0;

    // Interpolate position between ticks; use the latest view angles for responsiveness.
    lerp(prevOrigin, me.origin, acc / TICK_DT, eye);
    eye.z += EYE_HEIGHT;
    renderer.render(eye, input.yaw, input.pitch, now / 1000);

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
      `${me.origin.x.toFixed(0)} ${me.origin.y.toFixed(0)} ${me.origin.z.toFixed(0)}  tick ${world.tick}`;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  if (import.meta.env.DEV) Object.assign(window, { skronk: { world, input, renderer, level } });
}

start().catch((err) => {
  console.error(err);
  status.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
  overlay.classList.remove("hidden");
});
