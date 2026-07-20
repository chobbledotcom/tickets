import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getCurrentCsrfToken } from "#shared/csrf.ts";
import { AttendeeTable } from "#templates/attendee-table.tsx";
import { hasInputWithValue } from "#test-utils/csrf.ts";
import { testAttendee } from "#test-utils/factories.ts";
import {
  attendeeTableSuite,
  makeOpts,
  makeRow,
  zaraAliceRows,
} from "./shared.ts";

attendeeTableSuite(() => {
  describe("check-in button", () => {
    test("shows Check in for an unchecked attendee", () => {
      const attendee = testAttendee({ checked_in: false });
      const html = AttendeeTable(makeOpts({ rows: [makeRow({ attendee })] }));
      expect(html).toContain("Check in");
      expect(html).toContain('class="link-button checkin"');
    });

    test("shows Check out for a checked-in attendee", () => {
      const attendee = testAttendee({ checked_in: true });
      const html = AttendeeTable(makeOpts({ rows: [makeRow({ attendee })] }));
      expect(html).toContain("Check out");
      expect(html).toContain('class="link-button checkout"');
    });

    test("includes the current CSRF token", () => {
      expect(
        hasInputWithValue(
          AttendeeTable(makeOpts()),
          "csrf_token",
          getCurrentCsrfToken(),
        ),
      ).toBe(true);
    });

    test("acts on the row's own listing", () => {
      const rows = [makeRow({ listings: [{ id: 42, name: "Test Listing" }] })];
      expect(AttendeeTable(makeOpts({ rows }))).toContain(
        "/admin/listing/42/attendee/1/checkin",
      );
    });

    test("includes activeFilter as return_filter", () => {
      const html = AttendeeTable(makeOpts({ activeFilter: "in" }));
      expect(hasInputWithValue(html, "return_filter", "in")).toBe(true);
    });

    test("includes return_url when provided", () => {
      const html = AttendeeTable(makeOpts({ returnUrl: "/checkin/abc" }));
      expect(hasInputWithValue(html, "return_url", "/checkin/abc")).toBe(true);
    });

    test("omits return_url when not provided", () => {
      expect(AttendeeTable(makeOpts())).not.toContain("return_url");
    });
  });

  describe("row state", () => {
    test("does not render moved refund or delete actions", () => {
      const attendee = testAttendee({ payment_id: "pay_123" });
      const html = AttendeeTable(makeOpts({ rows: [makeRow({ attendee })] }));
      expect(html).not.toContain("/refund");
      expect(html).not.toContain("/delete");
    });

    test("shows Refunded for a refunded attendee", () => {
      const attendee = testAttendee({ refunded: true });
      expect(
        AttendeeTable(makeOpts({ rows: [makeRow({ attendee })] })),
      ).toContain("Refunded");
    });

    test("does not show check-in actions for a refunded attendee", () => {
      const attendee = testAttendee({ refunded: true });
      const html = AttendeeTable(makeOpts({ rows: [makeRow({ attendee })] }));
      expect(html).not.toContain("Check in");
      expect(html).not.toContain("Check out");
    });

    test("shows Check in for a non-refunded attendee", () => {
      const attendee = testAttendee({ refunded: false });
      const html = AttendeeTable(makeOpts({ rows: [makeRow({ attendee })] }));
      expect(html).toContain("Check in");
      expect(html).not.toContain("Refunded");
    });

    test("shows No quantity instead of live actions and ticket link", () => {
      const attendee = testAttendee({
        quantity: 0,
        ticket_token: "ghost-token",
      });
      const html = AttendeeTable(makeOpts({ rows: [makeRow({ attendee })] }));
      expect(html).toContain("No quantity");
      expect(html).not.toContain("/attendee/1/checkin");
      expect(html).not.toContain("/t/ghost-token");
    });
  });

  describe("empty state", () => {
    test("shows the default empty message", () => {
      expect(AttendeeTable(makeOpts({ rows: [] }))).toContain(
        "No attendees yet",
      );
    });

    test("shows a custom empty message", () => {
      expect(
        AttendeeTable(makeOpts({ emptyMessage: "Select a date", rows: [] })),
      ).toContain("Select a date");
    });

    test("uses the minimal column count", () => {
      const html = AttendeeTable(
        makeOpts({ rows: [], showDate: false, showListing: false }),
      );
      expect(html).toContain('colspan="5"');
    });

    test("counts optional visible columns", () => {
      const html = AttendeeTable(
        makeOpts({ rows: [], showDate: true, showListing: true }),
      );
      expect(html).toContain('colspan="7"');
    });
  });

  describe("showCheckin option", () => {
    test("hides check-in when false", () => {
      expect(AttendeeTable(makeOpts({ showCheckin: false }))).not.toContain(
        "Check in",
      );
    });

    test("retains data columns when false", () => {
      const html = AttendeeTable(makeOpts({ showCheckin: false }));
      expect(html).toContain("John Doe");
      expect(html).toContain("test-token-1");
    });

    test("shows check-in by default", () => {
      expect(AttendeeTable(makeOpts())).toContain("Check in");
    });

    test("drops the status column from empty colspan when false", () => {
      const html = AttendeeTable(makeOpts({ rows: [], showCheckin: false }));
      expect(html).toContain('colspan="4"');
    });
  });

  describe("presorted option", () => {
    test("preserves row order when true", () => {
      const html = AttendeeTable(
        makeOpts({ presorted: true, rows: zaraAliceRows(), showListing: true }),
      );
      expect(html.indexOf("Zara")).toBeLessThan(html.indexOf("Alice"));
    });

    test("sorts rows by default", () => {
      const html = AttendeeTable(
        makeOpts({ rows: zaraAliceRows(), showListing: true }),
      );
      expect(html.indexOf("Alice")).toBeLessThan(html.indexOf("Zara"));
    });
  });
});
