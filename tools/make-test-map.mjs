// Generates public/assets/maps/test_box.map: a box room with stairs, a ramp, a
// pillar, a jumpable wall and portal-friendly east and west walls and a floor pad. It exists to test the
// loader and movement; Dave's own maps get drawn in TrenchBroom.
import { box, face, SURF_PORTAL, writeMap } from "./mapgen.mjs";

const brushes = [];
const B = (faces) => brushes.push(faces);

// Room shell: interior x,y in [-512, 512], z in [0, 384].
B(box([-528, -528, -16], [528, 528, 0], "base/floor"));
B(box([-528, -528, 384], [528, 528, 400], "base/ceiling"));
// West and east walls: the faces pointing into the room are portal-friendly.
B(box([-528, -528, 0], [-512, 528, 384], (n) => (n[0] === 1 ? ["base/portal_panel", SURF_PORTAL] : ["base/wall", 0])));
B(box([512, -528, 0], [528, 528, 384], (n) => (n[0] === -1 ? ["base/portal_panel", SURF_PORTAL] : ["base/wall", 0])));
B(box([-512, -528, 0], [512, -512, 384], "base/wall"));
B(box([-512, 512, 0], [512, 528, 384], "base/wall"));

// Floor pad in the south-west corner whose top is portal-friendly: drop through the floor.
B(box([-496, -496, 0], [-336, -336, 2], (n) => (n[2] === 1 ? ["base/portal_panel", SURF_PORTAL] : ["base/trim", 0])));

// Pillar.
B(box([-264, 136, 0], [-136, 264, 384], "base/trim"));

// Platform against the east wall, with three 16-unit steps leading up to it.
B(box([192, -512, 0], [512, -256, 64], "base/trim"));
for (let k = 1; k <= 3; k++) {
  B(box([256, -256 + (3 - k) * 32, 0], [384, -256 + (4 - k) * 32, 16 * k], "base/trim"));
}

// Ledge in the north-west corner, reached by a ramp rising 128 over 256 units.
B(box([-512, 256, 0], [-320, 512, 128], "base/trim"));
B([
  face([0, 0, -1], [0, 0, 0], "base/trim"),
  face([-1, 0, 0], [-512, 0, 0], "base/trim"),
  face([1, 0, 0], [-384, 0, 0], "base/trim"),
  face([0, 1, 0], [0, 256, 0], "base/trim"),
  face([0, -1, 2], [0, 0, 0], "base/floor"), // slope: z = y / 2
]);

// A wall too tall to step over (40) but low enough to jump (max jump ~45).
B(box([-128, 300, 0], [128, 316, 40], "base/trim"));

writeMap("test_box", {
  title: "Test Box",
  generator: "tools/make-test-map.mjs",
  brushes,
  entities: [
    { classname: "player_spawn", origin: "0 -300 25", angle: "90" },
    { classname: "player_spawn", origin: "-300 0 25", angle: "0" },
    { classname: "player_spawn", origin: "300 300 25", angle: "180" },
    { classname: "player_spawn", origin: "100 100 25", angle: "270" },
    { classname: "pickup_health", origin: "352 -384 81", amount: "25" },
    { classname: "pickup_armor", origin: "-416 384 145", amount: "50" },
    { classname: "pickup_ammo", origin: "0 400 17", amount: "50" },
    { classname: "light", origin: "0 0 320", light: "400" },
    { classname: "light", origin: "352 -384 300", light: "250", _color: "1 0.85 0.6" },
    { classname: "light", origin: "-416 384 300", light: "250", _color: "0.6 0.8 1" },
  ],
});
