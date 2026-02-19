import { describe, expect, test } from "#test-compat";
import { AttendeeTable, type AttendeeTableOptions, type AttendeeTableRow, formatAddressInline, sortAttendeeRows } from "#templates/attendee-table.tsx";
import { testAttendee } from "#test-utils";

const CSRF_TOKEN = "test-csrf-token";
const ALLOWED_DOMAIN = "example.com";

const makeRow = (overrides: Partial<AttendeeTableRow> = {}): AttendeeTableRow => ({
  attendee: testAttendee(),
  eventId: 1,
  eventName: "Test Event",
  hasPaidEvent: false,
  ...overrides,
});

const makeOpts = (overrides: Partial<AttendeeTableOptions> = {}): AttendeeTableOptions => ({
  rows: [makeRow()],
  allowedDomain: ALLOWED_DOMAIN,
  csrfToken: CSRF_TOKEN,
  showEvent: false,
  showDate: false,
  ...overrides,
});

describe("AttendeeTable", () => {
  describe("always-visible columns", () => {
    test("renders check-in button column", () => {
      const html = AttendeeTable(makeOpts());
      expect(html).toContain("Check in");
      expect(html).toContain("/checkin");
    });

    test("renders Name column", () => {
      const html = AttendeeTable(makeOpts());
      expect(html).toContain("<th>Name</th>");
      expect(html).toContain("John Doe");
    });

    test("renders Qty column", () => {
      const html = AttendeeTable(makeOpts());
      expect(html).toContain("<th>Qty</th>");
    });

    test("renders Ticket column with link", () => {
      const html = AttendeeTable(makeOpts());
      expect(html).toContain("<th>Ticket</th>");
      expect(html).toContain(`https://${ALLOWED_DOMAIN}/t/test-token-1`);
      expect(html).toContain("test-token-1");
    });

    test("renders Registered column", () => {
      const html = AttendeeTable(makeOpts());
      expect(html).toContain("<th>Registered</th>");
    });

    test("renders Actions column with Edit and Delete", () => {
      const html = AttendeeTable(makeOpts());
      expect(html).toContain("/admin/attendees/1");
      expect(html).toContain("Edit");
      expect(html).toContain("Delete");
      expect(html).toContain("Re-send Webhook");
    });
  });

  describe("column order", () => {
    test("renders columns in correct order", () => {
      const rows = [makeRow({
        attendee: testAttendee({ email: "a@b.com", phone: "555", address: "123 Main", special_instructions: "VIP" }),
        eventName: "Gala",
      })];
      const html = AttendeeTable(makeOpts({ rows, showEvent: true, showDate: true }));
      const headers = [...html.matchAll(/<th>(.*?)<\/th>/g)].map(m => m[1]);
      // Empty headers are for Checked In (first) and Actions (last)
      expect(headers).toEqual(["", "Event", "Date", "Name", "Email", "Phone", "Address", "Special Instructions", "Qty", "Ticket", "Registered", ""]);
    });
  });

  describe("Event column", () => {
    test("hidden when showEvent is false", () => {
      const html = AttendeeTable(makeOpts({ showEvent: false }));
      expect(html).not.toContain("<th>Event</th>");
    });

    test("shown with linked event name when showEvent is true", () => {
      const rows = [makeRow({ eventName: "Test Gala", eventId: 42 })];
      const html = AttendeeTable(makeOpts({ rows, showEvent: true }));
      expect(html).toContain("<th>Event</th>");
      expect(html).toContain("/admin/event/42");
      expect(html).toContain("Test Gala");
    });
  });

  describe("Date column", () => {
    test("hidden when showDate is false", () => {
      const html = AttendeeTable(makeOpts({ showDate: false }));
      expect(html).not.toContain("<th>Date</th>");
    });

    test("shown when showDate is true", () => {
      const rows = [makeRow({ attendee: testAttendee({ date: "2026-03-15" }) })];
      const html = AttendeeTable(makeOpts({ rows, showDate: true }));
      expect(html).toContain("<th>Date</th>");
    });
  });

  describe("Email column", () => {
    test("hidden when no attendees have email", () => {
      const rows = [makeRow({ attendee: testAttendee({ email: "" }) })];
      const html = AttendeeTable(makeOpts({ rows }));
      expect(html).not.toContain("<th>Email</th>");
    });

    test("shown when at least one attendee has email", () => {
      const rows = [
        makeRow({ attendee: testAttendee({ email: "" }) }),
        makeRow({ attendee: testAttendee({ email: "test@example.com" }) }),
      ];
      const html = AttendeeTable(makeOpts({ rows }));
      expect(html).toContain("<th>Email</th>");
      expect(html).toContain("test@example.com");
    });
  });

  describe("Phone column", () => {
    test("hidden when no attendees have phone", () => {
      const rows = [makeRow({ attendee: testAttendee({ phone: "" }) })];
      const html = AttendeeTable(makeOpts({ rows }));
      expect(html).not.toContain("<th>Phone</th>");
    });

    test("shown when at least one attendee has phone", () => {
      const rows = [makeRow({ attendee: testAttendee({ phone: "555-1234" }) })];
      const html = AttendeeTable(makeOpts({ rows }));
      expect(html).toContain("<th>Phone</th>");
      expect(html).toContain("555-1234");
    });

    test("renders empty cell for attendee without phone when column is shown", () => {
      const rows = [
        makeRow({ attendee: testAttendee({ phone: "555-1234" }) }),
        makeRow({ attendee: testAttendee({ phone: "" }) }),
      ];
      const html = AttendeeTable(makeOpts({ rows }));
      expect(html).toContain("<th>Phone</th>");
      // Two phone cells: one with data, one empty
      const phoneCells = html.match(/<td>555-1234<\/td>/g);
      expect(phoneCells).toHaveLength(1);
    });
  });

  describe("Address column", () => {
    test("hidden when no attendees have address", () => {
      const rows = [makeRow({ attendee: testAttendee({ address: "" }) })];
      const html = AttendeeTable(makeOpts({ rows }));
      expect(html).not.toContain("<th>Address</th>");
    });

    test("shown when at least one attendee has address", () => {
      const rows = [makeRow({ attendee: testAttendee({ address: "123 Main St" }) })];
      const html = AttendeeTable(makeOpts({ rows }));
      expect(html).toContain("<th>Address</th>");
      expect(html).toContain("123 Main St");
    });
  });

  describe("Special Instructions column", () => {
    test("hidden when no attendees have special instructions", () => {
      const rows = [makeRow({ attendee: testAttendee({ special_instructions: "" }) })];
      const html = AttendeeTable(makeOpts({ rows }));
      expect(html).not.toContain("<th>Special Instructions</th>");
    });

    test("shown when at least one attendee has special instructions", () => {
      const rows = [makeRow({ attendee: testAttendee({ special_instructions: "Vegetarian" }) })];
      const html = AttendeeTable(makeOpts({ rows }));
      expect(html).toContain("<th>Special Instructions</th>");
      expect(html).toContain("Vegetarian");
    });

    test("renders single-line instructions and empty cell when column is shown", () => {
      const rows = [
        makeRow({ attendee: testAttendee({ special_instructions: "Line 1\nLine 2" }) }),
        makeRow({ attendee: testAttendee({ special_instructions: "" }) }),
      ];
      const html = AttendeeTable(makeOpts({ rows }));
      expect(html).toContain("<th>Special Instructions</th>");
      expect(html).toContain("Line 1 Line 2");
      expect(html).not.toContain("Line 1, Line 2");
    });
  });

  describe("check-in button", () => {
    test("shows Check in for unchecked attendee", () => {
      const rows = [makeRow({ attendee: testAttendee({ checked_in: "false" }) })];
      const html = AttendeeTable(makeOpts({ rows }));
      expect(html).toContain("Check in");
      expect(html).toContain('class="link-button checkin"');
    });

    test("shows Check out for checked-in attendee", () => {
      const rows = [makeRow({ attendee: testAttendee({ checked_in: "true" }) })];
      const html = AttendeeTable(makeOpts({ rows }));
      expect(html).toContain("Check out");
      expect(html).toContain('class="link-button checkout"');
    });

    test("includes csrf token in form", () => {
      const html = AttendeeTable(makeOpts());
      expect(html).toContain(`value="${CSRF_TOKEN}"`);
    });

    test("form action points to correct endpoint", () => {
      const rows = [makeRow({ eventId: 42 })];
      const html = AttendeeTable(makeOpts({ rows }));
      expect(html).toContain("/admin/event/42/attendee/1/checkin");
    });

    test("includes activeFilter as return_filter", () => {
      const html = AttendeeTable(makeOpts({ activeFilter: "in" }));
      expect(html).toContain('name="return_filter" value="in"');
    });
  });

  describe("actions", () => {
    test("shows Refund link when hasPaidEvent and attendee has payment_id", () => {
      const rows = [makeRow({
        hasPaidEvent: true,
        attendee: testAttendee({ payment_id: "pay_123" }),
      })];
      const html = AttendeeTable(makeOpts({ rows }));
      expect(html).toContain("Refund");
      expect(html).toContain("/refund");
    });

    test("hides Refund link when hasPaidEvent is false", () => {
      const rows = [makeRow({
        hasPaidEvent: false,
        attendee: testAttendee({ payment_id: "pay_123" }),
      })];
      const html = AttendeeTable(makeOpts({ rows }));
      expect(html).not.toContain("Refund");
    });

    test("hides Refund link when attendee has no payment_id", () => {
      const rows = [makeRow({
        hasPaidEvent: true,
        attendee: testAttendee({ payment_id: "" }),
      })];
      const html = AttendeeTable(makeOpts({ rows }));
      expect(html).not.toContain("Refund");
    });
  });

  describe("return_url", () => {
    test("appends return_url to action links when provided", () => {
      const html = AttendeeTable(makeOpts({ returnUrl: "/checkin/abc" }));
      expect(html).toContain("return_url=%2Fcheckin%2Fabc");
    });

    test("includes return_url as hidden form field in check-in form", () => {
      const html = AttendeeTable(makeOpts({ returnUrl: "/checkin/abc" }));
      expect(html).toContain('name="return_url" value="/checkin/abc"');
    });

    test("does not include return_url when not provided", () => {
      const html = AttendeeTable(makeOpts({ returnUrl: undefined }));
      expect(html).not.toContain("return_url");
    });
  });

  describe("empty state", () => {
    test("shows default empty message when no rows", () => {
      const html = AttendeeTable(makeOpts({ rows: [] }));
      expect(html).toContain("No attendees yet");
    });

    test("shows custom empty message when provided", () => {
      const html = AttendeeTable(makeOpts({ rows: [], emptyMessage: "Select a date" }));
      expect(html).toContain("Select a date");
    });

    test("empty row has correct colspan for minimal columns", () => {
      const html = AttendeeTable(makeOpts({ rows: [], showEvent: false, showDate: false }));
      expect(html).toContain('colspan="6"');
    });

    test("empty row colspan includes optional visible columns", () => {
      const html = AttendeeTable(makeOpts({ rows: [], showEvent: true, showDate: true }));
      expect(html).toContain('colspan="8"');
    });
  });
});

