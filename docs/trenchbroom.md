# TrenchBroom for Skronk

A cheat sheet for making Skronk maps. New to it? Start with the [lessons](editor-lessons.md). Learn the editor itself from TrenchBroom's built-in manual (Help → TrenchBroom Manual) or Quake-focused tutorials; this page covers what's different here.

## One-time setup

1. Install TrenchBroom (trenchbroom.github.io).
2. In this repo: `npm run tb:install`. It links `trenchbroom/Skronk/` into TrenchBroom's games folder.
3. Restart TrenchBroom. New map → game **Skronk**, format **Quake2 (Valve)**.
4. When asked for the game path (or in Preferences → Skronk), choose this repo's `public/` folder. Textures then show up in the texture browser.

## Using Quake tutorials: keep vs skip

Keep everything about the editor: camera and views, drawing and cutting brushes, the clip tool, vertex editing, grid snapping, texturing faces (alignment, scale), groups and layers, placing entities.

Skip:

- **Compiling** (qbsp, vis, light, "build" or "run" dialogs). Skronk loads the `.map` file directly. Save and refresh the browser.
- **Quake entities** (monsters, weapons, keys, doors, triggers, `info_player_start`). Skronk only knows the entities below.
- **WAD textures.** Ours are PNG files.
- **Leaks.** Quake's compiler refuses maps that aren't sealed. Skronk loads them anyway, but seal your maps: players and shots can fall out of a gap. The map check (below) finds gaps and says roughly where.

## Sizes (1 unit ≈ 1 inch)

| Thing | Size |
| --- | --- |
| Player | 32 wide, 56 tall; eyes 46 above the floor |
| Step up without jumping | 18 |
| Jump height | about 45 (a 40-unit wall is jumpable) |
| Steepest walkable slope | about 45° |
| Run / sprint speed | 320 / 560 units per second |
| Portal opening | 64 wide, 112 tall |
| Doorway, comfortable | 64 wide, 96+ tall |
| Corridor, comfortable | 96–128 wide |

Use a grid of 16 or 32 for most work (press `[` and `]` to change it).

## Textures

Texture name in the map = `<folder>/<name>`, from `public/assets/textures/`. Current set in `base/`: `floor`, `wall`, `ceiling`, `trim`, `portal_panel`, plus two special ones:

- `base/nodraw`: solid but invisible. Use it on faces nobody will see (backs of walls, under floors).
- `base/clip`: invisible wall. Blocks players and shots, never drawn.

Add your own: drop a PNG into a folder under `public/assets/textures/` (power-of-two sizes like 64, 128, 256 work best).

## Portal surfaces

A face accepts portals only if its **`portal` surface flag** is ticked: select the face (Shift+click in the 3D view), then tick `portal` in the Face inspector's surface flags. The `base/portal_panel` texture is only a hint for players; the flag is what counts.

Make a portal face flat and at least 64 × 112, plus a few units of margin. Portals can't wrap over edges or corners.

## Entities

Right-click in the 2D or 3D view → Create Point Entity, or drag from the Entity browser.

| Entity | Keys |
| --- | --- |
| `player_spawn` | `angle` (degrees, 0 = +X, 90 = +Y), `team` (0 any, 1, 2) |
| `pickup_health` | `amount` (default 25) |
| `pickup_armor` | `amount` (default 50) |
| `pickup_ammo` | `amount` (default 50) |
| `light` | `light` brightness (default 300), `_color` as `R G B` from 0 to 1 |

Put spawns' boxes just above the floor, not inside it (origin 25 above the floor top); pickups' boxes too (origin 17 above). The first four lights are used in Light graphics mode (Xbox), the first eight in Full: put the important ones first.

The map's title: the worldspawn entity's `message` key (with nothing selected, the Entity inspector shows worldspawn). The game's Map menu shows it.

Groups and layers are fine: grouped brushes count as normal world geometry. Other brush entities (doors, triggers) are ignored.

## Testing a map

1. Save as `public/assets/maps/<name>.map`.
2. With `npm run dev` running and the game open at `http://localhost:5173/`, pick your map with the **Map** button in the menu. From then on, every save reloads the game with your changes.
3. **Map check** under the menu lists problems: spawns in walls, gaps to the outside, places bots can't walk to, portal faces too small, unknown entities, missing textures. Same check in a terminal: `npm run maps:check` (all maps) or `npm run maps:check <name>`.
4. Add `?navdebug` to the address to see where bots can walk (green walk, yellow jump, orange drop). Set **Bots** in the menu to watch them use it.
5. To see how a whole map fits together, open the starter maps **Portal Gym** (`portal_gym.map`) and **Arena** (`arena.map`). Work on a copy: `npm run maps:starters` remakes the originals.

To put a map on the live site, commit and push it.

## First map checklist

- [ ] A sealed room: floor, ceiling, four walls
- [ ] Two or more `player_spawn`s, facing into the room
- [ ] Stairs (steps 16 high) and a ramp up to a higher area
- [ ] A ledge to drop off, and a low wall to jump (40 high)
- [ ] Two portal-flagged walls facing each other
- [ ] One of each pickup and a couple of lights
- [ ] A `message` title on worldspawn
- [ ] Map check: **all good**
- [ ] Load it with `?navdebug` and check the green covers everywhere you expect
