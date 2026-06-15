import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  ADD_LINE_ACTION,
  type AttendeeFormLine,
  attendeeBalanceNotice,
  bookingDurationDays,
  parseAttendeeForm,
  resolveDailyDefaults,
  toCreateInput,
  trimTrailingBlankLines,
  validateParsedForm,
} from "#routes/admin/attendee-form-model.ts";
import type { ListingAttendeeRow } from "#shared/db/attendee-types.ts";
import { FormParams } from "#shared/form-data.ts";
import { MAX_FORM_LINES } from "#shared/limits.ts";
import type { Holiday } from "#shared/types.ts";
import { testListingWithCount } from "#test-utils";

const makeForm = (data: Record<string, string>): FormParams =>
  new FormParams(new URLSearchParams(data));

const blankLine = (
  overrides: Partial<AttendeeFormLine> = {},
): AttendeeFormLine => ({
  date: "",
  error: null,
  existingBooking: null,
  key: "",
  listing: null,
  listingId: 0,
  quantity: 1,
  ...overrides,
});

const bookingRow = (
  overrides: Partial<ListingAttendeeRow> = {},
): ListingAttendeeRow => ({
  attachment_downloads: 0,
  checked_in: 0,
  end_at: null,
  listing_id: 1,
  price_paid: 0,
  quantity: 1,
  refunded: 0,
  start_at: null,
  ...overrides,
});

describe("trimTrailingBlankLines", () => {
  test("removes a single trailing blank line", () => {
    const lines = [
      blankLine({ listing: testListingWithCount({ id: 1 }), listingId: 1 }),
      blankLine(),
    ];
    expect(trimTrailingBlankLines(lines)).toHaveLength(1);
  });

  test("removes consecutive trailing blank lines", () => {
    const lines = [
      blankLine({ listing: testListingWithCount({ id: 1 }), listingId: 1 }),
      blankLine(),
      blankLine(),
      blankLine(),
    ];
    expect(trimTrailingBlankLines(lines)).toHaveLength(1);
  });

  test("preserves at least one line (the operator's blank placeholder)", () => {
    expect(trimTrailingBlankLines([blankLine()])).toHaveLength(1);
  });

  test("does not remove blank lines in the middle", () => {
    const filled = blankLine({
      listing: testListingWithCount({ id: 1 }),
      listingId: 1,
    });
    const lines = [filled, blankLine(), filled];
    expect(trimTrailingBlankLines(lines)).toHaveLength(3);
  });
});

