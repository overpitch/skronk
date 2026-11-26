# Building Skronk maps: lessons

Seven short lessons. Each one ends with a small map of your own that you play in the game. They teach what's special about Skronk maps; for TrenchBroom's own controls (camera, drawing brushes, the clip and vertex tools), keep its manual open: **Help → TrenchBroom Manual**. The [cheat sheet](trenchbroom.md) has all the numbers in one place.

**Before you start**

- TrenchBroom is set up for Skronk (the "One-time setup" in the [cheat sheet](trenchbroom.md)).
- The dev server is running: `npm run dev` in a terminal, and the game open in Chrome at `http://localhost:5173/`.
- Put TrenchBroom and Chrome side by side. Every time you save a map, the game reloads with your changes.

**Seeing your map in the game:** click the **Map** button in the game's menu until your map comes up (it remembers your choice). Under the menu, **Map check** lists anything wrong with the map; click it to open the list. The same check runs from a terminal with `npm run maps:check`.

---

## Lesson 1: A room to stand in

**You'll make:** a closed room with somewhere to spawn and a light.

1. **New map:** File → New Map, game **Skronk**, format **Quake2 (Valve)**.
2. **Floor:** set the grid to 16 (the grid size shows at the bottom of the window; `[` and `]` change it). Draw a brush 1024 × 1024 and 16 thick, with its top at height 0. A brush is a solid block; everything in a map is made of them.
3. **Walls and ceiling:** draw four walls, 16 thick, from the floor up to 256, around the edges of the floor. Then a ceiling slab on top. The walls should overlap or touch at the corners with no gaps. (TrenchBroom can also make a room in one go: draw one big block, then **Edit → CSG → Hollow**, if your version has it.)
4. **A spawn:** right-click inside the room in a 2D view → **Create Point Entity → player_spawn**. Move it so its green box sits just above the floor (its origin 25 above the floor top). In the Entity inspector, set `angle` to the direction it should face: 0 faces +X (east), 90 faces +Y.
5. **A light:** create a `light` entity near the ceiling. Its `light` key is the brightness (try 400).
6. **A title:** with nothing selected (or any wall selected), the Entity inspector shows **worldspawn**, the map itself. Add a property `message` with your map's name, for example `My First Room`. That's what the game's menu shows.
7. **Save** as `public/assets/maps/lesson1.map` (inside this repo).

**Check it:** pick **My First Room** in the game's Map menu and walk around. The map check will say **No portal-friendly faces**; that's lesson 3. If it says **gap to the outside**, a wall doesn't quite meet the next one: it tells you roughly where.

---

## Lesson 2: Textures

**You'll make:** the same room, looking like a place.

1. Select a face: **Shift+click** it in the 3D view. Select a whole brush with a plain click.
2. Pick a texture in the texture browser (the Face tab). The Skronk set is in `base/`: `floor`, `wall`, `ceiling`, `trim`, `portal_panel`.
3. Give the floor `base/floor`, the walls `base/wall`, the ceiling `base/ceiling`.
4. Scale and shift textures in the Face inspector until the tiles line up. The default (scale 1) is one texture pixel per unit, which is usually right.
5. Two invisible textures:
   - `base/nodraw`: solid, but never drawn. For faces nobody will ever see, like the outsides of walls.
   - `base/clip`: an invisible wall. Use it to stop players getting somewhere, without anything showing.
6. Your own textures: drop a PNG (64, 128 or 256 pixels square work best) into a folder under `public/assets/textures/`, for example `public/assets/textures/mine/brick.png`. It shows up in TrenchBroom as `mine/brick` (you may need to refresh the texture browser).

**Check it:** save and look. A face showing a coloured checkerboard has a texture the game can't find; the map check names it.

---

## Lesson 3: Portal walls

**You'll make:** a room where portals work.

1. Shift+click a wall's inside face. In the Face inspector, under **surface flags**, tick **portal**. That flag is what makes a face take portals.
2. Give it the `base/portal_panel` texture, so players can see it takes portals. (The texture is only a hint; the flag is what counts.)
3. Do the same on the opposite wall.
4. A portal is 64 wide and 112 tall. A portal face has to be flat and bigger than that, with a little room to spare. The map check notes any portal face too small to ever hold one.
5. For flings: flag the top of a floor area too, so a portal can go in the floor.

