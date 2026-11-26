/** One Chromium lifecycle for the recorder and the renderer. Both need a real
 * browser for a short local job; both must close it even when the job throws. */

import {
  type Browser,
  type BrowserContextOptions,
  chromium,
  type Page,
} from "playwright";
import { defineScreenshotBrowserLauncher } from "#scripts/browser-options.ts";
import { withCleanup } from "#scripts/cleanup.ts";
import { GUIDE_DEVICE_SCALE_FACTOR } from "#scripts/guides/video.ts";
import { chromiumExecutable } from "#scripts/screenshots/browser.ts";
import { DESKTOP_SCREENSHOT_PROFILE } from "#scripts/screenshots/profile.ts";

/**
 * Chrome's screencast sends frames at the browser window's device resolution,
 * not at the page's emulated device scale. Forcing the window's scale factor is
 * therefore what gives the recorder 2x frames: the layout stays the storyboard
 * viewport, and a 1280 by 720 page arrives as 2560 by 1440 pixels with real
 * detail for the camera zoom. The window size must equal that viewport.
 */
const GUIDE_BROWSER_ARGS = [
  `--force-device-scale-factor=${GUIDE_DEVICE_SCALE_FACTOR}`,
  `--window-size=${DESKTOP_SCREENSHOT_PROFILE.viewport.width},${DESKTOP_SCREENSHOT_PROFILE.viewport.height}`,
];

export const launchGuideBrowser = defineScreenshotBrowserLauncher(
  chromium,
  chromiumExecutable,
  undefined,
  GUIDE_BROWSER_ARGS,
);

/** The renderer is screenshotted frame by frame, not screencast, so it needs no
 * forced window scale: Playwright's device scale factor already produces 2x
 * screenshots, and combining both breaks the capture. */
export const launchRenderBrowser = defineScreenshotBrowserLauncher(
  chromium,
  chromiumExecutable,
);

const withBrowserPage = async <T>(
  browser: Browser,
  task: {
    contextOptions: BrowserContextOptions;
    run: (page: Page) => Promise<T>;
  },
): Promise<T> =>
  withCleanup(async () => {
    const context = await browser.newContext(task.contextOptions);
    return withCleanup(async () => {
      const page = await context.newPage();
      return task.run(page);
    }, [() => context.close()]);
  }, [async () => await browser.close()]);

export const withGuideBrowserPage = async <T>(
  task: Parameters<typeof withBrowserPage<T>>[1],
): Promise<T> => withBrowserPage(await launchGuideBrowser(), task);

export const withRenderBrowserPage = async <T>(
  task: Parameters<typeof withBrowserPage<T>>[1],
): Promise<T> => withBrowserPage(await launchRenderBrowser(), task);
