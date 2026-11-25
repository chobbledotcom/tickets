import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { attendeeBookingsFromLines } from "#routes/admin/attendee-form-dates.ts";
import {
  ATTENDEE_FORM_ID,
  parseAttendeeForm,
  toLedgerOrder,
} from "#routes/admin/attendee-form-model.ts";
import { FormParams } from "#shared/form-data.ts";
import {
  line,
  makeForm,
  parsedBase,
} from "#test/features/admin/attendee-form-model/fixtures.ts";
import { bookingRow, testListingWithCount } from "#test-utils/factories.ts";

describe("toLedgerOrder", () => {
  test("a zero package override keeps the leg at zero, not the listing price", () => {
    const listing = testListingWithCount({ id: 3, unitPrice: 900 });
    const parsed = parsedBase({
      lines: [
        line({
          listing,
          listingId: 3,
          packageGroupId: 4,
          packagePrice: 0,
          quantity: 2,
        }),
      ],
    });
    const order = toLedgerOrder(parsed, []);
    expect(order.lines[0]!.chargedUnitAmount).toBe(0);
    expect(order.lines[0]!.item.unitPrice).toBe(0);
  });
});

describe("ATTENDEE_FORM_ID", () => {
  test("matches the anchor the saved redirect scrolls to", () => {
    // The form template renders id={ATTENDEE_FORM_ID} and attendee-edit.test.ts
    // asserts the redirect lands on "#attendee-form", so the string is the
    // contract between the two.
    expect(ATTENDEE_FORM_ID).toBe("attendee-form");
  });
});

describe("attendeeBookingsFromLines", () => {
  test("projects a booked line's stored booking onto a summary row", () => {
    const bookings = attendeeBookingsFromLines([
      line({
        existingBooking: bookingRow({
          checked_in: 1,
          end_at: "2026-06-03T00:00:00Z",
          listing_id: 7,
          quantity: 3,
          refunded: 1,
          start_at: "2026-06-01T00:00:00Z",
        }),
        listing: testListingWithCount({ active: false, id: 7, name: "Kayak" }),
        listingId: 7,
      }),
    ]);
    // Every stored field is carried through, flags coerced, the count kept.
    expect(bookings).toEqual([
      {
        checkedIn: 1,
        endAt: "2026-06-03T00:00:00Z",
        listingActive: false,
        listingId: 7,
        listingName: "Kayak",
        parentListingId: 0,
        quantity: 3,
        refunded: true,
        startAt: "2026-06-01T00:00:00Z",
      },
    ]);
  });
  test("carries a folded child row's parent listing id onto the summary", () => {
    const bookings = attendeeBookingsFromLines([
      line({
        existingBooking: bookingRow({
          listing_id: 8,
          parent_listing_id: 7,
        }),
        listing: testListingWithCount({ id: 8, name: "Add-on" }),
        listingId: 8,
      }),
    ]);
    expect(bookings[0]!.parentListingId).toBe(7);
  });

  test("keeps only the lines that carry a saved booking", () => {
    const bookings = attendeeBookingsFromLines([
      line({
        existingBooking: bookingRow({ listing_id: 1, quantity: 2 }),
        listing: testListingWithCount({ id: 1, name: "Booked" }),
      }),
      // A not-yet-booked row (the quantity box left at 0) has no stored booking.
      line({ existingBooking: null, listingId: 2 }),
    ]);
    expect(bookings.map((b) => b.listingName)).toEqual(["Booked"]);
  });

  test("drops a booking whose listing no longer resolves", () => {
    // A hand-crafted POST can pair a real booking key with an unknown listing
    // id; that bogus line is dropped rather than rendered with a null listing.
    const bookings = attendeeBookingsFromLines([
      line({
        existingBooking: bookingRow({ listing_id: 99, quantity: 1 }),
        listing: null,
        listingId: 99,
      }),
    ]);
    expect(bookings).toEqual([]);
  });
});

