import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import type { AttendeeStatus } from "#shared/db/attendee-statuses.ts";
import type { SystemNote } from "#shared/db/system-notes.ts";
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
  attendee_id: 1,
  created: "2026-07-11T10:00:00.000Z",
  id: 1,
  note: "Bring identification",
  type: "owner",
};

const renderBanner = (
  statuses: AttendeeStatus[],
  notes: SystemNote[] = [],
): JSX.Element | null =>
  attendeeBanner({
    attendee: testAttendee({ status_id: 1 }),
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

  test("omits the payment block when the attendee has no payment", () => {
    expect(
      PaymentDetails({
        attendee: testAttendee({ payment_id: "" }),
        showBalanceLink: true,
      }),
    ).toBeNull();
  });
});
