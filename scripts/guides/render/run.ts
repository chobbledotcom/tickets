/** Drive the renderer page one output frame at a time and keep each PNG. The
 * browser does the drawing; Deno only seeks the timeline and saves the result. */

import { join } from "@std/path";
import type { Page } from "playwright";
import { withCleanup } from "#scripts/cleanup.ts";
import { withGuideBrowserPage } from "#scripts/guides/browser.ts";
import { frameFileName } from "#scripts/guides/frame-name.ts";
import { readGuideTimeline } from "#scripts/guides/session-timeline.ts";
import type { GuideTimeline } from "#scripts/guides/timeline.ts";
import { startGuideRenderServer } from "./server.ts";

const waitForRenderer = (page: Page): Promise<unknown> =>
  page.waitForFunction(() => Reflect.get(globalThis, "rendererReady") === true);

export interface RenderInput {
  framesDir: string;
  sessionDir: string;
  timeline: GuideTimeline;
}

export interface RenderOutput {
  frameCount: number;
  framesDir: string;
}

const renderFrames = async (
  page: Page,
  timeline: GuideTimeline,
  framesDir: string,
): Promise<number> => {
  const viewport = timeline.viewport;
  const frameCount = Math.max(
    1,
    Math.ceil((timeline.durationMs / 1000) * viewport.fps),
  );
  await Deno.mkdir(framesDir, { recursive: true });
  for (let index = 0; index < frameCount; index += 1) {
    const atMs = Math.round((index * 1000) / viewport.fps);
    await page.evaluate((time) => {
      const renderAt: unknown = Reflect.get(globalThis, "renderAt");
      if (typeof renderAt !== "function") {
        throw new Error("The guide renderer page has no renderAt function");
      }
      return renderAt(time);
    }, atMs);
    const png = await page.screenshot({
      animations: "disabled",
      caret: "hide",
      clip: {
        height: viewport.height,
        width: viewport.width,
        x: 0,
        y: 0,
      },
      type: "png",
    });
    await Deno.writeFile(join(framesDir, frameFileName(index + 1, "png")), png);
  }
  return frameCount;
};

export const renderGuide = async (
  input: RenderInput,
): Promise<RenderOutput> => {
  const { timeline } = input;
  const server = await startGuideRenderServer(
    input.sessionDir,
    timeline.guide.title,
  );
  return withCleanup(
    () =>
      withGuideBrowserPage({
        contextOptions: { deviceScaleFactor: 1, viewport: timeline.viewport },
        run: async (page) => {
          page.setDefaultTimeout(60_000);
          await page.goto(server.baseUrl, { waitUntil: "domcontentloaded" });
          await waitForRenderer(page);
          const frameCount = await renderFrames(
            page,
            timeline,
            input.framesDir,
          );
          return { frameCount, framesDir: input.framesDir };
        },
      }),
    [server.close],
  );
};

export const renderGuideFromSession = async (
  sessionDir: string,
  framesDir: string,
): Promise<RenderOutput> => {
  const timeline = await readGuideTimeline(sessionDir);
  return renderGuide({ framesDir, sessionDir, timeline });
};
