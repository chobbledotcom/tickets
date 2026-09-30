// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
// jscpd:ignore-end
import { adminListingPage } from "#test-utils/admin-fixture.ts";
import {
  expectHtmlResponse,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { setupListingAndAttendee } from "#test-utils/attendees/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { adminGet } from "#test-utils/session.ts";

describeWithEnv(
  "server (admin attendees) > resend notification",
  { db: true },
  () => {
    describe("GET /admin/attendees/:attendeeId/resend-notification", () => {
      testRequiresAuth("/admin/attendees/1/resend-notification", {
        setup: async () => {
          await setupListingAndAttendee();
        },
      });

      test("returns 404 for non-existent listing", async () => {
        const response = await adminGet(
          "/admin/attendees/1/resend-notification",
        );
        expect(response.status).toBe(404);
      });

      test("returns 404 for non-existent attendee", async () => {
        await setupListingAndAttendee();

        const response = await adminGet(
          "/admin/attendees/999/resend-notification",
        );
        expect(response.status).toBe(404);
      });

      test("shows resend notification confirmation page when authenticated", async () => {
        const { response } = await adminListingPage(
          (ctx) => `/admin/attendees/${ctx.attendee.id}/resend-notification`,
        )();
        await expectHtmlResponse(
          response,
          200,
          "Re-send Notification",
          "John Doe",
          "type their name",
        );
      });

      test("includes return_url as hidden field when provided", async () => {
        const { response } = await adminListingPage(
          (ctx) =>
            `/admin/attendees/${ctx.attendee.id}/resend-notification?return_url=${encodeURIComponent(
              "/admin/calendar#attendees",
            )}`,
        )();
        await expectHtmlResponse(
          response,
          200,
          'name="return_url"',
          "/admin/calendar#attendees",
        );
      });

      test("shows amount paid on resend notification page for paid attendee", async () => {
        const listing = await createTestListing({
          maxAttendees: 100,
          unitPrice: 1000,
        });

        const result = await bookAttendee(listing, {
          email: "jane@example.com",
          name: "Jane Paid",
          paymentId: "pi_test",
          pricePaid: 1000,
          quantity: 1,
        });

        if (!result.success) {
          throw new Error("Failed to create attendee");
        }

        const response = await adminGet(
          `/admin/attendees/${result.attendees[0]!.id}/resend-notification`,
        );
        await expectHtmlResponse(
          response,
          200,
          "Re-send Notification",
          "Jane Paid",
          "Amount Paid",
        );
      });
    });
  },
);
