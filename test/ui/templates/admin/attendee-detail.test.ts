import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import type { ActivityLogEntry } from "#db/activity-log.ts";
import {
  BookingStatusBadges,
  InactiveNote,
} from "#templates/admin/attendee-detail.tsx";
import { attendeeSummaryRows } from "#templates/admin/attendee-page.tsx";
import { renderSection } from "#templates/admin/entity-pages.tsx";
import { setupTestEncryptionKey } from "#test-utils/env.ts";
import { testAttendee } from "#test-utils/factories.ts";

const ALLOWED_DOMAIN = "tickets.example.com";

const renderDetail = (
  attendee = testAttendee(),
  phonePrefix = "44",
  hasRealLine = true,
): string =>
  String(
    renderSection({
      kind: "summary",
      rows: attendeeSummaryRows({
        allowedDomain: ALLOWED_DOMAIN,
        attendee,
        hasRealLine,
        phonePrefix,
      }),
    }),
  );

beforeAll(() => {
  setupTestEncryptionKey();
});

describe("attendee summary section", () => {
  test("always shows name, ticket link and registered", () => {
    const html = renderDetail(
      testAttendee({ name: "Jane Doe", ticket_token: "tok-123" }),
    );
    expect(html).toContain('<th scope="row">Name</th>');
    expect(html).toContain("Jane Doe");
    expect(html).toContain(`https://${ALLOWED_DOMAIN}/t/tok-123`);
    expect(html).toContain("Registered");
  });

  test("shows the no-quantity indicator instead of a dead ticket link for a ghost-only attendee", () => {
    // A no-quantity-only attendee's /t page 404s, so we must not render a link
    // that fails on click — show the same "No quantity" indicator as the table.
    const html = renderDetail(
      testAttendee({ ticket_token: "tok-ghost" }),
      "44",
      false,
    );
    expect(html).not.toContain("/t/tok-ghost");
    expect(html).toContain("No quantity");
  });

  test("renders email as a mailto link when present", () => {
    const html = renderDetail(testAttendee({ email: "jane@example.com" }));
    expect(html).toContain('href="mailto:jane@example.com"');
  });

  test("omits the email row when there is no email", () => {
    const html = renderDetail(testAttendee({ email: "" }));
    expect(html).not.toContain('<th scope="row">Email</th>');
  });

  test("shows the phone number with small tel and whatsapp links", () => {
    const html = renderDetail(testAttendee({ phone: "07700 900000" }));
    expect(html).toContain("07700 900000");
    expect(html).toContain('<a href="tel:+447700900000">tel</a>');
    expect(html).toContain("https://wa.me/447700900000");
    expect(html).toContain("<small>");
  });

  test("normalises the phone with the given dialling code", () => {
    const html = renderDetail(testAttendee({ phone: "0234 567 8900" }), "1");
    expect(html).toContain('href="tel:+12345678900"');
    expect(html).toContain("https://wa.me/12345678900");
  });

  test("omits the phone row when there is no phone", () => {
    const html = renderDetail(testAttendee({ phone: "" }));
    expect(html).not.toContain('<th scope="row">Phone</th>');
    expect(html).not.toContain("tel:");
  });

  test("preserves line breaks for address and special instructions", () => {
    const html = renderDetail(
      testAttendee({
        address: "1 High St\nTownsville",
        special_instructions: "Step free\nNut allergy",
      }),
    );
    expect(html).toContain("white-space:pre-wrap");
    expect(html).toContain("1 High St\nTownsville");
    expect(html).toContain("Step free\nNut allergy");
  });
});

describe("BookingStatusBadges", () => {
  test("returns null when the booking is neither checked in nor refunded", () => {
    // Null lets the table swap in an em dash for the status cell.
    expect(
      BookingStatusBadges({ checkedIn: false, refunded: false }),
    ).toBeNull();
  });

  test("renders a plain badge when checked in", () => {
    const html = String(
      BookingStatusBadges({ checkedIn: true, refunded: false }),
    );
    expect(html).toContain(
      '<div class="muted small"><span class="badge">Checked in</span></div>',
    );
    expect(html).not.toContain("Refunded");
  });

  test("renders a danger badge when refunded", () => {
    const html = String(
      BookingStatusBadges({ checkedIn: false, refunded: true }),
    );
    expect(html).toContain('<span class="badge danger">Refunded</span>');
    expect(html).not.toContain("Checked in");
  });

  test("renders both badges when checked in and refunded", () => {
    const html = String(
      BookingStatusBadges({ checkedIn: true, refunded: true }),
    );
    expect(html).toContain(
      '<span class="badge">Checked in</span> <span class="badge danger">Refunded</span>',
    );
  });
});

describe("InactiveNote", () => {
  test("returns nothing for an active listing", () => {
    expect(InactiveNote({ active: true })).toBeNull();
  });

  test("marks an inactive listing, with and without a leading space", () => {
    expect(String(InactiveNote({ active: false, leadingSpace: true }))).toBe(
      '<span class="muted small"> (Inactive)</span>',
    );
    expect(String(InactiveNote({ active: false }))).toBe(
      '<span class="muted small">(Inactive)</span>',
    );
  });
});

describe("attendee activity section", () => {
  const entries: ActivityLogEntry[] = [
    {
      attendee_id: 7,
      created: "2026-01-15T10:30:00Z",
      id: 1,
      listing_id: 2,
      message: "Attendee 'Jane Doe' updated",
    },
  ];

  test("renders the log table with the same Time/Activity columns as /admin/log", () => {
    const html = String(
      renderSection({ entries, kind: "activity", viewAllHref: null }),
    );
    expect(html).toContain("Attendee 'Jane Doe' updated");
    expect(html).toContain("<th>Time</th>");
    expect(html).toContain("<th>Activity</th>");
    // The full tab has no preview link.
    expect(html).not.toContain("View all activity");
  });

  test("a preview links through to the full Activity tab", () => {
    const html = String(
      renderSection({
        entries,
        kind: "activity",
        viewAllHref: "/admin/attendees/7/activity",
      }),
    );
    expect(html).toContain('href="/admin/attendees/7/activity"');
    expect(html).toContain("View all activity");
  });

  test("shows the empty state when the attendee has no log entries", () => {
    const html = String(
      renderSection({ entries: [], kind: "activity", viewAllHref: null }),
    );
    expect(html).toContain("No activity recorded yet");
  });
});
