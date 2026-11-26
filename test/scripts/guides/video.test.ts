import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  GUIDE_DEVICE_SCALE_FACTOR,
  GUIDE_PIPELINE_VERSION,
  guideVideoInputsHash,
  guideVideoObjectPath,
  guideVideoPointerPath,
  parseGuideVideoPointer,
} from "#scripts/guides/video.ts";

const INPUTS = {
  anchors: { "capture-one": "a".repeat(60), "capture-two": "b".repeat(60) },
  slug: "create-a-listing",
  storyboard: '{"slug":"create-a-listing"}',
};

describe("guideVideoInputsHash", () => {
  test("is the same for the same inputs in any anchor order", async () => {
    const reversed = {
      ...INPUTS,
      anchors: { "capture-one": "a".repeat(60), "capture-two": "b".repeat(60) },
    };
    expect(await guideVideoInputsHash(INPUTS)).toBe(
      await guideVideoInputsHash(reversed),
    );
    expect(await guideVideoInputsHash(INPUTS)).toMatch(/^[a-f0-9]{16}$/);
  });

  test("changes with an anchored screenshot", async () => {
    const changed = {
      ...INPUTS,
      anchors: { ...INPUTS.anchors, "capture-one": "c".repeat(60) },
    };
    expect(await guideVideoInputsHash(INPUTS)).not.toBe(
      await guideVideoInputsHash(changed),
    );
  });

  test("changes with the storyboard and with the pipeline version", async () => {
    const base = await guideVideoInputsHash(INPUTS);
    expect(
      await guideVideoInputsHash({ ...INPUTS, storyboard: "{}" }),
    ).not.toBe(base);
    expect(GUIDE_PIPELINE_VERSION).toBe(2);
  });
});

describe("guideVideoObjectPath", () => {
  test("names the object after the content hash", () => {
    expect(guideVideoObjectPath("create-a-listing", "0123456789abcdef00")).toBe(
      "guides/create-a-listing-0123456789abcdef.mp4",
    );
  });
});

describe("guideVideoPointerPath", () => {
  test("keys the pointer by the inputs hash", () => {
    expect(guideVideoPointerPath("create-a-listing", "0123456789abcdef")).toBe(
      "guides/pointers/create-a-listing-0123456789abcdef.json",
    );
  });
});

describe("parseGuideVideoPointer", () => {
  test("reads a written pointer", () => {
    expect(
      parseGuideVideoPointer({
        inputs: "0123456789abcdef",
        schemaVersion: 1,
        video: "guides/create-a-listing-0123456789abcdef.mp4",
      }),
    ).toEqual({
      inputs: "0123456789abcdef",
      schemaVersion: 1,
      video: "guides/create-a-listing-0123456789abcdef.mp4",
    });
  });

  test("rejects a pointer that names another object or schema", () => {
    for (const pointer of [
      {
        inputs: "0123456789abcdef",
        schemaVersion: 1,
        video: "guides/create-a-listing.mp4",
      },
      {
        inputs: "0123456789abcdef",
        schemaVersion: 2,
        video: "guides/create-a-listing-0123456789abcdef.mp4",
      },
      {
        inputs: "abc",
        schemaVersion: 1,
        video: "guides/x-0123456789abcdef.mp4",
      },
    ]) {
      expect(() => parseGuideVideoPointer(pointer)).toThrow();
    }
  });
});

describe("GUIDE_DEVICE_SCALE_FACTOR", () => {
  test("matches the 2x zoom headroom the storyboards use", () => {
    expect(GUIDE_DEVICE_SCALE_FACTOR).toBe(2);
  });
});
