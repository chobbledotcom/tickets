import type { BrowserContextOptions } from "playwright";

export interface ScreenshotProfile {
  colorScheme: "light";
  deviceScaleFactor: number;
  locale: string;
  name: "mobile";
  reducedMotion: "reduce";
  timezoneId: string;
  viewport: { height: number; width: number };
}

export const MOBILE_SCREENSHOT_PROFILE: ScreenshotProfile = {
  colorScheme: "light",
  deviceScaleFactor: 2,
  locale: "en-GB",
  name: "mobile",
  reducedMotion: "reduce",
  timezoneId: "UTC",
  viewport: { height: 844, width: 390 },
};

export const SCREENSHOT_PROFILES = {
  mobile: MOBILE_SCREENSHOT_PROFILE,
} as const satisfies Record<string, ScreenshotProfile>;

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
