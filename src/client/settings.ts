/**
 * Player preferences, saved per browser. Storage can be missing or blocked
 * (private windows, Xbox Edge quirks), so every access falls back to defaults.
 */
export interface Settings {
  /** Flight-stick style: mouse/stick back (down) looks up. */
  invertLook: boolean;
  /** Multiplier on the base mouse look speed. */
  mouseSensitivity: number;
}

export const MOUSE_SENSITIVITY_RANGE = { min: 0.2, max: 4, step: 0.05 };

const STORAGE_KEY = "skronk.settings";

export function defaultSettings(): Settings {
  return { invertLook: false, mouseSensitivity: 1 };
}

export function loadSettings(): Settings {
  const settings = defaultSettings();
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (typeof saved.invertLook === "boolean") settings.invertLook = saved.invertLook;
    const sens = saved.mouseSensitivity;
    if (typeof sens === "number" && sens >= MOUSE_SENSITIVITY_RANGE.min && sens <= MOUSE_SENSITIVITY_RANGE.max) {
      settings.mouseSensitivity = sens;
    }
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
