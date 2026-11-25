import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { parseGuideFreshnessBaseline } from "#scripts/guides/baseline.ts";
import { expectEachRefused, guideBaseline, hashOf } from "./fixtures.ts";

const baseline = guideBaseline({ "listing-form": hashOf("8") });

describe("guide freshness baseline", () => {
  test("reads a committed baseline", () => {
    expect(parseGuideFreshnessBaseline(baseline)).toEqual(baseline);
  });

  test("reads the committed create-a-listing baseline", async () => {
    const committed = parseGuideFreshnessBaseline(
      JSON.parse(
        await Deno.readTextFile("guides/create-a-listing/freshness.json"),
      ),
    );
    expect(Object.keys(committed.anchors)).toEqual([
      "listing-form",
      "public-booking-page",
    ]);
  });

  test("rejects a baseline the check cannot compare", () => {
    expectEachRefused(parseGuideFreshnessBaseline, [
      [{ ...baseline, anchors: {} }, "at least one anchor"],
      [{ ...baseline, anchors: { "Not An Id": hashOf("8") } }, "stable id"],
      [{ ...baseline, anchors: { "listing-form": "short" } }, "edge hash"],
      [{ ...baseline, recordedCommit: "short" }, "recorded commit"],
      [{ ...baseline, profile: "desktop" }, "profile"],
      [{ ...baseline, schemaVersion: 1 }, "2"],
    ]);
  });
});
