/**
 * What a recorded session hands to the renderer: the frames, and the times at
 * which the camera should move and the cursor should appear. The timeline is
 * plain JSON so a failed render can be replayed without another browser run.
 */

import * as v from "valibot";
import { integerAtLeast } from "#shared/validation/number.ts";
import { parseDocument } from "./schema-parts.ts";

const WholeNumberSchema = integerAtLeast(0);
const PositiveNumberSchema = v.pipe(v.number(), v.minValue(0));
const FrameFileSchema = v.pipe(
  v.string(),
  v.regex(/^frame-\d{5}\.(jpg|webp)$/, "Invalid frame file"),
);

export interface GuideRect {
  height: number;
  width: number;
  x: number;
  y: number;
}

export interface GuideFrame {
  atMs: number;
  file: string;
}

export type GuideTimelineEvent =
  | {
      atMs: number;
      kind: "focus";
      rect: GuideRect;
      scale: number;
      transitionMs: number;
    }
  | { atMs: number; kind: "blur"; transitionMs: number }
  | { atMs: number; kind: "cursor"; x: number; y: number }
  | { atMs: number; kind: "click"; x: number; y: number }
  | { atMs: number; captureId: string; kind: "evidence" };

export interface GuideTimeline {
  durationMs: number;
  events: readonly GuideTimelineEvent[];
  frames: readonly GuideFrame[];
  guide: { slug: string; title: string };
  schemaVersion: 1;
  viewport: { fps: number; height: number; width: number };
}

const RectSchema = v.strictObject({
  height: v.pipe(v.number(), v.minValue(0)),
  width: v.pipe(v.number(), v.minValue(0)),
  x: v.number(),
  y: v.number(),
});

/* jscpd:ignore-start -- the event table is static data, one shape per event */
const EventSchema: v.GenericSchema<GuideTimelineEvent> = v.variant("kind", [
  v.strictObject({
    atMs: WholeNumberSchema,
    kind: v.literal("focus"),
    rect: RectSchema,
    scale: v.pipe(v.number(), v.minValue(0.1), v.maxValue(5)),
    transitionMs: WholeNumberSchema,
  }),
  v.strictObject({
    atMs: WholeNumberSchema,
    kind: v.literal("blur"),
    transitionMs: WholeNumberSchema,
  }),
  v.strictObject({
    atMs: WholeNumberSchema,
    kind: v.literal("cursor"),
    x: PositiveNumberSchema,
    y: PositiveNumberSchema,
  }),
  v.strictObject({
    atMs: WholeNumberSchema,
    kind: v.literal("click"),
    x: PositiveNumberSchema,
    y: PositiveNumberSchema,
  }),
  v.strictObject({
    atMs: WholeNumberSchema,
    captureId: v.pipe(v.string(), v.nonEmpty()),
    kind: v.literal("evidence"),
  }),
]);
/* jscpd:ignore-end */

const isOrdered = (times: readonly number[]): boolean =>
  times.every((time, index) => index === 0 || time >= times[index - 1]!);

/* jscpd:ignore-start -- the timeline document is static data */
const TimelineSchema = v.strictObject({
  durationMs: WholeNumberSchema,
  events: v.pipe(
    v.array(EventSchema),
    v.check(
      (events) => isOrdered(events.map(({ atMs }) => atMs)),
      "Timeline events must be in time order",
    ),
  ),
  frames: v.pipe(
    v.array(
      v.strictObject({
        atMs: WholeNumberSchema,
        file: FrameFileSchema,
      }),
    ),
    v.minLength(1),
    v.check(
      (frames) => frames.length === 0 || frames[0]!.atMs === 0,
      "The first frame must sit at the start of the video",
    ),
    v.check(
      (frames) => isOrdered(frames.map(({ atMs }) => atMs)),
      "Timeline frames must be in time order",
    ),
  ),
  guide: v.strictObject({
    slug: v.pipe(v.string(), v.nonEmpty()),
    title: v.pipe(v.string(), v.nonEmpty()),
  }),
  schemaVersion: v.literal(1),
  viewport: v.strictObject({
    fps: v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(60)),
    height: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
    width: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  }),
});
/* jscpd:ignore-end */

export const parseGuideTimeline = (input: unknown): GuideTimeline =>
  parseDocument({ input, schema: TimelineSchema });

/** The frame that is showing at a time: the last one at or before it. */
export const frameAt = (
  frames: readonly GuideFrame[],
  atMs: number,
): GuideFrame => {
  let showing = frames[0]!;
  for (const frame of frames) {
    if (frame.atMs > atMs) break;
    showing = frame;
  }
  return showing;
};
