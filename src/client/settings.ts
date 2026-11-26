/**
 * Player preferences, saved per browser. Storage can be missing or blocked
 * (private windows, Xbox Edge quirks), so every access falls back to defaults.
 */
export type Difficulty = "beginner" | "easy" | "normal" | "hard";

/** Menu order, with the bot skill (0..1) each one means. */
export const DIFFICULTIES: readonly { id: Difficulty; label: string; skill: number }[] = [
  { id: "beginner", label: "Beginner", skill: 0 },
  { id: "easy", label: "Easy", skill: 0.25 },
  { id: "normal", label: "Normal", skill: 0.5 },
  { id: "hard", label: "Hard", skill: 0.85 },
];

export const MAX_BOTS = 6;

export interface Settings {
  /** Flight-stick style: mouse/stick back (down) looks up. */
  invertLook: boolean;
  /** Multiplier on the base mouse look speed. */
  mouseSensitivity: number;
  /** How sharp the bots are. */
  difficulty: Difficulty;
  /** Bots in the game; 0 gives you a practice dummy instead. */
  bots: number;
  /** Sound volume, 0..1. */
  volume: number;
  /** Map to play (file name without .map). */
  map: string;
}

export const MOUSE_SENSITIVITY_RANGE = { min: 0.2, max: 4, step: 0.05 };

const STORAGE_KEY = "skronk.settings";

export function defaultSettings(): Settings {
  return { invertLook: false, mouseSensitivity: 1, difficulty: "normal", bots: 0, volume: 1, map: "test_box" };
}

export const difficultyOf = (id: Difficulty) => DIFFICULTIES.find((d) => d.id === id) ?? DIFFICULTIES[2];

export function loadSettings(): Settings {
  const settings = defaultSettings();
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (typeof saved.invertLook === "boolean") settings.invertLook = saved.invertLook;
    const sens = saved.mouseSensitivity;
    if (typeof sens === "number" && sens >= MOUSE_SENSITIVITY_RANGE.min && sens <= MOUSE_SENSITIVITY_RANGE.max) {
      settings.mouseSensitivity = sens;
    }
    if (DIFFICULTIES.some((d) => d.id === saved.difficulty)) settings.difficulty = saved.difficulty;
    if (Number.isInteger(saved.bots) && saved.bots >= 0 && saved.bots <= MAX_BOTS) settings.bots = saved.bots;
    if (typeof saved.volume === "number" && saved.volume >= 0 && saved.volume <= 1) settings.volume = saved.volume;
    if (typeof saved.map === "string" && /^[\w-]+$/.test(saved.map)) settings.map = saved.map;
  } catch {
    // Unreadable storage: keep defaults.
  }
  return settings;
}

export function saveSettings(settings: Settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage blocked: the setting still applies for this visit.
  }
}
