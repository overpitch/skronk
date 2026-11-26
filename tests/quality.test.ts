import { describe, expect, it } from "vitest";
import { autoQuality, chooseQuality, QUALITY } from "../src/render/quality";

const MAC_CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const XBOX_EDGE =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; Xbox; Xbox Series X) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

describe("graphics quality", () => {
  it("picks Full for a capable computer", () => {
    expect(autoQuality({ userAgent: MAC_CHROME, cores: 10, memoryGB: 8, touchPoints: 0 }).mode).toBe("full");
  });

  it("picks Light for the Xbox, phones, and weak machines", () => {
    expect(autoQuality({ userAgent: XBOX_EDGE, cores: 8, memoryGB: 8 })).toEqual({ mode: "light", reason: "Xbox" });
    expect(autoQuality({ userAgent: IPHONE }).mode).toBe("light");
    expect(autoQuality({ userAgent: MAC_CHROME, cores: 4, memoryGB: 8 }).mode).toBe("light");
    expect(autoQuality({ userAgent: MAC_CHROME, cores: 8, memoryGB: 4 }).mode).toBe("light");
  });

  it("uses the menu's choice over Auto", () => {
    expect(chooseQuality("light", { userAgent: MAC_CHROME, cores: 10 }).profile).toBe(QUALITY.light);
    expect(chooseQuality("full", { userAgent: XBOX_EDGE }).profile).toBe(QUALITY.full);
  });

  it("only differs in looks: Full is at least as good as Light everywhere", () => {
    const { full, light } = QUALITY;
    expect(full.maxPixelRatio).toBeGreaterThanOrEqual(light.maxPixelRatio);
    expect(full.anisotropy).toBeGreaterThanOrEqual(light.anisotropy);
    expect(full.maxLights).toBeGreaterThanOrEqual(light.maxLights);
    expect(full.maxPortalViews).toBeGreaterThanOrEqual(light.maxPortalViews);
    expect(full.portalViewScale).toBeGreaterThanOrEqual(light.portalViewScale);
  });
});
