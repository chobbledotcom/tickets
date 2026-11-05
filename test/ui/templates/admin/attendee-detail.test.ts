import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import type { ActivityLogEntry } from "#db/activity-log.ts";
import type { InvoiceSummary } from "#db/invoices.ts";
import {
  BookingStatusBadges,
  InactiveNote,
} from "#templates/admin/attendee-detail.tsx";
import { attendeeSummaryRows } from "#templates/admin/attendee-page.tsx";
import { renderSection } from "#templates/admin/entity-pages.tsx";
import { expectIncludesAll } from "#test-utils/assertions.ts";
import { setupTestEncryptionKey } from "#test-utils/env.ts";
import { testAttendee } from "#test-utils/factories.ts";

const ALLOWED_DOMAIN = "tickets.example.com";

const presentInvoice: InvoiceSummary = {
  attendee_id: 1,
  created: "2026-11-04T09:00:00.000Z",
  id: 12,
  status: "new",
};

const renderDetail = (
  attendee = testAttendee(),
  phonePrefix = "44",
  hasRealLine = true,
  invoices: readonly InvoiceSummary[] = [],
): string =>
  String(
    renderSection({
      kind: "summary",
      rows: attendeeSummaryRows({
        allowedDomain: ALLOWED_DOMAIN,
        attendee,
        hasRealLine,
        invoices,
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
    expectIncludesAll(html, [
      '<th scope="row">Name</th>',
      "Jane Doe",
      `https://${ALLOWED_DOMAIN}/t/tok-123`,
      "Registered",
    ]);
  });

  test("shows the no-quantity indicator instead of a dead ticket link for a ghost-only attendee", () => {
    // A no-quantity-only attendee's /t page 404s, so we must not render a link
    // that fails on click — show the same "No quantity" indicator as the table.
    const html = renderDetail(
      testAttendee({ ticket_token: "tok-ghost" }),
      "44",
      false,
    );
    assert(!html.includes("/t/tok-ghost"));
    assertStringIncludes(html, "No quantity");
  });

  test("renders email as a mailto link when present", () => {
    const html = renderDetail(testAttendee({ email: "jane@example.com" }));
    assertStringIncludes(html, 'href="mailto:jane@example.com"');
  });

  test("omits the email row when there is no email", () => {
    const html = renderDetail(testAttendee({ email: "" }));
    assert(!html.includes('<th scope="row">Email</th>'));
  });

  test("shows the phone number with small tel and whatsapp links", () => {
    const html = renderDetail(testAttendee({ phone: "07700 900000" }));
    expectIncludesAll(html, [
      "07700 900000",
      '<a href="tel:+447700900000">tel</a>',
      "https://wa.me/447700900000",
      "<small>",
    ]);
  });

  test("normalises the phone with the given dialling code", () => {
    const html = renderDetail(testAttendee({ phone: "0234 567 8900" }), "1");
    expectIncludesAll(html, [
      'href="tel:+12345678900"',
      "https://wa.me/12345678900",
    ]);
  });

  test("omits the phone row when there is no phone", () => {
    const html = renderDetail(testAttendee({ phone: "" }));
    assert(!html.includes('<th scope="row">Phone</th>'));
    assert(!html.includes("tel:"));
  });

  test("preserves line breaks for address and special instructions", () => {
    const html = renderDetail(
      testAttendee({
        address: "1 High St\nTownsville",
        special_instructions: "Step free\nNut allergy",
      }),
    );
    expectIncludesAll(html, [
      "white-space:pre-wrap",
      "1 High St\nTownsville",
      "Step free\nNut allergy",
    ]);
  });

  test("links the attendee's invoice and names its status and date", () => {
    const html = renderDetail(testAttendee(), "44", true, [presentInvoice]);
    expectIncludesAll(html, [
      '<th scope="row">Invoice</th>',
      'href="/admin/invoices/12"',
      "12 — New — Wednesday 4 November 2026",
    ]);
  });

  test("omits the invoice row when the attendee has no invoice", () => {
    const html = renderDetail(testAttendee());
    assert(!html.includes('<th scope="row">Invoice</th>'));
  });
});

describe("BookingStatusBadges", () => {
  test("returns null when the booking is neither checked in nor refunded", () => {
    // Null lets the table swap in an em dash for the status cell.
    expect(
      BookingStatusBadges({ checkedIn: 0, quantity: 1, refunded: false }),
    ).toBeNull();
  });

  test("renders a plain badge when checked in", () => {
    const html = String(
      BookingStatusBadges({ checkedIn: 1, quantity: 1, refunded: false }),
    );
    assertStringIncludes(
      html,
      '<div class="muted small"><span class="badge">Checked in</span></div>',
    );
    assert(!html.includes("Refunded"));
  });

  test("names the count a part booking admitted", () => {
    const html = String(
      BookingStatusBadges({ checkedIn: 2, quantity: 3, refunded: false }),
    );
    assertStringIncludes(html, "Checked in (2 of 3)");
  });

  test("renders a danger badge when refunded", () => {
    const html = String(
      BookingStatusBadges({ checkedIn: 0, quantity: 1, refunded: true }),
    );
    assertStringIncludes(html, '<span class="badge danger">Refunded</span>');
    assert(!html.includes("Checked in"));
  });

  test("renders both badges when checked in and refunded", () => {
    const html = String(
      BookingStatusBadges({ checkedIn: 1, quantity: 1, refunded: true }),
    );
    assertStringIncludes(
      html,
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
    expectIncludesAll(html, [
      "Attendee 'Jane Doe' updated",
      "<th>Time</th>",
      "<th>Activity</th>",
    ]);
    // The full tab has no preview link.
    assert(!html.includes("View all activity"));
  });

  test("a preview links through to the full Activity tab", () => {
    const html = String(
      renderSection({
        entries,
        kind: "activity",
        viewAllHref: "/admin/attendees/7/activity",
      }),
    );
    expectIncludesAll(html, [
      'href="/admin/attendees/7/activity"',
      "View all activity",
    ]);
  });

  test("shows the empty state when the attendee has no log entries", () => {
    const html = String(
      renderSection({ entries: [], kind: "activity", viewAllHref: null }),
    );
    assertStringIncludes(html, "No activity recorded yet");
  });
});
