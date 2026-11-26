# Skronk

Browser arena shooter with personal portals. Full brief: [docs/brief.md](docs/brief.md). Original game: no Quake/Portal names, assets, maps or characters.

## Commands

- `npm run dev`: dev server on http://localhost:5173 (`--host`, so other devices on the LAN, like the Xbox, can open it)
- `npm test`: vitest (parser, brush geometry, collision, movement, portals, bots, map check, network)
- `npm run lan -- --map arena --bots 2 --difficulty easy`: for a visit. Builds the game and serves it from the game server (port 5175): any device on the network, the Xbox included, opens `http://<mac>:5175/` and is straight in (a page from the game server joins by itself; `?solo` plays alone). macOS may ask to allow incoming connections for node the first time.
- `npm run server -- --map arena --bots 2 --difficulty easy`: game server for network play (port 5175). `--fraglimit N --timelimit minutes` (default 20 and 10; 0 for none); the next match starts by itself 15 s after one ends. Browsers join with `?join` on the dev server's address (`http://<mac>:5173/?join`); `?join=host[:port]` for another machine.
- `npm run typecheck` / `npm run build`
- `npm run textures`: regenerate the placeholder PNGs in `public/assets/textures/base/`
- `npm run maps:test`: regenerate `public/assets/maps/test_box.map`
- `npm run maps:starters`: regenerate the starter maps `portal_gym.map` and `arena.map` (`tools/make-portal-gym.mjs`, `tools/make-arena.mjs`, helpers in `tools/mapgen.mjs`). They're starting points for Dave to edit in TrenchBroom: once he has, don't regenerate them (it overwrites his changes).
- `npm run maps:check [name ...]`: check maps for problems (spawns, gaps to the outside, bot reachability, portal faces, textures; `src/devtools/mapCheck.ts`). The dev server also shows the result in the menu.
- `npm run tb:install`: symlink `trenchbroom/Skronk` into TrenchBroom's user games folder

Live build: https://overpitch.github.io/skronk/ (every push to `main` runs tests, builds and deploys via `.github/workflows/deploy.yml`).

Test in desktop Chrome only (the built-in browser pane is Chromium too). Safari is not a test target. The Xbox browser is Edge, also Chromium, so Chrome is the closest stand-in.

Maps: every `public/assets/maps/*.map` is in the menu's Map choice (listed at build time by the `skronk-maps` plugin in `vite.config.ts`, imported as `virtual:maps`). A map's title is worldspawn's `message` key. In dev, saving a map file reloads the game. `?map=<name>` plays that map for one visit.
Sound: `?mute` plays nothing this visit (not saved). Use it for every browser-pane test, and close the tab afterwards.
Matches (`src/sim/match.ts`): the menu's Match setting (controller B) applies when bots play; practice with no bots has no limits. First to the frag limit wins; at the time limit the leader wins, a tied lead goes to sudden death. Over: everything freezes and the end screen shows; locally a fresh fire/jump press after 3 s asks for a rematch (`world.rematch()`, takes effect next step). `?fraglimit=N&timelimit=minutes` for one visit. Spawns are picked fairly (`pickSpawn`: never on top of someone, out of enemies' sight if possible, far away, random among the good ones by a hash, not `Math.random`), with 2 s of spawn protection (`protectedUntil`; firing ends it; bots ignore protected players) and the gun up after 0.3 s. On your own the game pauses while the menu is open.
Weapons (`src/sim/weapons.ts`, batch one): fists, machine gun, shotgun, rocket launcher, railgun, in slot order (keys 1–5, mouse wheel, controller LB/RB in play). Plain ids in code and maps (`pickup_shotgun`, `pickup_rocketlauncher`, `pickup_railgun`); `name` is what players see. Everyone spawns with fists and the machine gun and loses the rest on death; `pickup_ammo` tops up every gun held. The trigger rules (`triggerTick`: cooldown, switching, ammo, switching away from an empty gun) are shared by the sim and network prediction. Shotgun and railgun shots are instant and go through portals (`traceShot`), rockets are projectiles with splash (`explode`: falloff, line of sight, self damage 0.4, rocket jumps), fists punch-jump off walls and floors. Bots pick by distance (`src/bots/weaponChoice.ts`). Later batches: nailgun, chaingun, grenade launcher, laser, Ricochet, Swapper (and maybe proximity mines).
Testing weapons: `?allweapons` gives you every weapon with full ammo on every spawn (your own game only).
Practice targets: `?dummies=N` (default 1, or 0 when there are bots); add `?dummyfire` to make them shoot back, `?dummyspeed=0..1` for strafe speed (default 0.35, 0 stands still).
Bots and difficulty are menu settings (saved per browser; controller LB/RB bots, X difficulty). Address options override them for one visit: `?bots=N` bots that roam, fight and use pickups (milestone 4); `?difficulty=beginner|easy|normal|hard` instead of the menu's (levels measured apart in `tests/botSkill.test.ts`: lower levels aim worse, let go of the trigger, steady heavy shots longer, switch weapons slowly, dodge slower and stand still more, notice being shot later; only Hard fires rockets at your feet); `?navdebug` draws their walk graph (green walk, yellow jump, orange drop). The walk graph is built from the level at load (`src/bots/nav.ts`), no waypoints to place. Bots use portals that are open (anyone's) as shortcuts: `src/bots/portalLinks.ts` walks a stand-in player into each opening with the real movement code and adds an edge to wherever it lands, redone when portals change. Places only a portal reaches (a ledge) stay in the graph if they overlook walkable ground. Bots place portals of their own too (`src/bots/portalPlanner.ts` finds every spot a portal fits on the map and where coming out of it lands you, then picks a pair; `src/bots/portalJob.ts` walks, aims and fires them): to reach a pickup they can't walk to, to cut a long trip short, or now and then to visit somewhere only portals reach. Next: fighting with portals (shooting through, escaping, following).

