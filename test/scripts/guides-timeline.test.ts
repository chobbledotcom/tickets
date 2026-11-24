import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { frameAt, parseGuideTimeline } from "#scripts/guides/timeline.ts";
import {
  expectEachRefused,
  focusEvent,
  guideTimeline,
  pointerEvent,
} from "./guides-fixtures.ts";

const timeline = guideTimeline(
  3000,
  [
    pointerEvent("cursor", 0, 10, 20),
    pointerEvent("click", 500, 10, 20),
    focusEvent(1000, { height: 100, width: 200, x: 10, y: 20 }, 0.7, 900),
    { atMs: 2000, kind: "blur", transitionMs: 900 },
    { atMs: 2500, captureId: "listing-form", kind: "evidence" },
  ],
  500,
);

describe("guide timeline", () => {
  test("reads a recorded timeline and finds the showing frame", () => {
    const parsed = parseGuideTimeline(timeline);

    expect(parsed.frames).toHaveLength(2);
    expect(
      [0, 499, 500, 9999].map((atMs) => frameAt(parsed.frames, atMs).file),
    ).toEqual([
      "frame-00001.jpg",
      "frame-00001.jpg",
      "frame-00002.jpg",
      "frame-00002.jpg",
    ]);
  });

  test("rejects a timeline the renderer cannot replay", () => {
    expectEachRefused(parseGuideTimeline, [
      [{ ...timeline, frames: [] }, "length"],
      [
        {
          ...timeline,
          frames: [{ atMs: 100, file: "frame-00001.jpg" }],
        },
        "start",
      ],
      [
        {
          ...timeline,
          frames: [
            { atMs: 0, file: "frame-00001.jpg" },
            { atMs: 100, file: "frame-00002.jpg" },
            { atMs: 50, file: "frame-00003.jpg" },
          ],
        },
        "time order",
      ],
      [
        {
          ...timeline,
          events: [
            { atMs: 10, kind: "cursor", x: 1, y: 2 },
            { atMs: 5, kind: "cursor", x: 3, y: 4 },
          ],
        },
        "time order",
      ],
      [
        {
          ...timeline,
          frames: [{ atMs: 0, file: "frame.png" }],
        },
        "frame file",
      ],
      [{ ...timeline, viewport: { ...timeline.viewport, fps: 0 } }, "Invalid"],
      [{ ...timeline, schemaVersion: 2 }, "2"],
    ]);
  });
});