**Check it:** in the game, put one portal on each wall (right click or E), walk into one and out of the other. Then put one in the floor, drop into it, and come flying out of a wall. Open the **Portal Gym** map for more ideas.

---

## Lesson 4: Up and down

**You'll make:** a second level, with every way of getting up and down.

What a player can do (1 unit is about an inch):

| Move | Size |
| --- | --- |
| Walk up a step | up to 18 high (16 is comfortable) |
| Jump onto something | up to about 45 high (40 is a sure thing) |
| Walk up a slope | up to about 45 degrees |
| Fit through a gap | 32 wide and 56 tall at least; doorways feel right at 64 × 96 |

1. **Stairs:** a row of blocks, each 16 higher than the last and 24 or 32 deep.
2. **A ramp:** draw a block, then cut its top at a slant with the **clip tool** (see the manual) so it rises 128 over 256.
3. **A ledge:** a block 128 high you can get onto by the ramp, and drop off.
4. **A low wall:** 40 high, to jump over.

**Check it:** walk everything. Then open the game with `&navdebug` added to the address (`http://localhost:5173/?navdebug`): green lines show where bots can walk, yellow where they jump, orange where they drop. Anywhere without lines, bots never go. The map check warns if a spawn or pickup can't be walked to.

---

## Lesson 5: Spawns, pickups and bots

**You'll make:** a map ready for a fight.

1. **Spawns:** four or more `player_spawn`s spread round the map, each facing into the open. When someone is fragged they come back at one of these.
2. **Pickups:** `pickup_health`, `pickup_armor` and `pickup_ammo`. Place each one's box just above the floor (origin 17 above the floor top). Their `amount` key sets how much they give.
   - Health and ammo spread out, so nobody can camp them all.
   - Armor somewhere worth the trip: the top of a ramp, the far side of a jump.
3. **Lights:** two to four. Light graphics mode (the Xbox) uses only the first four lights in a map and Full mode the first eight, so put the important ones first; `_color` tints them (`1 0.85 0.6` is warm, `0.6 0.8 1` cool).

**Check it:** in the game's menu set **Bots** to 3 and play. Bots go for pickups when they need them, so you'll see quickly whether yours are placed well. Open the **Arena** map to see a full layout.

---

## Lesson 6: Sealing, and the map check

**You'll make:** a gap on purpose, and fix it.

1. Move one wall of your lesson 1 room 32 units outwards, so gaps open at its corners. Save.
2. The map check says **There's a gap to the outside near (x y z)**. Players and shots can leave the map through a gap like that. (It finds gaps a player or a shot could get through; a hairline crack of a unit or two can slip past it, so keep corners overlapping anyway.)
3. Close it: move the wall back, or make the walls overlap at the corners.
4. Other things the check finds, and what to do:
   - **Spawn inside a wall or floor:** move it up or out.
   - **Can't be walked to from spawn 1:** that place needs stairs, a ramp, or a lower ledge (bots don't use portals).
   - **Unknown entity:** Skronk ignores Quake entities like doors and monsters.
   - **Brush entity ignored:** only plain brushes (and groups) count as world. Doors and triggers aren't supported yet.

**Check it:** the map check says **all good**. Notes (in grey) are only for information.

---

## Lesson 7: Make one of the starter maps your own

**You'll make:** your first real map.

1. Copy `public/assets/maps/arena.map` (or `portal_gym.map`) to a new name, say `my_arena.map`, and open the copy in TrenchBroom.
2. Change its `message` (lesson 1) so the menu shows your title.
3. Change anything: move the pillars, add a third walkway, cut a pit, swap textures, add portal faces.
4. Keep the map check at **all good** as you go.

The starter maps were generated by scripts in `tools/`. Running `npm run maps:starters` remakes the originals and overwrites any changes made to `arena.map` or `portal_gym.map` themselves, which is another reason to work on a copy.

**Putting it on the live site:** commit the new `.map` file (and any new textures) and push, or ask Claude to. The site updates a minute or two later, with your map in the menu.
