import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  MOBILE_SCREENSHOT_PROFILE,
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
});
