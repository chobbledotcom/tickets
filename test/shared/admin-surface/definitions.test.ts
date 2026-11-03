import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type AdminAreasSpec,
  adminPathSegment,
  foldAdminAreas,
  ownerOnlyAudience,
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
    // The area serves no page of its own, so it contributes no route.
    expect(Object.keys(folded.destinations)).not.toContain("markdownPreview");
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

describe("a route that declares a read-only write", () => {
  test("carries the mode the guard keeps it open for", () => {
    const surface = foldAdminAreas({
      holidays: {
        audience: ["owner"],
        write: {
          holidayHold: {
            pattern: "/admin/holidays/:id/hold",
            readOnlyWrite: "always",
          },
          holidayRelease: "/admin/holidays/:id/release",
        },
      },
    });
    expect(surface.destinations.holidayHold!.readOnlyWrite).toBe("always");
    expect(surface.destinations.holidayRelease).toEqual({
      area: "holidays",
      audience: ["owner"],
      id: "holidayRelease",
      intent: "write-form",
      pattern: "/admin/holidays/:id/release",
    });
  });
});

describe("a route that names its after-save landing", () => {
  const WITH_LANDING: AdminAreasSpec = {
    holidays: {
      audience: ["owner"],
      view: { holiday: "/admin/holidays/:id", holidays: "/admin/holidays" },
      write: {
        holidayEdit: {
          afterSave: "holiday",
          pattern: "/admin/holidays/:id/edit",
        },
        holidayNew: "/admin/holidays/new",
      },
    },
  };

  test("holds the landing id the route declares", () => {
    const surface = foldAdminAreas(WITH_LANDING);
    expect(surface.destinations.holidayEdit!.afterSave).toBe("holiday");
    expect(surface.byPattern["/admin/holidays/:id/edit"]!.afterSave).toBe(
      "holiday",
    );
  });

  test("leaves a route with no landing declared without one", () => {
    const surface = foldAdminAreas(WITH_LANDING);
    expect(surface.destinations.holidayNew).toEqual({
      area: "holidays",
      audience: ["owner"],
      id: "holidayNew",
      intent: "write-form",
      pattern: "/admin/holidays/new",
    });
  });

  test("refuses a landing that no route declares", () => {
    expect(() =>
      foldAdminAreas({
        holidays: {
          audience: ["owner"],
          write: {
            holidayEdit: {
              afterSave: "nowhere",
              pattern: "/admin/holidays/:id/edit",
            },
          },
        },
      }),
    ).toThrow(
      'Admin route "holidayEdit" saves to "nowhere", which no route declares',
    );
  });

  test("refuses a route that lands on itself", () => {
    // A save that returns to its own form names no landing. A route that
    // names itself would hold itself, and a reader would walk a loop.
    expect(() =>
      foldAdminAreas({
        holidays: {
          audience: ["owner"],
          write: {
            holidayEdit: {
              afterSave: "holidayEdit",
              pattern: "/admin/holidays/:id/edit",
            },
          },
        },
      }),
    ).toThrow(
      'Admin route "holidayEdit" saves to itself. A save that returns to ' +
        "its own form needs no afterSave",
    );
  });

  test("refuses a landing that names two records", () => {
    // A saved record fills one parameter. Two would take the same id twice.
    expect(() =>
      foldAdminAreas({
        holidays: {
          audience: ["owner"],
          view: { holidayReport: "/admin/holidays/:id/report/:kind" },
          write: {
            holidayEdit: {
              afterSave: "holidayReport",
              pattern: "/admin/holidays/:id/edit",
            },
          },
        },
      }),
    ).toThrow(
      'Admin route "holidayEdit" saves to "holidayReport", which names more ' +
        "than one record",
    );
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

describe("a table that declares one path twice", () => {
  test("refuses to fold, naming both routes", () => {
    // Two ids at one path would give the page two audiences, and the gate a
    // handler looks up by its own path would take whichever won the race.
    expect(() =>
      foldAdminAreas({
        holidays: {
          audience: ["owner"],
          view: { report: "/admin/holidays", summary: "/admin/holidays" },
        },
      }),
    ).toThrow(
      'Admin path "/admin/holidays" is declared by both "report" and "summary"',
    );
  });
});

describe("ownerOnlyAudience", () => {
  test("a gate that names the owner role refuses everyone else as owner-only", () => {
    expect(ownerOnlyAudience({ role: "owner", roles: undefined })).toBe(true);
    expect(ownerOnlyAudience({ role: "editor", roles: undefined })).toBe(false);
  });

  test("a gate that names one role owner-wide is owner-only", () => {
    expect(ownerOnlyAudience({ role: undefined, roles: ["owner"] })).toBe(true);
  });

  test("a gate naming owner among several roles is not owner-only", () => {
    expect(
      ownerOnlyAudience({ role: undefined, roles: ["owner", "editor"] }),
    ).toBe(false);
  });

  test("a gate with no audience spelled out is not owner-only", () => {
    expect(ownerOnlyAudience({ role: undefined, roles: undefined })).toBe(
      false,
    );
  });
});
