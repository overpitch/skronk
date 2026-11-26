// Starter map: Portal Gym. A tall hall with places to practise portals:
//  - a chasm too wide to jump, with a narrow bridge along the south side for
//    walking round (and stairs up out of it), and a target wall across it;
//  - a high ledge in the north-east corner you can only reach by portal (the
//    east wall above it takes portals);
//  - a fling pit with a portal floor: drop in through a portal and fly out of
//    another (stairs lead back up);
//  - portal walls at both ends of the hall.
// Generated once as a starting point; it's Dave's to edit in TrenchBroom.
import { box, N, portalOn, ramp, stairs, writeMap } from "./mapgen.mjs";

const brushes = [];
const B = (faces) => brushes.push(faces);
const T = 16; // wall thickness

// Hall interior: x -1024..1024, y -640..640, floor z 0, ceiling z 512.
const X0 = -1024, X1 = 1024, Y0 = -640, Y1 = 640, TOP = 512;
// Pits go down to here (their floors are 16 thick below).
const DEEP = -256;

// Floor, in pieces around the chasm (x -384..0, y -512..640) and the fling pit (x 256..640, y -640..-256).
const floor = (x0, y0, x1, y1) => B(box([x0, y0, -T], [x1, y1, 0], "base/floor"));
floor(X0, Y0, -384, Y1); // west: where you start
floor(-384, Y0, 0, -512); // the bridge over the chasm
floor(0, -256, X1, Y1); // east, north of the fling pit
floor(0, Y0, 256, -256); // west of the fling pit
floor(640, Y0, X1, -256); // east of the fling pit

// Ceiling and walls. Walls reach down to the pit floors so the pits are sealed.
B(box([X0 - T, Y0 - T, TOP], [X1 + T, Y1 + T, TOP + T], "base/ceiling"));
B(box([X0 - T, Y0 - T, DEEP - T], [X0, Y1 + T, TOP], portalOn([N.east], "base/wall"))); // west wall: portals
B(box([X1, Y0 - T, DEEP - T], [X1 + T, Y1 + T, TOP], portalOn([N.west], "base/wall"))); // east wall: portals
B(box([X0, Y0 - T, DEEP - T], [X1, Y0, TOP], "base/wall")); // south wall
B(box([X0, Y1, DEEP - T], [X1, Y1 + T, TOP], "base/wall")); // north wall

// The chasm: 384 across, 256 deep. Portal-friendly floor and side walls.
B(box([-384 - T, -512 - T, DEEP - T], [0 + T, Y1, DEEP], portalOn([N.up], "base/floor")));
B(box([-384 - T, -512, DEEP], [-384, Y1, 0], portalOn([N.east], "base/trim"))); // west side
B(box([0, -512, DEEP], [0 + T, Y1, 0], portalOn([N.west], "base/trim"))); // east side
B(box([-384, -512 - T, DEEP], [0, -512, 0], "base/trim")); // under the bridge
// Stairs up out of the chasm along its north side, climbing east to the floor.
for (const s of stairs({ start: [-384, 0, DEEP], up: "+x", count: 16, rise: 16, depth: 24, across: [512, Y1], tex: "base/trim" })) B(s);

// Target wall across the chasm, facing it: put a portal here and one on your side to cross.
B(box([192, -128, 0], [208, 256, 256], portalOn([N.west], "base/trim")));

// High ledge in the north-east corner, 256 up: only portals get you there. Its top takes portals too.
B(box([768, 256, 0], [X1, Y1, 256], portalOn([N.up], "base/trim")));

// The fling pit: 256 deep, a portal floor. Fall in through a portal, come out of another with all that speed.
B(box([256 - T, Y0, DEEP - T], [640 + T, -256 + T, DEEP], portalOn([N.up], "base/floor")));
B(box([256 - T, Y0, DEEP], [256, -256, 0], "base/trim")); // west side
B(box([640, Y0, DEEP], [640 + T, -256, 0], "base/trim")); // east side
B(box([256, -256, DEEP], [640, -256 + T, 0], "base/trim")); // north side
// Stairs back up along the pit's south side, climbing east.
for (const s of stairs({ start: [256, 0, DEEP], up: "+x", count: 16, rise: 16, depth: 24, across: [Y0, -544], tex: "base/trim" })) B(s);

// A ramp up to a low lookout in the start area, for shooting portals from a bit higher.
B(box([-1024, -256, 0], [-896, 256, 96], portalOn([N.up], "base/trim")));
B(ramp([-896, -256, 0], [-704, -160, 96], "-x", "base/trim", "base/floor"));

writeMap("portal_gym", {
  title: "Portal Gym",
  generator: "tools/make-portal-gym.mjs",
  starter: true,
  brushes,
  entities: [
    { classname: "player_spawn", origin: "-800 -450 25", angle: "0" },
    { classname: "player_spawn", origin: "-800 450 25", angle: "0" },
    { classname: "player_spawn", origin: "-560 0 25", angle: "0" },
    { classname: "player_spawn", origin: "480 300 25", angle: "180" },
    { classname: "pickup_ammo", origin: "-600 520 17", amount: "50" },
    { classname: "pickup_health", origin: "100 500 17", amount: "25" },
    // A reward at the bottom of the chasm.
    { classname: "pickup_armor", origin: "-192 0 -239", amount: "50" },
    { classname: "light", origin: "-640 0 420", light: "450" },
    { classname: "light", origin: "-192 100 120", light: "350", _color: "0.6 0.8 1" },
    { classname: "light", origin: "448 -100 420", light: "400" },
    { classname: "light", origin: "896 448 440", light: "300", _color: "1 0.85 0.6" },
  ],
});
