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
       * the session, the created attendee, and a bound `deleteIncomplete` that
       * POSTs the delete-incomplete route for that attendee. */
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
        const deleteIncomplete = (): Promise<Response> =>
          submitDeleteIncomplete(
            session.listing.id,
            attendee.id,
            session.cookie,
            session.csrfToken,
          );
        return { ...session, attendee, deleteIncomplete };
      };

      /** Assert a delete-incomplete POST was refused: it redirects to the
       * roster with no flash and the attendee is still there. */
      const expectDeleteRefused = async (
        response: Response,
        listingId: number,
      ): Promise<void> => {
        await expectFlashRedirect(
          `/admin/listing/${listingId}/attendees`,
          undefined,
          false,
        )(response);
        const rows = await getAttendeesRaw(listingId);
        expect(rows.length).toBe(1);
      };

      /** Assert a delete-incomplete POST succeeded: it redirects to the roster
       * with the removal flash and the attendee is gone. */
      const expectDeleteSucceeded = async (
        response: Response,
        listingId: number,
        attendeeId: number,
      ): Promise<void> => {
        await expectFlashRedirect(
          `/admin/listing/${listingId}/attendees`,
          "Incomplete registration removed",
        )(response);
        const { getAttendeeRaw } = await import(
          "#shared/db/attendees/queries.ts"
        );
        expect(await getAttendeeRaw(attendeeId)).toBeNull();
      };

      testRequiresAuth("/admin/listing/1/attendee/1/delete-incomplete", {
        body: {},
        method: "POST",
        setup: async () => {
          await setupPaidAttendee("John Doe", "john@example.com", "", 1000);
        },
      });

      test("deletes incomplete attendee without name confirmation", async () => {
        const { listing, attendee, deleteIncomplete } = await setupPaidAttendee(
          "Jane Stuck",
          "jane@example.com",
          "",
          1000,
        );

        const response = await deleteIncomplete();
        await expectDeleteSucceeded(response, listing.id, attendee.id);

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
        const { listing, deleteIncomplete } = await setupPaidAttendee(
          "John Paid",
          "john@example.com",
          "pi_test_123",
          1000,
        );

        await expectDeleteRefused(await deleteIncomplete(), listing.id);
      });

      test("refuses to delete empty-payment-id attendee with processed payment reference", async () => {
        const { listing, attendee, deleteIncomplete } = await setupPaidAttendee(
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

        await expectDeleteRefused(await deleteIncomplete(), listing.id);
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
        await expectDeleteRefused(response, listing.id);
      });

      test("deletes incomplete attendee on free can_pay_more listing", async () => {
        const { listing, attendee, deleteIncomplete } = await setupPaidAttendee(
          "Jane Stuck",
          "jane@example.com",
          "",
          500,
          { canPayMore: true, maxAttendees: 100, unitPrice: 0 },
        );

        await expectDeleteSucceeded(
          await deleteIncomplete(),
          listing.id,
          attendee.id,
        );
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
