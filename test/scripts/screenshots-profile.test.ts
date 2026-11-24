import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  DESKTOP_SCREENSHOT_PROFILE,
  MOBILE_SCREENSHOT_PROFILE,
  SCREENSHOT_PROFILES,
  screenshotContextOptions,
} from "#scripts/screenshots/profile.ts";

describe("screenshot browser profile", () => {
  test("uses the deterministic settings at each profile's viewport", () => {
    const settings = (
      deviceScaleFactor: number,
      viewport: { height: number; width: number },
    ) => ({
      colorScheme: "light",
      deviceScaleFactor,
      locale: "en-GB",
      reducedMotion: "reduce",
      timezoneId: "UTC",
      viewport,
    });
    expect(screenshotContextOptions(MOBILE_SCREENSHOT_PROFILE)).toEqual(
      settings(2, { height: 844, width: 390 }),
    );
    expect(screenshotContextOptions(DESKTOP_SCREENSHOT_PROFILE)).toEqual(
      settings(1, { height: 720, width: 1280 }),
    );
    expect(Object.keys(SCREENSHOT_PROFILES)).toEqual(["desktop", "mobile"]);
  });
});
