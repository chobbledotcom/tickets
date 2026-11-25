/** One Chromium lifecycle for the recorder and the renderer. Both need a real
 * browser for a short local job; both must close it even when the job throws. */

import { type BrowserContextOptions, chromium, type Page } from "playwright";
import { defineScreenshotBrowserLauncher } from "#scripts/browser-options.ts";
import { withCleanup } from "#scripts/cleanup.ts";
import { chromiumExecutable } from "#scripts/screenshots/browser.ts";

export const launchGuideBrowser = defineScreenshotBrowserLauncher(
  chromium,
  chromiumExecutable,
);

export const withGuideBrowserPage = async <T>(task: {
  contextOptions: BrowserContextOptions;
  run: (page: Page) => Promise<T>;
}): Promise<T> => {
  const browser = await launchGuideBrowser();
  return withCleanup(async () => {
    const context = await browser.newContext(task.contextOptions);
    return withCleanup(async () => {
      const page = await context.newPage();
      return task.run(page);
    }, [() => context.close()]);
  }, [async () => await browser.close()]);
};
