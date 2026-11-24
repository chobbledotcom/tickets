/** Drive the renderer page one output frame at a time and keep each PNG. The
 * browser does the drawing; Deno only seeks the timeline and saves the result. */

import { join } from "@std/path";
import type { Page } from "playwright";
import { withCleanup } from "#scripts/cleanup.ts";
import { withGuideBrowserPage } from "../browser.ts";
import { type GuideTimeline, parseGuideTimeline } from "../timeline.ts";
import { startGuideRenderServer } from "./server.ts";

interface RendererWindow {
  renderAt: (atMs: number) => Promise<unknown>;
  rendererReady: boolean;
}

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
    await page.evaluate(
      (time) => (globalThis as unknown as RendererWindow).renderAt(time),
      atMs,
    );
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
    await Deno.writeFile(
      join(framesDir, `frame-${String(index + 1).padStart(5, "0")}.png`),
      png,
    );
  }
  return frameCount;
};

export const renderGuide = async (
  input: RenderInput,
): Promise<RenderOutput> => {
  const { timeline } = input;
  const server = await startGuideRenderServer(
    input.sessionDir,
    timeline.viewport,
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
  const timeline = parseGuideTimeline(
    JSON.parse(await Deno.readTextFile(join(sessionDir, "timeline.json"))),
  );
  return renderGuide({ framesDir, sessionDir, timeline });
};
