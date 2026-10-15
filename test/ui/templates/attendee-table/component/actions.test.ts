import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getCurrentCsrfToken } from "#shared/csrf.ts";
import {
  attendeeTableSuite,
  makeOpts,
  makeRow,
  render,
  zaraAliceRows,
} from "#test/ui/templates/attendee-table/shared.ts";
import { hasInputWithValue } from "#test-utils/csrf.ts";
import { testAttendee } from "#test-utils/factories.ts";

attendeeTableSuite(() => {
  describe("check-in button", () => {
    test("shows Check in for an unchecked attendee", () => {
      const attendee = testAttendee({ checked_in: 0 });
      const html = render(makeOpts({ rows: [makeRow({ attendee })] }));
      assertStringIncludes(html, "Check in");
      assertStringIncludes(html, 'class="link-button checkin"');
    });

    test("shows Check out for a checked-in attendee", () => {
      const attendee = testAttendee({ checked_in: 1 });
      const html = render(makeOpts({ rows: [makeRow({ attendee })] }));
      assertStringIncludes(html, "Check out");
      assertStringIncludes(html, 'class="link-button checkout"');
    });

    test("includes the current CSRF token", () => {
      expect(
        hasInputWithValue(
          render(makeOpts()),
          "csrf_token",
          getCurrentCsrfToken(),
        ),
      ).toBe(true);
    });

    test("acts on the row's own listing", () => {
      const rows = [makeRow({ listings: [{ id: 42, name: "Test Listing" }] })];
      assertStringIncludes(
        render(makeOpts({ rows })),
        "/admin/listing/42/attendee/1/checkin",
      );
    });

    test("rejects a check-in row without a listing", () => {
      expect(() =>
        render(
          makeOpts({
            rows: [makeRow({ listings: [] })],
          }),
        ),
      ).toThrow("Attendee 1 has no listing");
    });

    test("includes activeFilter as return_filter", () => {
      const html = render(makeOpts({ activeFilter: "in" }));
      expect(hasInputWithValue(html, "return_filter", "in")).toBe(true);
    });

    test("includes return_url when provided", () => {
      const html = render(makeOpts({ returnUrl: "/checkin/abc" }));
      expect(hasInputWithValue(html, "return_url", "/checkin/abc")).toBe(true);
    });

    test("omits return_url when not provided", () => {
      assert(
        !render(makeOpts()).includes("return_url"),
        "the value should not contain the searched item",
      );
    });
  });

  describe("row state", () => {
    test("does not render moved refund or delete actions", () => {
      const attendee = testAttendee({ payment_id: "pay_123" });
      const html = render(makeOpts({ rows: [makeRow({ attendee })] }));
      assert(
        !html.includes("/refund"),
        "the value should not contain the searched item",
      );
      assert(
        !html.includes("/delete"),
        "the value should not contain the searched item",
      );
    });

    test("shows Refunded for a refunded attendee", () => {
      const attendee = testAttendee({ refunded: true });
      assertStringIncludes(
        render(makeOpts({ rows: [makeRow({ attendee })] })),
        '<span class="badge-alert">Refunded</span>',
      );
    });

    test("marks servicing attendee rows", () => {
      const attendee = testAttendee({ kind: "servicing" });
      assertStringIncludes(
        render(makeOpts({ rows: [makeRow({ attendee })] })),
        '<tr class="servicing-event" data-servicing="true">',
      );
    });

    test("does not show check-in actions for a refunded attendee", () => {
      const attendee = testAttendee({ refunded: true });
      const html = render(makeOpts({ rows: [makeRow({ attendee })] }));
      assert(
        !html.includes("Check in"),
        "the value should not contain the searched item",
      );
      assert(
        !html.includes("Check out"),
        "the value should not contain the searched item",
      );
    });

    test("shows Check in for a non-refunded attendee", () => {
      const attendee = testAttendee({ refunded: false });
      const html = render(makeOpts({ rows: [makeRow({ attendee })] }));
      assertStringIncludes(html, "Check in");
      assert(
        !html.includes("Refunded"),
        "the value should not contain the searched item",
      );
    });

    test("shows No quantity instead of live actions and ticket link", () => {
      const attendee = testAttendee({
        quantity: 0,
        ticket_token: "ghost-token",
      });
      const html = render(makeOpts({ rows: [makeRow({ attendee })] }));
      assertStringIncludes(html, "No quantity");
      assert(
        !html.includes("/attendee/1/checkin"),
        "the value should not contain the searched item",
      );
      assert(
        !html.includes("/t/ghost-token"),
        "the value should not contain the searched item",
      );
    });
  });

  describe("empty state", () => {
    test("shows the default empty message", () => {
      assertStringIncludes(render(makeOpts({ rows: [] })), "No attendees yet");
    });

    test("shows a custom empty message", () => {
      assertStringIncludes(
        render(makeOpts({ emptyMessage: "Select a date", rows: [] })),
        "Select a date",
      );
    });

    test("uses the minimal column count", () => {
      const html = render(
        makeOpts({ rows: [], showDate: false, showListing: false }),
      );
      assertStringIncludes(html, 'colspan="5"');
    });

    test("counts optional visible columns", () => {
      const html = render(
        makeOpts({ rows: [], showDate: true, showListing: true }),
      );
      assertStringIncludes(html, 'colspan="7"');
    });
  });

  describe("showCheckin option", () => {
    test("hides check-in when false", () => {
      assert(
        !render(makeOpts({ showCheckin: false })).includes("Check in"),
        "the value should not contain the searched item",
      );
    });

    test("retains data columns when false", () => {
      const html = render(makeOpts({ showCheckin: false }));
      assertStringIncludes(html, "John Doe");
      assertStringIncludes(html, "test-token-1");
    });

    test("shows check-in by default", () => {
      assertStringIncludes(render(makeOpts()), "Check in");
    });

    test("drops the status column from empty colspan when false", () => {
      const html = render(makeOpts({ rows: [], showCheckin: false }));
      assertStringIncludes(html, 'colspan="4"');
    });
  });

  describe("presorted option", () => {
    test("preserves row order when true", () => {
      const html = render(
        makeOpts({ presorted: true, rows: zaraAliceRows(), showListing: true }),
      );
      expect(html.indexOf("Zara")).toBeLessThan(html.indexOf("Alice"));
    });

    test("sorts rows by default", () => {
      const html = render(
        makeOpts({ rows: zaraAliceRows(), showListing: true }),
      );
      expect(html.indexOf("Alice")).toBeLessThan(html.indexOf("Zara"));
    });
  });
});
