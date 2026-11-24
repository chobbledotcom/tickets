import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as bddTest, describe } from "@std/testing/bdd";
import type { ActivityLogEntry } from "#db/activity-log.ts";
import { ErrorCode, formatErrorMessage } from "#shared/logger.ts";
import {
  type ActivityLogRefs,
  ActivityLogTable,
  adminGlobalActivityLogPage,
} from "#templates/admin/activity-log.tsx";
import { OWNER_SESSION } from "#test-utils/admin-page-test.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";
import { withCsrfRequest } from "#test-utils/csrf-request.ts";
import { testListingWithCount } from "#test-utils/factories.ts";

const test = (name: string, body: () => void | Promise<void>): void => {
  bddTest(name, () => withCsrfRequest(body));
};

/** Empty reference lookups — the global log always takes refs, even when no
 * entry links to an attendee or listing. */
const emptyRefs = (): ActivityLogRefs => ({
  attendees: { kinds: new Map(), names: new Map() },
  listings: new Map(),
});

/** Factory for an activity-log entry with defaults for every stored field. */
const logEntry = (overrides: Partial<ActivityLogEntry>): ActivityLogEntry => ({
  attendeeId: null,
  created: "2024-01-15T10:30:00Z",
  id: 1,
  listingId: null,
  message: "System started",
  ...overrides,
});

