/** The check-in page a door-only scanner login reads: the bulk form it can
 * work, the state badges it sees per row, and the staff affordances it must
 * never see. The admin view lives in rendering.test.ts beside it. */

import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import {
  checkOneLegAsStaff,
  postCheckin,
  readTicketPage,
  setupCheckinTest,
} from "#test/features/checkin/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendeeWithToken } from "#test-utils/db-helpers/attendees.ts";
import { createTwoListingBooking } from "#test-utils/db-helpers/bookings.ts";
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

      const body = await readTicketPage(token, scanner.cookie);
      // The working bulk check-in stays; the per-row forms POST to a
      // staff-only admin endpoint, so a scanner is never shown one. Each
      // row's state reads as a badge instead.
      assertStringIncludes(body, "Check In All");
      assertStringIncludes(body, 'class="bulk-checkin"');
      // The hidden field's value is what the POST reads; the admit button
      // must submit the true spelling, not any falsy stand-in.
      assertStringIncludes(body, 'type="hidden" value="true"');
      assertStringIncludes(body, "Not checked in");
      assert(
        !body.includes(`/admin/listing/${listing.id}/attendee/`),
        "the value should not contain the searched item",
      );
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

      const beforeBody = await readTicketPage(token, cookie);
      // The checked refunded row must not flip the bulk action to checkout
      // while the live row still waits at the door.
      assertStringIncludes(beforeBody, "Check In All");
      assert(
        !beforeBody.includes("Check Out All"),
        "the value should not contain the searched item",
      );
      assertStringIncludes(beforeBody, "Refunded");
      assertStringIncludes(beforeBody, "Not checked in");

      const went = await postCheckin(token, session, "true");
      expect(went.status).toBe(302);
      expect(went.headers.get("location")).toBe(
        `/checkin/${token}?message=Checked%20in%201%20ticket`,
      );

      const afterBody = await readTicketPage(token, cookie);
      assertStringIncludes(afterBody, "Checked in");
      assert(
        !afterBody.includes("Not checked in"),
        "the value should not contain the searched item",
      );
      assert(
        !afterBody.includes(
          `/admin/listing/${first.id}/attendee/${attendee.id}/checkin`,
        ),
        "the value should not contain the searched item",
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

      const body = await readTicketPage(token, cookie);
      // The page keeps the row's refunded badge but advertises no action
      // that the POST could never honour.
      assertStringIncludes(body, "Refunded");
      assert(
        !body.includes("Check In All"),
        "the value should not contain the searched item",
      );
      assert(
        !body.includes('name="check_in"'),
        "the value should not contain the searched item",
      );
    });

    test("keeps both bulk actions on a partly checked ticket", async () => {
      const { attendee, first } = await createTwoListingBooking(
        "Scanner Mixed",
        "scanner-mixed@test.com",
      );
      // Staff admit one leg through its own row's form; the scanner's bulk
      // actions must still cover both intents for the other leg.
      await checkOneLegAsStaff(first.id, attendee.id);

      const response = await awaitTestRequest(
        `/checkin/${attendee.ticket_token}`,
        {
          cookie: (await createTestScannerSession()).cookie,
        },
      );
      const body = await response.text();
      // The checked leg can be undone and the waiting leg can be admitted:
      // neither intent is hidden behind the other.
      assertStringIncludes(body, "Check In All");
      assertStringIncludes(body, "Check Out All");
      assertStringIncludes(body, "Checked in");
      assertStringIncludes(body, "Not checked in");
    });

    test("offers checkout once a row is checked, with no per-row controls", async () => {
      const { token } = await setupCheckinTest("Todd", "todd@test.com");
      const { cookie } = await createTestScannerSession();
      const session = { cookie, csrfToken: await testCsrfToken() };
      await postCheckin(token, session, "true");

      const body = await readTicketPage(token, cookie);
      // The one bulk action can undo the check-in the door just made.
      assertStringIncludes(body, "Check Out All");
      assertStringIncludes(body, 'class="bulk-checkout"');
      assertStringIncludes(body, 'name="check_in"');
      assertStringIncludes(body, 'value="false"');
      assert(
        !body.includes("/attendee/"),
        "the value should not contain the searched item",
      );
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

      const body = await readTicketPage(token, scanner.cookie);
      assertStringIncludes(body, "Rae");
      assert(
        !body.includes("rae@test.com"),
        "the value should not contain the searched item",
      );
      assert(
        !body.includes("555-1234"),
        "the value should not contain the searched item",
      );
      assert(
        !body.includes("<th>Email</th>"),
        "the value should not contain the searched item",
      );
      assert(
        !body.includes("<th>Phone</th>"),
        "the value should not contain the searched item",
      );
    });

    test("keeps its table intact under a contact-only staff column order", async () => {
      const { token } = await setupCheckinTest("Fay", "fay@test.com");
      const scanner = await createTestScannerSession();
      // The staff attendee table's saved column order names only contact
      // columns — every one of which a door-safe projection blanks.
      settings.setForTest({
        attendee_column_order: "{{email}}, {{phone}}",
      });

      const body = await readTicketPage(token, scanner.cookie);
      // The fixed door-safe columns carry the door facts regardless.
      assertStringIncludes(body, "Fay");
      assertStringIncludes(body, ">Qty</th>");
      assert(
        !body.includes("<th>Email</th>"),
        "the value should not contain the searched item",
      );
    });
  },
);
