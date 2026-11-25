import type { BrowserContextOptions } from "playwright";

export const SCREENSHOT_PROFILE_NAMES = ["mobile", "desktop"] as const;
export type ScreenshotProfileName = (typeof SCREENSHOT_PROFILE_NAMES)[number];

export interface ScreenshotProfile {
  colorScheme: "light";
  deviceScaleFactor: number;
  locale: string;
  name: ScreenshotProfileName;
  reducedMotion: "reduce";
  timezoneId: string;
  viewport: { height: number; width: number };
}

const profile = (
  name: ScreenshotProfileName,
  deviceScaleFactor: number,
  height: number,
  width: number,
): ScreenshotProfile => ({
  colorScheme: "light",
  deviceScaleFactor,
  locale: "en-GB",
  name,
  reducedMotion: "reduce",
  timezoneId: "UTC",
  viewport: { height, width },
});

export const MOBILE_SCREENSHOT_PROFILE = profile("mobile", 2, 844, 390);

/** The viewport a tutorial video is recorded at. Evidence anchors use the same
 * shape, so a guide frame and its reference differ only by what the app shows. */
export const DESKTOP_SCREENSHOT_PROFILE = profile("desktop", 1, 720, 1280);

export const SCREENSHOT_PROFILES = {
  desktop: DESKTOP_SCREENSHOT_PROFILE,
  mobile: MOBILE_SCREENSHOT_PROFILE,
} as const satisfies Record<ScreenshotProfileName, ScreenshotProfile>;

export const screenshotContextOptions = (
  profile: ScreenshotProfile,
): BrowserContextOptions => ({
  colorScheme: profile.colorScheme,
  deviceScaleFactor: profile.deviceScaleFactor,
  locale: profile.locale,
  reducedMotion: profile.reducedMotion,
  timezoneId: profile.timezoneId,
  viewport: profile.viewport,
});
