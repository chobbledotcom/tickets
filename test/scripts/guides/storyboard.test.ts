import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  parseGuideStoryboard,
  storyboardEvidence,
} from "#scripts/guides/storyboard.ts";

const storyboard = {
  actions: [
    { kind: "open", path: "/admin/" },
    { kind: "click", selector: "a[href='/admin/listing/new']" },
    {
      kind: "type",
      perCharacterMs: 70,
      selector: "input[name='name']",
      text: "Pottery",
    },
    {
      captureId: "listing-form",
      caseId: "booking.group-page-journey",
      kind: "evidence",
    },
  ],
  fps: 30,
  setup: [{ kind: "wait", ms: 100 }],
  slug: "create-a-listing",
  title: "Create a listing",
};

describe("guide storyboard", () => {
  test("reads a complete storyboard and lists its evidence once", () => {
    const parsed = parseGuideStoryboard(storyboard);

    expect(parsed.slug).toBe("create-a-listing");
    expect(storyboardEvidence(parsed)).toEqual([
      {
        captureId: "listing-form",
        caseId: "booking.group-page-journey",
      },
    ]);
  });

  test("rejects a storyboard that cannot be measured", () => {
    const invalid = [
      [{ ...storyboard, actions: [] }, "length"],
      [{ ...storyboard, actions: [{ kind: "wait", ms: 10 }] }, "evidence"],
      [
        { ...storyboard, setup: storyboard.actions },
        "setup cannot declare evidence",
      ],
      [
        {
          ...storyboard,
          actions: [storyboard.actions[3], storyboard.actions[3]],
        },
        "same evidence capture twice",
      ],
      [
        {
          ...storyboard,
          actions: [{ kind: "open", path: "admin/listing" }],
        },
        "whole address",
      ],
      [
        {
          ...storyboard,
          actions: [{ kind: "focus", selector: " " }],
        },
        "Invalid",
      ],
      [{ ...storyboard, slug: "Create A Listing" }, "Invalid stable id"],
      [{ ...storyboard, fps: 0 }, "Invalid"],
      [
        {
          ...storyboard,
          actions: [{ deltaY: 1e6, kind: "scroll" }],
        },
        "Invalid",
      ],
    ] as const;

    for (const [input, message] of invalid) {
      expect(() => parseGuideStoryboard(input)).toThrow(message);
    }
  });
});
