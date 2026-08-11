import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import type { RefundAttemptResult } from "#shared/payment/refund-attempt.ts";
import {
  createPaidListing,
  type RefundCtx,
  setBookingLineQuantity,
  setupRefundTest,
} from "#test/features/admin/refunds-helpers.ts";
import { getAttendeeActivityLog } from "#test-utils/activity-log.ts";
import {
  assertAdminHtml,
  expectFlashRedirect,
  expectHtmlResponse,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createPaidAttendeeWithoutLedger } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { awaitTestRequest, mockFormRequest } from "#test-utils/mocks.ts";
import { claimCurrentAttendeeRows } from "#test-utils/payment-claim.ts";
import {
  acceptedRefund,
  fullyRefundedMoney,
} from "#test-utils/payment-state.ts";
import {
  expectSingleRefundIssued,
  refundUrl,
  submitRefund,
  withRefundMock,
} from "#test-utils/refund-routes.ts";
import {
  setupListingAndLogin,
  testCookie,
  testCsrfToken,
} from "#test-utils/session.ts";

// -- Tests ---------------------------------------------------------------- //

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

  describe("POST /admin/listing/:listingId/attendee/:attendeeId/refund", () => {
    testRequiresAuth("/admin/attendees/1/refund", {
      body: {
        confirm_identifier: "John Doe",
      },
      method: "POST",
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

    test("rejects invalid CSRF token", async () => {
      const ctx = await setupRefundTest("pi_test_456");
      const response = await submitRefund(ctx, { csrf_token: "invalid-token" });
      expect(response.status).toBe(403);
    });

    test("rejects mismatched attendee name", async () => {
      const ctx = await setupRefundTest("pi_test_789");
      const response = await submitRefund(ctx, {
        confirm_identifier: "Wrong Name",
      });
      await expectFlashRedirect(
        `/admin/attendees/${ctx.attendee.id}/refund`,
        "Attendee name does not match. Please type the exact attendee name to confirm refund.",
        false,
      )(response);
    });

    test("returns error when attendee has no payment", async () => {
      const listing = await createTestListing({ maxAttendees: 100 });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "John Doe",
        "john@example.com",
      );
      const response = await handleRequest(
        mockFormRequest(
          refundUrl(attendee.id),
          { confirm_identifier: "John Doe", csrf_token: await testCsrfToken() },
          await testCookie(),
        ),
      );
      await expectFlashRedirect(
        `/admin/attendees/${attendee.id}/refund`,
        expect.stringContaining("no payment to refund"),
        false,
      )(response);
    });

    test("returns error when attendee has no active booking line", async () => {
      const ctx = await setupRefundTest("pi_no_quantity_post");
      await setBookingLineQuantity(ctx.attendee.id, ctx.listing.id, 0);

      await expectFlashRedirect(
        `/admin/attendees/${ctx.attendee.id}/refund`,
        "This attendee has no payment to refund.",
        false,
      )(await submitRefund(ctx));
    });

    test("returns error when no payment provider configured", async () => {
      const ctx = await setupRefundTest("pi_test_noprov");
      const response = await submitRefund(ctx);
      await expectFlashRedirect(
        `/admin/attendees/${ctx.attendee.id}/refund`,
        expect.stringContaining("No payment provider configured"),
        false,
      )(response);
    });

    test("successfully refunds attendee payment", async () => {
      const ctx = await setupRefundTest("pi_test_success");

      await expectSingleRefundIssued(ctx);
      expect(
        (await getAttendeeActivityLog(ctx.attendee.id)).map(
          (entry) => entry.message,
        ),
      ).toContain("Refund issued for attendee 'John Doe'");
    });

    // The money is already back, so it is reported as a success WITHOUT the
    // provider being asked to send it again. SumUp has no idempotency key, so
    // a second call there would pay the buyer twice.
    test("treats an already-refunded provider charge as success", async () => {
      const ctx = await setupRefundTest("pi_test_provider_done");

      await withRefundMock(
        false,
        async (mockRefund) => {
          const response = await submitRefund(ctx);
          await expectFlashRedirect(
            `/admin/attendees/${ctx.attendee.id}/actions`,
            "Refund issued",
          )(response);
          expect(mockRefund.calls.length).toBe(0);
        },
        {
          charge: (reference) => {
            expect(reference).toBe("pi_test_provider_done");
            return Promise.resolve(fullyRefundedMoney());
          },
        },
      );
    });

    test("a refund success honors the form's return_url (e.g. the Actions tab)", async () => {
      const ctx = await setupRefundTest("pi_test_return");
      const returnUrl = `/admin/attendees/${ctx.attendee.id}/actions`;

      await withRefundMock(true, async () => {
        const response = await submitRefund(ctx, { return_url: returnUrl });
        await expectFlashRedirect(returnUrl, "Refund issued")(response);
      });
    });

    test("a refund error keeps return_url threaded so a retry returns to its origin", async () => {
      const ctx = await setupRefundTest("pi_test_return_err");
      const returnUrl = `/admin/attendees/${ctx.attendee.id}/actions`;

      await withRefundMock(false, async () => {
        const response = await submitRefund(ctx, { return_url: returnUrl });
        await expectFlashRedirect(
          `/admin/attendees/${ctx.attendee.id}/refund?return_url=${encodeURIComponent(
            returnUrl,
          )}`,
          expect.stringContaining("failed"),
          false,
        )(response);
      });
    });

    test("shows error when refund fails", async () => {
      const ctx = await setupRefundTest("pi_test_fail");

      await withRefundMock(false, async () => {
        const response = await submitRefund(ctx);
        await expectFlashRedirect(
          `/admin/attendees/${ctx.attendee.id}/refund`,
          expect.stringContaining("Refund failed"),
          false,
        )(response);
      });
    });

    test("reports an accepted refund as still settling, not failed", async () => {
      const ctx = await setupRefundTest("pi_test_pending");

      await withRefundMock(acceptedRefund(), async () => {
        const response = await submitRefund(ctx);
        await expectFlashRedirect(
          `/admin/attendees/${ctx.attendee.id}/refund`,
          "A refund for this payment is still settling. Try again after it completes.",
          false,
        )(response);
      });
    });

    test("a refund run that loses the claim race reports settling without a provider call", async () => {
      const ctx = await setupRefundTest("pi_claimed_elsewhere");
      await claimCurrentAttendeeRows(
        [ctx.attendee.id],
        "keyless",
        new Map([[ctx.attendee.id, "pi_claimed_elsewhere"]]),
      );

      await withRefundMock(true, async (mockRefund) => {
        await expectFlashRedirect(
          `/admin/attendees/${ctx.attendee.id}/refund`,
          "A refund for this payment is still settling. Try again after it completes.",
          false,
        )(await submitRefund(ctx));
        expect(mockRefund.calls).toEqual([]);
      });
    });

    test("a provider that never answered is not reported as money sent", async () => {
      // The call died before the provider said anything, so nobody knows
      // whether the money moved. Telling the operator to correct the books and
      // never resend would strand a buyer whose refund was never sent.
      const ctx = await setupRefundTest("pi_uncertain");

      await withRefundMock(
        async (): Promise<RefundAttemptResult> => ({
          kind: "uncertain",
          reason: "network_error",
        }),
        async () => {
          await expectFlashRedirect(
            `/admin/attendees/${ctx.attendee.id}/refund`,
            expect.stringContaining("Refund failed"),
            false,
          )(await submitRefund(ctx));
        },
      );
    });

    describe("a provider refund the ledger could not record", () => {
      const errors = setupErrorSpy();

      test("surfaces it for a manual adjustment and reports the broken promise", async () => {
        // The booking predates the ledger, so the provider refund succeeds but the
        // reversal finds no clean order to post — refund status is ledger-only now,
        // so this must surface for a manual adjustment, not read as refunded.
        const listing = await createPaidListing();
        const attendee = await createPaidAttendeeWithoutLedger(
          listing.id,
          "John Doe",
          "john@example.com",
          "pi_unrecorded",
        );
        const ctx: RefundCtx = {
          attendee,
          cookie: await testCookie(),
          csrfToken: await testCsrfToken(),
          listing,
        };
        await withRefundMock(true, async (mockRefund) => {
          const response = await submitRefund(ctx);
          await expectFlashRedirect(
            `/admin/attendees/${attendee.id}/refund`,
            "The payment provider sent the refund. It could not be recorded in Money. Add a correction. Do not send the refund again.",
            false,
          )(response);
          expect(mockRefund.calls.length).toBeGreaterThan(0);
          // Money moved without a ledger record: the flash alone is not enough,
          // the incident must reach the classified error fan-out too.
          expect(
            errors.contains(
              `[Error] E_INVARIANT_REPORTED listing=${listing.id} ` +
                `attendee=${attendee.id} detail="error.refund_not_recorded"`,
            ),
          ).toBe(true);
        });
      });
    });

    test("handles missing confirm_identifier field", async () => {
      const ctx = await setupRefundTest("pi_test_missing");
      const response = await handleRequest(
        mockFormRequest(
          refundUrl(ctx.attendee.id),
          { csrf_token: ctx.csrfToken },
          ctx.cookie,
        ),
      );
      await expectFlashRedirect(
        `/admin/attendees/${ctx.attendee.id}/refund`,
        expect.stringContaining("does not match"),
        false,
      )(response);
    });
  });
});
