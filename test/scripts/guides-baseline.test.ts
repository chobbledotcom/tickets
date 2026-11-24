import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { parseGuideFreshnessBaseline } from "#scripts/guides/baseline.ts";
import {
  expectEachRefused,
  guideBaseline,
  listingFormAnchor,
} from "./guides-fixtures.ts";

const baseline = guideBaseline([listingFormAnchor(0, "a")]);

describe("guide freshness baseline", () => {
  test("reads a committed baseline", () => {
    expect(parseGuideFreshnessBaseline(baseline)).toEqual(baseline);
  });

  test("rejects a baseline the check cannot compare", () => {
    expectEachRefused(parseGuideFreshnessBaseline, [
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
    ]);
  });
});