describe("sortAttendeeRows", () => {
  test("sorts by event date ascending, null dates last", () => {
    const rows = [
      makeRow({ attendee: testAttendee({ id: 1, date: null }), eventName: "A" }),
      makeRow({ attendee: testAttendee({ id: 2, date: "2026-03-01" }), eventName: "A" }),
      makeRow({ attendee: testAttendee({ id: 3, date: "2026-01-15" }), eventName: "A" }),
    ];
    const sorted = sortAttendeeRows(rows);
    expect(sorted.map((r) => r.attendee.id)).toEqual([3, 2, 1]);
  });

  test("sorts by event name when dates are equal", () => {
    const rows = [
      makeRow({ attendee: testAttendee({ id: 1, date: "2026-03-01" }), eventName: "Zebra" }),
      makeRow({ attendee: testAttendee({ id: 2, date: "2026-03-01" }), eventName: "Alpha" }),
    ];
    const sorted = sortAttendeeRows(rows);
    expect(sorted.map((r) => r.attendee.id)).toEqual([2, 1]);
  });

  test("sorts by attendee name when date and event name are equal", () => {
    const rows = [
      makeRow({ attendee: testAttendee({ id: 1, name: "Zara" }), eventName: "Gala" }),
      makeRow({ attendee: testAttendee({ id: 2, name: "Alice" }), eventName: "Gala" }),
    ];
    const sorted = sortAttendeeRows(rows);
    expect(sorted.map((r) => r.attendee.id)).toEqual([2, 1]);
  });

  test("sorts by id when all other fields are equal", () => {
    const rows = [
      makeRow({ attendee: testAttendee({ id: 5, name: "Sam" }), eventName: "Gala" }),
      makeRow({ attendee: testAttendee({ id: 2, name: "Sam" }), eventName: "Gala" }),
    ];
    const sorted = sortAttendeeRows(rows);
    expect(sorted.map((r) => r.attendee.id)).toEqual([2, 5]);
  });

  test("applies full multi-key sort order", () => {
    const rows = [
      makeRow({ attendee: testAttendee({ id: 1, name: "Bob", date: "2026-02-01" }), eventName: "Concert" }),
      makeRow({ attendee: testAttendee({ id: 2, name: "Alice", date: null }), eventName: "Gala" }),
      makeRow({ attendee: testAttendee({ id: 3, name: "Alice", date: "2026-01-15" }), eventName: "Concert" }),
      makeRow({ attendee: testAttendee({ id: 4, name: "Alice", date: "2026-02-01" }), eventName: "Concert" }),
    ];
    const sorted = sortAttendeeRows(rows);
    // date 2026-01-15 first, then 2026-02-01 (Alice before Bob by name), then null date last
    expect(sorted.map((r) => r.attendee.id)).toEqual([3, 4, 1, 2]);
  });

  test("does not mutate the original array", () => {
    const rows = [
      makeRow({ attendee: testAttendee({ id: 2 }), eventName: "B" }),
      makeRow({ attendee: testAttendee({ id: 1 }), eventName: "A" }),
    ];
    const original = [...rows];
    sortAttendeeRows(rows);
    expect(rows.map((r) => r.attendee.id)).toEqual(original.map((r) => r.attendee.id));
  });
});

