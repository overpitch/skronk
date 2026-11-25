/**
 * Player preferences, saved per browser. Storage can be missing or blocked
 * (private windows, Xbox Edge quirks), so every access falls back to defaults.
 */
export interface Settings {
  /** Flight-stick style: mouse/stick back (down) looks up. */
  invertLook: boolean;
}

const STORAGE_KEY = "skronk.settings";

export function defaultSettings(): Settings {
  return { invertLook: false };
}

export function loadSettings(): Settings {
  const settings = defaultSettings();
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (typeof saved.invertLook === "boolean") settings.invertLook = saved.invertLook;
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
