import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { EVENT_TABLE_COLUMNS } from "#lib/columns/event-columns.ts";
import { ATTENDEE_TABLE_COLUMNS } from "#lib/columns/attendee-columns.ts";
import type { AttendeeTableRow } from "#lib/types.ts";
import type { AttendeeColumnOpts } from "#templates/attendee-table.tsx";
import {
  setupTestEncryptionKey,
  testAttendee,
  testEventWithCount,
} from "#test-utils";

setupTestEncryptionKey();

describe("EVENT_TABLE_COLUMNS cell renderers", () => {
  const u = undefined as unknown;

  test("date cell formats date for display", () => {
    const col = EVENT_TABLE_COLUMNS.date!;
    expect(
      col.cell(testEventWithCount({ date: "2026-04-10T19:00:00Z" }), u),
    ).toContain("2026");
  });

  test("date cell renders empty for missing date", () => {
    const col = EVENT_TABLE_COLUMNS.date!;
    expect(col.cell(testEventWithCount({ date: "" }), u)).toBe("");
  });

  test("price cell renders Free for zero price", () => {
    expect(
      EVENT_TABLE_COLUMNS.price!.cell(testEventWithCount({ unit_price: 0 }), u),
    ).toBe("Free");
  });

  test("status cell shows Active or Inactive", () => {
    expect(
      EVENT_TABLE_COLUMNS.status!.cell(
        testEventWithCount({ active: true }),
        u,
      ),
    ).toBe("Active");
    expect(
      EVENT_TABLE_COLUMNS.status!.cell(
        testEventWithCount({ active: false }),
        u,
      ),
    ).toBe("Inactive");
  });

  test("attendees cell shows count vs capacity", () => {
    expect(
      EVENT_TABLE_COLUMNS.attendees!.cell(
        testEventWithCount({ attendee_count: 5, max_attendees: 20 }),
        u,
      ),
    ).toBe("5 / 20");
  });
});

describe("ATTENDEE_TABLE_COLUMNS cell renderers", () => {
  const opts: AttendeeColumnOpts = {
    allowedDomain: "example.com",
    phonePrefix: "44",
    renderStatus: () => "",
    renderActions: () => "",
    answerTextMap: new Map(),
    answerQuestionMap: new Map(),
  };
  const makeRow = (
    overrides: Partial<AttendeeTableRow> = {},
  ): AttendeeTableRow => ({
    attendee: testAttendee(),
    eventId: 1,
    eventName: "Test Event",
    ...overrides,
  });

  test("event cell renders link to admin event page", () => {
    const html = ATTENDEE_TABLE_COLUMNS.event!.cell(
      makeRow({ eventName: "Gala", eventId: 42 }),
      opts,
    );
    expect(html).toContain("/admin/event/42");
    expect(html).toContain("Gala");
  });

  test("date cell formats date labels", () => {
    expect(
      ATTENDEE_TABLE_COLUMNS.date!.cell(
        makeRow({ attendee: testAttendee({ date: "2026-03-15" }) }),
        opts,
      ),
    ).toContain("March");
  });

  test("date cell renders empty for null date", () => {
    expect(
      ATTENDEE_TABLE_COLUMNS.date!.cell(
        makeRow({ attendee: testAttendee({ date: null }) }),
        opts,
      ),
    ).toBe("");
  });

  test("phone cell renders clickable tel link with normalized number", () => {
    const html = ATTENDEE_TABLE_COLUMNS.phone!.cell(
      makeRow({ attendee: testAttendee({ phone: "07700 900000" }) }),
      opts,
    );
    expect(html).toContain("tel:+447700900000");
    expect(html).toContain("07700 900000");
  });

  test("phone cell renders empty when not provided", () => {
    expect(
      ATTENDEE_TABLE_COLUMNS.phone!.cell(
        makeRow({ attendee: testAttendee({ phone: "" }) }),
        opts,
      ),
    ).toBe("");
  });

  test("phone cell defaults to prefix 44 when phonePrefix is empty", () => {
    const html = ATTENDEE_TABLE_COLUMNS.phone!.cell(
      makeRow({ attendee: testAttendee({ phone: "07700 900000" }) }),
      { ...opts, phonePrefix: "" },
    );
    expect(html).toContain("tel:+447700900000");
  });

  test("address cell formats multi-line address inline", () => {
    expect(
      ATTENDEE_TABLE_COLUMNS.address!.cell(
        makeRow({ attendee: testAttendee({ address: "123 Main\nNew York" }) }),
        opts,
      ),
    ).toContain("123 Main");
  });

  test("special_instructions cell collapses newlines", () => {
    expect(
      ATTENDEE_TABLE_COLUMNS.special_instructions!.cell(
        makeRow({
          attendee: testAttendee({ special_instructions: "VIP\nfront row" }),
        }),
        opts,
      ),
    ).toContain("VIP");
  });

  test("special_instructions cell renders empty when not provided", () => {
    expect(
      ATTENDEE_TABLE_COLUMNS.special_instructions!.cell(
        makeRow({ attendee: testAttendee({ special_instructions: "" }) }),
        opts,
      ),
    ).toBe("");
  });

  test("ticket cell renders full URL with domain and token", () => {
    expect(
      ATTENDEE_TABLE_COLUMNS.ticket!.cell(
        makeRow({ attendee: testAttendee({ ticket_token: "abc123" }) }),
        opts,
      ),
    ).toContain("example.com/t/abc123");
  });

  test("registered cell renders formatted datetime", () => {
    expect(
      ATTENDEE_TABLE_COLUMNS.registered!.cell(
        makeRow({
          attendee: testAttendee({ created: "2026-01-01T12:00:00Z" }),
        }),
        opts,
      ),
    ).toContain("2026");
  });
});
