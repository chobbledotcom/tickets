import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { AREAS_A_L } from "#shared/admin-surface/areas-a-l.ts";
import { CONTENT_ADMIN_LEVELS, STAFF_ADMIN_LEVELS } from "#types";

/** One declared route: a bare pattern, or a pattern with its own audience. */
type DeclaredRoute = string | { pattern: string };

/** Every route pattern one area declares, views and writes alike. */
const patternsOf = (area: {
  view?: Record<string, DeclaredRoute>;
  write?: Record<string, DeclaredRoute>;
}): string[] =>
  [...Object.values(area.view ?? {}), ...Object.values(area.write ?? {})].map(
    (route) => (typeof route === "string" ? route : route.pattern),
  );

const areas = Object.entries(AREAS_A_L);

/** The record block of an area: its detail page, its list page, whether it
 *  has a new page, and the write that deletes it. */
const recordOf = (
  detail: string,
  list: string,
  newPage: boolean,
  remove: string,
) => ({ detail, list, newPage, remove });

/** A route whose save lands on the named record page. */
const savesTo = (afterSave: string, pattern: string) => ({
  afterSave,
  pattern,
});

/** A route that only staff can reach. */
const staffRoute = (pattern: string) => ({
  audience: STAFF_ADMIN_LEVELS,
  pattern,
});

describe("the A-L admin areas", () => {
  test("declare every route as a real path under /admin/", () => {
    const stray = areas.flatMap(([name, area]) =>
      patternsOf(area)
        .filter((pattern) => !/^\/admin\/\S*$/.test(pattern))
        .map((pattern) => `${name}: ${JSON.stringify(pattern)}`),
    );
    expect(stray).toEqual([]);
  });

  test("name every extra URL segment", () => {
    const blank = areas.flatMap(([name, area]) =>
      ("segments" in area ? area.segments : [])
        .filter((segment: string) => segment === "")
        .map(() => name),
    );
    expect(blank).toEqual([]);
  });

  test("declare the per-line check-in page with the attendees, for staff", () => {
    // The quantity page a roster's Check in link opens: a staff page, so a
    // door-only scanner login is never offered it.
    expect(AREAS_A_L.attendees.view.attendeeCheckin).toBe(
      "/admin/listing/:id/attendee/:attendeeId/checkin",
    );
    assert(
      !(AREAS_A_L.attendees.audience as readonly string[]).includes("scanner"),
    );
  });
});

describe("the A-L record areas", () => {
  test("close the refresh-payment and check-in writes in update mode", () => {
    expect(AREAS_A_L.attendees.write.attendeeRefreshPayment.readOnlyWrite).toBe(
      "read-only",
    );
    expect(AREAS_A_L.attendees.write.listingAttendeeCheckin.readOnlyWrite).toBe(
      "read-only",
    );
  });

  test("declare attributes with moves and options, and no new page", () => {
    expect(AREAS_A_L.attributes).toStrictEqual({
      audience: ["owner"],
      record: recordOf("attribute", "attributes", false, "attributeDelete"),
      segments: ["listing"],
      view: {
        attribute: "/admin/attributes/:id",
        attributes: "/admin/attributes",
      },
      write: {
        attributeDelete: { pattern: "/admin/attributes/:id/delete" },
        attributeEdit: "/admin/attributes/:id/edit",
        attributeMoveAfter: "/admin/attributes/:id/move-after",
        attributeMoveBefore: "/admin/attributes/:id/move-before",
        attributeOptionAdd: "/admin/attributes/:id/options",
        attributeOptionDelete: "/admin/attributes/:id/options/:optionId/delete",
        attributeOptionEdit: "/admin/attributes/:id/options/:optionId/edit",
        attributeOptionMoveAfter:
          "/admin/attributes/:id/options/:optionId/move-after",
        attributeOptionMoveBefore:
          "/admin/attributes/:id/options/:optionId/move-before",
      },
    });
  });

  test("land a built site save on the built site", () => {
    expect(AREAS_A_L.builtSites.view.builtSites).toStrictEqual(
      savesTo("builtSite", "/admin/built-sites"),
    );
    expect(AREAS_A_L.builtSites.write.builtSiteEdit).toStrictEqual(
      savesTo("builtSite", "/admin/built-sites/:id/edit"),
    );
  });

  test("declare groups with images, notes, and a staff delete", () => {
    expect(AREAS_A_L.groups).toStrictEqual({
      audience: CONTENT_ADMIN_LEVELS,
      record: recordOf("group", "groups", true, "groupDelete"),
      view: {
        group: "/admin/groups/:id",
        groups: savesTo("group", "/admin/groups"),
      },
      write: {
        groupAddListings: "/admin/groups/:id/add-listings",
        groupDelete: staffRoute("/admin/groups/:id/delete"),
        groupEdit: savesTo("group", "/admin/groups/:id/edit"),
        groupImageMoveAfter: "/admin/groups/:id/images/:imageId/move-after",
        groupImageMoveBefore: "/admin/groups/:id/images/:imageId/move-before",
        groupImages: "/admin/groups/:id/images",
        groupImagesUpload: "/admin/groups/:id/images/upload",
        groupNew: "/admin/groups/new",
        groupNote: staffRoute("/admin/groups/:id/note"),
        groupNoteDelete: staffRoute("/admin/groups/:id/note/:noteId/delete"),
        groupRemoveListings: "/admin/groups/:id/remove-listings",
      },
    });
  });

  test("declare holidays that save to the holiday", () => {
    expect(AREAS_A_L.holidays).toStrictEqual({
      audience: ["owner"],
      record: recordOf("holiday", "holidays", true, "holidayDelete"),
      view: {
        holiday: "/admin/holidays/:id",
        holidays: savesTo("holiday", "/admin/holidays"),
      },
      write: {
        holidayDelete: { pattern: "/admin/holidays/:id/delete" },
        holidayEdit: savesTo("holiday", "/admin/holidays/:id/edit"),
        holidayNew: "/admin/holidays/new",
      },
    });
  });

  test("declare images with no page of their own", () => {
    expect(AREAS_A_L.images).toStrictEqual({
      audience: CONTENT_ADMIN_LEVELS,
      view: {
        imageOptions: "/admin/images/options",
        images: "/admin/images",
      },
      write: {
        imageDelete: { pattern: "/admin/images/:id/delete" },
        imageEdit: "/admin/images/:id/edit",
        imageNew: "/admin/images/new",
      },
    });
  });

  test("declare invoices with no edit form", () => {
    expect(AREAS_A_L.invoices).toStrictEqual({
      audience: STAFF_ADMIN_LEVELS,
      record: recordOf("invoice", "invoices", true, "invoiceDelete"),
      view: { invoice: "/admin/invoices/:id", invoices: "/admin/invoices" },
      write: {
        invoiceCancel: "/admin/invoices/:id/cancel",
        invoiceDelete: { pattern: "/admin/invoices/:id/delete" },
        invoiceNew: "/admin/invoices/new",
        invoicePreview: "/admin/invoices/preview",
      },
    });
  });
});