describe("parseAttendeeForm", () => {
  test("reads attendee fields and a single line", () => {
    const form = makeForm({
      address: "1 St",
      email: "a@b.com",
      line_count: "1",
      line_event_id_0: "5",
      line_key_0: "5|",
      line_quantity_0: "2",
      name: "Jane",
      phone: "555",
      special_instructions: "VIP",
    });
    const parsed = parseAttendeeForm(form, new Map());
    expect(parsed.name).toBe("Jane");
    expect(parsed.email).toBe("a@b.com");
    expect(parsed.phone).toBe("555");
    expect(parsed.address).toBe("1 St");
    expect(parsed.special_instructions).toBe("VIP");
    expect(parsed.lines).toHaveLength(1);
    expect(parsed.lines[0]!.listingId).toBe(5);
    expect(parsed.lines[0]!.quantity).toBe(2);
    expect(parsed.lines[0]!.key).toBe("5|");
    expect(parsed.lines[0]!.listing).toBeNull();
    expect(parsed.action.kind).toBe("save");
  });

  test("reads a selected status id", () => {
    const parsed = parseAttendeeForm(
      makeForm({ line_count: "1", name: "X", status_id: "4" }),
      new Map(),
    );
    expect(parsed.statusId).toBe(4);
  });

  test("treats a blank status id as no status", () => {
    const parsed = parseAttendeeForm(
      makeForm({ line_count: "1", name: "X", status_id: "" }),
      new Map(),
    );
    expect(parsed.statusId).toBeNull();
  });

  test("treats a non-positive status id as no status", () => {
    const parsed = parseAttendeeForm(
      makeForm({ line_count: "1", name: "X", status_id: "0" }),
      new Map(),
    );
    expect(parsed.statusId).toBeNull();
  });

  test("treats blank, zero and negative balances as nothing owed", () => {
    for (const value of ["", "0", "-5"]) {
      const parsed = parseAttendeeForm(
        makeForm({ line_count: "1", name: "X", remaining_balance: value }),
        new Map(),
      );
      expect(parsed.remainingBalance).toBe(0);
    }
  });

  test("toCreateInput carries the status id and balance through", () => {
    const input = toCreateInput({
      action: { kind: "save" },
      address: "",
      email: "",
      lines: [blankLine()],
      name: "X",
      phone: "",
      remainingBalance: 1500,
      returnUrl: "",
      special_instructions: "",
      statusId: 7,
    });
    expect(input.statusId).toBe(7);
    expect(input.remainingBalance).toBe(1500);
    expect(input.bookings).toHaveLength(0);
  });

  test("resolves listing references against the provided map", () => {
    const listing = testListingWithCount({ id: 7, name: "Resolved" });
    const form = makeForm({
      line_count: "1",
      line_event_id_0: "7",
      line_quantity_0: "1",
      name: "X",
    });
    const parsed = parseAttendeeForm(form, new Map([[7, listing]]));
    expect(parsed.lines[0]!.listing?.name).toBe("Resolved");
  });

  test("treats non-numeric or missing event_id as blank line (listingId 0)", () => {
    const form = makeForm({
      line_count: "1",
      line_event_id_0: "not-a-number",
      line_quantity_0: "1",
      name: "X",
    });
    expect(parseAttendeeForm(form, new Map()).lines[0]!.listingId).toBe(0);
  });

  test("treats empty quantity as null", () => {
    const form = makeForm({
      line_count: "1",
      line_event_id_0: "1",
      line_quantity_0: "",
      name: "X",
    });
    expect(parseAttendeeForm(form, new Map()).lines[0]!.quantity).toBeNull();
  });

  test("parses add_line and remove_line actions", () => {
    const addForm = makeForm({
      action: ADD_LINE_ACTION,
      line_count: "1",
      name: "X",
    });
    expect(parseAttendeeForm(addForm, new Map()).action).toEqual({
      kind: "add_line",
    });

    const removeForm = makeForm({
      action: "remove_line_2",
      line_count: "3",
      name: "X",
    });
    expect(parseAttendeeForm(removeForm, new Map()).action).toEqual({
      index: 2,
      kind: "remove_line",
    });
  });

  test("falls back to line_count=1 on malformed input", () => {
    const form = makeForm({ line_count: "garbage", name: "X" });
    expect(parseAttendeeForm(form, new Map()).lines).toHaveLength(1);
  });

  test("clamps an abusive line_count to MAX_FORM_LINES", () => {
    const form = makeForm({
      line_count: String(MAX_FORM_LINES + 50),
      name: "X",
    });
    expect(parseAttendeeForm(form, new Map()).lines).toHaveLength(
      MAX_FORM_LINES,
    );
  });

  test("attaches existing booking rows by key", () => {
    const booking = bookingRow({ listing_id: 5, quantity: 3 });
    const form = makeForm({
      line_count: "1",
      line_event_id_0: "5",
      line_key_0: "5|",
      line_quantity_0: "3",
      name: "X",
    });
    const parsed = parseAttendeeForm(
      form,
      new Map(),
      new Map([["5|", booking]]),
    );
    expect(parsed.lines[0]!.existingBooking).toEqual(booking);
  });
});

