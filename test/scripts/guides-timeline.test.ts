import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  frameAt,
  type GuideTimeline,
  parseGuideTimeline,
} from "#scripts/guides/timeline.ts";

const timeline: GuideTimeline = {
  durationMs: 3000,
  events: [
    { atMs: 0, kind: "cursor", x: 10, y: 20 },
    { atMs: 500, kind: "click", x: 10, y: 20 },
    {
      atMs: 1000,
      kind: "focus",
      rect: { height: 100, width: 200, x: 10, y: 20 },
      scale: 0.7,
      transitionMs: 900,
    },
    { atMs: 2000, kind: "blur", transitionMs: 900 },
    { atMs: 2500, captureId: "listing-form", kind: "evidence" },
  ],
  frames: [
    { atMs: 0, file: "frame-00001.jpg" },
    { atMs: 500, file: "frame-00002.jpg" },
  ],
  guide: { slug: "create-a-listing", title: "Create a listing" },
  schemaVersion: 1,
  viewport: { fps: 30, height: 720, width: 1280 },
};

describe("guide timeline", () => {
  test("reads a recorded timeline and finds the showing frame", () => {
    const parsed = parseGuideTimeline(timeline);

    expect(parsed.frames).toHaveLength(2);
    expect(frameAt(parsed.frames, 0).file).toBe("frame-00001.jpg");
    expect(frameAt(parsed.frames, 499).file).toBe("frame-00001.jpg");
    expect(frameAt(parsed.frames, 500).file).toBe("frame-00002.jpg");
    expect(frameAt(parsed.frames, 9999).file).toBe("frame-00002.jpg");
  });

  test("rejects a timeline the renderer cannot replay", () => {
    const invalid = [
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
    ] as const;

    for (const [input, message] of invalid) {
      expect(() => parseGuideTimeline(input)).toThrow(message);
    }
  });
});
