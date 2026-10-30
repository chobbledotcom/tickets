import type { Browser, chromium, LaunchOptions } from "playwright";

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

/** Fast actions on a contract page must fail fast. The contract app runs on a
 * local loopback server, so a click, a fill, or a navigation answers in
 * milliseconds; a page that does not answer has a broken browser, and the
 * suite must report it instead of burning the job's cap on a hang. */
const STRICT_ACTION_TIMEOUT_MS = 10_000;
const STRICT_NAVIGATION_TIMEOUT_MS = 15_000;

/** A BrowserContext or a Page: the two timeout setters both accept. */
export type BrowserTimeoutTarget = {
  setDefaultNavigationTimeout(timeout: number): void;
  setDefaultTimeout(timeout: number): void;
};

/** Bounds the fast actions on a contract page, so a hung browser fails at
 * once instead of waiting out Playwright's 30-second default on every
 * action. Set it on the context before its first page, or on the page
 * itself: a page with no own setting falls back to its context's setting. */
export const withStrictBrowserTimeouts = (
  target: BrowserTimeoutTarget,
): void => {
  target.setDefaultTimeout(STRICT_ACTION_TIMEOUT_MS);
  target.setDefaultNavigationTimeout(STRICT_NAVIGATION_TIMEOUT_MS);
};

/** Launch Chromium with screenshot-mode flags (headless, CDP screenshot fix). */
const launchScreenshotChromium = (
  browser: Chromium,
  executablePath?: string,
  overrides: Pick<LaunchOptions, "ignoreDefaultArgs"> = {},
): Promise<Browser> =>
  browser.launch({
    ...browserLaunchOptions(true, executablePath, SCREENSHOT_LAUNCH_ARGS),
    ...overrides,
  });

export const defineScreenshotBrowserLauncher =
  (
    browser: Chromium,
    executablePath: () => Promise<string | undefined>,
    overrides?: Pick<LaunchOptions, "ignoreDefaultArgs">,
  ): (() => Promise<Browser>) =>
  async () =>
    launchScreenshotChromium(browser, await executablePath(), overrides);