describe("parseAttendeeForm", () => {
  test("reads attendee fields, the shared range, and one editor line", () => {
    const parsed = parseAttendeeForm(
      makeForm({
        address: "1 St",
        dayCount: "3",
        email: "a@b.com",
        lineKey0: "5|||0",
        lineListing0: "5",
        name: "Jane",
        phone: "555",
        qty0: "2",
        returnUrl: "/admin/attendees?tab=overview",
        specialInstructions: "VIP",
        startDate: "2026-03-02",
      }),
      new Map(),
    );
    expect(parsed.name).toBe("Jane");
    expect(parsed.email).toBe("a@b.com");
    expect(parsed.phone).toBe("555");
    expect(parsed.address).toBe("1 St");
    expect(parsed.special_instructions).toBe("VIP");
    expect(parsed.startDate).toBe("2026-03-02");
    expect(parsed.returnUrl).toBe("/admin/attendees?tab=overview");
    expect(parsed.dayCount).toBe(3);
    expect(parsed.lines).toHaveLength(1);
    expect(parsed.lines[0]!.listingId).toBe(5);
    expect(parsed.lines[0]!.quantity).toBe(2);
    expect(parsed.lines[0]!.key).toBe("5|||0");
  });

  test("reads one line per lineListing<i>, de-duplicated by index", () => {
    const parsed = parseAttendeeForm(
      new FormParams(
        "name=X&lineListing0=3&qty0=1&lineListing1=7&qty1=0&lineListing1=9",
      ),
      new Map(),
    );
    // The duplicate index 1 is ignored; two lines, even for the same listing.
    expect(parsed.lines.map((l) => l.listingId)).toEqual([3, 7]);
  });

  test("ignores line fields whose indexes are invalid", () => {
    const parsed = parseAttendeeForm(
      new FormParams(
        "name=X&lineListingBad=3&qtyBad=1&lineListing-1=4&qty-1=1&lineListing2=5&qty2=1",
      ),
      new Map(),
    );
    expect(parsed.lines.map((line) => line.listingId)).toEqual([5]);
  });

  test("two lines may target the SAME listing — one per booking path", () => {
    const parsed = parseAttendeeForm(
      makeForm({
        lineListing0: "3",
        lineListing1: "3",
        linePackage1: "7",
        name: "X",
        qty0: "1",
        qty1: "2",
      }),
      new Map(),
      new Map(),
      new Map([[3, new Map([[7, null]])]]),
    );
    expect(
      parsed.lines.map((l) => [l.listingId, l.packageGroupId, l.quantity]),
    ).toEqual([
      [3, 0, 1],
      [3, 7, 2],
    ]);
  });

  test("resolves listing references against the provided map", () => {
    const listing = testListingWithCount({ id: 7, name: "Resolved" });
    const parsed = parseAttendeeForm(
      makeForm({ lineListing0: "7", name: "X", qty0: "1" }),
      new Map([[7, listing]]),
    );
    expect(parsed.lines[0]!.listing?.name).toBe("Resolved");
  });

  test("ignores lines whose listing value is not a positive id", () => {
    const parsed = parseAttendeeForm(
      makeForm({
        lineListing0: "0",
        lineListing1: "4",
        lineListing2: "5abc",
        lineListing3: "abc",
        name: "X",
        qty0: "1",
        qty1: "1",
        qty2: "1",
        qty3: "1",
      }),
      new Map(),
    );
    expect(parsed.lines.map((l) => l.listingId)).toEqual([4]);
  });

  test("a blank line's package path only sticks for a real membership", () => {
    const memberships = new Map([[4, new Map([[7, 250]])]]);
    const parsed = parseAttendeeForm(
      makeForm({
        lineListing0: "4",
        lineListing1: "4",
        linePackage0: "7",
        linePackage1: "8",
        name: "X",
        qty0: "1",
        qty1: "1",
      }),
      new Map(),
      new Map(),
      memberships,
    );
    // Line 0 books through its real package (carrying that path's price);
    // line 1 named a package that does not contain listing 4 (or was
    // deleted) and falls back to the listing's own row.
    expect(parsed.lines.map((l) => [l.packageGroupId, l.packagePrice])).toEqual(
      [
        [7, 250],
        [0, null],
      ],
    );
  });

  test("an existing row's path comes from the row, never linePackage", () => {
    const row = bookingRow({ listing_id: 4, package_group_id: 7 });
    const parsed = parseAttendeeForm(
      makeForm({
        lineKey0: "4|||7",
        lineListing0: "4",
        linePackage0: "9",
        name: "X",
        qty0: "1",
      }),
      new Map(),
      new Map([["4|||7", row]]),
    );
    expect(parsed.lines[0]!.packageGroupId).toBe(7);
    expect(parsed.lines[0]!.existingBooking).toBe(row);
  });

  test("treats empty and non-numeric quantity as null", () => {
    const parsed = parseAttendeeForm(
      makeForm({
        lineListing0: "1",
        lineListing1: "2",
        name: "X",
        qty0: "",
        qty1: "abc",
      }),
      new Map(),
    );
    expect(parsed.lines[0]!.quantity).toBeNull();
    expect(parsed.lines[1]!.quantity).toBeNull();
  });

  test("rejects malformed quantity values instead of parsing their prefix", () => {
    const parsed = parseAttendeeForm(
      makeForm({
        lineListing0: "1",
        name: "X",
        qty0: "2x",
      }),
      new Map(),
    );
    expect(parsed.lines[0]!.quantity).toBeNull();
  });

  test("clamps the day count to the valid range", () => {
    expect(
      parseAttendeeForm(makeForm({ dayCount: "0", name: "X" }), new Map())
        .dayCount,
    ).toBe(1);
    expect(
      parseAttendeeForm(makeForm({ dayCount: "9999", name: "X" }), new Map())
        .dayCount,
    ).toBe(90);
    expect(parseAttendeeForm(makeForm({ name: "X" }), new Map()).dayCount).toBe(
      1,
    );
    // A non-numeric value parses to no count and clamps to 1.
    expect(
      parseAttendeeForm(makeForm({ dayCount: "garbage", name: "X" }), new Map())
        .dayCount,
    ).toBe(1);
  });

  test("reads a selected status id, blank and non-positive as none", () => {
    expect(
      parseAttendeeForm(makeForm({ name: "X", statusId: "4" }), new Map())
        .statusId,
    ).toBe(4);
    // The lowest real id must still count as a choice, not as "none".
    expect(
      parseAttendeeForm(makeForm({ name: "X", statusId: "1" }), new Map())
        .statusId,
    ).toBe(1);
    expect(
      parseAttendeeForm(makeForm({ name: "X", statusId: "" }), new Map())
        .statusId,
    ).toBeNull();
    expect(
      parseAttendeeForm(makeForm({ name: "X", statusId: "0" }), new Map())
        .statusId,
    ).toBeNull();
  });

  test("attaches an existing booking row by key", () => {
    const booking = bookingRow({ listing_id: 5, quantity: 3 });
    const parsed = parseAttendeeForm(
      makeForm({
        lineKey0: "5|||0",
        lineListing0: "5",
        name: "X",
        qty0: "3",
      }),
      new Map(),
      new Map([["5|||0", booking]]),
    );
    expect(parsed.lines[0]!.existingBooking).toEqual(booking);
  });

  test("a ticked no-quantity box forces quantity 0 and ignores the qty input", () => {
    const parsed = parseAttendeeForm(
      // The qty input is CSS-hidden but a stale value can still be submitted;
      // it must be ignored in favour of the sentinel 0.
      makeForm({ lineListing0: "5", name: "X", noqty0: "1", qty0: "9" }),
      new Map(),
    );
    expect(parsed.lines[0]!.noQuantity).toBe(true);
    expect(parsed.lines[0]!.quantity).toBe(0);
  });

  test("an unticked no-quantity box keeps the entered quantity", () => {
    const parsed = parseAttendeeForm(
      makeForm({ lineListing0: "5", name: "X", qty0: "2" }),
      new Map(),
    );
    expect(parsed.lines[0]!.noQuantity).toBe(false);
    expect(parsed.lines[0]!.quantity).toBe(2);
  });
});
