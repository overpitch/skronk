// Starter map: Arena. A two-level room for fighting bots:
//  - raised walkways along the north and south walls (128 up), ramps at all four corners;
//  - four pillars for cover, and a low plinth in the middle with the armor;
//  - health on each walkway, ammo by the east and west walls;
//  - a railgun on the north walkway, a rocket launcher on the south one, shotguns on the floor,
//    a grenade launcher by the west wall;
//  - portal walls east and west, portal faces on the walkway fronts, two portal floor pads.
// Generated once as a starting point; it's Dave's to edit in TrenchBroom.
import { box, N, portalOn, ramp, shell, writeMap } from "./mapgen.mjs";

const brushes = [];
const B = (faces) => brushes.push(faces);

// Interior x,y -768..768, floor z 0, ceiling z 448.
for (const b of shell([-768, -768, 0], [768, 768, 448], 16, {
  floor: "base/floor",
  ceiling: "base/ceiling",
  wall: "base/wall",
  westWall: portalOn([N.east], "base/wall"),
  eastWall: portalOn([N.west], "base/wall"),
})) B(b);

// Walkways: 192 deep, 128 up; their fronts (facing the middle) take portals.
const walkTop = (front) => (n) => (n[2] === 1 ? ["base/floor", 0] : portalOn([front], "base/trim")(n));
B(box([-512, 576, 0], [512, 768, 128], walkTop(N.south)));
B(box([-512, -768, 0], [512, -576, 128], walkTop(N.north)));
// Ramps at the corners, rising 128 over 256 towards the walkways.
B(ramp([512, 576, 0], [768, 768, 128], "-x", "base/trim", "base/floor"));
B(ramp([-768, 576, 0], [-512, 768, 128], "+x", "base/trim", "base/floor"));
B(ramp([512, -768, 0], [768, -576, 128], "-x", "base/trim", "base/floor"));
B(ramp([-768, -768, 0], [-512, -576, 128], "+x", "base/trim", "base/floor"));

// Pillars, floor to ceiling.
for (const [x, y] of [[-320, -224], [320, -224], [-320, 224], [320, 224]]) {
  B(box([x - 48, y - 48, 0], [x + 48, y + 48, 448], "base/trim"));
}

// Plinth in the middle: one step up.
B(box([-96, -96, 0], [96, 96, 16], (n) => (n[2] === 1 ? ["base/floor", 0] : ["base/trim", 0])));

// Portal floor pads, east and west.
const pad = (n) => (n[2] === 1 ? ["base/portal_panel", 1] : ["base/trim", 0]);
B(box([432, -80, 0], [592, 80, 2], pad));
B(box([-592, -80, 0], [-432, 80, 2], pad));

writeMap("arena", {
  title: "Arena",
  generator: "tools/make-arena.mjs",
  starter: true,
  brushes,
  entities: [
    { classname: "player_spawn", origin: "-600 -400 25", angle: "0" },
    { classname: "player_spawn", origin: "600 400 25", angle: "180" },
    { classname: "player_spawn", origin: "-600 400 25", angle: "0" },
    { classname: "player_spawn", origin: "600 -400 25", angle: "180" },
    { classname: "player_spawn", origin: "0 672 153", angle: "270" },
    { classname: "player_spawn", origin: "0 -672 153", angle: "90" },
    { classname: "pickup_armor", origin: "0 0 33", amount: "50" },
    { classname: "pickup_health", origin: "-256 672 145", amount: "25" },
    { classname: "pickup_health", origin: "256 -672 145", amount: "25" },
    { classname: "pickup_ammo", origin: "-680 0 17", amount: "50" },
    { classname: "pickup_ammo", origin: "680 0 17", amount: "50" },
    { classname: "pickup_railgun", origin: "256 672 145" },
    { classname: "pickup_rocketlauncher", origin: "-256 -672 145" },
    { classname: "pickup_shotgun", origin: "0 400 17" },
    { classname: "pickup_shotgun", origin: "0 -400 17" },
    { classname: "pickup_grenadelauncher", origin: "-680 300 17" },
    { classname: "light", origin: "-384 0 380", light: "450" },
    { classname: "light", origin: "384 0 380", light: "450" },
    { classname: "light", origin: "0 640 380", light: "350", _color: "1 0.85 0.6" },
    { classname: "light", origin: "0 -640 380", light: "350", _color: "0.6 0.8 1" },
  ],
});
