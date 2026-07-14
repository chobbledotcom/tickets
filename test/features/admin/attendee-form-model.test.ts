import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  attendeeBalanceNotice,
  attendeeBookingsFromLines,
  bookingDurationDays,
  isBookedLine,
  isNoQuantityLine,
  isRetainedLine,
  parseAttendeeForm,
  resolveSharedDates,
  resolveStatusId,
  toCreateInput,
  toDesiredLines,
  validateParsedForm,
} from "#routes/admin/attendee-form-model.ts";
import type { AttendeeStatus } from "#shared/db/attendee-statuses.ts";
import type { ListingAttendeeRow } from "#shared/db/attendee-types.ts";
import { FormParams } from "#shared/form-data.ts";
import { testListingWithCount } from "#test-utils/factories.ts";
import { bookingRow, line, parsedBase } from "./attendee-form-fixtures.ts";

const makeForm = (data: Record<string, string>): FormParams =>
  new FormParams(new URLSearchParams(data));

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
    // Every stored field is carried through, with the 0/1 flags coerced to bools.
    expect(bookings).toEqual([
      {
        checkedIn: true,
        endAt: "2026-06-03T00:00:00Z",
        listingActive: false,
        listingDeleted: false,
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
        existingBooking: bookingRow({ listing_id: 8, parent_listing_id: 7 }),
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

  test("shows a booking whose listing no longer resolves as a placeholder", () => {
    // A saved row can outlive its listing (a delete racing a mid-payment
    // checkout keeps the staged rows). The operator must still see what the
    // customer booked — a read-only "Deleted listing" placeholder, flagged so
    // the table never links to the listing's 404.
    const bookings = attendeeBookingsFromLines([
      line({
        existingBooking: bookingRow({ listing_id: 99, quantity: 1 }),
        listing: null,
        listingId: 99,
      }),
    ]);
    expect(bookings).toEqual([
      {
        checkedIn: false,
        endAt: null,
        listingActive: false,
        listingDeleted: true,
        listingId: 99,
        listingName: "Deleted listing",
        parentListingId: 0,
        quantity: 1,
        refunded: false,
        startAt: null,
      },
    ]);
  });
});

describe("parseAttendeeForm", () => {
  test("reads attendee fields, the shared range, and one editor line", () => {
    const parsed = parseAttendeeForm(
      makeForm({
        address: "1 St",
        day_count: "3",
        email: "a@b.com",
        line_key_0: "5|||0",
        line_listing_0: "5",
        name: "Jane",
        phone: "555",
        qty_0: "2",
        special_instructions: "VIP",
        start_date: "2026-03-02",
      }),
      new Map(),
    );
    expect(parsed.name).toBe("Jane");
    expect(parsed.email).toBe("a@b.com");
    expect(parsed.address).toBe("1 St");
    expect(parsed.special_instructions).toBe("VIP");
    expect(parsed.startDate).toBe("2026-03-02");
    expect(parsed.dayCount).toBe(3);
    expect(parsed.lines).toHaveLength(1);
    expect(parsed.lines[0]!.listingId).toBe(5);
    expect(parsed.lines[0]!.quantity).toBe(2);
    expect(parsed.lines[0]!.key).toBe("5|||0");
  });

  test("reads one line per line_listing_<i>, de-duplicated by index", () => {
    const parsed = parseAttendeeForm(
      new FormParams(
        "name=X&line_listing_0=3&qty_0=1&line_listing_1=7&qty_1=0&line_listing_1=9",
      ),
      new Map(),
    );
    // The duplicate index 1 is ignored; two lines, even for the same listing.
    expect(parsed.lines.map((l) => l.listingId)).toEqual([3, 7]);
  });

  test("two lines may target the SAME listing — one per booking path", () => {
    const parsed = parseAttendeeForm(
      makeForm({
        line_listing_0: "3",
        line_listing_1: "3",
        line_package_1: "7",
        name: "X",
        qty_0: "1",
        qty_1: "2",
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
      makeForm({ line_listing_0: "7", name: "X", qty_0: "1" }),
      new Map([[7, listing]]),
    );
    expect(parsed.lines[0]!.listing?.name).toBe("Resolved");
  });

  test("ignores lines whose listing value is not a positive id", () => {
    const parsed = parseAttendeeForm(
      makeForm({
        line_listing_0: "0",
        line_listing_1: "4",
        line_listing_2: "5abc",
        line_listing_3: "abc",
        name: "X",
        qty_0: "1",
        qty_1: "1",
        qty_2: "1",
        qty_3: "1",
      }),
      new Map(),
    );
    expect(parsed.lines.map((l) => l.listingId)).toEqual([4]);
  });

  test("a blank line's package path only sticks for a real membership", () => {
    const memberships = new Map([[4, new Map([[7, 250]])]]);
    const parsed = parseAttendeeForm(
      makeForm({
        line_listing_0: "4",
        line_listing_1: "4",
        line_package_0: "7",
        line_package_1: "8",
        name: "X",
        qty_0: "1",
        qty_1: "1",
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

  test("an existing row's path comes from the row, never line_package", () => {
    const row = bookingRow({ listing_id: 4, package_group_id: 7 });
    const parsed = parseAttendeeForm(
      makeForm({
        line_key_0: "4|||7",
        line_listing_0: "4",
        line_package_0: "9",
        name: "X",
        qty_0: "1",
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
        line_listing_0: "1",
        line_listing_1: "2",
        name: "X",
        qty_0: "",
        qty_1: "abc",
      }),
      new Map(),
    );
    expect(parsed.lines[0]!.quantity).toBeNull();
    expect(parsed.lines[1]!.quantity).toBeNull();
  });

  test("rejects malformed quantity values instead of parsing their prefix", () => {
    const parsed = parseAttendeeForm(
      makeForm({
        line_listing_0: "1",
        name: "X",
        qty_0: "2x",
      }),
      new Map(),
    );
    expect(parsed.lines[0]!.quantity).toBeNull();
  });

  test("clamps the day count to the valid range", () => {
    expect(
      parseAttendeeForm(makeForm({ day_count: "0", name: "X" }), new Map())
        .dayCount,
    ).toBe(1);
    expect(
      parseAttendeeForm(makeForm({ day_count: "9999", name: "X" }), new Map())
        .dayCount,
    ).toBe(90);
    expect(parseAttendeeForm(makeForm({ name: "X" }), new Map()).dayCount).toBe(
      1,
    );
    // A non-numeric value parses to no count and clamps to 1.
    expect(
      parseAttendeeForm(
        makeForm({ day_count: "garbage", name: "X" }),
        new Map(),
      ).dayCount,
    ).toBe(1);
  });

  test("reads a selected status id, blank and non-positive as none", () => {
    expect(
      parseAttendeeForm(makeForm({ name: "X", status_id: "4" }), new Map())
        .statusId,
    ).toBe(4);
    expect(
      parseAttendeeForm(makeForm({ name: "X", status_id: "" }), new Map())
        .statusId,
    ).toBeNull();
    expect(
      parseAttendeeForm(makeForm({ name: "X", status_id: "0" }), new Map())
        .statusId,
    ).toBeNull();
  });

  test("attaches an existing booking row by key", () => {
    const booking = bookingRow({ listing_id: 5, quantity: 3 });
    const parsed = parseAttendeeForm(
      makeForm({
        line_key_0: "5|||0",
        line_listing_0: "5",
        name: "X",
        qty_0: "3",
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
      makeForm({ line_listing_0: "5", name: "X", noqty_0: "1", qty_0: "9" }),
      new Map(),
    );
    expect(parsed.lines[0]!.noQuantity).toBe(true);
    expect(parsed.lines[0]!.quantity).toBe(0);
  });

  test("an unticked no-quantity box keeps the entered quantity", () => {
    const parsed = parseAttendeeForm(
      makeForm({ line_listing_0: "5", name: "X", qty_0: "2" }),
      new Map(),
    );
    expect(parsed.lines[0]!.noQuantity).toBe(false);
    expect(parsed.lines[0]!.quantity).toBe(2);
  });
});

describe("isBookedLine", () => {
  test("true only when quantity ≥ 1 and the listing resolves", () => {
    expect(isBookedLine(line({ quantity: 2 }))).toBe(true);
    expect(isBookedLine(line({ quantity: 0 }))).toBe(false);
    expect(isBookedLine(line({ quantity: null }))).toBe(false);
    expect(isBookedLine(line({ listing: null }))).toBe(false);
  });
});

describe("isNoQuantityLine / isRetainedLine", () => {
  test("a no-quantity line is not booked but is retained", () => {
    const noQty = line({ noQuantity: true, quantity: 0 });
    expect(isBookedLine(noQty)).toBe(false);
    expect(isNoQuantityLine(noQty)).toBe(true);
    expect(isRetainedLine(noQty)).toBe(true);
  });

  test("an unbooked line (qty 0, box unticked) is neither retained nor no-quantity", () => {
    const removed = line({ noQuantity: false, quantity: 0 });
    expect(isNoQuantityLine(removed)).toBe(false);
    expect(isRetainedLine(removed)).toBe(false);
  });

  test("a real booking is retained", () => {
    expect(isRetainedLine(line({ quantity: 2 }))).toBe(true);
  });

  test("a no-quantity tick on an unresolved listing is ignored", () => {
    expect(
      isNoQuantityLine(line({ listing: null, noQuantity: true, quantity: 0 })),
    ).toBe(false);
  });
});

describe("resolveStatusId", () => {
  const status = (id: number, isPublicDefault: boolean): AttendeeStatus => ({
    id,
    is_paid_default: false,
    is_public_default: isPublicDefault,
    is_reservation: false,
    name: `Status ${id}`,
    reservation_amount: "0",
    sort_order: id,
  });

  test("keeps an explicitly chosen status", () => {
    expect(resolveStatusId(2, [status(1, true), status(2, false)])).toBe(2);
  });

  test("falls back to the public default when none is given", () => {
    expect(resolveStatusId(null, [status(1, false), status(2, true)])).toBe(2);
  });
});

describe("validateParsedForm", () => {
  test("fails when name is blank", () => {
    const result = validateParsedForm(parsedBase({ name: "" }));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.attendeeError?.field).toBe("name");
  });

  test("passes for a booked standard listing with no date", () => {
    const result = validateParsedForm(parsedBase({ lines: [line()] }));
    expect(result.valid).toBe(true);
  });

  test("fails when a booked quantity exceeds the listing max", () => {
    const result = validateParsedForm(
      parsedBase({
        lines: [
          line({
            listing: testListingWithCount({ id: 1, max_quantity: 5 }),
            quantity: 10,
          }),
        ],
      }),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.lineErrors.get(0)).toContain("at most 5");
  });

  test("treats a 0-quantity line as not booked, not an error", () => {
    const result = validateParsedForm(
      parsedBase({ lines: [line({ quantity: 0 })] }),
    );
    expect(result.valid).toBe(true);
  });

  test("ignores an unbooked line whose listing is unknown", () => {
    const result = validateParsedForm(
      parsedBase({ lines: [line({ listing: null, quantity: 1 })] }),
    );
    expect(result.valid).toBe(true);
  });

  test("allows keeping a booked inactive listing", () => {
    const result = validateParsedForm(
      parsedBase({
        lines: [
          line({ listing: testListingWithCount({ active: false, id: 1 }) }),
        ],
      }),
    );
    expect(result.valid).toBe(true);
  });

  test("fails when a daily listing is booked but the start date is missing", () => {
    const result = validateParsedForm(
      parsedBase({
        lines: [
          line({
            listing: testListingWithCount({ id: 1, listing_type: "daily" }),
          }),
        ],
        startDate: "",
      }),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.dateError).toContain("start date");
  });

  test("passes a booked daily listing with a valid start date", () => {
    const result = validateParsedForm(
      parsedBase({
        lines: [
          line({
            listing: testListingWithCount({ id: 1, listing_type: "daily" }),
          }),
        ],
        startDate: "2026-03-02",
      }),
    );
    expect(result.valid).toBe(true);
  });

  test("rejects a malformed email, phone, address and instructions", () => {
    expect(
      validateParsedForm(parsedBase({ email: "nope", lines: [line()] })).valid,
    ).toBe(false);
    expect(
      validateParsedForm(parsedBase({ lines: [line()], phone: "not a phone" }))
        .valid,
    ).toBe(false);
    expect(
      validateParsedForm(
        parsedBase({ address: "x".repeat(251), lines: [line()] }),
      ).valid,
    ).toBe(false);
    expect(
      validateParsedForm(
        parsedBase({ lines: [line()], special_instructions: "x".repeat(251) }),
      ).valid,
    ).toBe(false);
  });

  test("accepts well-formed optional email and phone", () => {
    const result = validateParsedForm(
      parsedBase({
        email: "jane@example.com",
        lines: [line()],
        phone: "+1 (555) 123-4567",
      }),
    );
    expect(result.valid).toBe(true);
  });
});

describe("toCreateInput", () => {
  test("carries the status id through", () => {
    const input = toCreateInput(parsedBase({ statusId: 7 }));
    expect(input.statusId).toBe(7);
    expect(input.bookings).toHaveLength(0);
  });

  test("books daily listings on the shared range and standard with no date", () => {
    const input = toCreateInput(
      parsedBase({
        dayCount: 3,
        lines: [
          line({
            listing: testListingWithCount({ id: 1, listing_type: "daily" }),
            listingId: 1,
            quantity: 2,
          }),
          line({
            listing: testListingWithCount({ id: 2, listing_type: "standard" }),
            listingId: 2,
            quantity: 1,
          }),
          line({ listingId: 3, quantity: 0 }),
        ],
        startDate: "2026-03-02",
      }),
    );
    expect(input.bookings).toHaveLength(2);
    expect(input.bookings[0]).toEqual({
      date: "2026-03-02",
      durationDays: 3,
      listingId: 1,
      packageGroupId: 0,
      quantity: 2,
    });
    expect(input.bookings[1]).toEqual({
      date: null,
      durationDays: undefined,
      listingId: 2,
      packageGroupId: 0,
      quantity: 1,
    });
  });
});

describe("toDesiredLines", () => {
  test("marks existing lines as updates and new lines as inserts", () => {
    const desired = toDesiredLines(
      parsedBase({
        dayCount: 2,
        lines: [
          line({
            existingBooking: bookingRow({ listing_id: 1 }),
            key: "1|2026-03-01T00:00:00Z",
            listing: testListingWithCount({ id: 1, listing_type: "daily" }),
            listingId: 1,
            quantity: 1,
          }),
          line({
            listing: testListingWithCount({ id: 2, listing_type: "daily" }),
            listingId: 2,
            quantity: 1,
          }),
        ],
        startDate: "2026-03-05",
      }),
    );
    // The existing line keeps its old key (so the date move is an UPDATE)
    // and carries its booking's package path (0 = a plain line) so the
    // update pins the right row when a listing books through several paths.
    expect(desired[0]).toEqual({
      date: "2026-03-05",
      durationDays: 2,
      exists: true,
      key: "1|2026-03-01T00:00:00Z",
      listingId: 1,
      packageGroupId: 0,
      parentListingId: 0,
      quantity: 1,
    });
    // …the new line is an INSERT.
    expect(desired[1]!.exists).toBe(false);
    expect(desired[1]!.key).toBe("");
  });

  test("excludes unbooked lines", () => {
    const desired = toDesiredLines(
      parsedBase({ lines: [line({ quantity: 0 })] }),
    );
    expect(desired).toHaveLength(0);
  });

  test("keeps a no-quantity line as a quantity-0 desired line", () => {
    const desired = toDesiredLines(
      parsedBase({
        lines: [
          line({
            existingBooking: bookingRow({ listing_id: 1 }),
            key: "1|",
            noQuantity: true,
            quantity: 0,
          }),
        ],
      }),
    );
    expect(desired).toHaveLength(1);
    expect(desired[0]).toEqual({
      date: null,
      durationDays: 1,
      exists: true,
      key: "1|",
      listingId: 1,
      packageGroupId: 0,
      parentListingId: 0,
      quantity: 0,
    });
  });

  test("each line books its own path — two rows of one listing stay two", () => {
    // The editor renders one line per stored ROW, so a dual-path attendee
    // (package 7 beside the listing's own row) round-trips as two desired
    // lines, each on its own key and path.
    const packageRow = bookingRow({
      end_at: "2026-03-03T00:00:00Z",
      listing_id: 1,
      package_group_id: 7,
      quantity: 2,
      start_at: "2026-03-01T00:00:00Z",
    });
    const desired = toDesiredLines(
      parsedBase({
        lines: [
          line({
            existingBooking: bookingRow({ listing_id: 1 }),
            key: "1|||0",
            listingId: 1,
            quantity: 3,
          }),
          line({
            existingBooking: packageRow,
            key: "1|2026-03-01T00:00:00Z|0|7",
            listingId: 1,
            packageGroupId: 7,
            quantity: 2,
          }),
        ],
      }),
    );
    expect(desired).toEqual([
      {
        date: null,
        durationDays: 1,
        exists: true,
        key: "1|||0",
        listingId: 1,
        packageGroupId: 0,
        parentListingId: 0,
        quantity: 3,
      },
      {
        date: null,
        durationDays: 1,
        exists: true,
        key: "1|2026-03-01T00:00:00Z|0|7",
        listingId: 1,
        packageGroupId: 7,
        parentListingId: 0,
        quantity: 2,
      },
    ]);
  });

  test("a blank package line given a quantity inserts on that path", () => {
    const desired = toDesiredLines(
      parsedBase({
        lines: [line({ listingId: 1, packageGroupId: 7, quantity: 2 })],
      }),
    );
    expect(desired).toEqual([
      {
        date: null,
        durationDays: 1,
        exists: false,
        key: "",
        listingId: 1,
        packageGroupId: 7,
        parentListingId: 0,
        quantity: 2,
      },
    ]);
  });

  test("a zeroed line's row falls out and is deleted", () => {
    const desired = toDesiredLines(
      parsedBase({
        lines: [
          line({
            existingBooking: bookingRow({ listing_id: 1 }),
            key: "1|||0",
            listingId: 1,
            quantity: 0,
          }),
        ],
      }),
    );
    expect(desired).toEqual([]);
  });
});

describe("no-quantity persistence + paid-line guard", () => {
  test("toCreateInput keeps a no-quantity line at quantity 0", () => {
    const input = toCreateInput(
      parsedBase({
        lines: [
          line({
            listing: testListingWithCount({ id: 1, listing_type: "standard" }),
            listingId: 1,
            noQuantity: true,
            quantity: 0,
          }),
        ],
      }),
    );
    expect(input.bookings).toEqual([
      {
        date: null,
        durationDays: undefined,
        listingId: 1,
        packageGroupId: 0,
        quantity: 0,
      },
    ]);
  });

  test("validateParsedForm blocks marking a paid line no-quantity", () => {
    const parsed = parsedBase({
      lines: [
        line({
          existingBooking: bookingRow({ price_paid: 1500, quantity: 2 }),
          noQuantity: true,
          quantity: 0,
        }),
      ],
    });
    const result = validateParsedForm(parsed);
    expect(result.valid).toBe(false);
    // The paid-line block is a form-wide error (shown at the top of the page),
    // not a per-line error buried in the quantity table.
    if (!result.valid) {
      expect(result.formError).toBe(
        "Refund this line's payment before marking it no quantity.",
      );
      expect(result.lineErrors.size).toBe(0);
    }
    expect(parsed.lines[0]!.error).toBe(null);
  });

  test("validateParsedForm allows marking an unpaid line no-quantity", () => {
    const parsed = parsedBase({
      lines: [
        line({
          existingBooking: bookingRow({ price_paid: 0, quantity: 1 }),
          noQuantity: true,
          quantity: 0,
        }),
      ],
    });
    const result = validateParsedForm(parsed);
    expect(result.valid).toBe(true);
    // A valid line's per-line error is cleared to exactly null.
    expect(parsed.lines[0]!.error).toBe(null);
  });

  test("validateParsedForm allows a brand-new no-quantity line (no existing booking)", () => {
    // A never-booked line ticked no-quantity has no existingBooking, so the
    // paid-line guard reads price_paid as 0 and the line validates.
    const result = validateParsedForm(
      parsedBase({
        lines: [line({ existingBooking: null, noQuantity: true, quantity: 0 })],
      }),
    );
    expect(result.valid).toBe(true);
  });
});

describe("resolveSharedDates", () => {
  const addDaysIso = (date: string, n: number): string => {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };

  const daily = (start: string, durationDays: number): ListingAttendeeRow =>
    bookingRow({
      end_at: `${addDaysIso(start, durationDays)}T00:00:00.000Z`,
      start_at: `${start}T00:00:00Z`,
    });

  test("returns empty defaults when there are no dated bookings", () => {
    const result = resolveSharedDates([bookingRow({ start_at: null })]);
    expect(result).toEqual({
      dayCount: 1,
      hasMixedTimings: false,
      startDate: "",
    });
  });

  test("returns the shared range when bookings agree", () => {
    const result = resolveSharedDates([
      daily("2026-06-14", 1),
      daily("2026-06-14", 1),
    ]);
    expect(result.hasMixedTimings).toBe(false);
    expect(result.startDate).toBe("2026-06-14");
    expect(result.dayCount).toBe(1);
  });

  test("flags mixed start dates, seeding earliest start + longest length", () => {
    const result = resolveSharedDates([
      daily("2026-07-01", 1),
      daily("2026-06-14", 3),
    ]);
    expect(result.hasMixedTimings).toBe(true);
    expect(result.startDate).toBe("2026-06-14");
    expect(result.dayCount).toBe(3);
  });

  test("flags mixed durations", () => {
    const result = resolveSharedDates([
      daily("2026-06-14", 1),
      daily("2026-06-14", 3),
    ]);
    expect(result.hasMixedTimings).toBe(true);
  });

  test("ignores a booking with no end date", () => {
    const result = resolveSharedDates([
      bookingRow({ end_at: null, start_at: "2026-06-14T00:00:00Z" }),
    ]);
    expect(result.startDate).toBe("");
  });

  test("falls back to length 1 for a dated but zero-length booking", () => {
    // Both endpoints present (so it passes the filter) but the range is empty,
    // so the per-booking duration is null and defaults to 1.
    const result = resolveSharedDates([daily("2026-06-14", 0)]);
    expect(result.startDate).toBe("2026-06-14");
    expect(result.dayCount).toBe(1);
    expect(result.hasMixedTimings).toBe(false);
  });
});

describe("bookingDurationDays", () => {
  test("returns null when a range endpoint is missing or invalid", () => {
    expect(
      bookingDurationDays(bookingRow({ end_at: "x", start_at: null })),
    ).toBeNull();
    expect(
      bookingDurationDays(bookingRow({ end_at: null, start_at: "x" })),
    ).toBeNull();
    expect(
      bookingDurationDays(bookingRow({ end_at: "bad", start_at: "bad" })),
    ).toBeNull();
  });

  test("returns null for a zero-length range", () => {
    expect(
      bookingDurationDays(
        bookingRow({
          end_at: "2026-06-14T00:00:00Z",
          start_at: "2026-06-14T00:00:00Z",
        }),
      ),
    ).toBeNull();
  });

  test("counts whole days for a real range", () => {
    expect(
      bookingDurationDays(
        bookingRow({
          end_at: "2026-06-17T00:00:00Z",
          start_at: "2026-06-14T00:00:00Z",
        }),
      ),
    ).toBe(3);
  });
});

describe("attendeeBalanceNotice", () => {
  const paid = { is_paid_default: true, is_reservation: false };
  const reservation = { is_paid_default: false, is_reservation: true };
  const other = { is_paid_default: false, is_reservation: false };

  test("is silent when there is no status", () => {
    expect(attendeeBalanceNotice(null, 500, 1000, 100)).toBeNull();
  });

  test("warns when a paid status still owes money", () => {
    const notice = attendeeBalanceNotice(paid, 500, 1000, 500);
    expect(notice?.tone).toBe("warning");
    expect(notice?.message).toContain("paid status");
  });

  test("is silent when a paid status owes nothing", () => {
    expect(attendeeBalanceNotice(paid, 0, 1000, 1000)).toBeNull();
  });

  test("is silent for a reservation that still owes a balance", () => {
    expect(attendeeBalanceNotice(reservation, 900, 1000, 100)).toBeNull();
  });

  test("warns when a reservation has no balance but is still unpaid", () => {
    const notice = attendeeBalanceNotice(reservation, 0, 1000, 100);
    expect(notice?.tone).toBe("warning");
    expect(notice?.message).toContain("still unpaid");
  });

  test("nudges (info) when a reservation is fully paid", () => {
    const notice = attendeeBalanceNotice(reservation, 0, 1000, 1000);
    expect(notice?.tone).toBe("info");
    expect(notice?.message).toContain("moving it to a paid status");
  });

  test("is silent for a free reservation with no balance", () => {
    expect(attendeeBalanceNotice(reservation, 0, 0, 0)).toBeNull();
  });

  test("is silent for a balance on a neither-paid-nor-reservation status", () => {
    expect(attendeeBalanceNotice(other, 500, 1000, 500)).toBeNull();
  });
});
