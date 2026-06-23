import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type AttendeeFormLine,
  attendeeBalanceNotice,
  attendeeBookingsFromLines,
  bookingDurationDays,
  isBookedLine,
  isNoQuantityLine,
  isRetainedLine,
  type ParsedAttendeeForm,
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
import { testListingWithCount } from "#test-utils";

const makeForm = (data: Record<string, string>): FormParams =>
  new FormParams(new URLSearchParams(data));

const line = (overrides: Partial<AttendeeFormLine> = {}): AttendeeFormLine => ({
  error: null,
  existingBooking: null,
  key: "",
  listing: testListingWithCount({ id: 1, max_quantity: 5 }),
  listingId: 1,
  noQuantity: false,
  quantity: 1,
  ...overrides,
});

const bookingRow = (
  overrides: Partial<ListingAttendeeRow> = {},
): ListingAttendeeRow => ({
  attachment_downloads: 0,
  checked_in: 0,
  end_at: null,
  ledger_event_group: "",
  listing_id: 1,
  price_paid: 0,
  quantity: 1,
  refunded: 0,
  start_at: null,
  ...overrides,
});

const parsedBase = (
  overrides: Partial<ParsedAttendeeForm> = {},
): ParsedAttendeeForm => ({
  address: "",
  dayCount: 1,
  email: "",
  lines: [],
  name: "Test",
  phone: "",
  remainingBalance: 0,
  returnUrl: "",
  special_instructions: "",
  startDate: "",
  statusId: null,
  ...overrides,
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
    // Every stored field is carried through, with the 0/1 flags coerced to bools.
    expect(bookings).toEqual([
      {
        checkedIn: true,
        endAt: "2026-06-03T00:00:00Z",
        listingActive: false,
        listingId: 7,
        listingName: "Kayak",
        quantity: 3,
        refunded: true,
        startAt: "2026-06-01T00:00:00Z",
      },
    ]);
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
  test("reads attendee fields, the shared range, and one qty line", () => {
    const parsed = parseAttendeeForm(
      makeForm({
        address: "1 St",
        day_count: "3",
        email: "a@b.com",
        line_key_5: "5|",
        name: "Jane",
        phone: "555",
        qty_5: "2",
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
    expect(parsed.lines[0]!.key).toBe("5|");
  });

  test("reads one line per qty_<id> field, de-duplicated", () => {
    const parsed = parseAttendeeForm(
      makeForm({ name: "X", qty_3: "1", qty_7: "0" }),
      new Map(),
    );
    expect(parsed.lines.map((l) => l.listingId)).toEqual([3, 7]);
  });

  test("resolves listing references against the provided map", () => {
    const listing = testListingWithCount({ id: 7, name: "Resolved" });
    const parsed = parseAttendeeForm(
      makeForm({ name: "X", qty_7: "1" }),
      new Map([[7, listing]]),
    );
    expect(parsed.lines[0]!.listing?.name).toBe("Resolved");
  });

  test("ignores non-positive, partly-numeric and non-numeric listing ids", () => {
    const parsed = parseAttendeeForm(
      makeForm({
        name: "X",
        qty_0: "1",
        qty_4: "1",
        qty_5abc: "1",
        qty_abc: "1",
      }),
      new Map(),
    );
    expect(parsed.lines.map((l) => l.listingId)).toEqual([4]);
  });

  test("treats empty and non-numeric quantity as null", () => {
    const parsed = parseAttendeeForm(
      makeForm({ name: "X", qty_1: "", qty_2: "abc" }),
      new Map(),
    );
    expect(parsed.lines[0]!.quantity).toBeNull();
    expect(parsed.lines[1]!.quantity).toBeNull();
  });

  test("rejects malformed quantity values instead of parsing their prefix", () => {
    const parsed = parseAttendeeForm(
      makeForm({
        name: "X",
        qty_1: "2x",
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

  test("treats blank, zero and negative balances as nothing owed", () => {
    for (const value of ["", "0", "-5"]) {
      const parsed = parseAttendeeForm(
        makeForm({ name: "X", remaining_balance: value }),
        new Map(),
      );
      expect(parsed.remainingBalance).toBe(0);
    }
  });

  test("attaches an existing booking row by key", () => {
    const booking = bookingRow({ listing_id: 5, quantity: 3 });
    const parsed = parseAttendeeForm(
      makeForm({ line_key_5: "5|", name: "X", qty_5: "3" }),
      new Map(),
      new Map([["5|", booking]]),
    );
    expect(parsed.lines[0]!.existingBooking).toEqual(booking);
  });

  test("a ticked no-quantity box forces quantity 0 and ignores the qty input", () => {
    const parsed = parseAttendeeForm(
      // The qty input is CSS-hidden but a stale value can still be submitted;
      // it must be ignored in favour of the sentinel 0.
      makeForm({ name: "X", noqty_5: "1", qty_5: "9" }),
      new Map(),
    );
    expect(parsed.lines[0]!.noQuantity).toBe(true);
    expect(parsed.lines[0]!.quantity).toBe(0);
  });

  test("an unticked no-quantity box keeps the entered quantity", () => {
    const parsed = parseAttendeeForm(
      makeForm({ name: "X", qty_5: "2" }),
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
  test("carries the status id and balance through", () => {
    const input = toCreateInput(
      parsedBase({ remainingBalance: 1500, statusId: 7 }),
    );
    expect(input.statusId).toBe(7);
    expect(input.remainingBalance).toBe(1500);
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
      quantity: 2,
    });
    expect(input.bookings[1]).toEqual({
      date: null,
      durationDays: undefined,
      listingId: 2,
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
    // The existing line keeps its old key (so the date move is an UPDATE)…
    expect(desired[0]).toEqual({
      date: "2026-03-05",
      durationDays: 2,
      exists: true,
      key: "1|2026-03-01T00:00:00Z",
      listingId: 1,
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
    expect(desired[0]).toMatchObject({ exists: true, quantity: 0 });
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
      { date: null, durationDays: undefined, listingId: 1, quantity: 0 },
    ]);
  });

  test("validateParsedForm blocks marking a paid line no-quantity", () => {
    const result = validateParsedForm(
      parsedBase({
        lines: [
          line({
            existingBooking: bookingRow({ price_paid: 1500, quantity: 2 }),
            noQuantity: true,
            quantity: 0,
          }),
        ],
      }),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.lineErrors.get(0)).toContain("Refund");
  });

  test("validateParsedForm allows marking an unpaid line no-quantity", () => {
    const result = validateParsedForm(
      parsedBase({
        lines: [
          line({
            existingBooking: bookingRow({ price_paid: 0, quantity: 1 }),
            noQuantity: true,
            quantity: 0,
          }),
        ],
      }),
    );
    expect(result.valid).toBe(true);
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
