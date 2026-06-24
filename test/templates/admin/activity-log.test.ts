import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { signCsrfToken } from "#shared/csrf.ts";
import { ErrorCode, formatErrorMessage } from "#shared/logger.ts";
import {
  type ActivityLogRefs,
  adminGlobalActivityLogPage,
  adminListingActivityLogPage,
} from "#templates/admin/activityLog.tsx";
import { setupTestEncryptionKey, testListingWithCount } from "#test-utils";

const TEST_SESSION = { adminLevel: "owner" as const };

/** Empty reference lookups — the global log always takes refs, even when no
 * entry links to an attendee or listing. */
const emptyRefs = (): ActivityLogRefs => ({
  attendees: new Map(),
  listings: new Map(),
});

/** Factory for a single activity-log entry. All entries in these tests share
 *  the same `created` timestamp and `id: 1`; only `message`, `attendee_id`,
 *  and `listing_id` vary, so those are the override knobs. */
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

beforeAll(async () => {
  setupTestEncryptionKey();
  await signCsrfToken();
});

describe("adminListingActivityLogPage", () => {
  test("renders activity log entries", () => {
    const listing = testListingWithCount();
    const entries = [
      logEntry({ listing_id: 1, message: "Ticket reserved" }),
      logEntry({ id: 2, listing_id: 1, message: "Payment received" }),
    ];
    const html = adminListingActivityLogPage(listing, entries, TEST_SESSION);
    expect(html).toContain("Ticket reserved");
    expect(html).toContain("Payment received");
    expect(html).toContain("Log");
  });

  test("renders empty state when no entries", () => {
    const listing = testListingWithCount();
    const html = adminListingActivityLogPage(listing, [], TEST_SESSION);
    expect(html).toContain("No activity recorded yet");
  });
});

describe("adminGlobalActivityLogPage", () => {
  test("renders global activity log with entries", () => {
    const entries = [logEntry({ message: "System started" })];
    const html = adminGlobalActivityLogPage(
      entries,
      false,
      TEST_SESSION,
      emptyRefs(),
    );
    expect(html).toContain("System started");
    expect(html).toContain("Log");
  });

  test("renders empty state when no entries", () => {
    const html = adminGlobalActivityLogPage(
      [],
      false,
      TEST_SESSION,
      emptyRefs(),
    );
    expect(html).toContain("No activity recorded yet");
  });

  test("shows truncation message when truncated", () => {
    const entries = [logEntry({ message: "Action" })];
    const html = adminGlobalActivityLogPage(
      entries,
      true,
      TEST_SESSION,
      emptyRefs(),
    );
    expect(html).toContain("Showing the most recent 200 entries");
  });

  test("does not show truncation message when not truncated", () => {
    const entries = [logEntry({ message: "Action" })];
    const html = adminGlobalActivityLogPage(
      entries,
      false,
      TEST_SESSION,
      emptyRefs(),
    );
    expect(html).not.toContain("Showing the most recent 200 entries");
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
      TEST_SESSION,
      emptyRefs(),
    );
    expect(html).toContain('href="/admin/settings#settings-square-webhook"');
    expect(html).toContain("Click here to re-do your Square settings");
    // The original error message is still shown after the link
    expect(html).toContain("Square signature verification failed");
  });

  test("does not add the Square settings link to unrelated messages", () => {
    const entries = [logEntry({ message: "Payment received" })];
    const html = adminGlobalActivityLogPage(
      entries,
      false,
      TEST_SESSION,
      emptyRefs(),
    );
    expect(html).not.toContain("Click here to re-do your Square settings");
  });
});

describe("adminGlobalActivityLogPage reference columns", () => {
  const refsWith = (
    attendees: [number, string][],
    listings: [number, string][],
  ): ActivityLogRefs => ({
    attendees: new Map(attendees),
    listings: new Map(listings),
  });

  test("renders the Attendee and Listing column headers", () => {
    const html = adminGlobalActivityLogPage(
      [],
      false,
      TEST_SESSION,
      emptyRefs(),
    );
    expect(html).toContain("<th>Attendee</th>");
    expect(html).toContain("<th>Listing</th>");
    // The empty-state row spans all four columns.
    expect(html).toContain('colspan="4"');
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
    const html = adminGlobalActivityLogPage(entries, false, TEST_SESSION, refs);
    expect(html).toContain('<a href="/admin/attendees/7">Ada Lovelace</a>');
    expect(html).toContain('<a href="/admin/listing/3">Summer Concert</a>');
  });

  test("escapes attendee names so stored PII cannot inject markup", () => {
    const entries = [logEntry({ attendee_id: 7, message: "Note added" })];
    const refs = refsWith([[7, "<script>alert(1)</script>"]], []);
    const html = adminGlobalActivityLogPage(entries, false, TEST_SESSION, refs);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  test("leaves both link cells empty when an entry references neither", () => {
    const entries = [logEntry({ message: "System started" })];
    const html = adminGlobalActivityLogPage(
      entries,
      false,
      TEST_SESSION,
      emptyRefs(),
    );
    expect(html).not.toContain('href="/admin/attendees/');
    expect(html).not.toContain('href="/admin/listing/');
    // The two reference columns are still rendered, just empty.
    expect(html).toContain("<td></td><td></td>");
  });

  test("renders no link when the referenced attendee no longer exists", () => {
    const entries = [
      logEntry({ attendee_id: 42, message: "Attendee deleted" }),
    ];
    // Attendee 42 is absent from refs — a deleted attendee keeps its log rows.
    const html = adminGlobalActivityLogPage(
      entries,
      false,
      TEST_SESSION,
      emptyRefs(),
    );
    expect(html).not.toContain('href="/admin/attendees/42"');
    expect(html).toContain("Attendee deleted");
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
    const html = adminListingActivityLogPage(listing, entries, TEST_SESSION);
    expect(html).not.toContain("<th>Attendee</th>");
    expect(html).not.toContain('href="/admin/attendees/7"');
  });
});