describe("AttendeeTable sorting", () => {
  test("renders rows in sorted order", () => {
    const rows = [
      makeRow({ attendee: testAttendee({ id: 1, name: "Zara" }), eventName: "B Event" }),
      makeRow({ attendee: testAttendee({ id: 2, name: "Alice" }), eventName: "A Event" }),
    ];
    const html = AttendeeTable(makeOpts({ rows, showEvent: true }));
    const nameIdx1 = html.indexOf("Alice");
    const nameIdx2 = html.indexOf("Zara");
    expect(nameIdx1).toBeLessThan(nameIdx2);
  });
});

describe("formatAddressInline", () => {
  test("returns empty string for empty input", () => {
    expect(formatAddressInline("")).toBe("");
  });

  test("joins multi-line address with commas", () => {
    expect(formatAddressInline("123 Main St\nApt 4\nNew York")).toBe("123 Main St, Apt 4, New York");
  });

  test("preserves existing trailing comma", () => {
    expect(formatAddressInline("123 Main St,\nNew York")).toBe("123 Main St, New York");
  });

  test("trims whitespace from lines", () => {
    expect(formatAddressInline("  123 Main St  \n  New York  ")).toBe("123 Main St, New York");
  });

  test("filters out blank lines", () => {
    expect(formatAddressInline("123 Main St\n\nNew York")).toBe("123 Main St, New York");
  });
});
