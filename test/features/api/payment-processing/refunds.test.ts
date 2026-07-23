import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  chargeMismatchSpec,
  deletedListingSpec,
  refundAndFail,
  refundSpec,
  refundWithProvider,
  refuseMismatch,
  tryRefund,
  validationFailure,
} from "#routes/api/payment-processing/refunds.ts";
import {
  parseSessionFailure,
  reserveSession,
} from "#shared/db/processed-payments.ts";
import { setSuppressDebugLogs } from "#shared/log-settings.ts";
import { ErrorCode } from "#shared/logger.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { webhookMeta } from "#test-utils/factories.ts";
import { setupStripe } from "#test-utils/settings.ts";

const session = {
  amountTotal: 1200,
  id: "refund-session",
  metadata: webhookMeta({ name: "Buyer" }),
  paymentReference: "payment-reference",
  paymentStatus: "paid" as const,
};

const withRefundProvider = async <T>(
  refundStatus: "failed" | "pending" | "refunded",
  alreadyRefunded: boolean | undefined,
  action: () => Promise<T>,
): Promise<T> => {
  await setupStripe();
  using _refund = stub(stripePaymentProvider, "refundPayment", () =>
    Promise.resolve(refundStatus),
  );
  using _status =
    alreadyRefunded === undefined
      ? null
      : stub(stripePaymentProvider, "inspectPaymentRefund", () =>
          Promise.resolve(alreadyRefunded ? "refunded" : "failed"),
        );
  return await action();
};

const tryProviderRefund = (
  refundStatus: "failed" | "pending" | "refunded",
  alreadyRefunded?: boolean,
) =>
  withRefundProvider(refundStatus, alreadyRefunded, () =>
    tryRefund("payment-reference", 7),
  );

const captureLog = async <T>(
  method: "debug" | "error",
  action: () => Promise<T>,
): Promise<{ logs: unknown[][]; result: T }> => {
  const logs: unknown[][] = [];
  using _log =
    method === "debug"
      ? stub(console, "debug", (...args) => logs.push(args))
      : stub(console, "error", (...args) => logs.push(args));
  if (method === "debug") setSuppressDebugLogs(false);
  try {
    return { logs, result: await action() };
  } finally {
    if (method === "debug") setSuppressDebugLogs(null);
  }
};

describeWithEnv("payment refunds", { db: true }, () => {
  test("rejects an empty reference", async () => {
    using refund = stub(stripePaymentProvider, "refundPayment", () =>
      Promise.resolve("refunded" as const),
    );

    expect(await refundWithProvider(stripePaymentProvider, "")).toBe("failed");
    expect(refund.calls).toHaveLength(0);
  });

  test("returns provider refunded and pending outcomes", async () => {
    for (const status of ["refunded", "pending"] as const) {
      const { logs, result } = await captureLog("debug", () =>
        tryProviderRefund(status),
      );
      expect(result).toBe(status);
      if (status === "refunded")
        expect(
          logs.some((args) => String(args[0]).includes("Refund issued")),
        ).toBe(true);
    }
  });

  test("treats an already refunded provider failure as success", async () => {
    const { logs, result } = await captureLog("debug", () =>
      tryProviderRefund("failed", true),
    );
    expect(result).toBe("refunded");
    expect(
      logs.some((args) =>
        String(args[0]).includes("Payment already fully refunded"),
      ),
    ).toBe(true);
  });

  test("keeps a genuine provider failure", async () => {
    const { logs, result } = await captureLog("error", () =>
      tryProviderRefund("failed", false),
    );
    expect(result).toBe("failed");
    expect(String(logs[0]?.[0])).toContain("E_PAYMENT_REFUND");
  });

  test("returns validation failures with their expected refund code", () => {
    expect(
      validationFailure(
        session,
        {
          error: "Gone",
          ok: false,
          refundCode: "registration_closed",
          status: 410,
        },
        7,
      ),
    ).toEqual({
      error: "Gone",
      refundCode: "registration_closed",
      status: 410,
      success: false,
    });
  });

  test("builds every refund reason with only its expected alert", () => {
    const expected = {
      capacity_full: undefined,
      charge_mismatch: ErrorCode.WEBHOOK_PRICE_SIGNATURE,
      listing_removed: ErrorCode.PAYMENT_SESSION,
      price_changed: undefined,
      registration_closed: undefined,
      sold_out: undefined,
      unexpected_error: ErrorCode.PAYMENT_SESSION,
    } as const;
    for (const [code, notify] of Object.entries(expected)) {
      const spec = refundSpec(code as keyof typeof expected)("detail");
      expect(spec).toMatchObject({ code, detail: "detail" });
      expect(spec.notify).toBe(notify);
    }
  });

  test("builds mismatch and deleted-listing diagnostics", () => {
    expect(chargeMismatchSpec(session, 1000)).toMatchObject({
      code: "charge_mismatch",
      detail: "Provider charged 1200 but signed total was 1000",
    });
    expect(deletedListingSpec(session)).toMatchObject({
      code: "listing_removed",
      detail: "Listing not found for a signed session (session=refund-session)",
    });
  });

  test("refunds a mismatch with its buyer message and status", async () => {
    await setupStripe();
    await reserveSession(session.id);
    using _refund = stub(stripePaymentProvider, "refundPayment", () =>
      Promise.resolve("refunded"),
    );
    const result = await refuseMismatch(session, 1000, 7);
    expect(result).toEqual({
      detail: "Provider charged 1200 but signed total was 1000",
      error:
        "The price for this listing changed while you were completing payment.",
      refundStatus: "refunded",
      status: 409,
      success: false,
    });
    const conflict = await reserveSession(session.id);
    if (conflict.reserved) throw new Error("Expected stored failure");
    expect(
      await parseSessionFailure(conflict.existing.failure_data),
    ).toMatchObject({ refunded: true });
  });

  test("logs when refunding has no configured provider", async () => {
    const { logs, result } = await captureLog("error", () =>
      tryRefund("payment-reference", 7),
    );
    expect(result).toBe("failed");
    expect(String(logs[0]?.[0])).toContain(
      "No payment provider configured for refund",
    );
  });

  test("does not mark a failed refund terminal", async () => {
    const result = await withRefundProvider("failed", false, () =>
      refundAndFail(session, "Failure", 7, 503, "detail"),
    );
    expect(result).toEqual({
      detail: "detail",
      error: "Failure",
      refundStatus: "failed",
      status: 503,
      success: false,
    });
  });
});
