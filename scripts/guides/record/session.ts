/**
 * Record one page session and turn it into a timeline. The recorder knows
 * nothing about the site: it runs the story actions, writes the frames Chrome
 * paints, and stores the times the renderer needs.
 */

import { join } from "@std/path";
import type { Page } from "playwright";
import type { GuideAction } from "../storyboard.ts";
import type {
  GuideFrame,
  GuideTimeline,
  GuideTimelineEvent,
} from "../timeline.ts";
import { type ActionRecorder, executeGuideActions } from "./actions.ts";
import { type Screencast, withScreencast } from "./screencast.ts";

const TAIL_MS = 800;

export interface SessionOptions {
  actions: readonly GuideAction[];
  fps: number;
  guide: { slug: string; title: string };
  outputDir: string;
  viewport: { height: number; width: number };
}

const baseRecorder = (
  viewport: { height: number; width: number },
  muted: boolean,
  now: () => number,
  events: GuideTimelineEvent[],
): ActionRecorder => ({
  cursor: { x: viewport.width / 2, y: viewport.height / 2 },
  events,
  muted,
  now,
  viewport,
});

export const mutedRecorder = (viewport: {
  height: number;
  width: number;
}): ActionRecorder => baseRecorder(viewport, true, () => 0, []);

const recorderFor = (
  screencast: Screencast,
  viewport: { height: number; width: number },
): ActionRecorder =>
  baseRecorder(viewport, false, screencast.now, [
    {
      atMs: 0,
      kind: "cursor",
      x: viewport.width / 2,
      y: viewport.height / 2,
    },
  ]);

export const timelineFor = (
  frames: readonly GuideFrame[],
  events: readonly GuideTimelineEvent[],
  options: SessionOptions,
): GuideTimeline => {
  const frameEnd = frames.at(-1)?.atMs ?? 0;
  const eventEnd = events.at(-1)?.atMs ?? 0;
  return {
    durationMs: Math.max(frameEnd, eventEnd) + TAIL_MS,
    events,
    frames,
    guide: options.guide,
    schemaVersion: 1,
    viewport: {
      fps: options.fps,
      height: options.viewport.height,
      width: options.viewport.width,
    },
  };
};

export const recordSession = async (
  page: Page,
  options: SessionOptions,
): Promise<GuideTimeline> => {
  await page.waitForTimeout(400);
  const timeline = await withScreencast(
    {
      outputDir: options.outputDir,
      page,
      viewport: options.viewport,
    },
    async (screencast) => {
      const recorder = recorderFor(screencast, options.viewport);
      await page.mouse.move(
        options.viewport.width / 2,
        options.viewport.height / 2,
      );
      await executeGuideActions(page, options.actions, recorder);
      await page.waitForTimeout(TAIL_MS);
      const frames = screencast.frames.map(({ atMs, file }) => ({
        atMs,
        file,
      }));
      return timelineFor(frames, recorder.events, options);
    },
  );
  await Deno.writeTextFile(
    join(options.outputDir, "timeline.json"),
    `${JSON.stringify(timeline, null, 2)}\n`,
  );
  return timeline;
};
