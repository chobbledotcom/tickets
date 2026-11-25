/** Guide timelines and baselines that the guide tests build their cases from. */

import { expect } from "@std/expect";
import type { GuideFreshnessBaseline } from "#scripts/guides/baseline.ts";
import type { GuideToGrade } from "#scripts/guides/freshness.ts";
import type {
  GuideRect,
  GuideTimeline,
  GuideTimelineEvent,
} from "#scripts/guides/timeline.ts";

/** An edge hash whose leading hex digits are `digits` and the rest zero. */
export const hashOf = (digits: string): string => digits.padEnd(60, "0");

const GUIDE_SUMMARY = {
  slug: "create-a-listing",
  title: "Create a listing",
};

/** A focus keyframe that zooms the camera onto one page rectangle. */
export const focusEvent = (
  atMs: number,
  rect: GuideRect,
  scale: number,
  transitionMs: number,
): GuideTimelineEvent => ({ atMs, kind: "focus", rect, scale, transitionMs });

/** A pointer move or a click at one page point. */
export const pointerEvent = (
  kind: "click" | "cursor",
  atMs: number,
  x: number,
  y: number,
): GuideTimelineEvent => ({ atMs, kind, x, y });

/** A timeline with two frames at the desktop guide viewport. */
export const guideTimeline = (
  durationMs: number,
  events: GuideTimelineEvent[],
  secondFrameAtMs: number,
): GuideTimeline => ({
  durationMs,
  events,
  frames: [
    { atMs: 0, file: "frame-00001.jpg" },
    { atMs: secondFrameAtMs, file: "frame-00002.jpg" },
  ],
  guide: GUIDE_SUMMARY,
  schemaVersion: 1,
  viewport: { fps: 30, height: 720, width: 1280 },
});

/** A baseline recorded against the given anchors. */
export const guideBaseline = (
  anchors: Record<string, string>,
): GuideFreshnessBaseline => ({
  anchors,
  recordedCommit: "d".repeat(40),
  schemaVersion: 2,
});

/** The create-a-listing guide as the check reads it from its storyboard. */
export const LISTING_GUIDE: GuideToGrade = {
  ...GUIDE_SUMMARY,
  evidence: [
    { captureId: "listing-form", caseId: "booking.group-page-journey" },
    {
      captureId: "public-booking-page",
      caseId: "minimum-quantity.choices-skip-below-the-minimum",
    },
  ],
};

/** Expects the parser to refuse each input with a message that names why. */
export const expectEachRefused = (
  parse: (input: unknown) => unknown,
  cases: readonly (readonly [unknown, string])[],
): void => {
  for (const [input, message] of cases) {
    expect(() => parse(input)).toThrow(message);
  }
};
