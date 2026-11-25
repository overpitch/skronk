# Portal Arena Shooter: Project Brief

## Goal

A Quake Team Arena style first-person arena shooter with Portal-style portals, playable in a web browser. It must run on a Mac, on any desktop browser, and on the Xbox browser, so the grandkids can open a URL and play with no install.

This is an original game. Write all code from scratch. Create or license original art, sound, names, characters, and maps. Do not use Quake or Portal names, assets, maps, or character designs. Match the feel (fast movement, weapon pacing, team modes), not the protected expression.

## Decisions Made

- **Platform:** browser game, built with Three.js (WebGL first, WebGPU later if useful).
- **Multiplayer from day one in the design.** Ship bots first, but structure the code so humans can join later. Target: Dave plays with his grandkids on their Xbox when he visits.
- **Weapon:** one weapon with two triggers. Primary fire shoots bullets. Secondary fire shoots a portal.
  - Keyboard and mouse: left click shoots, right click fires a portal.
  - Xbox controller: right trigger shoots, left trigger fires a portal.
- **Portals:** each player owns a personal pair of two linked portals. A new portal shot replaces the oldest. Portals stick only to surfaces marked portal-friendly. Players and bullets that cross a portal are teleported to the linked exit with position and direction rotated to match.
- **Portal ownership model:** a portal pair belongs to an "owner" that is a player now. Keep the code general so the owner can become a team later (shared team portals as a future mode). Shared team portals need voice coordination, so they are not in the first version.
- **Levels are data, independent of the core game.** A match loads any level. Dave will play many levels in a session and wants to author his own.
- **Level editor from day one:** use TrenchBroom (free, native on Mac, Quake-style). Claude Code writes a loader for its map format. Use custom surface properties to tag portal-friendly walls. Spawn points and weapon pickups are placed entity markers.

## Architecture

1. **One simulation** runs the world: players, bullets, portals, pickups, scores. It is deterministic and independent of rendering.
2. **Inputs drive everything.** Every participant (bot, local player, remote player) is just a source of inputs: move, aim, shoot, place portal. The simulation does not care where inputs come from.
3. **Renderer** reads simulation state and draws it with Three.js, including rendering the view through each portal.
4. **Networking layer** (added after bots work): WebSockets or WebRTC, with a small relay server. Fast shooters are lag sensitive, so plan for client prediction and server authority. Portals complicate this because a shot can exit somewhere else.
5. **Level loader** reads TrenchBroom map files and builds geometry, collision, spawn points, pickups, and portal-friendly surface flags.

**Loader interface rule:** the simulation never reads TrenchBroom files directly. It talks to levels through a loader interface that returns geometry, collision, spawn points, pickups, and portal-friendly surface flags. The TrenchBroom loader is the first implementation. Other loaders (heightmap terrain, chunked world streaming) can be added later without touching the simulation.

## Milestones

1. **First milestone:** draw a simple box room in TrenchBroom, load it in the browser, and walk around in it with mouse and keyboard. This also proves the map format loads well in a browser.
2. Shooting and basic weapon feel.
3. Portal placement and teleporting players, then bullets.
4. Bots with simple behavior.
5. Several hand-made test levels, including some for learning the editor.
6. Gamepad support, tested early on the Xbox browser (aiming tuning needed).
7. Multiplayer networking and a hosted relay server.
8. Team modes and further levels.

## Future: Open Worlds

Not in scope for the first version. Dave may later want larger open worlds in the style of GTA 6 or Satisfactory.

- TrenchBroom stays useful for arenas, interiors, caves, and prefabs placed into a larger world. It is a poor fit for large outdoor terrain (no sculpting, heightmaps, or chunk streaming).
- A terrain layer would sit beside it: heightmaps or procedural generation, loaded through the loader interface above.
- Large worlds need chunked streaming that loads and unloads as the player moves. Browser memory and draw distance make this harder.
- Portals through streamed terrain need both ends of a pair loaded at the same time. Plan for that before committing to a huge world.
- A Satisfactory-style game depends more on an in-game build system than on any level editor.

## Open Questions and Risks

- Performance of portal rendering in a browser, especially on the Xbox browser. Test early.
- Whether the Xbox browser handles pointer lock, gamepad input, and WebGL or WebGPU well enough.
- Lag handling for portal-crossing shots in multiplayer.
- Possible patents on the portal mechanic. Dave is not a lawyer and should consult one before selling anything.

## Working Notes for Claude Code

- Dave is a solo developer who sets his own pace. Do not push timelines.
- Push back on weak design or scope decisions.
- Make reasonable assumptions from context and state them rather than asking.
- Keep output concise.
