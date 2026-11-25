/**
 * Start a throwaway site, sign the owner in, run the guide's setup, then record
 * the story. The app and the temporary database stop when the session ends,
 * whether it succeeded or not.
 */

import { withCleanup } from "#scripts/cleanup.ts";
import { withGuideBrowserPage } from "#scripts/guides/browser.ts";
import type { GuideStoryboard } from "#scripts/guides/storyboard.ts";
import type { GuideTimeline } from "#scripts/guides/timeline.ts";
import { startScreenshotAppServer } from "#scripts/screenshots/app-server.ts";
import {
  DESKTOP_SCREENSHOT_PROFILE,
  screenshotContextOptions,
} from "#scripts/screenshots/profile.ts";
import { waitForScreenshotPage } from "#scripts/screenshots/readiness.ts";
import { setUpScreenshotAdmin } from "#scripts/screenshots/setup.ts";
import { executeGuideActions } from "./actions.ts";
import { mutedRecorder, recordSession } from "./session.ts";

export const recordGuideSession = async (
  storyboard: GuideStoryboard,
  outputDir: string,
): Promise<GuideTimeline> => {
  const server = await startScreenshotAppServer();
  return withCleanup(
    () =>
      withGuideBrowserPage({
        contextOptions: {
          baseURL: server.baseUrl,
          ...screenshotContextOptions(DESKTOP_SCREENSHOT_PROFILE),
          reducedMotion: "no-preference",
        },
        run: async (page) => {
          page.setDefaultTimeout(30_000);
          page.setDefaultNavigationTimeout(60_000);
          await setUpScreenshotAdmin(page, server.baseUrl);
          await server.enableStripe();
          await executeGuideActions(
            page,
            storyboard.setup,
            mutedRecorder(DESKTOP_SCREENSHOT_PROFILE.viewport),
          );
          await page.goto(`${server.baseUrl}/admin/`, {
            waitUntil: "domcontentloaded",
          });
          await waitForScreenshotPage(page);
          return recordSession(page, {
            actions: storyboard.actions,
            fps: storyboard.fps,
            guide: { slug: storyboard.slug, title: storyboard.title },
            outputDir,
            viewport: DESKTOP_SCREENSHOT_PROFILE.viewport,
          });
        },
      }),
    [server.stop],
  );
};