describe("validateParsedForm", () => {
  test("fails when name is blank", () => {
    const parsed = parseAttendeeForm(
      makeForm({ line_count: "1", name: "" }),
      new Map(),
    );
    const result = validateParsedForm(parsed, []);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.attendeeError?.field).toBe("name");
    }
  });

  test("passes for a valid line pointing at an active listing", () => {
    const listing = testListingWithCount({
      active: true,
      id: 1,
      max_quantity: 5,
    });
    const parsed = parseAttendeeForm(
      makeForm({
        line_count: "1",
        line_event_id_0: "1",
        line_quantity_0: "2",
        name: "Jane",
      }),
      new Map([[1, listing]]),
    );
    const result = validateParsedForm(parsed, []);
    expect(result.valid).toBe(true);
  });

  test("fails when selected listing is unknown", () => {
    const parsed = parseAttendeeForm(
      makeForm({
        line_count: "1",
        line_event_id_0: "999",
        line_quantity_0: "1",
        name: "Jane",
      }),
      new Map(),
    );
    const result = validateParsedForm(parsed, []);
    expect(result.valid).toBe(false);
  });

  test("fails when quantity is below 1", () => {
    const listing = testListingWithCount({ active: true, id: 1 });
    const parsed = parseAttendeeForm(
      makeForm({
        line_count: "1",
        line_event_id_0: "1",
        line_quantity_0: "0",
        name: "Jane",
      }),
      new Map([[1, listing]]),
    );
    const result = validateParsedForm(parsed, []);
    expect(result.valid).toBe(false);
  });

  test("fails when quantity exceeds listing max_quantity", () => {
    const listing = testListingWithCount({
      active: true,
      id: 1,
      max_quantity: 5,
    });
    const parsed = parseAttendeeForm(
      makeForm({
        line_count: "1",
        line_event_id_0: "1",
        line_quantity_0: "10",
        name: "Jane",
      }),
      new Map([[1, listing]]),
    );
    const result = validateParsedForm(parsed, []);
    expect(result.valid).toBe(false);
  });

  test("fails when daily listing is selected but date is missing", () => {
    const listing = testListingWithCount({
      bookable_days: ["Monday"],
      duration_days: 1,
      id: 1,
      listing_type: "daily",
      maximum_days_after: 30,
      minimum_days_before: 0,
    });
    const parsed = parseAttendeeForm(
      makeForm({
        line_count: "1",
        line_event_id_0: "1",
        line_quantity_0: "1",
        name: "Jane",
      }),
      new Map([[1, listing]]),
    );
    const result = validateParsedForm(parsed, []);
    expect(result.valid).toBe(false);
  });

  test("fails on duplicate (listing_id, date) pairs", () => {
    const listing = testListingWithCount({ active: true, id: 1 });
    const parsed = parseAttendeeForm(
      makeForm({
        line_count: "2",
        line_event_id_0: "1",
        line_event_id_1: "1",
        line_quantity_0: "1",
        line_quantity_1: "1",
        name: "Jane",
      }),
      new Map([[1, listing]]),
    );
    const result = validateParsedForm(parsed, []);
    expect(result.valid).toBe(false);
  });

  test("allows trailing blank lines (the placeholder row)", () => {
    const listing = testListingWithCount({ active: true, id: 1 });
    const parsed = parseAttendeeForm(
      makeForm({
        line_count: "2",
        line_event_id_0: "1",
        line_event_id_1: "",
        line_quantity_0: "1",
        line_quantity_1: "",
        name: "Jane",
      }),
      new Map([[1, listing]]),
    );
    const trimmed = { ...parsed, lines: trimTrailingBlankLines(parsed.lines) };
    const result = validateParsedForm(trimmed, []);
    expect(result.valid).toBe(true);
  });

  test("rejects a malformed email even though it is optional", () => {
    const listing = testListingWithCount({
      active: true,
      id: 1,
      max_quantity: 5,
    });
    const parsed = parseAttendeeForm(
      makeForm({
        email: "not-an-email",
        line_count: "1",
        line_event_id_0: "1",
        line_quantity_0: "1",
        name: "Jane",
      }),
      new Map([[1, listing]]),
    );
    const result = validateParsedForm(parsed, []);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.attendeeError?.field).toBe("email");
  });

  test("rejects a malformed phone even though it is optional", () => {
    const listing = testListingWithCount({
      active: true,
      id: 1,
      max_quantity: 5,
    });
    const parsed = parseAttendeeForm(
      makeForm({
        line_count: "1",
        line_event_id_0: "1",
        line_quantity_0: "1",
        name: "Jane",
        phone: "not a phone",
      }),
      new Map([[1, listing]]),
    );
    const result = validateParsedForm(parsed, []);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.attendeeError?.field).toBe("phone");
  });

  test("rejects an address that exceeds the length cap", () => {
    const listing = testListingWithCount({
      active: true,
      id: 1,
      max_quantity: 5,
    });
    const parsed = parseAttendeeForm(
      makeForm({
        address: "x".repeat(251),
        line_count: "1",
        line_event_id_0: "1",
        line_quantity_0: "1",
        name: "Jane",
      }),
      new Map([[1, listing]]),
    );
    const result = validateParsedForm(parsed, []);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.attendeeError?.field).toBe("address");
  });

  test("rejects special instructions that exceed the length cap", () => {
    const listing = testListingWithCount({
      active: true,
      id: 1,
      max_quantity: 5,
    });
    const parsed = parseAttendeeForm(
      makeForm({
        line_count: "1",
        line_event_id_0: "1",
        line_quantity_0: "1",
        name: "Jane",
        special_instructions: "x".repeat(251),
      }),
      new Map([[1, listing]]),
    );
    const result = validateParsedForm(parsed, []);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.attendeeError?.field).toBe("special_instructions");
    }
  });

  test("accepts well-formed optional email and phone", () => {
    const listing = testListingWithCount({
      active: true,
      id: 1,
      max_quantity: 5,
    });
    const parsed = parseAttendeeForm(
      makeForm({
        email: "jane@example.com",
        line_count: "1",
        line_event_id_0: "1",
        line_quantity_0: "1",
        name: "Jane",
        phone: "+1 (555) 123-4567",
      }),
      new Map([[1, listing]]),
    );
    const result = validateParsedForm(parsed, []);
    expect(result.valid).toBe(true);
  });

  test("ignores inactive listing when validation runs", () => {
    const listing = testListingWithCount({ active: false, id: 1 });
    const parsed = parseAttendeeForm(
      makeForm({
        line_count: "1",
        line_event_id_0: "1",
        line_quantity_0: "1",
        name: "Jane",
      }),
      new Map([[1, listing]]),
    );
    const result = validateParsedForm(parsed, []);
    expect(result.valid).toBe(false);
  });
});