## Architecture rules

- `src/sim/` is the simulation. It must not import `three`, the DOM, or anything in `src/render`, `src/client`. Fixed tick (`TICK_RATE`), driven only by `PlayerCommand`s. Bots, local players and remote players are all just command sources.
- `src/level/types.ts` is the loader interface. The sim reads `LevelData`, never `.map` text. `src/level/trenchbroom/` is one loader implementation.
- `src/render/` reads sim state and draws it. Graphics quality (`src/render/quality.ts`): two modes, Full and Light (Auto picks Light on Xbox, phones, weak machines; menu Graphics button; `?quality=full|light`). Only looks differ between modes, never gameplay. Every visual feature takes its numbers from `QualityProfile`; Full-only features (shadows from the first map lights) are switched there. New visual work gets a value for both modes. `src/client/` owns the browser: input devices, HUD, audio, settings, main loop.
- `src/bots/` turns world state into `PlayerCommand`s. Bots never touch sim state directly.
- Network play (milestone 7): `server/` runs the one true `World` (and the bots) in Node; browsers send a `PlayerCommand` per tick and get a full `WorldSnapshot` per tick (`src/net/`). A joined client's `World` is a mirror: never stepped, overwritten by `applySnapshot`, so render/HUD/audio work unchanged. Messages are JSON for now. Your own player is predicted (`src/client/prediction.ts`): commands are kept until the server acks them (`acks` in each snap), replayed on the server's state with `World.movePlayer` (same movement code, portals included), and corrections fade out. Firing feedback (kick, flash, sound) is predicted; the shot itself is the server's. `?lag=ms` fakes a slow connection for testing. Online hosting (milestone 7 step 4): `Dockerfile` runs the server (settings from `SKRONK_MAP`/`SKRONK_BOTS`/`SKRONK_DIFFICULTY`/`SKRONK_FRAGLIMIT`/`SKRONK_TIMELIMIT`, `PORT`; `/health` for checks). The live site joins the server in the `GAME_SERVER` repository variable (passed to the build as `VITE_GAME_SERVER`, a `wss://` address); an https page can only use `wss`. The server sanitizes every command (`sanitizeCommand`) and caps message size and connections.
- The sim reports what happened each tick in `world.events` (shots, hits, kills, pickups, match over/start). Effects, sound and HUD react to those; the sim never reads them back.
- Teleports (respawn, later portals) must set `prevOrigin` too, or the renderer interpolates across the map.
- Coordinates everywhere: map units (1 unit ≈ 1 inch), **Z up**, right-handed, same as the `.map` file. Three.js runs Z-up too (`camera.up = (0,0,1)`); no axis conversion.
- Angles: radians in code. Yaw 0 = +X, counter-clockwise. Pitch positive = look up. Map entity `angle` keys are degrees.
- Determinism: same inputs on the same JS engine give the same result. Not bit-exact across browsers (`Math.sin` etc. may differ), so the network plan is server authority + client prediction, not lockstep.

## Level conventions (TrenchBroom)

Guides for Dave: [docs/editor-lessons.md](docs/editor-lessons.md) (lessons) and [docs/trenchbroom.md](docs/trenchbroom.md) (cheat sheet). Keep them in step with the game when map features change.

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
