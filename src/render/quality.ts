/**
 * Graphics quality. Two modes: Full for a strong computer, Light for the Xbox
 * and weaker machines. Only how things look changes between them; the game
 * itself (maps, movement, bots, weapons, portals) is the same in both, so it
 * stays fair and network play keeps working.
 *
 * Every visual feature reads its numbers from the profile here, and anything
 * Full-only (shadows from the map's lights, so far) is switched by it. New visual features add a field
 * with a value for each mode.
 */
export type QualityMode = "full" | "light";
/** The menu setting: a mode, or let the game pick. */
export type QualitySetting = "auto" | QualityMode;

export interface QualityProfile {
  mode: QualityMode;
  /** Most screen pixels per CSS pixel (sharpness on high-density displays). */
  maxPixelRatio: number;
  /** Smoothed edges (multisampling). Fixed when the graphics start up. */
  antialias: boolean;
  /** Texture sharpness at grazing angles (anisotropic filtering), capped by the GPU. */
  anisotropy: number;
  /** Map light entities used (each costs every pixel). */
  maxLights: number;
  /** Shadows at all. */
  shadows: boolean;
  /** How many of the map's lights cast shadows (the first ones in the map). */
  shadowLights: number;
  /** Shadow map size in texels (each side of each cube face). */
  shadowMapSize: number;
  /** Portal views drawn per frame, nearest first; others show their swirl. */
  maxPortalViews: number;
  /** Portal view resolution as a fraction of the screen's. */
  portalViewScale: number;
  /** Smoothed edges inside portal views (samples; 0 for none). */
  portalSamples: number;
}

export const QUALITY: Record<QualityMode, QualityProfile> = {
  full: {
    mode: "full",
    maxPixelRatio: 2,
    antialias: true,
    anisotropy: 16,
    maxLights: 8,
    shadows: true,
    shadowLights: 2,
    shadowMapSize: 1024,
    maxPortalViews: 4,
    portalViewScale: 1,
    portalSamples: 4,
  },
  light: {
    mode: "light",
    maxPixelRatio: 1,
    antialias: false,
    anisotropy: 4,
    maxLights: 4,
    shadows: false,
    shadowLights: 0,
    shadowMapSize: 0,
    maxPortalViews: 2,
    portalViewScale: 0.5,
    portalSamples: 0,
  },
};

export interface DeviceInfo {
  userAgent: string;
  /** Logical CPU cores, if the browser says. */
  cores?: number;
  /** Device memory in GB, if the browser says (Chromium rounds it, max 8). */
  memoryGB?: number;
  /** Touch points: phones and tablets have some. */
  touchPoints?: number;
}

/**
 * Picks a mode for this device when the setting is Auto: Light for the Xbox,
 * phones and tablets, and machines with few cores or little memory; Full otherwise.
 * Returns the reason too, for the menu.
 */
export function autoQuality(device: DeviceInfo): { mode: QualityMode; reason: string } {
  const ua = device.userAgent;
  if (/xbox/i.test(ua)) return { mode: "light", reason: "Xbox" };
  if (/android|iphone|ipad|mobile/i.test(ua) || (device.touchPoints ?? 0) > 1) return { mode: "light", reason: "phone or tablet" };
  if (device.cores !== undefined && device.cores <= 4) return { mode: "light", reason: `${device.cores} CPU cores` };
  if (device.memoryGB !== undefined && device.memoryGB < 8) return { mode: "light", reason: `${device.memoryGB} GB memory` };
  return { mode: "full", reason: "capable computer" };
}

/** The profile to use: the setting, or Auto's pick for this device. */
export function chooseQuality(setting: QualitySetting, device: DeviceInfo): { profile: QualityProfile; reason: string } {
  if (setting !== "auto") return { profile: QUALITY[setting], reason: "chosen in the menu" };
  const { mode, reason } = autoQuality(device);
  return { profile: QUALITY[mode], reason: `auto: ${reason}` };
}

/** What the browser says about this device. */
export function browserDevice(): DeviceInfo {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return { userAgent: nav.userAgent, cores: nav.hardwareConcurrency, memoryGB: nav.deviceMemory, touchPoints: nav.maxTouchPoints };
}
