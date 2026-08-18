import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type AdminAreasSpec,
  adminPathSegment,
  foldAdminAreas,
} from "#shared/admin-surface/definitions.ts";

const SPEC: AdminAreasSpec = {
  // An area whose routes mostly share one role, and one route that does not.
  holidays: {
    audience: ["owner"],
    view: { holidays: "/admin/holidays" },
    write: {
      holidayEdit: "/admin/holidays/:id/edit",
      holidayReport: { audience: ["manager"], pattern: "/admin/reports/:id" },
    },
  },
  // An area serving a segment with no page of its own.
  markdownPreview: { segments: ["markdown-preview"] },
  // An area whose extra segment sits beside the segment its own page serves.
  scanner: {
    audience: ["manager"],
    segments: ["scan"],
    view: { scanner: "/admin/listing/:id/scan" },
  },
};

const folded = foldAdminAreas(SPEC);

describe("foldAdminAreas", () => {
  test("gives a route the audience of the area that declares it", () => {
    expect(folded.destinations.holidayEdit!.audience).toEqual(["owner"]);
    expect(folded.destinations.holidays!.audience).toEqual(["owner"]);
  });

  test("keeps the audience a route declares for itself", () => {
    expect(folded.destinations.holidayReport!.audience).toEqual(["manager"]);
  });

  test("takes intent from the group the route is declared in", () => {
    expect(folded.destinations.holidays!.intent).toBe("view");
    expect(folded.destinations.holidayEdit!.intent).toBe("write-form");
    expect(folded.destinations.holidayReport!.intent).toBe("write-form");
  });

  test("names the area that declares each route", () => {
    expect(folded.destinations.holidayEdit!.area).toBe("holidays");
    expect(folded.destinations.scanner!.area).toBe("scanner");
  });

  test("carries the pattern through in both spellings", () => {
    expect(folded.destinations.holidays!.pattern).toBe("/admin/holidays");
    expect(folded.destinations.holidayReport!.pattern).toBe(
      "/admin/reports/:id",
    );
  });

  test("keys every route by its own id", () => {
    expect(Object.keys(folded.destinations).toSorted()).toEqual([
      "holidayEdit",
      "holidayReport",
      "holidays",
      "scanner",
    ]);
  });

  test("reads an area's segments from the patterns it declares", () => {
    // Two holidays routes share the "holidays" segment; the report adds one.
    expect(folded.areas.holidays).toEqual(["holidays", "reports"]);
  });

  test("adds a segment the area serves without a page", () => {
    expect(folded.areas.scanner).toEqual(["listing", "scan"]);
  });

  test("gives an area with no routes only the segments it declares", () => {
    expect(folded.areas.markdownPreview).toEqual(["markdown-preview"]);
    expect(folded.destinations.markdownPreview).toBeUndefined();
  });
});

describe("adminPathSegment", () => {
  test("picks the part after /admin", () => {
    expect(adminPathSegment("/admin")).toBe("");
    expect(adminPathSegment("/admin/")).toBe("");
    expect(adminPathSegment("/admin/settings")).toBe("settings");
    expect(adminPathSegment("/admin/listing/5/edit")).toBe("listing");
  });
});

describe("a table that declares one route twice", () => {
  test("refuses to fold, naming both areas", () => {
    expect(() =>
      foldAdminAreas({
        holidays: { audience: ["owner"], view: { report: "/admin/holidays" } },
        ledger: { audience: ["owner"], view: { report: "/admin/ledger" } },
      }),
    ).toThrow(
      'Admin route "report" is declared by both "holidays" and "ledger"',
    );
  });
});
