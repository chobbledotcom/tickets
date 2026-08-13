// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import {
  chargeMismatchSpec,
  deletedListingSpec,
  failureDetail,
  refuseMismatch,
  validationFailure,
} from "#routes/api/payment-processing/refunds.ts";
import type { PaymentFailureResult } from "#routes/api/webhook-types.ts";
import {
  placeholderRefund,
  placeholderRefundNote,
  type RefundCode,
} from "#shared/payment/placeholder-refund.ts";
import type { RefundRequest } from "#shared/payment/refund-attempt.ts";
import { expectHtmlResponse } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestListing,
  deactivateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { signedMeta, singleItem } from "#test-utils/factories.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { paidSession } from "#test-utils/payment-session.ts";
import {
  chargeMoney,
  completedRefund,
  foundCharge,
  fullyRefundedMoney,
} from "#test-utils/payment-state.ts";
import { refundCompletes, withRefundMock } from "#test-utils/refund-routes.ts";
import { setupStripe } from "#test-utils/settings.ts";
import { stubRetrieveCheckoutSession } from "#test-utils/webhooks/stripe.ts";
// jscpd:ignore-end

import {
  debugLogged,
  errorLogged,
  useDebugLogSpy,
  useErrorLogSpy,
} from "#test-utils/debug-log.ts";
import {
  webhookEvent,
  withWebhookVerify,
} from "#test-utils/webhook-verify-helpers.ts";

/** Create a listing, deactivate it, and return its id — the shared setup for
 *  every redirect-path refund test. */
const deactivatedListing = async () => {
  const listing = await createTestListing({
    maxAttendees: 50,
    unitPrice: 1000,
  });
  await deactivateTestListing(listing.id);
  return listing;
};

/** Set up a deactivated listing, stub the refund/refunded behaviors, retrieve
 *  a session, and run the redirect handler — the shared scaffold for the
 *  already-refunded and refund-failed redirect tests. */
const withRefundRedirect = async (
  refundSucceeds: boolean,
  alreadyRefunded: boolean,
  sessionId: string,
  paymentIntent: string,
  email: string,
  name: string,
  assert: () => Promise<void>,
): Promise<void> => {
  await setupStripe();
  const listing = await deactivatedListing();
  const { stripePaymentProvider } = await import("#shared/stripe-provider.ts");
  using _refund = stub(
    stripePaymentProvider,
    "refundCharge",
    (request: RefundRequest) =>
      Promise.resolve(
        refundSucceeds
          ? completedRefund(request.charge)
          : ({ kind: "rejected", reason: "failed" } as const),
      ),
  );
  using _refunded = stub(stripePaymentProvider, "readCharge", () =>
    Promise.resolve(
      foundCharge(alreadyRefunded ? fullyRefundedMoney() : chargeMoney()),
    ),
  );
  const mockRetrieve = stubRetrieveCheckoutSession({
    amountTotal: 1000,
    email,
    items: singleItem(listing.id, 1, 1000),
    name,
    paymentIntent,
    sessionId,
  });
  try {
    await handleRequest(
      mockRequest(`/payment/success?session_id=${sessionId}`),
    );
    await assert();
  } finally {
    mockRetrieve.restore();
  }
};

