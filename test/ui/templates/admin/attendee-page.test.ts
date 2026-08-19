import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import type { AttendeeStatus } from "#db/attendee-statuses.ts";
import type { SystemNote } from "#db/notes/types.ts";
import {
  attendeeBanner,
  ContactHistory,
} from "#templates/admin/attendee-page.tsx";
import { PaymentDetails } from "#templates/admin/attendees.tsx";
import { setupTestEncryptionKey } from "#test-utils/env.ts";
import { testAttendee } from "#test-utils/factories.ts";

const attendeeStatus = (
  overrides: Partial<AttendeeStatus> = {},
): AttendeeStatus => ({
  id: 1,
  is_paid_default: false,
  is_public_default: true,
  is_reservation: false,
  name: "Confirmed",
  reservation_amount: "0",
  sort_order: 0,
  ...overrides,
});

const OWNER_NOTE: SystemNote = {
  created: "2026-07-11T10:00:00.000Z",
  entity_id: 1,
  entity_type: "attendee",
  id: 1,
  note: "Bring identification",
  type: "owner",
};

const renderBanner = (
  statuses: AttendeeStatus[],
  notes: SystemNote[] = [],
  isOwner = false,
): JSX.Element | null =>
  attendeeBanner({
    attendee: testAttendee({ status_id: 1 }),
    isOwner,
    notes,
    statuses,
  });

beforeAll(setupTestEncryptionKey);

describe("attendee page blocks", () => {
  test("keeps each contact record as a semantic section", () => {
    const html = String(
      ContactHistory({
        attendee: testAttendee({ email: "jane@example.com" }),
        contactRecords: {
          email: {
            hashParam: "email-hash",
            record: {
              adminBookingCount: 1,
              adminNotes: "Private note",
              contactCount: 2,
              lastContact: "",
              lastSubject: "",
              publicBookingCount: 3,
              visits: 4,
            },
          },
          phone: null,
        },
        isOwner: false,
        previousBookings: [],
      }),
    );

    expect(html).toMatch(
      /^<div class="page-regions"><div class="page-block">[\s\S]*<\/div><section class="page-block"><div class="prose"><h4>Stats \/ notes for jane@example\.com<\/h4><\/div>[\s\S]*<\/section><\/div>$/,
    );
  });

  test("omits the banner when the attendee has one status and no notes", () => {
    expect(renderBanner([attendeeStatus()])).toBeNull();
  });

  test("keeps the status and notes in one related banner block", () => {
    const html = String(
      renderBanner(
        [
          attendeeStatus(),
          attendeeStatus({
            id: 2,
            is_paid_default: true,
            is_public_default: false,
            name: "Paid",
            sort_order: 1,
          }),
        ],
        [OWNER_NOTE],
      ),
    );

    expect(html).toMatch(
      /^<div class="page-block attendee-banner"><div class="prose attendee-status"><h2>Status: Confirmed<\/h2><\/div><section class="attendee-notes">[\s\S]*<p>Bring identification<\/p>[\s\S]*<\/section><\/div>$/,
    );
  });

  test("keeps notes visible when there is only one status", () => {
    const html = String(renderBanner([attendeeStatus()], [OWNER_NOTE]));

    expect(html).toMatch(
      /^<div class="page-block attendee-banner"><section class="attendee-notes">[\s\S]*<p>Bring identification<\/p>[\s\S]*<\/section><\/div>$/,
    );
    expect(html).not.toContain("attendee-status");
  });

  test("keeps a note's ledger link for owners but demotes it for other admins", () => {
    const ledgerNote: SystemNote = {
      ...OWNER_NOTE,
      note: "Refunded. Please check the [ledger](/admin/ledger/attendee/1).",
      type: "system",
    };
    // The ledger pages are owner-only, so a non-owner's note renders the
    // words without the link — a rendered link is a promise that it works.
    const staffHtml = String(renderBanner([attendeeStatus()], [ledgerNote]));
    expect(staffHtml).toContain("check the ledger");
    expect(staffHtml).not.toContain('href="/admin/ledger/attendee/1"');

    const ownerHtml = String(
      renderBanner([attendeeStatus()], [ledgerNote], true),
    );
    expect(ownerHtml).toContain('href="/admin/ledger/attendee/1"');
  });

  test("omits the payment block when the attendee has no payment", () => {
    expect(
      PaymentDetails({
        attendee: testAttendee({ payment_id: "" }),
        refresh: { kind: "none" },
        showBalanceLink: true,
      }),
    ).toBeNull();
  });

  test("shows indexed payment recovery without a legacy payment id", () => {
    const html = String(
      PaymentDetails({
        attendee: testAttendee({ id: 7, payment_id: "" }),
        refresh: {
          kind: "available",
          url: "/admin/attendees/7/refresh-payment",
        },
        showBalanceLink: true,
      }),
    );

    expect(html).toContain("Payment Details");
    expect(html).toContain('action="/admin/attendees/7/refresh-payment"');
    expect(html).not.toContain("Payment ID:");
  });

  test("does not promise refresh for an unindexed legacy payment", () => {
    const html = String(
      PaymentDetails({
        attendee: testAttendee({ id: 8, payment_id: "pi_legacy" }),
        refresh: { kind: "none" },
        showBalanceLink: true,
      }),
    );

    expect(html).toContain("pi_legacy");
    expect(html).not.toContain("/refresh-payment");
  });

  test("explains an older provider-unknown payment without a dead form", () => {
    const message = "This older payment needs manual recovery.";
    const html = String(
      PaymentDetails({
        attendee: testAttendee({ id: 9, payment_id: "" }),
        refresh: { kind: "unavailable", message },
        showBalanceLink: true,
      }),
    );

    expect(html).toContain("Payment Details");
    expect(html).toContain(message);
    expect(html).not.toContain("/refresh-payment");
  });
});
