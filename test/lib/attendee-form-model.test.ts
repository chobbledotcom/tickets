import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  ADD_LINE_ACTION,
  bookingDurationDays,
  buildLineKey,
  parseAttendeeForm,
  resolveDailyDefaults,
  trimTrailingBlankLines,
  validateParsedForm,
  type AttendeeFormLine,
} from "#routes/admin/attendee-form-model.ts";
import type { Holiday } from "#shared/types.ts";
import { FormParams } from "#shared/form-data.ts";
import { testEventWithCount } from "#test-utils";
import type { EventAttendeeRow } from "#shared/db/attendee-types.ts";

const makeForm = (data: Record<string, string>): FormParams =>
  new FormParams(new URLSearchParams(data));

const blankLine = (overrides: Partial<AttendeeFormLine> = {}): AttendeeFormLine => ({
  date: "",
  error: null,
  event: null,
  eventId: 0,
  existingBooking: null,
  key: "",
  quantity: 1,
  ...overrides,
});

const bookingRow = (overrides: Partial<EventAttendeeRow> = {}): EventAttendeeRow => ({
  attachment_downloads: 0,
  checked_in: 0,
  end_at: null,
  event_id: 1,
  price_paid: 0,
  quantity: 1,
  refunded: 0,
  start_at: null,
  ...overrides,
});

describe("buildLineKey", () => {
  test("round-trips event id and start_at via the canonical key string", () => {
    const key = buildLineKey(42, "2026-06-14T00:00:00Z");
    expect(key).toBe("42|2026-06-14T00:00:00Z");
  });

  test("handles null start_at (standard events)", () => {
    const key = buildLineKey(7, null);
    expect(key).toBe("7|");
  });
});