describeWithEnv("server (refund helper mutations)", { db: true }, () => {
  const debugSpy = useDebugLogSpy();
  const errorSpy = useErrorLogSpy();

  test("refund logs debug when issued", async () => {
    const listing = await deactivatedListing();
    const mockRetrieve = stubRetrieveCheckoutSession({
      amountTotal: 1000,
      email: "r@e.com",
      items: singleItem(listing.id, 1, 1000),
      name: "R",
      paymentIntent: "pi_refund_log",
      sessionId: "cs_refund_log",
    });
    try {
      await withRefundMock(refundCompletes, async () => {
        const res = await handleRequest(
          mockRequest("/payment/success?session_id=cs_refund_log"),
        );
        await expectHtmlResponse(res, 410, "no longer accepting", "refunded");
        expect(debugLogged(debugSpy, "Refund completed")).toBe(true);
      });
    } finally {
      mockRetrieve.restore();
    }
  });

  test("refund reports success when the money is already back", async () => {
    await withRefundRedirect(
      false,
      true,
      "cs_already_refunded",
      "pi_already_refunded",
      "r2@e.com",
      "R2",
      async () =>
        expect(debugLogged(debugSpy, "the money is already back")).toBe(true),
    );
  });

  test("refund logs error when refund fails and provider is reachable", async () => {
    await withRefundRedirect(
      false,
      false,
      "cs_refund_fail",
      "pi_refund_fail",
      "r3@e.com",
      "R3",
      async () =>
        expect(errorLogged(errorSpy, "Refund rejected for stripe payment")).toBe(
          true,
        ),
    );
  });

  test("price-mismatch refund stores and refunds", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 1000,
    });
    await withWebhookVerify(
      webhookEvent({
        amountTotal: 500,
        eventId: "evt_mismatch",
        metadata: signedMeta(
          {
            email: "m@e.com",
            items: singleItem(listing.id, 1, 1000),
            name: "M",
          },
          1000,
        ),
        paymentIntent: "pi_mismatch",
        sessionId: "cs_mismatch",
      }),
      (json) => {
        expect(json.processed).toBe(false);
        expect(json.error).toContain("saved your details");
      },
    );
  });

  test("deleted-listing refund is acknowledged with 200 status", async () => {
    await setupStripe();
    await withWebhookVerify(
      webhookEvent({
        amountTotal: 500,
        eventId: "evt_404",
        metadata: signedMeta(
          { email: "n@e.com", items: singleItem(99999, 1, 500), name: "N" },
          500,
        ),
        paymentIntent: "pi_404",
        sessionId: "cs_404",
      }),
      (json, status) => {
        expect(json.processed).toBe(false);
        expect(status).toBe(200);
      },
    );
  });

  /** Each reason code → the operator-facing phrase stamped into the system note.
   *  Pins the REFUND_REASONS table: a mutated phrase fails its row. */
  const REASON_EXPECTATIONS: [RefundCode, string][] = [
    ["capacity_full", "the event filled up"],
    ["charge_mismatch", "did not match the agreed total"],
    ["listing_removed", "was removed while they were paying"],
    ["price_changed", "the listing price changed"],
    ["sold_out", "sold out while they were paying"],
    ["unexpected_error", "an unexpected error stopped"],
  ];

  test("placeholderRefund carries each reason code's operator-facing phrase", () => {
    for (const [code, expected] of REASON_EXPECTATIONS) {
      const spec = placeholderRefund(code)("internal detail line");
      expect(spec.code).toBe(code);
      expect(spec.reason).toContain(expected);
      expect(spec.detail).toBe("internal detail line");
    }
  });

  test("chargeMismatchSpec and deletedListingSpec select their code and detail", () => {
    const mismatch = chargeMismatchSpec(paidSession("cs_charge"), 1000);
    expect(mismatch.code).toBe("charge_mismatch");
    expect(mismatch.detail).toContain("1000");
    expect(mismatch.reason).toContain("did not match the agreed total");
    const removed = deletedListingSpec(paidSession("cs_deleted"));
    expect(removed.code).toBe("listing_removed");
    expect(removed.detail).toContain("cs_deleted");
    expect(removed.reason).toContain("was removed while they were paying");
  });

  test("placeholderRefundNote distinguishes refunded vs could-not-refund", () => {
    const spec = placeholderRefund("price_changed")("detail line");
    const refunded = placeholderRefundNote(7, spec, true);
    expect(refunded).toContain("payment was refunded because");
    expect(refunded).toContain("Refund code: price_changed");
    expect(refunded).not.toContain("pi_ref");
    expect(refunded).not.toContain("Payment reference");
    expect(refunded).toContain("/admin/ledger/attendee/7");
    expect(refunded).not.toContain("could NOT be refunded");
    const notRefunded = placeholderRefundNote(7, spec, false);
    expect(notRefunded).toContain("could NOT be refunded automatically");
    expect(notRefunded).not.toContain("payment was refunded because");
  });

  test("validationFailure short-circuits 404 without refunding", () => {
    const result = validationFailure(
      paidSession("cs_404"),
      { error: "Listing not found", status: 404 },
      1,
    ) as PaymentFailureResult;
    expect(result).not.toBeInstanceOf(Promise);
    expect(result.status).toBe(404);
    expect(result.success).toBe(false);
    expect(result.detail).toContain("Post-payment listing not found");
    expect(result.detail).toContain("cs_404");
    expect(result.error).toBe("Listing not found");
  });

  test("validationFailure refunds for non-404 statuses", async () => {
    await withRefundMock(refundCompletes, async () => {
      const result = await validationFailure(
        paidSession("cs_410"),
        { error: "no longer accepting", status: 410 },
        1,
      );
      expect(result.status).toBe(410);
      expect(result.refunded).toBe(true);
    });
  });

  test("refuseMismatch returns the price-changed message at 409 and refunds", async () => {
    await withRefundMock(refundCompletes, async () => {
      const result = await refuseMismatch(paidSession("cs_price"), 1000, 1);
      expect(result.success).toBe(false);
      if (result.success) throw new Error("expected a failure result");
      expect(result.refunded).toBe(true);
      expect(result.status).toBe(409);
      expect(result.error.toLowerCase()).toContain("price");
      expect(result.detail).toContain("1000");
    });
  });

  test("failureDetail uses detail when present and non-empty", () => {
    const result = {
      detail: "internal diagnostic",
      error: "user-facing error",
      success: false,
    } as const;
    expect(failureDetail(result)).toBe("internal diagnostic");
  });

  test("failureDetail preserves empty detail instead of falling back to error", () => {
    const result = {
      detail: "",
      error: "user-facing error",
      success: false,
    } as const;
    expect(failureDetail(result)).toBe("");
  });

  test("failureDetail falls back to error when detail is absent", () => {
    const result = { error: "user-facing error", success: false } as const;
    expect(failureDetail(result)).toBe("user-facing error");
  });
});
