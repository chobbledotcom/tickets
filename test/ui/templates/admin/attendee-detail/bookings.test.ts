import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { AttendeeBooking } from "#routes/admin/attendee-form-model.ts";
import { formatDateRangeLabel } from "#shared/date-labels.ts";
import { AttendeeBookingsTable } from "#templates/admin/attendee-detail.tsx";
import { expectListingRowQuantity } from "#test-utils/assertions.ts";

const booking = (
  overrides: Partial<AttendeeBooking> = {},
): AttendeeBooking => ({
  assignBuiltSite: false,
  checkedIn: 0,
  endAt: null,
  listingActive: true,
  listingId: 1,
  listingName: "Test Listing",
  parentListingId: 0,
  quantity: 1,
  refunded: false,
  startAt: null,
  ...overrides,
});

const renderBookings = (
  bookings: AttendeeBooking[],
  planSaleMissingSite = false,
): string => String(AttendeeBookingsTable({ bookings, planSaleMissingSite }));

describe("AttendeeBookingsTable", () => {
  test("returns null when the attendee has no bookings", () => {
    // Null lets the caller drop the whole section.
    expect(
      AttendeeBookingsTable({ bookings: [], planSaleMissingSite: true }),
    ).toBeNull();
  });

  test("lists each booked listing with a link, quantity, and total", () => {
    const html = renderBookings([
      booking({ listingId: 7, listingName: "Kayak", quantity: 2 }),
      booking({ listingId: 8, listingName: "Canoe", quantity: 3 }),
    ]);
    assertStringIncludes(html, "Bookings");
    assertStringIncludes(html, 'href="/admin/listing/7"');
    assertStringIncludes(html, "Kayak");
    assertStringIncludes(html, 'href="/admin/listing/8"');
    assertStringIncludes(html, "Canoe");
    // Each listing's row shows its own quantity (Kayak→2, Canoe→3), so a
    // swapped grouping fails here, not just a wrong sum...
    expectListingRowQuantity(html, 7, 2);
    expectListingRowQuantity(html, 8, 3);
    // ...and the footer totals them (2 + 3); only the total cell holds 5.
    assertStringIncludes(html, '<th colspan="2" scope="row">Total</th>');
    assertStringIncludes(html, '<td class="col-quantity">5</td>');
  });

  test("formats the date range for a dated (daily) booking", () => {
    const html = renderBookings([
      booking({
        endAt: "2026-06-03T00:00:00Z",
        startAt: "2026-06-01T00:00:00Z",
      }),
    ]);
    assertStringIncludes(
      html,
      formatDateRangeLabel("2026-06-01T00:00:00Z", "2026-06-03T00:00:00Z"),
    );
  });

  test("shows an em dash in the date cell when a booking has no date", () => {
    // A standard (fixed-date) booking carries no start date; the status badge
    // proves the only em dash present is the date fallback.
    const html = renderBookings([booking({ checkedIn: 1, startAt: null })]);
    assertStringIncludes(html, "Checked in");
    assertStringIncludes(html, "—");
  });

  test("marks an inactive listing", () => {
    assertStringIncludes(
      renderBookings([booking({ listingActive: false })]),
      "(Inactive)",
    );
    assert(
      !renderBookings([booking({ listingActive: true })]).includes(
        "(Inactive)",
      ),
      "the value should not contain the searched item",
    );
  });

  test("flags a plan booking that has no site yet", () => {
    const planLine = booking({
      assignBuiltSite: true,
      listingName: "One Month Site",
    });
    assertStringIncludes(
      renderBookings([planLine], true),
      '<div class="muted small">No site assigned yet</div>',
    );
    // The buyer already holds a site, so no plan row shows the cue.
    assert(
      !renderBookings([planLine]).includes("No site assigned yet"),
      "the value should not contain the searched item",
    );
    // An ordinary listing never reads as owed a site, and a no-quantity
    // plan line bought nothing.
    assert(
      !renderBookings(
        [booking({ assignBuiltSite: true, quantity: 0 })],
        true,
      ).includes("No site assigned yet"),
      "the value should not contain the searched item",
    );
    assert(
      !renderBookings([booking({ listingName: "Concert" })], true).includes(
        "No site assigned yet",
      ),
      "the value should not contain the searched item",
    );
  });

  test("shows no repair cue on a refunded plan booking", () => {
    const refundedPlan = booking({
      assignBuiltSite: true,
      listingName: "Refunded Site",
      refunded: true,
    });
    assert(
      !renderBookings([refundedPlan], true).includes("No site assigned yet"),
      "the value should not contain the searched item",
    );
  });

  test("annotates a folded child row with the parent it was chosen under", () => {
    // The child's parentListingId points at the parent, which is booked in the
    // same order — so its name resolves from the sibling row. A parent id of
    // the lowest possible value keeps the "has a parent" check honest.
    const html = renderBookings([
      booking({ listingId: 1, listingName: "Base unit" }),
      booking({
        listingId: 8,
        listingName: "Add-on",
        parentListingId: 1,
      }),
    ]);
    assertStringIncludes(
      html,
      '<div class="muted small">Add-on chosen under Base unit</div>',
    );
  });

  test("a plain booking shows no add-on annotation", () => {
    const html = renderBookings([
      booking({ listingId: 7, listingName: "Base unit" }),
    ]);
    assert(
      !html.includes("Add-on chosen under"),
      "the value should not contain the searched item",
    );
    assert(
      !html.includes("Includes add-on"),
      "the value should not contain the searched item",
    );
  });

  test("annotates a parent row with the add-on children folded under it (#5)", () => {
    // The reverse of "chosen under": the parent row lists every child booked
    // against it in this order, so the relationship reads both ways. Children
    // pointed at the lowest possible parent id keep the fold's check honest.
    const html = renderBookings([
      booking({ listingId: 1, listingName: "Base unit" }),
      booking({ listingId: 8, listingName: "Paddle", parentListingId: 1 }),
      booking({ listingId: 9, listingName: "Helmet", parentListingId: 1 }),
    ]);
    assertStringIncludes(
      html,
      '<div class="muted small">Includes add-on: Paddle, Helmet</div>',
    );
    // The children still show their own "chosen under" annotation.
    assertStringIncludes(
      html,
      '<div class="muted small">Add-on chosen under Base unit</div>',
    );
  });

  test("falls back to the parent id when its row is absent from the order", () => {
    // Defensive: a child whose parent row is not in this attendee's set still
    // labels the pairing rather than dropping it silently.
    const html = renderBookings([
      booking({ listingId: 8, listingName: "Add-on", parentListingId: 7 }),
    ]);
    assertStringIncludes(html, "Add-on chosen under #7");
  });

  test("falls back to an em dash when a booking has no status", () => {
    // Dated so the only em dash can come from the empty status cell.
    const html = renderBookings([
      booking({
        checkedIn: 0,
        endAt: "2026-06-02T00:00:00Z",
        refunded: false,
        startAt: "2026-06-01T00:00:00Z",
      }),
    ]);
    assertStringIncludes(html, "—");
    // With a start date, the date cell renders words, so this one em dash
    // can only be the status column's fallback.
    assert(
      !html.includes("Checked in"),
      "the value should not contain the searched item",
    );
    assert(
      !html.includes("Refunded"),
      "the value should not contain the searched item",
    );
  });
});
