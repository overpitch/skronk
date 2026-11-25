// Symlinks trenchbroom/Skronk into TrenchBroom's user games folder so edits here are live.
import { existsSync, lstatSync, mkdirSync, symlinkSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";

const src = resolve(import.meta.dirname, "../trenchbroom/Skronk");
const base =
  platform() === "darwin"
    ? join(homedir(), "Library/Application Support/TrenchBroom/games")
    : platform() === "win32"
      ? join(process.env.APPDATA ?? "", "TrenchBroom/games")
      : join(homedir(), ".TrenchBroom/games");
const dest = join(base, "Skronk");

mkdirSync(base, { recursive: true });
if (existsSync(dest) || lstatSync(dest, { throwIfNoEntry: false })) {
  console.log(`Already present: ${dest}`);
} else {
  symlinkSync(src, dest, "dir");
  console.log(`Linked ${dest} -> ${src}`);
}
console.log(`In TrenchBroom: Preferences > Games > Skronk, set Game Path to ${resolve(import.meta.dirname, "../public")}`);
