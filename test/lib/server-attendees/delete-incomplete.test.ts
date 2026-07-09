// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getListingWithCount } from "#shared/db/listings.ts";
import {
  createPaidTestAttendee,
  createTestAttendee,
  describeWithEnv,
  expectFlashRedirect,
  getAttendeesRaw,
  setupListingAndLogin,
  testRequiresAuth,
} from "#test-utils";

// jscpd:ignore-end
import { submitDeleteIncomplete } from "./helpers.ts";

describeWithEnv(
  "server (admin attendees) > delete-incomplete",
  { db: true },
  () => {
    describe("POST /admin/listing/:listingId/attendee/:attendeeId/delete-incomplete", () => {
      testRequiresAuth("/admin/listing/1/attendee/1/delete-incomplete", {
        body: {},
        method: "POST",
        setup: async () => {
          const { listing } = await setupListingAndLogin({
            maxAttendees: 100,
            unitPrice: 1000,
          });
          await createPaidTestAttendee(
            listing.id,
            "John Doe",
            "john@example.com",
            "",
            1000,
          );
        },
      });

      test("deletes incomplete attendee without name confirmation", async () => {
        const { listing, cookie, csrfToken } = await setupListingAndLogin({
          maxAttendees: 100,
          unitPrice: 1000,
        });
        const attendee = await createPaidTestAttendee(
          listing.id,
          "Jane Stuck",
          "jane@example.com",
          "",
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
          "Incomplete registration removed",
        )(response);

        // Verify attendee was deleted
        const { getAttendeeRaw } = await import("#shared/db/attendees.ts");
        const deleted = await getAttendeeRaw(attendee.id);
        expect(deleted).toBeNull();

        // The deletion is recorded in the listing activity log.
        const { getListingActivityLog } = await import("#test-utils");
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
        const { listing, cookie, csrfToken } = await setupListingAndLogin({
          maxAttendees: 100,
          unitPrice: 1000,
        });
        const attendee = await createPaidTestAttendee(
          listing.id,
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

      test("refuses to delete admin-added attendee on paid listing via delete-incomplete", async () => {
        const { listing, cookie, csrfToken } = await setupListingAndLogin({
          maxAttendees: 100,
          unitPrice: 1000,
        });
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
        const { listing, cookie, csrfToken } = await setupListingAndLogin({
          canPayMore: true,
          maxAttendees: 100,
          unitPrice: 0,
        });
        const attendee = await createPaidTestAttendee(
          listing.id,
          "Jane Stuck",
          "jane@example.com",
          "",
          500,
        );

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

        const { getAttendeeRaw } = await import("#shared/db/attendees.ts");
        const deleted = await getAttendeeRaw(attendee.id);
        expect(deleted).toBeNull();
      });

      test("returns 404 for non-existent attendee", async () => {
        const { listing, cookie, csrfToken } = await setupListingAndLogin({
          maxAttendees: 100,
          unitPrice: 1000,
        });

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
