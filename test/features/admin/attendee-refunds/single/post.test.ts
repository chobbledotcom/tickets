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
  expectFlashRedirect,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createPaidAttendeeWithoutLedger } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import { claimCurrentAttendeeRows } from "#test-utils/payment-claim.ts";
import { chargeMoney, fullyRefundedMoney } from "#test-utils/payment-state.ts";
import {
  refundCompletes,
  refundIsRejected,
  refundStaysPending,
  refundUrl,
  submitRefund,
  withRefundMock,
} from "#test-utils/refund-routes.ts";
import { testCookie, testCsrfToken } from "#test-utils/session.ts";

describeWithEnv("server (admin refunds)", { db: true }, () => {
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

    test("explains when no configured provider recognizes the payment", async () => {
      const ctx = await setupRefundTest("pi_test_noprov");
      const response = await submitRefund(ctx);
      await expectFlashRedirect(
        `/admin/attendees/${ctx.attendee.id}/refund`,
        expect.stringContaining(
          "No configured payment provider recognizes this payment",
        ),
        false,
      )(response);
    });

    test("successfully refunds attendee payment", async () => {
      const ctx = await setupRefundTest("pi_test_success");
      const observed = chargeMoney(731, 0, "USD");

      await withRefundMock(
        refundCompletes,
        async (mockRefund) => {
          await expectFlashRedirect(
            `/admin/attendees/${ctx.attendee.id}/actions`,
            "Refund issued",
          )(await submitRefund(ctx));
          expect(mockRefund.calls[0]?.args[0]).toMatchObject({
            authorization: {
              capability: "keyed",
              generation: 1,
              provider: "stripe",
            },
            charge: observed,
            paymentReference: "pi_test_success",
          });
        },
        { charge: observed },
      );
      expect(
        (await getAttendeeActivityLog(ctx.attendee.id)).map(
          (entry) => entry.message,
        ),
      ).toContain("Refund issued");
      expect(
        (await getAttendeeActivityLog(ctx.attendee.id)).map(
          (entry) => entry.message,
        ),
      ).not.toContain("Refund issued for attendee 'John Doe'");
    });

    // The money is already back, so it is reported as a success WITHOUT the
    // provider being asked to send it again. SumUp has no idempotency key, so
    // a second call there would pay the buyer twice.
    test("treats an already-refunded provider charge as success", async () => {
      const ctx = await setupRefundTest("pi_test_provider_done");

      await withRefundMock(
        refundIsRejected,
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

      await withRefundMock(refundCompletes, async () => {
        const response = await submitRefund(ctx, { return_url: returnUrl });
        await expectFlashRedirect(returnUrl, "Refund issued")(response);
      });
    });

    test("a refund error opens its canonical recovery case", async () => {
      const ctx = await setupRefundTest("pi_test_return_err");
      const returnUrl = `/admin/attendees/${ctx.attendee.id}/actions`;

      await withRefundMock(refundIsRejected, async () => {
        const response = await submitRefund(ctx, { return_url: returnUrl });
        await expectFlashRedirect(
          "/admin/privacy#refund-recovery",
          expect.stringContaining("failed"),
          false,
        )(response);
      });
    });

    test("shows error when refund fails", async () => {
      const ctx = await setupRefundTest("pi_test_fail");

      await withRefundMock(refundIsRejected, async () => {
        const response = await submitRefund(ctx);
        await expectFlashRedirect(
          "/admin/privacy#refund-recovery",
          expect.stringContaining("Refund failed"),
          false,
        )(response);
      });
    });

    test("reports an accepted refund as still settling, not failed", async () => {
      const ctx = await setupRefundTest("pi_test_pending");

      await withRefundMock(refundStaysPending, async () => {
        const response = await submitRefund(ctx);
        await expectFlashRedirect(
          "/admin/privacy#refund-recovery",
          "A refund for this payment is still settling. Refresh payment status after it completes.",
          false,
        )(response);
      });
    });

    test("a stale form sees the refund already owned by another run", async () => {
      const ctx = await setupRefundTest("pi_claimed_elsewhere");
      await claimCurrentAttendeeRows([ctx.attendee.id]);

      await withRefundMock(refundCompletes, async (mockRefund) => {
        await expectFlashRedirect(
          `/admin/attendees/${ctx.attendee.id}/actions`,
          "A refund for this payment is still settling. Refresh payment status after it completes.",
          false,
        )(await submitRefund(ctx));
        expect(mockRefund.calls).toEqual([]);
      });
    });

    test("a provider that never answered is checked instead of sent again", async () => {
      // The call died before the provider said anything, so nobody knows
      // whether the money moved. Its canonical authority stays observable and
      // refuses to expose a second provider call.
      const ctx = await setupRefundTest("pi_uncertain");

      await withRefundMock(
        async (): Promise<RefundAttemptResult> => ({
          kind: "uncertain",
          reason: "network_error",
        }),
        async (mockRefund) => {
          for (const response of [await submitRefund(ctx), await submitRefund(ctx)]) {
            await expectFlashRedirect(
              "/admin/privacy#refund-recovery",
              "A refund for this payment is still settling. Refresh payment status after it completes.",
              false,
            )(response);
          }
          expect(mockRefund.calls.length).toBe(1);
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
        await withRefundMock(refundCompletes, async (mockRefund) => {
          const response = await submitRefund(ctx);
          await expectFlashRedirect(
            "/admin/privacy#refund-recovery",
            "The payment provider sent the refund. It could not be recorded in Money. Fix Money, then refresh payment status. Do not send the refund again.",
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
