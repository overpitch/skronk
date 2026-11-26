# Skronk

Browser arena shooter with personal portals. Full brief: [docs/brief.md](docs/brief.md). Original game: no Quake/Portal names, assets, maps or characters.

## Commands

- `npm run dev`: dev server on http://localhost:5173 (`--host`, so other devices on the LAN, like the Xbox, can open it)
- `npm test`: vitest (parser, brush geometry, collision, movement)
- `npm run typecheck` / `npm run build`
- `npm run textures`: regenerate the placeholder PNGs in `public/assets/textures/base/`
- `npm run maps:test`: regenerate `public/assets/maps/test_box.map`
- `npm run tb:install`: symlink `trenchbroom/Skronk` into TrenchBroom's user games folder

Live build: https://overpitch.github.io/skronk/ (every push to `main` runs tests, builds and deploys via `.github/workflows/deploy.yml`).

Test in desktop Chrome only (the built-in browser pane is Chromium too). Safari is not a test target. The Xbox browser is Edge, also Chromium, so Chrome is the closest stand-in.

Load a map with `?map=<name>` (file in `public/assets/maps/<name>.map`). Default: `test_box`.
Sound: `?mute` plays nothing this visit (not saved). Use it for every browser-pane test, and close the tab afterwards.
Practice targets: `?dummies=N` (default 1, or 0 when there are bots); add `?dummyfire` to make them shoot back, `?dummyspeed=0..1` for strafe speed (default 0.35, 0 stands still).
Bots and difficulty are menu settings (saved per browser; controller LB/RB bots, X difficulty). Address options override them for one visit: `?bots=N` bots that roam, fight and use pickups (milestone 4); `?botskill=0..1` instead of the difficulty; `?navdebug` draws their walk graph (green walk, yellow jump, orange drop). The walk graph is built from the level at load (`src/bots/nav.ts`), no waypoints to place.

## Architecture rules

- `src/sim/` is the simulation. It must not import `three`, the DOM, or anything in `src/render`, `src/client`. Fixed tick (`TICK_RATE`), driven only by `PlayerCommand`s. Bots, local players and remote players are all just command sources.
- `src/level/types.ts` is the loader interface. The sim reads `LevelData`, never `.map` text. `src/level/trenchbroom/` is one loader implementation.
- `src/render/` reads sim state and draws it. `src/client/` owns the browser: input devices, HUD, audio, settings, main loop.
- `src/bots/` turns world state into `PlayerCommand`s. Bots never touch sim state directly.
- The sim reports what happened each tick in `world.events` (shots, hits, kills, pickups). Effects, sound and HUD react to those; the sim never reads them back.
- Teleports (respawn, later portals) must set `prevOrigin` too, or the renderer interpolates across the map.
- Coordinates everywhere: map units (1 unit ≈ 1 inch), **Z up**, right-handed, same as the `.map` file. Three.js runs Z-up too (`camera.up = (0,0,1)`); no axis conversion.
- Angles: radians in code. Yaw 0 = +X, counter-clockwise. Pitch positive = look up. Map entity `angle` keys are degrees.
- Determinism: same inputs on the same JS engine give the same result. Not bit-exact across browsers (`Math.sin` etc. may differ), so the network plan is server authority + client prediction, not lockstep.

## Level conventions (TrenchBroom)

- Game config: `trenchbroom/Skronk/` (GameConfig.cfg + skronk.fgd). Map format: **Quake2 (Valve)**. TrenchBroom game path = this repo's `public/` folder.
- Textures: PNGs under `public/assets/textures/<collection>/`. Texture name in the map = `<collection>/<name>`.
- Portal-friendly faces: surface flag `portal` (bit 0, value 1) in the face inspector. The flag is the source of truth; `base/portal_panel` is just the texture that makes it visible to players.
- `nodraw` surface flag or a texture named `*/nodraw`: solid, not drawn. `*/clip`: solid, not drawn (invisible walls).
- Entities: `player_spawn` (`angle`, optional `team` 1/2), `pickup_<kind>` (health, armor, ammo...), `light`. Brushes in `func_group` (TrenchBroom groups/layers) count as world.

## Working with Dave

- Solo developer, sets his own pace. Don't push timelines.
- Push back on weak design or scope decisions.
- Make reasonable assumptions from context and state them rather than asking.
- Keep output concise.