describe("trimTrailingBlankLines", () => {
  test("removes a single trailing blank line", () => {
    const lines = [
      blankLine({ eventId: 1, event: testEventWithCount({ id: 1 }) }),
      blankLine(),
    ];
    expect(trimTrailingBlankLines(lines)).toHaveLength(1);
  });

  test("removes consecutive trailing blank lines", () => {
    const lines = [
      blankLine({ eventId: 1, event: testEventWithCount({ id: 1 }) }),
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
    const filled = blankLine({ eventId: 1, event: testEventWithCount({ id: 1 }) });
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
    expect(parsed.lines[0]!.eventId).toBe(5);
    expect(parsed.lines[0]!.quantity).toBe(2);
    expect(parsed.lines[0]!.key).toBe("5|");
    expect(parsed.lines[0]!.event).toBeNull();
    expect(parsed.action.kind).toBe("save");
  });

  test("resolves event references against the provided map", () => {
    const event = testEventWithCount({ id: 7, name: "Resolved" });
    const form = makeForm({
      line_count: "1",
      line_event_id_0: "7",
      line_quantity_0: "1",
      name: "X",
    });
    const parsed = parseAttendeeForm(form, new Map([[7, event]]));
    expect(parsed.lines[0]!.event?.name).toBe("Resolved");
  });

  test("treats non-numeric or missing event_id as blank line (eventId 0)", () => {
    const form = makeForm({
      line_count: "1",
      line_event_id_0: "not-a-number",
      line_quantity_0: "1",
      name: "X",
    });
    expect(parseAttendeeForm(form, new Map()).lines[0]!.eventId).toBe(0);
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
    expect(parseAttendeeForm(addForm, new Map()).action).toEqual({ kind: "add_line" });

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

  test("attaches existing booking rows by key", () => {
    const booking = bookingRow({ event_id: 5, quantity: 3 });
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
    const parsed = parseAttendeeForm(makeForm({ name: "", line_count: "1" }), new Map());
    const result = validateParsedForm(parsed, []);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.attendeeError?.field).toBe("name");
    }
  });

  test("passes for a valid line pointing at an active event", () => {
    const event = testEventWithCount({ id: 1, active: true, max_quantity: 5 });
    const parsed = parseAttendeeForm(
      makeForm({
        line_count: "1",
        line_event_id_0: "1",
        line_quantity_0: "2",
        name: "Jane",
      }),
      new Map([[1, event]]),
    );
    const result = validateParsedForm(parsed, []);
    expect(result.valid).toBe(true);
  });

  test("fails when selected event is unknown", () => {
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
    const event = testEventWithCount({ id: 1, active: true });
    const parsed = parseAttendeeForm(
      makeForm({
        line_count: "1",
        line_event_id_0: "1",
        line_quantity_0: "0",
        name: "Jane",
      }),
      new Map([[1, event]]),
    );
    const result = validateParsedForm(parsed, []);
    expect(result.valid).toBe(false);
  });

  test("fails when quantity exceeds event max_quantity", () => {
    const event = testEventWithCount({ id: 1, active: true, max_quantity: 5 });
    const parsed = parseAttendeeForm(
      makeForm({
        line_count: "1",
        line_event_id_0: "1",
        line_quantity_0: "10",
        name: "Jane",
      }),
      new Map([[1, event]]),
    );
    const result = validateParsedForm(parsed, []);
    expect(result.valid).toBe(false);
  });

  test("fails when daily event is selected but date is missing", () => {
    const event = testEventWithCount({
      bookable_days: ["Monday"],
      duration_days: 1,
      event_type: "daily",
      id: 1,
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
      new Map([[1, event]]),
    );
    const result = validateParsedForm(parsed, []);
    expect(result.valid).toBe(false);
  });

  test("fails on duplicate (event_id, date) pairs", () => {
    const event = testEventWithCount({ id: 1, active: true });
    const parsed = parseAttendeeForm(
      makeForm({
        line_count: "2",
        line_event_id_0: "1",
        line_event_id_1: "1",
        line_quantity_0: "1",
        line_quantity_1: "1",
        name: "Jane",
      }),
      new Map([[1, event]]),
    );
    const result = validateParsedForm(parsed, []);
    expect(result.valid).toBe(false);
  });

  test("allows trailing blank lines (the placeholder row)", () => {
    const event = testEventWithCount({ id: 1, active: true });
    const parsed = parseAttendeeForm(
      makeForm({
        line_count: "2",
        line_event_id_0: "1",
        line_event_id_1: "",
        line_quantity_0: "1",
        line_quantity_1: "",
        name: "Jane",
      }),
      new Map([[1, event]]),
    );
    const trimmed = { ...parsed, lines: trimTrailingBlankLines(parsed.lines) };
    const result = validateParsedForm(trimmed, []);
    expect(result.valid).toBe(true);
  });

  test("ignores inactive event when validation runs", () => {
    const event = testEventWithCount({ id: 1, active: false });
    const parsed = parseAttendeeForm(
      makeForm({
        line_count: "1",
        line_event_id_0: "1",
        line_quantity_0: "1",
        name: "Jane",
      }),
      new Map([[1, event]]),
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
    const event = testEventWithCount({
      event_type: "daily",
      id: 1,
    });
    const booking = bookingRow({
      end_at: "2026-06-15T00:00:00.000Z",
      event_id: 1,
      start_at: "2026-06-14T00:00:00Z",
    });
    const line = blankLine({
      event,
      eventId: 1,
      existingBooking: booking,
      key: "1|2026-06-14T00:00:00Z",
    });
    const result = resolveDailyDefaults([line]);
    expect(result.hasMixedTimings).toBe(false);
    expect(result.inheritedDate).toBe("2026-06-14");
    expect(result.inheritedDurationDays).toBe(1);
  });

  test("flags mixed daily timings (different start dates)", () => {
    const event = testEventWithCount({
      event_type: "daily",
      id: 1,
    });
    const lineA = blankLine({
      event,
      eventId: 1,
      existingBooking: bookingRow({
        end_at: "2026-06-15T00:00:00.000Z",
        event_id: 1,
        start_at: "2026-06-14T00:00:00Z",
      }),
      key: "1|2026-06-14T00:00:00Z",
    });
    const lineB = blankLine({
      event,
      eventId: 1,
      existingBooking: bookingRow({
        end_at: "2026-07-02T00:00:00.000Z",
        event_id: 1,
        start_at: "2026-07-01T00:00:00Z",
      }),
      key: "1|2026-07-01T00:00:00Z",
    });
    const result = resolveDailyDefaults([lineA, lineB]);
    expect(result.hasMixedTimings).toBe(true);
    expect(result.inheritedDate).toBeNull();
  });

  test("flags mixed daily timings (different durations)", () => {
    const event = testEventWithCount({
      event_type: "daily",
      id: 1,
    });
    const lineA = blankLine({
      event,
      eventId: 1,
      existingBooking: bookingRow({
        end_at: "2026-06-15T00:00:00.000Z",
        event_id: 1,
        start_at: "2026-06-14T00:00:00Z",
      }),
      key: "1|2026-06-14T00:00:00Z",
    });
    const lineB = blankLine({
      event,
      eventId: 1,
      existingBooking: bookingRow({
        end_at: "2026-06-17T00:00:00.000Z",
        event_id: 1,
        start_at: "2026-06-14T00:00:00Z",
      }),
      key: "1|2026-06-14T00:00:00Z",
    });
    const result = resolveDailyDefaults([lineA, lineB]);
    expect(result.hasMixedTimings).toBe(true);
  });

  test("ignores standard-event bookings when computing daily defaults", () => {
    const standardEvent = testEventWithCount({
      event_type: "standard",
      id: 1,
    });
    const line = blankLine({
      event: standardEvent,
      eventId: 1,
      existingBooking: bookingRow({ event_id: 1 }),
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
  test("rejects an invalid date string for a daily event", () => {
    const dailyEvent = {
      ...testEventWithCount({ event_type: "daily" }),
      bookableDays: ["2026-06-15"],
      duration_days: 1,
    };
    const holidays: Holiday[] = [];
    const line = blankLine({
      date: "not-a-date",
      event: dailyEvent,
      eventId: dailyEvent.id,
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
    const dailyEvent = {
      ...testEventWithCount({
        bookable_days: [],
        event_type: "daily",
      }),
      duration_days: 1,
    };
    const holidays: Holiday[] = [];
    const line = blankLine({
      date: "2026-06-20",
      event: dailyEvent,
      eventId: dailyEvent.id,
      quantity: 1,
    });
    const result = validateParsedForm(
      { ...parsedBase(), lines: [line] },
      holidays,
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.lineErrors.get(0)).toBe(
        "Date is not bookable for this event",
      );
    }
  });
});

describe("bookingDurationDays", () => {
  test("returns null when start_at is missing", () => {
    const row = bookingRow({ start_at: null, end_at: "2026-06-14" });
    expect(bookingDurationDays(row)).toBeNull();
  });

  test("returns null when end_at is missing", () => {
    const row = bookingRow({ start_at: "2026-06-14", end_at: null });
    expect(bookingDurationDays(row)).toBeNull();
  });

  test("returns null for invalid date strings", () => {
    const row = bookingRow({ start_at: "invalid", end_at: "also-invalid" });
    expect(bookingDurationDays(row)).toBeNull();
  });

  test("returns null when computed duration is less than 1 day", () => {
    const row = bookingRow({
      start_at: "2026-06-14T00:00:00Z",
      end_at: "2026-06-14T00:00:00Z",
    });
    expect(bookingDurationDays(row)).toBeNull();
  });
});

describe("resolveDailyDefaults fallback", () => {
  test("falls back to duration 1 when existing daily booking has invalid duration", () => {
    const dailyEvent = testEventWithCount({ event_type: "daily" });
    const line = blankLine({
      event: dailyEvent,
      eventId: dailyEvent.id,
      existingBooking: bookingRow({
        end_at: null,
        event_id: dailyEvent.id,
        start_at: "2026-06-14",
      }),
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
    returnUrl: "",
    special_instructions: "",
  };
}
