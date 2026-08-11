import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { setN1GuardNotifyOnly } from "#shared/db/query-log.ts";
import {
  createPaidListing,
  setupRefundTest,
} from "#test/features/admin/refunds-helpers.ts";
import { getListingActivityLog } from "#test-utils/activity-log.ts";
import {
  expectFlashRedirect,
  expectHtmlResponse,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createPaidTestAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { awaitTestRequest, mockFormRequest } from "#test-utils/mocks.ts";
import {
  postRefundAll,
  refundAllUrl,
  submitRefundAll,
  withRefundMock,
} from "#test-utils/refund-routes.ts";
import { testCookie, testCsrfToken } from "#test-utils/session.ts";

describeWithEnv("server (admin refund-all)", { db: true }, () => {
  describe("GET /admin/listing/:id/refund-all", () => {
    testRequiresAuth("/admin/listing/1/refund-all", {
      setup: async () => {
        await createPaidListing();
      },
    });

    test("returns 404 for non-existent listing", async () => {
      const response = await awaitTestRequest(refundAllUrl(999), {
        cookie: await testCookie(),
      });
      expect(response.status).toBe(404);
    });

    test("shows error when no attendees have payments", async () => {
      const listing = await createTestListing({ maxAttendees: 100 });
      await createTestAttendee(
        listing.id,
        listing.slug,
        "John Doe",
        "john@example.com",
      );

      const response = await awaitTestRequest(refundAllUrl(listing.id), {
        cookie: await testCookie(),
      });
      await expectHtmlResponse(
        response,
        400,
        "No attendees have payments to refund",
        "0 attendee(s) with payments",
      );
    });

    test("shows refund all confirmation page with refundable count", async () => {
      const listing = await createPaidListing();
      await createPaidTestAttendee(
        listing.id,
        "Paid User",
        "paid@example.com",
        "pi_paid_1",
      );
      await createTestAttendee(
        listing.id,
        listing.slug,
        "Free User",
        "free@example.com",
      );

      const response = await awaitTestRequest(refundAllUrl(listing.id), {
        cookie: await testCookie(),
      });
      await expectHtmlResponse(
        response,
        200,
        "Refund All",
        "1 attendee(s) with payments",
        "type the listing name",
      );
    });
  });

  describe("POST /admin/listing/:id/refund-all", () => {
    // A bulk refund posts a ledger reversal per attendee: a known per-attendee
    // read. Production runs the guard in notify-only mode (src/edge.ts), so a
    // real bulk refund of many attendees still posts every leg; match that here.
    beforeEach(() => setN1GuardNotifyOnly(true));
    afterEach(() => setN1GuardNotifyOnly(null));

    testRequiresAuth("/admin/listing/1/refund-all", {
      body: {
        confirm_identifier: "Test Listing",
      },
      method: "POST",
      setup: async () => {
        await createPaidListing();
      },
    });

    test("returns 404 for non-existent listing", async () => {
      const response = await handleRequest(
        mockFormRequest(
          refundAllUrl(999),
          { confirm_identifier: "Test", csrf_token: await testCsrfToken() },
          await testCookie(),
        ),
      );
      expect(response.status).toBe(404);
    });

    test("rejects mismatched listing name", async () => {
      const ctx = await setupRefundTest("pi_refundall_1");
      const response = await submitRefundAll(ctx, {
        confirm_identifier: "Wrong Listing Name",
      });
      await expectFlashRedirect(
        `/admin/listing/${ctx.listing.id}/refund-all`,
        "Listing name does not match. Please type the exact listing name to confirm.",
        false,
      )(response);
    });

    test("rejects when confirm_identifier is missing", async () => {
      const ctx = await setupRefundTest("pi_refundall_missing");
      const response = await handleRequest(
        mockFormRequest(
          refundAllUrl(ctx.listing.id),
          { csrf_token: ctx.csrfToken },
          ctx.cookie,
        ),
      );
      await expectFlashRedirect(
        `/admin/listing/${ctx.listing.id}/refund-all`,
        expect.stringContaining("does not match"),
        false,
      )(response);
    });

    test("returns error when no attendees have payments", async () => {
      const listing = await createTestListing({ maxAttendees: 100 });
      await createTestAttendee(
        listing.id,
        listing.slug,
        "John Doe",
        "john@example.com",
      );
      const response = await handleRequest(
        mockFormRequest(
          refundAllUrl(listing.id),
          {
            confirm_identifier: listing.name,
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );
      await expectFlashRedirect(
        `/admin/listing/${listing.id}/refund-all`,
        expect.stringContaining("No attendees have payments to refund"),
        false,
      )(response);
    });

    test("explains when no configured provider recognizes the payment", async () => {
      const ctx = await setupRefundTest("pi_noprov_all");
      const response = await submitRefundAll(ctx);
      await expectFlashRedirect(
        `/admin/listing/${ctx.listing.id}/refund-all`,
        expect.stringContaining(
          "No configured payment provider recognizes this payment",
        ),
        false,
      )(response);
    });

    test("successfully refunds all attendees", async () => {
      const listing = await createPaidListing();
      await createPaidTestAttendee(
        listing.id,
        "User One",
        "one@example.com",
        "pi_all_1",
      );
      await createPaidTestAttendee(
        listing.id,
        "User Two",
        "two@example.com",
        "pi_all_2",
      );
      await withRefundMock(true, async (mockRefund) => {
        const response = await postRefundAll(listing);
        await expectFlashRedirect(
          `/admin/listing/${listing.id}`,
          "All attendees refunded",
        )(response);
        expect(mockRefund.calls.length).toBe(2);
      });

      const log = (await getListingActivityLog(listing.id)).find((entry) =>
        entry.message.includes("Bulk refund: all"),
      );
      expect(log?.message).toContain("all 2 attendee(s) refunded");
    });
  });
});
