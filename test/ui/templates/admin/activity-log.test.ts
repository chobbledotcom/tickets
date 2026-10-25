import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as bddTest, describe } from "@std/testing/bdd";
import { signCsrfToken } from "#shared/csrf.ts";
import { ErrorCode, formatErrorMessage } from "#shared/logger.ts";
import {
  type ActivityLogRefs,
  adminGlobalActivityLogPage,
  adminListingActivityLogPage,
} from "#templates/admin/activity-log.tsx";
import { OWNER_SESSION } from "#test-utils/admin-page-test.ts";
import {
  clearTestEncryptionKey,
  setupTestEncryptionKey,
} from "#test-utils/env.ts";
import { testListingWithCount } from "#test-utils/factories.ts";
import { assertPageMatchesSnapshot } from "#test-utils/page-snapshot.ts";
import { withRequestContext } from "#test-utils/request-context.ts";

const test = (name: string, body: () => void | Promise<void>): void => {
  bddTest(name, async () => {
    setupTestEncryptionKey();
    try {
      await withRequestContext(async () => {
        await signCsrfToken();
        await body();
      });
    } finally {
      clearTestEncryptionKey();
    }
  });
};

/** Empty reference lookups — the global log always takes refs, even when no
 * entry links to an attendee or listing. */
const emptyRefs = (): ActivityLogRefs => ({
  attendees: { kinds: new Map(), names: new Map() },
  listings: new Map(),
});

/** Factory for an activity-log entry with defaults for every stored field. */
const logEntry = (
  overrides: Partial<{
    attendee_id: number | null;
    created: string;
    id: number;
    listing_id: number | null;
    message: string;
  }>,
): {
  attendee_id: number | null;
  created: string;
  id: number;
  listing_id: number | null;
  message: string;
} => ({
  attendee_id: null,
  created: "2024-01-15T10:30:00Z",
  id: 1,
  listing_id: null,
  message: "System started",
  ...overrides,
});

describe("activity log templates", () => {
  describe("adminListingActivityLogPage", () => {
    test("renders activity log entries", () => {
      const listing = testListingWithCount();
      const entries = [
        logEntry({ listing_id: 1, message: "Ticket reserved" }),
        logEntry({ id: 2, listing_id: 1, message: "Payment received" }),
      ];
      const html = adminListingActivityLogPage(listing, entries, OWNER_SESSION);
      assertStringIncludes(html, "Ticket reserved");
      assertStringIncludes(html, "Payment received");
      assertStringIncludes(html, "Log");
    });

    test("renders empty state when no entries", () => {
      const listing = testListingWithCount();
      const html = adminListingActivityLogPage(listing, [], OWNER_SESSION);
      assertStringIncludes(html, "No activity recorded yet");
    });
  });

  describe("adminGlobalActivityLogPage", () => {
    test("renders global activity log with entries", () => {
      const entries = [logEntry({ message: "System started" })];
      const html = adminGlobalActivityLogPage(
        entries,
        false,
        OWNER_SESSION,
        emptyRefs(),
      );
      assertStringIncludes(html, "System started");
      assertStringIncludes(html, "Log");
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
      assertStringIncludes(
        html,
        'href="/admin/settings#settings-square-webhook"',
      );
      assertStringIncludes(html, "Re-enter your Square settings");
      // The original error message is still shown after the link
      assertStringIncludes(html, "Square signature verification failed");
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
      assertStringIncludes(html, "<th>Attendee</th>");
      assertStringIncludes(html, "<th>Listing</th>");
      // The empty-state row spans all four columns.
      assertStringIncludes(html, 'colspan="4"');
    });

    test("links an entry to its attendee and listing by name", () => {
      const entries = [
        logEntry({
          attendee_id: 7,
          listing_id: 3,
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
      assertStringIncludes(
        html,
        '<a href="/admin/attendees/7">Ada Lovelace</a>',
      );
      assertStringIncludes(
        html,
        '<a href="/admin/listing/3">Summer Concert</a>',
      );
    });

    test("escapes attendee names so stored PII cannot inject markup", () => {
      const entries = [logEntry({ attendee_id: 7, message: "Note added" })];
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
        logEntry({ attendee_id: 42, message: "Attendee deleted" }),
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
      const entries = [
        logEntry({ attendee_id: attendeeId, message: "Note added" }),
      ];
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
      const entries = [
        logEntry({ listing_id: 99, message: "Listing deleted" }),
      ];
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
          attendee_id: 7,
          listing_id: listing.id,
          message: "Ticket reserved",
        }),
      ];
      const html = adminListingActivityLogPage(listing, entries, OWNER_SESSION);
      assert(!html.includes("<th>Attendee</th>"));
      assert(!html.includes('href="/admin/attendees/7"'));
    });
  });

  describe("the activity log page shell", () => {
    test("renders the same whole page the parent build rendered", () => {
      const html = adminGlobalActivityLogPage(
        [logEntry({ message: "System started" })],
        false,
        OWNER_SESSION,
        emptyRefs(),
      );

      assertPageMatchesSnapshot(
        new URL("./activity-log-global.snapshot.html", import.meta.url),
        html,
      );
    });

    test("renders the listing-scoped page identically to the parent", () => {
      const html = adminListingActivityLogPage(
        testListingWithCount({ id: 7, name: "Boathouse" }),
        [logEntry({})],
        OWNER_SESSION,
      );

      assertPageMatchesSnapshot(
        new URL("./activity-log-listing.snapshot.html", import.meta.url),
        html,
      );
    });
  });
});