describe("activity log templates", () => {
  describe("adminGlobalActivityLogPage", () => {
    test("renders global activity log with entries", () => {
      const entries = [logEntry({ message: "System started" })];
      const html = adminGlobalActivityLogPage(
        entries,
        false,
        OWNER_SESSION,
        emptyRefs(),
      );
      expectIncludesAll(html, ["System started", "Log"]);
    });

    test("renders empty state when no entries", () => {
      const html = adminGlobalActivityLogPage(
        [],
        false,
        OWNER_SESSION,
        emptyRefs(),
      );
      assertStringIncludes(html, "No activity recorded yet");
    });

    test("shows truncation message when truncated", () => {
      const entries = [logEntry({ message: "Action" })];
      const html = adminGlobalActivityLogPage(
        entries,
        true,
        OWNER_SESSION,
        emptyRefs(),
      );
      assertStringIncludes(html, "Showing the most recent 200 entries");
    });

    test("does not show truncation message when not truncated", () => {
      const entries = [logEntry({ message: "Action" })];
      const html = adminGlobalActivityLogPage(
        entries,
        false,
        OWNER_SESSION,
        emptyRefs(),
      );
      assert(!html.includes("Showing the most recent 200 entries"));
    });

    test("prefixes Square signature errors with a link to re-do settings", () => {
      const entries = [
        logEntry({
          message: formatErrorMessage({
            code: ErrorCode.SQUARE_SIGNATURE,
            detail: "mismatch",
          }),
        }),
      ];
      const html = adminGlobalActivityLogPage(
        entries,
        false,
        OWNER_SESSION,
        emptyRefs(),
      );
      expectIncludesAll(html, [
        'href="/admin/settings#settings-square-webhook"',
        "Re-enter your Square settings",
        // The original error message is still shown after the link
        "Square signature verification failed",
      ]);
    });

    test("puts a space between the Square settings link and the message", () => {
      const message = formatErrorMessage({
        code: ErrorCode.SQUARE_SIGNATURE,
        detail: "mismatch",
      });
      const html = adminGlobalActivityLogPage(
        [logEntry({ message })],
        false,
        OWNER_SESSION,
        emptyRefs(),
      );
      assertStringIncludes(html, `</a> ${message}`);
    });

    test("shows no truncation message when the caller does not say", () => {
      const html = adminGlobalActivityLogPage(
        [logEntry({ message: "Action" })],
        undefined,
        OWNER_SESSION,
        emptyRefs(),
      );
      assert(!html.includes("Showing the most recent 200 entries"));
    });

    test("links to the activity log section of the guide", () => {
      const html = adminGlobalActivityLogPage(
        [],
        false,
        OWNER_SESSION,
        emptyRefs(),
      );
      assertStringIncludes(
        html,
        '<a class="guide-link" href="/admin/guide#activity-log">',
      );
    });

    test("does not add the Square settings link to unrelated messages", () => {
      const entries = [logEntry({ message: "Payment received" })];
      const html = adminGlobalActivityLogPage(
        entries,
        false,
        OWNER_SESSION,
        emptyRefs(),
      );
      assert(!html.includes("Re-enter your Square settings"));
    });
  });

  describe("adminGlobalActivityLogPage reference columns", () => {
    const refsWith = (
      attendees: [number, string][],
      listings: [number, string][],
    ): ActivityLogRefs => ({
      attendees: {
        kinds: new Map(attendees.map(([id]) => [id, "attendee"])),
        names: new Map(attendees),
      },
      listings: new Map(listings),
    });

    test("renders the Attendee and Listing column headers", () => {
      const html = adminGlobalActivityLogPage(
        [],
        false,
        OWNER_SESSION,
        emptyRefs(),
      );
      expectIncludesAll(html, [
        "<th>Attendee</th>",
        "<th>Listing</th>",
        // The empty-state row spans all four columns.
        'colspan="4"',
      ]);
    });

    test("links an entry to its attendee and listing by name", () => {
      const entries = [
        logEntry({
          attendeeId: 7,
          listingId: 3,
          message: "Balance updated",
        }),
      ];
      const refs = refsWith([[7, "Ada Lovelace"]], [[3, "Summer Concert"]]);
      const html = adminGlobalActivityLogPage(
        entries,
        false,
        OWNER_SESSION,
        refs,
      );
      expectIncludesAll(html, [
        '<a href="/admin/attendees/7">Ada Lovelace</a>',
        '<a href="/admin/listing/3">Summer Concert</a>',
      ]);
    });

    test("escapes attendee names so stored PII cannot inject markup", () => {
      const entries = [logEntry({ attendeeId: 7, message: "Note added" })];
      const refs = refsWith([[7, "<script>alert(1)</script>"]], []);
      const html = adminGlobalActivityLogPage(
        entries,
        false,
        OWNER_SESSION,
        refs,
      );
      assertStringIncludes(html, "&lt;script&gt;alert(1)&lt;/script&gt;");
      assert(!html.includes("<script>alert(1)</script>"));
    });

    test("leaves both link cells empty when an entry references neither", () => {
      const entries = [logEntry({ message: "System started" })];
      const html = adminGlobalActivityLogPage(
        entries,
        false,
        OWNER_SESSION,
        emptyRefs(),
      );
      // Scoped to the table body: the admin nav itself always carries
      // /admin/attendees and /admin/listing/... links, so a page-wide check
      // would false-positive on those rather than the row's own cells.
      const tbody = html.slice(
        html.indexOf("<tbody>"),
        html.indexOf("</tbody>"),
      );
      assert(!tbody.includes('href="/admin/attendees/'));
      assert(!tbody.includes('href="/admin/listing/'));
      // The two reference columns are still rendered, just empty.
      assertStringIncludes(tbody, "<td></td><td></td>");
    });

    test("renders no link when the referenced attendee no longer exists", () => {
      const entries = [
        logEntry({ attendeeId: 42, message: "Attendee deleted" }),
      ];
      // Attendee 42 is absent from refs — a deleted attendee keeps its log rows.
      const html = adminGlobalActivityLogPage(
        entries,
        false,
        OWNER_SESSION,
        emptyRefs(),
      );
      assert(!html.includes('href="/admin/attendees/42"'));
      assertStringIncludes(html, "Attendee deleted");
    });

    // Render the global log with one attendee-referencing entry and return just
    // the table body — the nav always carries /admin links, so a page-wide check
    // would false-positive on those rather than the row's own cell.
    const attendeeRefTbody = (
      attendeeId: number,
      attendees: ActivityLogRefs["attendees"],
    ): string => {
      const entries = [logEntry({ attendeeId, message: "Note added" })];
      const html = adminGlobalActivityLogPage(entries, false, OWNER_SESSION, {
        attendees,
        listings: new Map(),
      });
      const tbodyStart = html.indexOf("<tbody>");
      const tbodyEnd = html.indexOf("</tbody>");
      // Fail loudly if the row didn't render — otherwise an empty slice would let
      // the "no link" assertions pass without testing anything.
      expect(tbodyStart).toBeGreaterThanOrEqual(0);
      expect(tbodyEnd).toBeGreaterThan(tbodyStart);
      return html.slice(tbodyStart, tbodyEnd);
    };

    test("renders no attendee link when only the name is loaded (kind missing)", () => {
      const tbody = attendeeRefTbody(8, {
        kinds: new Map(),
        names: new Map([[8, "Grace Hopper"]]),
      });
      assert(!tbody.includes('href="/admin/attendees/8"'));
      assert(!tbody.includes("Grace Hopper"));
    });

    test("renders no attendee link when only the kind is loaded (name missing)", () => {
      const tbody = attendeeRefTbody(9, {
        kinds: new Map([[9, "attendee"]]),
        names: new Map(),
      });
      assert(!tbody.includes('href="/admin/attendees/9"'));
    });

    test("renders no link when the referenced listing no longer exists", () => {
      const entries = [logEntry({ listingId: 99, message: "Listing deleted" })];
      const html = adminGlobalActivityLogPage(
        entries,
        false,
        OWNER_SESSION,
        emptyRefs(),
      );
      assert(!html.includes('href="/admin/listing/99"'));
      assertStringIncludes(html, "Listing deleted");
    });
  });

  describe("activity log reference columns are global-only", () => {
    test("the per-listing log omits the Attendee and Listing columns", () => {
      const listing = testListingWithCount();
      const entries = [
        logEntry({
          attendeeId: 7,
          listingId: listing.id,
          message: "Ticket reserved",
        }),
      ];
      const html = String(ActivityLogTable({ entries }));
      assertStringIncludes(html, "Ticket reserved");
      assert(!html.includes("<th>Attendee</th>"));
      assert(!html.includes('href="/admin/attendees/7"'));
    });
  });
});
