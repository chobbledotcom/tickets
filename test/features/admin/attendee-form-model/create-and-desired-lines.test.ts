/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { ListingAttendeeRow } from "#db/attendee-types.ts";
import {
  resolveSharedDates,
  toCreateInput,
  toDesiredLines,
  validateParsedForm,
} from "#routes/admin/attendee-form-model.ts";
import {
  line,
  parsedBase,
} from "#test/features/admin/attendee-form-model/fixtures.ts";
import { bookingRow, testListingWithCount } from "#test-utils/factories.ts";

/* jscpd:ignore-end */

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

  test("validateParsedForm blocks a line paid a single unit from going no-quantity", () => {
    const parsed = parsedBase({
      lines: [
        line({
          existingBooking: bookingRow({ price_paid: 1, quantity: 1 }),
          noQuantity: true,
          quantity: 0,
        }),
      ],
    });
    expect(validateParsedForm(parsed).valid).toBe(false);
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
