import type { chromium, LaunchOptions } from "playwright";

type Chromium = typeof chromium;

const SCREENSHOT_LAUNCH_ARGS = ["--disable-features=CDPScreenshotNewSurface"];

export const browserLaunchOptions = (
  headless: boolean,
  executablePath?: string,
  args?: string[],
): LaunchOptions => ({
  ...(args ? { args } : {}),
  ...(executablePath ? { executablePath } : {}),
  headless,
});

/** Launch Chromium with screenshot-mode flags (headless, CDP screenshot fix). */
export const launchScreenshotChromium = (
  browser: Chromium,
  executablePath?: string,
) =>
  browser.launch(
    browserLaunchOptions(true, executablePath, SCREENSHOT_LAUNCH_ARGS),
  );
