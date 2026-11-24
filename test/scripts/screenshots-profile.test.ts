import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  DESKTOP_SCREENSHOT_PROFILE,
  MOBILE_SCREENSHOT_PROFILE,
  SCREENSHOT_PROFILES,
  screenshotContextOptions,
} from "#scripts/screenshots/profile.ts";

describe("screenshot browser profile", () => {
  test("uses the deterministic mobile settings", () => {
    expect(screenshotContextOptions(MOBILE_SCREENSHOT_PROFILE)).toEqual({
      colorScheme: "light",
      deviceScaleFactor: 2,
      locale: "en-GB",
      reducedMotion: "reduce",
      timezoneId: "UTC",
      viewport: { height: 844, width: 390 },
    });
  });

  test("uses the desktop viewport a guide video records at", () => {
    expect(screenshotContextOptions(DESKTOP_SCREENSHOT_PROFILE)).toEqual({
      colorScheme: "light",
      deviceScaleFactor: 1,
      locale: "en-GB",
      reducedMotion: "reduce",
      timezoneId: "UTC",
      viewport: { height: 720, width: 1280 },
    });
    expect(Object.keys(SCREENSHOT_PROFILES)).toEqual(["desktop", "mobile"]);
  });
});
