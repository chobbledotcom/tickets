import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  buildFreshnessReport,
  freshnessReportLines,
  GUIDE_WARN_BELOW_PERCENT,
  type GuideFreshness,
  gradeGuide,
  staleGuides,
  statusForPercent,
} from "#scripts/guides/freshness.ts";
import { guideBaseline, hashOf, LISTING_GUIDE } from "./fixtures.ts";

const baseline = guideBaseline({
  "listing-form": hashOf("f"),
  "public-booking-page": hashOf("f"),
});

/** The create-a-listing guide with its listing form anchor at one score. */
const listingGuideAt = (
  anchorPercent: number,
  guidePercent: number,
): GuideFreshness => ({
  anchors: [
    {
      captureId: "listing-form",
      caseId: "booking.group-page-journey",
      percent: anchorPercent,
      status: statusForPercent(anchorPercent),
    },
  ],
  percent: guidePercent,
  slug: "create-a-listing",
  status: statusForPercent(guidePercent),
  title: "Create a listing",
});

describe("guide freshness", () => {
  test("grades each anchor and the guide", () => {
    const result = gradeGuide(LISTING_GUIDE, baseline, {
      "listing-form": hashOf("f"),
      "public-booking-page": hashOf("0f"),
    });

    expect(result.percent).toBe(50);
    expect(result.status).toBe("stale");
    expect(result.anchors).toEqual([
      {
        captureId: "listing-form",
        caseId: "booking.group-page-journey",
        percent: 100,
        status: "fresh",
      },
      {
        captureId: "public-booking-page",
        caseId: "minimum-quantity.choices-skip-below-the-minimum",
        percent: 0,
        status: "stale",
      },
    ]);
  });

  test("names a capture the evidence run no longer produces", () => {
    expect(() =>
      gradeGuide(LISTING_GUIDE, baseline, { "listing-form": hashOf("f") }),
    ).toThrow(
      "No evidence capture public-booking-page for guide create-a-listing",
    );
  });

  test("asks for a new recording when the storyboard and baseline differ", () => {
    const current = {
      "listing-form": hashOf("f"),
      "public-booking-page": hashOf("f"),
    };
    expect(() =>
      gradeGuide(
        LISTING_GUIDE,
        guideBaseline({ "listing-form": hashOf("f") }),
        current,
      ),
    ).toThrow(
      "The baseline for create-a-listing has no public-booking-page. Record the guide again.",
    );
    expect(() =>
      gradeGuide(
        LISTING_GUIDE,
        guideBaseline({ ...baseline.anchors, "old-page": hashOf("f") }),
        current,
      ),
    ).toThrow(
      "The baseline for create-a-listing names old-page, which the storyboard no longer uses. Record the guide again.",
    );
  });

  test("reports the guide and the overall score", () => {
    const report = buildFreshnessReport([
      listingGuideAt(100, 100),
      {
        anchors: [],
        percent: 50,
        slug: "manage-listings",
        status: "stale",
        title: "Manage listings",
      },
    ]);

    expect(report.overallPercent).toBe(75);
    expect(report.warnBelowPercent).toBe(GUIDE_WARN_BELOW_PERCENT);
    expect(staleGuides(report).map(({ guide }) => guide.slug)).toEqual([
      "manage-listings",
    ]);
    expect(freshnessReportLines(report)).toEqual([
      "Guide freshness against the Cucumber evidence",
      "",
      "create-a-listing  100%  fresh  (Create a listing)",
      "  listing-form  100%  fresh  (booking.group-page-journey)",
      "manage-listings  50%  stale  (Manage listings)",
      "",
      "Overall 75%  (warn below 80%)",
    ]);
  });

  test("refuses a report without guides", () => {
    expect(() => buildFreshnessReport([])).toThrow(
      "A score needs at least one value",
    );
  });

  test("needs attention when one anchor falls below the line", () => {
    const report = buildFreshnessReport([listingGuideAt(73, 87)]);
    const attention = staleGuides(report);

    expect(attention).toHaveLength(1);
    expect(attention[0]?.guide.percent).toBe(87);
    expect(attention[0]?.anchors.map(({ captureId }) => captureId)).toEqual([
      "listing-form",
    ]);
  });

  test("marks the warning boundary exactly", () => {
    const boundaries = [
      [99, "fresh"],
      [98, "aging"],
      [80, "aging"],
      [79, "stale"],
    ] as const;
    for (const [percent, status] of boundaries) {
      expect(statusForPercent(percent)).toBe(status);
    }
  });
});
