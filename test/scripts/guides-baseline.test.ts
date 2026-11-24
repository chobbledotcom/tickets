import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { toBase64 } from "#crypto/utils.ts";
import {
  type GuideFreshnessBaseline,
  parseGuideFreshnessBaseline,
} from "#scripts/guides/baseline.ts";

const baseline: GuideFreshnessBaseline = {
  anchors: [
    {
      captureId: "listing-form",
      caseId: "booking.group-page-journey",
      grayscale: toBase64(new Uint8Array(1024)),
      sha256: "a".repeat(64),
    },
  ],
  evidenceCommit: "b".repeat(40),
  guide: { slug: "create-a-listing", title: "Create a listing" },
  profile: "desktop",
  recordedCommit: "c".repeat(40),
  schemaVersion: 1,
};

describe("guide freshness baseline", () => {
  test("reads a committed baseline", () => {
    expect(parseGuideFreshnessBaseline(baseline)).toEqual(baseline);
  });

  test("rejects a baseline the check cannot compare", () => {
    const invalid = [
      [{ ...baseline, anchors: [] }, "length"],
      [{ ...baseline, profile: "tablet" }, "tablet"],
      [{ ...baseline, recordedCommit: "short" }, "recorded commit"],
      [{ ...baseline, evidenceCommit: "short" }, "evidence commit"],
      [
        {
          ...baseline,
          anchors: [{ ...baseline.anchors[0]!, sha256: "short" }],
        },
        "sha256",
      ],
      [{ ...baseline, schemaVersion: 2 }, "2"],
    ] as const;

    for (const [input, message] of invalid) {
      expect(() => parseGuideFreshnessBaseline(input)).toThrow(message);
    }
  });
});
