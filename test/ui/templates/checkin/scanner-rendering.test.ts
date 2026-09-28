/** The check-in page a door-only scanner login reads: the bulk form it can
 * work, the state badges it sees per row, and the staff affordances it must
 * never see. The admin view lives in rendering.test.ts beside it. */

import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import {
  postCheckin,
  setupCheckinTest,
} from "#test/features/checkin/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createMultiBookingAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import { createTestScannerSession } from "#test-utils/role-sessions.ts";
import { testCsrfToken } from "#test-utils/session.ts";

describeWithEnv(
  "check-in page (GET /checkin/:tokens) for a door-only scanner",
  { db: true },
  () => {
    afterEach(() => {
      settings.clearTestOverrides();
    });

    test("keeps the bulk form but hides the staff-only row controls", async () => {
      const { listing, token } = await setupCheckinTest("Sam", "sam@test.com");
      const scanner = await createTestScannerSession();

      const response = await awaitTestRequest(`/checkin/${token}`, {
        cookie: scanner.cookie,
      });
      expect(response.status).toBe(200);

      const body = await response.text();
      // The working bulk check-in stays; the per-row forms POST to a
      // staff-only admin endpoint, so a scanner is never shown one. Each
      // row's state reads as a badge instead.
      expect(body).toContain("Check In All");
      expect(body).toContain("Not checked in");
      expect(body).not.toContain(`/admin/listing/${listing.id}/attendee/`);
    });

    test("still admits the live row of a partly refunded attended ticket", async () => {
      const first = await createTestListing({
        maxAttendees: 10,
        name: "Doors",
      });
      const second = await createTestListing({
        maxAttendees: 10,
        name: "Workshop",
      });
      const attendee = await createMultiBookingAttendee(
        "Mixed",
        "mixed@test.com",
        [{ listingId: first.id }, { listingId: second.id }],
      );
      const token = attendee.ticket_token;
      const { cookie } = await createTestScannerSession();
      const session = { cookie, csrfToken: await testCsrfToken() };

      // Stamp the first leg's ledger order, so its booking can be refunded
      // the way the admin refund flow would.
      const { postListingSale, refundBookedOrder } = await import(
        "#test-utils/ledger.ts"
      );
      await postListingSale({
        attendeeId: attendee.id,
        gross: 500,
        listingId: first.id,
      });

      // One leg is attended and then refunded; the other still waits.
      await postCheckin(token, session, "true");
      await refundBookedOrder(attendee.id, first.id);
      await postCheckin(token, session, "false");

      const before = await awaitTestRequest(`/checkin/${token}`, { cookie });
      const beforeBody = await before.text();
      // The checked refunded row must not flip the bulk action to checkout
      // while the live row still waits at the door.
      expect(beforeBody).toContain("Check In All");
      expect(beforeBody).toContain("Refunded");
      expect(beforeBody).toContain("Not checked in");

      const went = await postCheckin(token, session, "true");
      expect(went.status).toBe(302);
      expect(went.headers.get("location")).toBe(
        `/checkin/${token}?message=Checked%20in%201%20ticket`,
      );

      const after = await awaitTestRequest(`/checkin/${token}`, { cookie });
      const afterBody = await after.text();
      expect(afterBody).toContain("Checked in");
      expect(afterBody).not.toContain("Not checked in");
      expect(afterBody).not.toContain(
        `/admin/listing/${first.id}/attendee/${attendee.id}/checkin`,
      );
    });

    test("offers checkout once a row is checked, with no per-row controls", async () => {
      const { token } = await setupCheckinTest("Todd", "todd@test.com");
      const { cookie } = await createTestScannerSession();
      const session = { cookie, csrfToken: await testCsrfToken() };
      await postCheckin(token, session, "true");

      const response = await awaitTestRequest(`/checkin/${token}`, { cookie });
      const body = await response.text();
      // The one bulk action can undo the check-in the door just made.
      expect(body).toContain("Check Out All");
      expect(body).toContain('name="check_in"');
      expect(body).toContain('value="false"');
      expect(body).not.toContain("/attendee/");
    });

    test("reads the door facts and none of the contact details", async () => {
      const { token } = await setupCheckinTest(
        "Rae",
        "rae@test.com",
        { fields: "email,phone" },
        1,
        "555-1234",
      );
      const scanner = await createTestScannerSession();

      const response = await awaitTestRequest(`/checkin/${token}`, {
        cookie: scanner.cookie,
      });
      const body = await response.text();
      expect(body).toContain("Rae");
      expect(body).not.toContain("rae@test.com");
      expect(body).not.toContain("555-1234");
      expect(body).not.toContain("<th>Email</th>");
      expect(body).not.toContain("<th>Phone</th>");
    });

    test("keeps its table intact under a contact-only staff column order", async () => {
      const { token } = await setupCheckinTest("Fay", "fay@test.com");
      const scanner = await createTestScannerSession();
      // The staff attendee table's saved column order names only contact
      // columns — every one of which a door-safe projection blanks.
      settings.setForTest({
        attendee_column_order: "{{email}}, {{phone}}",
      });

      const response = await awaitTestRequest(`/checkin/${token}`, {
        cookie: scanner.cookie,
      });
      const body = await response.text();
      // The fixed door-safe columns carry the door facts regardless.
      expect(body).toContain("Fay");
      expect(body).toContain(">Qty</th>");
      expect(body).not.toContain("<th>Email</th>");
    });
  },
);
