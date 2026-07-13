// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getListingWithCount } from "#shared/db/listings/records.ts";
import {
  finalizeSession,
  reserveSession,
} from "#shared/db/processed-payments.ts";
import {
  expectFlashRedirect,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createPaidTestAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import {
  createTestAttendee,
  getAttendeesRaw,
} from "#test-utils/db-helpers/attendees.ts";
import { setupListingAndLogin } from "#test-utils/session.ts";

// jscpd:ignore-end
import { submitDeleteIncomplete } from "./helpers.ts";

describeWithEnv(
  "server (admin attendees) > delete-incomplete",
  { db: true },
  () => {
    describe("POST /admin/listing/:listingId/attendee/:attendeeId/delete-incomplete", () => {
      /** Log in and make a paid listing — 100 places at £10.00 unless the caller
       * overrides the listing options. */
      const loginToPaidListing = (
        options: Parameters<typeof setupListingAndLogin>[0] = {
          maxAttendees: 100,
          unitPrice: 1000,
        },
      ): ReturnType<typeof setupListingAndLogin> =>
        setupListingAndLogin(options);

      /** Log in, make a paid listing, and add one paid attendee to it. Returns
       * the session together with the created attendee. */
      const setupPaidAttendee = async (
        name: string,
        email: string,
        paymentId: string,
        pricePaid: number,
        options?: Parameters<typeof setupListingAndLogin>[0],
      ) => {
        const session = await loginToPaidListing(options);
        const attendee = await createPaidTestAttendee(
          session.listing.id,
          name,
          email,
          paymentId,
          pricePaid,
        );
        return { ...session, attendee };
      };

      testRequiresAuth("/admin/listing/1/attendee/1/delete-incomplete", {
        body: {},
        method: "POST",
        setup: async () => {
          await setupPaidAttendee("John Doe", "john@example.com", "", 1000);
        },
      });

      test("deletes incomplete attendee without name confirmation", async () => {
        const { listing, cookie, csrfToken, attendee } =
          await setupPaidAttendee("Jane Stuck", "jane@example.com", "", 1000);

        const response = await submitDeleteIncomplete(
          listing.id,
          attendee.id,
          cookie,
          csrfToken,
        );
        await expectFlashRedirect(
          `/admin/listing/${listing.id}/attendees`,
          "Incomplete registration removed",
        )(response);

        // Verify attendee was deleted
        const { getAttendeeRaw } = await import(
          "#shared/db/attendees/queries.ts"
        );
        const deleted = await getAttendeeRaw(attendee.id);
        expect(deleted).toBeNull();

        // The deletion is recorded in the listing activity log.
        const { getListingActivityLog } = await import(
          "#test-utils/activity-log.ts"
        );
        const log = (await getListingActivityLog(listing.id)).find((l) =>
          l.message.includes("Incomplete attendee deleted"),
        );
        expect(log).toBeDefined();

        // The delete releases the booking by default, so the reserved spot is
        // freed (booked count returns to zero).
        const counted = await getListingWithCount(listing.id);
        expect(counted?.attendee_count).toBe(0);
      });

      test("refuses to delete complete attendee via delete-incomplete", async () => {
        const { listing, cookie, csrfToken, attendee } =
          await setupPaidAttendee(
            "John Paid",
            "john@example.com",
            "pi_test_123",
            1000,
          );

        const response = await submitDeleteIncomplete(
          listing.id,
          attendee.id,
          cookie,
          csrfToken,
        );
        await expectFlashRedirect(
          `/admin/listing/${listing.id}/attendees`,
          undefined,
          false,
        )(response);

        // Verify attendee was NOT deleted (still exists)
        const rows = await getAttendeesRaw(listing.id);
        expect(rows.length).toBe(1);
      });

      test("refuses to delete empty-payment-id attendee with processed payment reference", async () => {
        const { listing, cookie, csrfToken, attendee } =
          await setupPaidAttendee(
            "Balance Paid",
            "balance-paid@example.com",
            "",
            1000,
          );
        await reserveSession("balance_paid_delete_guard");
        await finalizeSession(
          "balance_paid_delete_guard",
          attendee.id,
          [],
          "pi_balance_paid",
        );

        const response = await submitDeleteIncomplete(
          listing.id,
          attendee.id,
          cookie,
          csrfToken,
        );
        await expectFlashRedirect(
          `/admin/listing/${listing.id}/attendees`,
          undefined,
          false,
        )(response);

        const rows = await getAttendeesRaw(listing.id);
        expect(rows.length).toBe(1);
      });

      test("refuses to delete admin-added attendee on paid listing via delete-incomplete", async () => {
        const { listing, cookie, csrfToken } = await loginToPaidListing();
        // Admin-added attendee: no payment_id and price_paid=0
        const attendee = await createTestAttendee(
          listing.id,
          listing.slug,
          "Admin Added",
          "admin@example.com",
        );

        const response = await submitDeleteIncomplete(
          listing.id,
          attendee.id,
          cookie,
          csrfToken,
        );
        await expectFlashRedirect(
          `/admin/listing/${listing.id}/attendees`,
          undefined,
          false,
        )(response);

        // Verify attendee was NOT deleted
        const rows = await getAttendeesRaw(listing.id);
        expect(rows.length).toBe(1);
      });

      test("deletes incomplete attendee on free can_pay_more listing", async () => {
        const { listing, cookie, csrfToken, attendee } =
          await setupPaidAttendee("Jane Stuck", "jane@example.com", "", 500, {
            canPayMore: true,
            maxAttendees: 100,
            unitPrice: 0,
          });

        const response = await submitDeleteIncomplete(
          listing.id,
          attendee.id,
          cookie,
          csrfToken,
        );
        await expectFlashRedirect(
          `/admin/listing/${listing.id}/attendees`,
          "Incomplete registration removed",
        )(response);

        const { getAttendeeRaw } = await import(
          "#shared/db/attendees/queries.ts"
        );
        const deleted = await getAttendeeRaw(attendee.id);
        expect(deleted).toBeNull();
      });

      test("returns 404 for non-existent attendee", async () => {
        const { listing, cookie, csrfToken } = await loginToPaidListing();

        const response = await submitDeleteIncomplete(
          listing.id,
          999,
          cookie,
          csrfToken,
        );
        expect(response.status).toBe(404);
      });
    });
  },
);