describe("resolveDailyDefaults", () => {
  test("returns empty defaults when no existing daily bookings", () => {
    const result = resolveDailyDefaults([blankLine()]);
    expect(result.hasMixedTimings).toBe(false);
    expect(result.inheritedDate).toBeNull();
    expect(result.inheritedDurationDays).toBeNull();
  });

  test("inherits uniform daily bookings (same start date + duration)", () => {
    const listing = testListingWithCount({
      id: 1,
      listing_type: "daily",
    });
    const booking = bookingRow({
      end_at: "2026-06-15T00:00:00.000Z",
      listing_id: 1,
      start_at: "2026-06-14T00:00:00Z",
    });
    const line = blankLine({
      existingBooking: booking,
      key: "1|2026-06-14T00:00:00Z",
      listing,
      listingId: 1,
    });
    const result = resolveDailyDefaults([line]);
    expect(result.hasMixedTimings).toBe(false);
    expect(result.inheritedDate).toBe("2026-06-14");
    expect(result.inheritedDurationDays).toBe(1);
  });

  test("flags mixed daily timings (different start dates)", () => {
    const listing = testListingWithCount({
      id: 1,
      listing_type: "daily",
    });
    const lineA = blankLine({
      existingBooking: bookingRow({
        end_at: "2026-06-15T00:00:00.000Z",
        listing_id: 1,
        start_at: "2026-06-14T00:00:00Z",
      }),
      key: "1|2026-06-14T00:00:00Z",
      listing,
      listingId: 1,
    });
    const lineB = blankLine({
      existingBooking: bookingRow({
        end_at: "2026-07-02T00:00:00.000Z",
        listing_id: 1,
        start_at: "2026-07-01T00:00:00Z",
      }),
      key: "1|2026-07-01T00:00:00Z",
      listing,
      listingId: 1,
    });
    const result = resolveDailyDefaults([lineA, lineB]);
    expect(result.hasMixedTimings).toBe(true);
    expect(result.inheritedDate).toBeNull();
  });

  test("flags mixed daily timings (different durations)", () => {
    const listing = testListingWithCount({
      id: 1,
      listing_type: "daily",
    });
    const lineA = blankLine({
      existingBooking: bookingRow({
        end_at: "2026-06-15T00:00:00.000Z",
        listing_id: 1,
        start_at: "2026-06-14T00:00:00Z",
      }),
      key: "1|2026-06-14T00:00:00Z",
      listing,
      listingId: 1,
    });
    const lineB = blankLine({
      existingBooking: bookingRow({
        end_at: "2026-06-17T00:00:00.000Z",
        listing_id: 1,
        start_at: "2026-06-14T00:00:00Z",
      }),
      key: "1|2026-06-14T00:00:00Z",
      listing,
      listingId: 1,
    });
    const result = resolveDailyDefaults([lineA, lineB]);
    expect(result.hasMixedTimings).toBe(true);
  });

  test("ignores standard-listing bookings when computing daily defaults", () => {
    const standardListing = testListingWithCount({
      id: 1,
      listing_type: "standard",
    });
    const line = blankLine({
      existingBooking: bookingRow({ listing_id: 1 }),
      listing: standardListing,
      listingId: 1,
    });
    const result = resolveDailyDefaults([line]);
    expect(result.hasMixedTimings).toBe(false);
    expect(result.inheritedDate).toBeNull();
  });
});

