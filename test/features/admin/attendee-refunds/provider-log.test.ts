import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { loadPaymentMoveSnapshot } from "#shared/db/payment-admit-move.ts";
import { listProviderRefundCases } from "#shared/db/provider-refund-cases.ts";
import {
  createPaidListing,
  createRefundableAttendee,
  setupRefundTest,
} from "#test/features/admin/refunds-helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { partlyRefundedCharge } from "#test-utils/payment-state.ts";
import {
  postRefundAll,
  refundCompletes,
  refundIsRejected,
  submitRefund,
  withRefundMock,
} from "#test-utils/refund-routes.ts";

describeWithEnv("server (admin refund provider logging)", { db: true }, () => {
  describe("provider refund failures reach the error log", () => {
    const errors = setupErrorSpy();
    const loggedDetails = (): string[] =>
      errors.calls.map((call) => String(call.args[0]));

    test("a single refund the provider rejects is logged", async () => {
      const ctx = await setupRefundTest("pi_logfail_single");
      await withRefundMock(refundIsRejected, async () => {
        await submitRefund(ctx);
      });
      expect(
        loggedDetails().some((s) =>
          s.includes("Admin bulk refund failed for 1 payment(s)"),
        ),
      ).toBe(true);
      expect(loggedDetails().some((s) => s.includes("pi_logfail_single"))).toBe(
        false,
      );
    });

    test("a bulk refund the provider rejects is logged per attendee", async () => {
      const listing = await createPaidListing();
      await createRefundableAttendee(
        listing.id,
        "Bulk Fail",
        "bulkfail@example.com",
        "pi_logfail_bulk",
      );
      await withRefundMock(refundIsRejected, async () => {
        await postRefundAll(listing);
      });
      expect(
        loggedDetails().some((s) => s.includes("Admin bulk refund failed")),
      ).toBe(true);
    });

    test("an uncertain bulk refund answer becomes durable recovery work", async () => {
      const listing = await createPaidListing();
      await createRefundableAttendee(
        listing.id,
        "Bulk Throw",
        "bulkthrow@example.com",
        "pi_logfail_throw",
      );
      await withRefundMock(
        () =>
          Promise.resolve({
            kind: "uncertain",
            reason: "network_error",
          } as const),
        async () => {
          await postRefundAll(listing);
        },
      );
      expect((await listProviderRefundCases()).cases).toEqual([
        expect.objectContaining({ state: "observing" }),
      ]);
    });

    test("a refused provider observation becomes durable owner work", async () => {
      const ctx = await setupRefundTest("pi_review_single");
      await withRefundMock(
        refundCompletes,
        async (mockRefund) => {
          await submitRefund(ctx);
          expect(mockRefund.calls).toEqual([]);
        },
        { charge: partlyRefundedCharge() },
      );

      expect(
        (await loadPaymentMoveSnapshot([ctx.attendee.id])).work.status,
      ).toBe("needs_provider_recovery");
    });
  });
});
