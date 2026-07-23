import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  type RefundProvider,
  refundPaymentAtProvider,
} from "#shared/payment-refunds.ts";
import type { PaymentRefundResult } from "#shared/payments.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { useDebugLogSpy } from "#test-utils/debug-log.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";

type TestProvider = RefundProvider & {
  refundCalls: string[];
  statusCalls: string[];
};

const provider = (
  options: {
    mode?: RefundProvider["refundRetryMode"];
    refund?: PaymentRefundResult | Error;
    refunded?: boolean | Error;
  } = {},
): TestProvider => {
  const refundCalls: string[] = [];
  const statusCalls: string[] = [];
  return {
    isPaymentRefunded: (reference) => {
      statusCalls.push(reference);
      return options.refunded instanceof Error
        ? Promise.reject(options.refunded)
        : Promise.resolve(options.refunded ?? false);
    },
    refundCalls,
    refundPayment: (reference) => {
      refundCalls.push(reference);
      return options.refund instanceof Error
        ? Promise.reject(options.refund)
        : Promise.resolve(options.refund ?? "failed");
    },
    refundRetryMode: options.mode ?? "idempotent",
    statusCalls,
    type: options.mode === "inspect-after-first" ? "sumup" : "stripe",
  };
};

describeWithEnv(
  "payment refunds > shared provider operation",
  { db: true },
  () => {
    const debugSpy = useDebugLogSpy();
    const errors = setupErrorSpy();

    test("rejects an empty reference before provider IO", async () => {
      const api = provider({ refund: "refunded" });
      expect(await refundPaymentAtProvider(api, "")).toBe("failed");
      expect(api.refundCalls).toEqual([]);
      expect(api.statusCalls).toEqual([]);
    });

    test("returns direct idempotent provider outcomes", async () => {
      for (const outcome of ["pending", "refunded"] as const) {
        const api = provider({ refund: outcome });
        expect(await refundPaymentAtProvider(api, outcome)).toBe(outcome);
        expect(api.refundCalls).toEqual([outcome]);
        expect(api.statusCalls).toEqual([]);
      }
      expect(debugSpy().calls.map((call) => call.args[0])).toContain(
        "[Payment] Refund issued",
      );
    });

    test("confirms an idempotent failed submission was already refunded", async () => {
      const api = provider({ refund: "failed", refunded: true });
      expect(await refundPaymentAtProvider(api, "already-refunded")).toBe(
        "refunded",
      );
      expect(api.statusCalls).toEqual(["already-refunded"]);
      expect(debugSpy().calls.map((call) => call.args[0])).toContain(
        "[Payment] Payment already fully refunded",
      );
    });

    test("keeps a genuine idempotent failure", async () => {
      const api = provider({ refund: "failed", refunded: false });
      expect(await refundPaymentAtProvider(api, "failed")).toBe("failed");
      expect(api.statusCalls).toEqual(["failed"]);
    });

    test("propagates idempotent submission and status errors", async () => {
      await expect(
        refundPaymentAtProvider(
          provider({ refund: new Error("submit failed") }),
          "submit-error",
        ),
      ).rejects.toThrow("submit failed");
      await expect(
        refundPaymentAtProvider(
          provider({ refund: "failed", refunded: new Error("status failed") }),
          "status-error",
        ),
      ).rejects.toThrow("status failed");
    });

    test("inspects a pending non-idempotent attempt without another submission", async () => {
      const api = provider({
        mode: "inspect-after-first",
        refund: "pending",
        refunded: false,
      });
      expect(await refundPaymentAtProvider(api, "uncertain")).toBe("pending");
      expect(await refundPaymentAtProvider(api, "uncertain")).toBe("pending");
      expect(api.refundCalls).toEqual(["uncertain"]);
      expect(api.statusCalls).toEqual(["uncertain"]);
    });

    test("allows only one simultaneous non-idempotent submission", async () => {
      const api = provider({
        mode: "inspect-after-first",
        refund: "pending",
        refunded: false,
      });
      expect(
        await Promise.all([
          refundPaymentAtProvider(api, "simultaneous"),
          refundPaymentAtProvider(api, "simultaneous"),
        ]),
      ).toEqual(["pending", "pending"]);
      expect(api.refundCalls).toEqual(["simultaneous"]);
      expect(api.statusCalls).toEqual(["simultaneous"]);
    });

    test("finishes a pending non-idempotent attempt after status confirms it", async () => {
      const api = provider({
        mode: "inspect-after-first",
        refund: "pending",
        refunded: true,
      });
      await refundPaymentAtProvider(api, "later-refunded");
      expect(await refundPaymentAtProvider(api, "later-refunded")).toBe(
        "refunded",
      );
      expect(api.refundCalls).toEqual(["later-refunded"]);
    });

    test("keeps uncertain non-idempotent submission and status errors pending", async () => {
      const submitError = provider({
        mode: "inspect-after-first",
        refund: new Error("submit uncertain"),
      });
      expect(
        await refundPaymentAtProvider(submitError, "submit-uncertain"),
      ).toBe("pending");
      expect(
        await refundPaymentAtProvider(submitError, "submit-uncertain"),
      ).toBe("pending");
      expect(errors.lastMessage()).toContain("submit uncertain");
      expect(submitError.refundCalls).toEqual(["submit-uncertain"]);
      expect(submitError.statusCalls).toEqual(["submit-uncertain"]);

      const statusError = provider({
        mode: "inspect-after-first",
        refund: "pending",
        refunded: new Error("status uncertain"),
      });
      await refundPaymentAtProvider(statusError, "status-uncertain");
      expect(
        await refundPaymentAtProvider(statusError, "status-uncertain"),
      ).toBe("pending");
      expect(errors.lastMessage()).toContain("status uncertain");
      expect(statusError.refundCalls).toEqual(["status-uncertain"]);
    });

    test("allows a new non-idempotent submission after authoritative failure", async () => {
      const api = provider({
        mode: "inspect-after-first",
        refund: "failed",
        refunded: false,
      });
      expect(await refundPaymentAtProvider(api, "rejected")).toBe("failed");
      expect(await refundPaymentAtProvider(api, "rejected")).toBe("failed");
      expect(api.refundCalls).toEqual(["rejected", "rejected"]);
    });
  },
);