describe("parseAttendeeForm quantity edge cases", () => {
  test("converts non-numeric quantity string to null", () => {
    const parsed = parseAttendeeForm(
      makeForm({
        line_count: "1",
        line_event_id_0: "1",
        line_quantity_0: "abc",
        name: "Test",
      }),
      new Map(),
    );
    expect(parsed.lines[0]!.quantity).toBeNull();
  });
});

describe("validateLine daily date checks", () => {
  test("rejects an invalid date string for a daily listing", () => {
    const dailyListing = {
      ...testListingWithCount({ listing_type: "daily" }),
      bookableDays: ["2026-06-15"],
      duration_days: 1,
    };
    const holidays: Holiday[] = [];
    const line = blankLine({
      date: "not-a-date",
      listing: dailyListing,
      listingId: dailyListing.id,
      quantity: 1,
    });
    const result = validateParsedForm(
      { ...parsedBase(), lines: [line] },
      holidays,
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.lineErrors.get(0)).toBe(
        "Date must be a valid YYYY-MM-DD value",
      );
    }
  });

  test("rejects a daily date that is not in allowed bookable days", () => {
    const dailyListing = {
      ...testListingWithCount({
        bookable_days: [],
        listing_type: "daily",
      }),
      duration_days: 1,
    };
    const holidays: Holiday[] = [];
    const line = blankLine({
      date: "2026-06-20",
      listing: dailyListing,
      listingId: dailyListing.id,
      quantity: 1,
    });
    const result = validateParsedForm(
      { ...parsedBase(), lines: [line] },
      holidays,
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.lineErrors.get(0)).toBe(
        "Date is not bookable for this listing",
      );
    }
  });
});

describe("bookingDurationDays", () => {
  test("returns null when start_at is missing", () => {
    const row = bookingRow({ end_at: "2026-06-14", start_at: null });
    expect(bookingDurationDays(row)).toBeNull();
  });

  test("returns null when end_at is missing", () => {
    const row = bookingRow({ end_at: null, start_at: "2026-06-14" });
    expect(bookingDurationDays(row)).toBeNull();
  });

  test("returns null for invalid date strings", () => {
    const row = bookingRow({ end_at: "also-invalid", start_at: "invalid" });
    expect(bookingDurationDays(row)).toBeNull();
  });

  test("returns null when computed duration is less than 1 day", () => {
    const row = bookingRow({
      end_at: "2026-06-14T00:00:00Z",
      start_at: "2026-06-14T00:00:00Z",
    });
    expect(bookingDurationDays(row)).toBeNull();
  });
});

describe("resolveDailyDefaults fallback", () => {
  test("falls back to duration 1 when existing daily booking has invalid duration", () => {
    const dailyListing = testListingWithCount({ listing_type: "daily" });
    const line = blankLine({
      existingBooking: bookingRow({
        end_at: null,
        listing_id: dailyListing.id,
        start_at: "2026-06-14",
      }),
      listing: dailyListing,
      listingId: dailyListing.id,
    });
    const result = resolveDailyDefaults([line]);
    expect(result.hasMixedTimings).toBe(false);
    expect(result.inheritedDate).toBe("2026-06-14");
    expect(result.inheritedDurationDays).toBe(1);
  });
});

function parsedBase() {
  return {
    action: { kind: "save" } as const,
    address: "",
    email: "",
    name: "Test",
    phone: "",
    remainingBalance: 0,
    returnUrl: "",
    special_instructions: "",
    statusId: null,
  };
}

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
    // £10 order, only the £1 deposit paid, balance wrongly cleared to £0.
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
