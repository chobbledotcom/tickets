import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { resetI18nForTest } from "#i18n";
import { handleRequest } from "#routes";
import { setN1GuardNotifyOnly } from "#shared/db/query-log.ts";
import { BULK_REFUND_FOREGROUND_REFERENCE_LIMIT } from "#shared/subrequest-budget.ts";
import {
  createPaidListing,
  createRefundableTestAttendee,
  createRefundableTestAttendeeWithoutLedger,
  seedBatchAttendees,
  setupRefundTest,
} from "#test/lib/server-refunds-helpers.ts";
import { getListingActivityLog } from "#test-utils/activity-log.ts";
import {
  expectFlashRedirect,
  expectHtmlResponse,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { withEnv } from "#test-utils/env.ts";
import { awaitTestRequest, mockFormRequest } from "#test-utils/mocks.ts";
import {
  postRefundAll,
  refundAllUrl,
  submitRefundAll,
  withRefundMock,
} from "#test-utils/refund-routes.ts";
import { testCookie, testCsrfToken } from "#test-utils/session.ts";

const SINGLE_ERROR_RESULT =
  "1 refund succeeded. There was 1 failure. There was 1 error. Check the activity log for details. Some payments may have already been refunded.";

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
      await createRefundableTestAttendee(
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

    test("reports a stored provider error when no active provider is configured", async () => {
      const ctx = await setupRefundTest("pi_noprov_all");
      const response = await submitRefundAll(ctx);
      await expectFlashRedirect(
        `/admin/listing/${ctx.listing.id}/refund-all`,
        "0 refunds succeeded. There was 1 failure. There was 1 error. Check the activity log for details. Some payments may have already been refunded.",
        false,
      )(response);
    });

    test("successfully refunds all attendees", async () => {
      const listing = await createPaidListing();
      await createRefundableTestAttendee(
        listing.id,
        "User One",
        "one@example.com",
        "pi_all_1",
      );
      await createRefundableTestAttendee(
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

    test("counts a refund the ledger could not record as errored, not refunded", async () => {
      const listing = await createPaidListing();
      await createRefundableTestAttendee(
        listing.id,
        "Ledgered",
        "ledgered@example.com",
        "pi_mixed_ledgered",
      );
      await createRefundableTestAttendeeWithoutLedger(
        listing.id,
        "Unledgered",
        "unledgered@example.com",
        "pi_mixed_unledgered",
      );
      await withRefundMock(true, async (mockRefund) => {
        const response = await postRefundAll(listing);
        expect(mockRefund.calls.length).toBe(2);
        await expectFlashRedirect(
          `/admin/listing/${listing.id}/refund-all`,
          SINGLE_ERROR_RESULT,
          false,
        )(response);
      });
    });

    test("caps refunds to preserve the edge subrequest budget", async () => {
      const listing = await createPaidListing({ maxAttendees: 500 });
      await seedBatchAttendees(
        listing,
        "pi_batch_",
        BULK_REFUND_FOREGROUND_REFERENCE_LIMIT + 1,
      );
      await withRefundMock(true, async (mockRefund) => {
        const response = await postRefundAll(listing);
        expect(mockRefund.calls.length).toBe(
          BULK_REFUND_FOREGROUND_REFERENCE_LIMIT,
        );
        await expectFlashRedirect(
          `/admin/listing/${listing.id}/refund-all`,
          `${BULK_REFUND_FOREGROUND_REFERENCE_LIMIT} refunds succeeded. 1 refund will continue in the background.`,
        )(response);
      });

      const log = (await getListingActivityLog(listing.id)).find((entry) =>
        entry.message.includes(
          `Bulk refund: ${BULK_REFUND_FOREGROUND_REFERENCE_LIMIT} of`,
        ),
      );
      expect(log?.message).toContain(
        `Bulk refund: ${BULK_REFUND_FOREGROUND_REFERENCE_LIMIT} of ${BULK_REFUND_FOREGROUND_REFERENCE_LIMIT + 1} refunded`,
      );
    });

    const remainingFailureCases = [
      {
        count: 1,
        expected: `0 refunds succeeded. There were ${BULK_REFUND_FOREGROUND_REFERENCE_LIMIT} failures. 1 refund will continue in the background.`,
        label: "one refund remaining",
      },
      {
        count: 2,
        expected: `0 refunds succeeded. There were ${BULK_REFUND_FOREGROUND_REFERENCE_LIMIT} failures. 2 refunds will continue in the background.`,
        label: "multiple refunds remaining",
      },
    ];
    for (const { count, expected, label } of remainingFailureCases) {
      test(`reports failures with ${label}`, async () => {
        const listing = await createPaidListing({ maxAttendees: 500 });
        await seedBatchAttendees(
          listing,
          `pi_batchfail_${count}_`,
          BULK_REFUND_FOREGROUND_REFERENCE_LIMIT + count,
        );
        await withRefundMock(false, async () => {
          await expectFlashRedirect(
            `/admin/listing/${listing.id}/refund-all`,
            expected,
            false,
          )(await postRefundAll(listing));
        });
      });
    }

    test("applies copy replacements to a completed partial-refund result", async () => {
      const listing = await createPaidListing();
      await createRefundableTestAttendee(
        listing.id,
        "Good User",
        "good@example.com",
        "pi_partial_ok",
      );
      await createRefundableTestAttendee(
        listing.id,
        "Bad User",
        "bad@example.com",
        "pi_partial_fail",
      );
      let callNum = 0;
      using _env = withEnv({ I18N_REPLACEMENTS: "failure|problem" });
      resetI18nForTest();
      try {
        await withRefundMock(
          () => Promise.resolve(++callNum <= 1),
          async () => {
            await expectFlashRedirect(
              `/admin/listing/${listing.id}/refund-all`,
              "1 refund succeeded. There was 1 problem. Some payments may have already been refunded.",
              false,
            )(await postRefundAll(listing));
          },
        );
      } finally {
        resetI18nForTest();
      }

      const log = (await getListingActivityLog(listing.id)).find((entry) =>
        entry.message.includes("Bulk refund: 1 succeeded"),
      );
      expect(log?.message).toContain("1 succeeded, 1 failed");
    });

    test("catches thrown refund errors and reports them in the flash", async () => {
      const listing = await createPaidListing();
      await createRefundableTestAttendee(
        listing.id,
        "Good User",
        "good@example.com",
        "pi_throw_ok",
      );
      await createRefundableTestAttendee(
        listing.id,
        "Throw User",
        "throw@example.com",
        "pi_throw_boom",
      );
      let callNum = 0;
      await withRefundMock(
        () => {
          callNum++;
          if (callNum === 1) return Promise.resolve(true);
          return Promise.reject(new Error("Stripe refund boom"));
        },
        async () => {
          const response = await postRefundAll(listing);
          await expectFlashRedirect(
            `/admin/listing/${listing.id}/refund-all`,
            SINGLE_ERROR_RESULT,
            false,
          )(response);
        },
      );
    });

    test("uses plural error copy when multiple refunds throw", async () => {
      const listing = await createPaidListing();
      await createRefundableTestAttendee(
        listing.id,
        "Throw One",
        "throw-one@example.com",
        "pi_throw_one",
      );
      await createRefundableTestAttendee(
        listing.id,
        "Throw Two",
        "throw-two@example.com",
        "pi_throw_two",
      );
      await withRefundMock(
        () => Promise.reject(new Error("Stripe refund boom")),
        async () => {
          await expectFlashRedirect(
            `/admin/listing/${listing.id}/refund-all`,
            "0 refunds succeeded. There were 2 failures. There were 2 errors. Check the activity log for details. Some payments may have already been refunded.",
            false,
          )(await postRefundAll(listing));
        },
      );
    });
  });
});
