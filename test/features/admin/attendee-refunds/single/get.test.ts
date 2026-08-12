import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import { deleteListing } from "#shared/db/listings/delete.ts";
import {
  createPaidListing,
  setBookingLineQuantity,
  setupRefundTest,
} from "#test/features/admin/refunds-helpers.ts";
import {
  assertAdminHtml,
  expectHtmlResponse,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import { claimCurrentAttendeeRows } from "#test-utils/payment-claim.ts";
import { statementSql, wrapDbClient } from "#test-utils/record-queries.ts";
import { refundUrl } from "#test-utils/refund-routes.ts";
import { setupListingAndLogin, testCookie } from "#test-utils/session.ts";

describeWithEnv("server (admin refunds)", { db: true }, () => {
  describe("GET /admin/listing/:listingId/attendee/:attendeeId/refund", () => {
    testRequiresAuth("/admin/attendees/1/refund", {
      setup: async () => {
        const listing = await createPaidListing();
        await createTestAttendee(
          listing.id,
          listing.slug,
          "John Doe",
          "john@example.com",
        );
      },
    });

    test("returns 404 for non-existent attendee", async () => {
      const { cookie } = await setupListingAndLogin({ maxAttendees: 100 });
      const response = await awaitTestRequest(refundUrl(999), { cookie });
      expect(response.status).toBe(404);
    });

    test("returns 404 for an orphan attendee with no home listing", async () => {
      // The attendee-scoped route loads the attendee's home listing; an
      // attendee whose bookings are all gone has none, so the action 404s.
      const listing = await createTestListing({ maxAttendees: 100 });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "John Doe",
        "john@example.com",
      );
      const { getDb } = await import("#shared/db/client.ts");
      await getDb().execute(
        "DELETE FROM listing_attendees WHERE attendee_id = ?",
        [attendee.id],
      );
      const response = await awaitTestRequest(refundUrl(attendee.id), {
        cookie: await testCookie(),
      });
      expect(response.status).toBe(404);
    });

    test("returns 404 when the chosen listing disappears during the load", async () => {
      const ctx = await setupRefundTest("pi_listing_deleted_during_load");
      const realDb = getDb();
      let removed = false;
      const restoreDb = wrapDbClient({
        batch: () => {},
        execute: (statement) => {
          if (
            removed ||
            !statementSql(statement).includes(
              "SELECT listingAttendee.listing_id",
            )
          ) {
            return null;
          }
          removed = true;
          return (async () => {
            const selected = await realDb.execute(statement);
            await deleteListing(ctx.listing.id);
            return selected;
          })();
        },
      });

      try {
        const response = await awaitTestRequest(refundUrl(ctx.attendee.id), {
          cookie: ctx.cookie,
        });
        expect(response.status).toBe(404);
      } finally {
        restoreDb();
      }
      expect(removed).toBe(true);
    });

    test("shows error when attendee has no payment", async () => {
      const listing = await createTestListing({ maxAttendees: 100 });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "John Doe",
        "john@example.com",
      );

      const response = await awaitTestRequest(refundUrl(attendee.id), {
        cookie: await testCookie(),
      });
      await expectHtmlResponse(response, 400, "no payment to refund");
    });

    test("shows refund confirmation page for paid attendee", async () => {
      const ctx = await setupRefundTest("pi_test_123");
      const response = await awaitTestRequest(refundUrl(ctx.attendee.id), {
        cookie: ctx.cookie,
      });
      await expectHtmlResponse(
        response,
        200,
        "Refund Attendee",
        "John Doe",
        "type their name",
        "£5",
      );
    });

    test("shows moving-payment guidance without a refund form", async () => {
      const ctx = await setupRefundTest("pi_moving_get");
      await claimCurrentAttendeeRows([ctx.attendee.id]);

      const response = await awaitTestRequest(refundUrl(ctx.attendee.id), {
        cookie: ctx.cookie,
      });
      const html = await response.text();

      expect(response.status).toBe(400);
      expect(html).toContain("Refresh payment status");
      expect(html).not.toContain("Refund Attendee</button>");
      expect(html).not.toContain('name="confirm_identifier"');
    });

    test("shows no-payment error when the attendee has no active booking line", async () => {
      const ctx = await setupRefundTest("pi_no_quantity_get");
      await setBookingLineQuantity(ctx.attendee.id, ctx.listing.id, 0);

      const response = await awaitTestRequest(refundUrl(ctx.attendee.id), {
        cookie: ctx.cookie,
      });

      await expectHtmlResponse(response, 400, "no payment to refund");
    });

    test("includes return_url as hidden field when provided", async () => {
      const ctx = await setupRefundTest("pi_test_return");
      const url = `${refundUrl(ctx.attendee.id)}?return_url=${encodeURIComponent(
        "/admin/calendar#attendees",
      )}`;
      await assertAdminHtml(
        url,
        'name="return_url"',
        "/admin/calendar#attendees",
      );
    });
  });
});
