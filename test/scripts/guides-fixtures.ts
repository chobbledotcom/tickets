/** Guide timelines and baselines that the guide tests build their cases from. */

import { expect } from "@std/expect";
import { toBase64 } from "#crypto/utils.ts";
import type {
  GuideBaselineAnchor,
  GuideFreshnessBaseline,
} from "#scripts/guides/baseline.ts";
import type {
  GuideRect,
  GuideTimeline,
  GuideTimelineEvent,
} from "#scripts/guides/timeline.ts";

/** A 32 by 32 greyscale thumbnail with every pixel at one shade. */
export const thumbnail = (grey: number): string =>
  toBase64(new Uint8Array(1024).fill(grey));

export const GUIDE_SUMMARY = {
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

/** A desktop baseline recorded against the given anchors. */
export const guideBaseline = (
  anchors: GuideBaselineAnchor[],
): GuideFreshnessBaseline => ({
  anchors,
  evidenceCommit: "c".repeat(40),
  guide: GUIDE_SUMMARY,
  profile: "desktop",
  recordedCommit: "d".repeat(40),
  schemaVersion: 1,
});

/** The anchor for the listing form screen, at one shade and hash letter. */
export const listingFormAnchor = (
  grey: number,
  sha: string,
): GuideBaselineAnchor => ({
  captureId: "listing-form",
  caseId: "booking.group-page-journey",
  grayscale: thumbnail(grey),
  sha256: sha.repeat(64),
});

/** Expects the parser to refuse each input with a message that names why. */
export const expectEachRefused = (
  parse: (input: unknown) => unknown,
  cases: readonly (readonly [unknown, string])[],
): void => {
  for (const [input, message] of cases) {
    expect(() => parse(input)).toThrow(message);
  }
};
