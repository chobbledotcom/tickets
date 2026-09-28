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
import { createTestAttendeeWithToken } from "#test-utils/db-helpers/attendees.ts";
import { createTwoListingBooking } from "#test-utils/db-helpers/bookings.ts";
import { awaitTestRequest, mockFormRequest } from "#test-utils/mocks.ts";
import { createTestScannerSession } from "#test-utils/role-sessions.ts";
import { testCookie, testCsrfToken } from "#test-utils/session.ts";

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
      expect(body).toContain('class="bulk-checkin"');
      // The hidden field's value is what the POST reads; the admit button
      // must submit the true spelling, not any falsy stand-in.
      expect(body).toContain('type="hidden" value="true"');
      expect(body).toContain("Not checked in");
      expect(body).not.toContain(`/admin/listing/${listing.id}/attendee/`);
    });

    test("still admits the live row of a partly refunded attended ticket", async () => {
      const { attendee, first } = await createTwoListingBooking(
        "Mixed",
        "mixed@test.com",
      );
      const token = attendee.ticket_token;
      const { cookie } = await createTestScannerSession();
      const session = { cookie, csrfToken: await testCsrfToken() };

      // One leg is attended and then refunded; the other still waits.
      await postCheckin(token, session, "true");
      const { refundThroughLedger } = await import("#test-utils/ledger.ts");
      await refundThroughLedger(attendee.id, first.id);
      await postCheckin(token, session, "false");

      const before = await awaitTestRequest(`/checkin/${token}`, { cookie });
      const beforeBody = await before.text();
      // The checked refunded row must not flip the bulk action to checkout
      // while the live row still waits at the door.
      expect(beforeBody).toContain("Check In All");
      expect(beforeBody).not.toContain("Check Out All");
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

    test("hides the bulk action when no row can change", async () => {
      const { attendee, listing, token } = await createTestAttendeeWithToken(
        "Nora",
        "nora@test.com",
      );
      const { cookie } = await createTestScannerSession();
      const session = { cookie, csrfToken: await testCsrfToken() };

      // The token's only leg is attended and then refunded: the POST has
      // nothing it is allowed to change.
      const { refundThroughLedger } = await import("#test-utils/ledger.ts");
      await refundThroughLedger(attendee.id, listing.id);
      await postCheckin(token, session, "true");

      const response = await awaitTestRequest(`/checkin/${token}`, { cookie });
      const body = await response.text();
      // The page keeps the row's refunded badge but advertises no action
      // that the POST could never honour.
      expect(body).toContain("Refunded");
      expect(body).not.toContain("Check In All");
      expect(body).not.toContain('name="check_in"');
    });

    test("keeps both bulk actions on a partly checked ticket", async () => {
      const { attendee, first } = await createTwoListingBooking(
        "Scanner Mixed",
        "scanner-mixed@test.com",
      );
      const { handleRequest } = await import("#routes");
      const staffSession = {
        cookie: await testCookie(),
        csrfToken: await testCsrfToken(),
      };
      // Staff admit one leg through its own row's form; the scanner's bulk
      // actions must still cover both intents for the other leg.
      await handleRequest(
        mockFormRequest(
          `/admin/listing/${first.id}/attendee/${attendee.id}/checkin`,
          { csrf_token: staffSession.csrfToken },
          staffSession.cookie,
        ),
      );

      const response = await awaitTestRequest(
        `/checkin/${attendee.ticket_token}`,
        {
          cookie: (await createTestScannerSession()).cookie,
        },
      );
      const body = await response.text();
      // The checked leg can be undone and the waiting leg can be admitted:
      // neither intent is hidden behind the other.
      expect(body).toContain("Check In All");
      expect(body).toContain("Check Out All");
      expect(body).toContain("Checked in");
      expect(body).toContain("Not checked in");
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
      expect(body).toContain('class="bulk-checkout"');
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
