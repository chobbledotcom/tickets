import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { ProviderRead } from "#shared/payment/provider-read.ts";
import { squareApi } from "#shared/square/api.ts";
import type { SquarePayment } from "#shared/square/payment-outcomes.ts";
import {
  SquareApiError,
  SquareConnectionError,
  SquareProtocolError,
} from "#shared/square/transport.ts";
import { withSquareClient } from "#test/test-utils/square/fixtures.ts";
import { describeSquare } from "#test/test-utils/square/harness.ts";
import { squareBoundaryValidationError } from "#test/test-utils/square/outcomes.ts";
import { providerReadHttpCases } from "#test-utils/provider-failure-cases.ts";

const readFrom = async (
  payment: unknown,
  paymentId = "pay_123",
): Promise<ProviderRead<SquarePayment>> =>
  await withSquareClient(
    { paymentsGet: () => Promise.resolve({ payment }) },
    () => squareApi.readPayment(paymentId),
  );

const readFailure = async (
  error: unknown,
): Promise<ProviderRead<SquarePayment>> =>
  await withSquareClient({ paymentsGet: () => Promise.reject(error) }, () =>
    squareApi.readPayment("pay_123"),
  );

describeSquare(() => {
  describe("readPayment", () => {
    test("keeps an unconfigured provider retryable", async () => {
      expect(await squareApi.readPayment("pay_123")).toEqual({
        reason: "not_configured",
        status: "unavailable",
      });
    });

    test("returns the named payment and preserves absent refund money", async () => {
      expect(
        await readFrom({
          amountMoney: { amount: 5000n, currency: "GBP" },
          id: "pay_123",
          orderId: "order_1",
          status: "COMPLETED",
        }),
      ).toEqual({
        resource: {
          amountMoney: { amount: 5000n, currency: "GBP" },
          id: "pay_123",
          orderId: "order_1",
          refundedMoney: undefined,
          status: "COMPLETED",
        },
        status: "found",
      });
    });

    test("keeps partly stated money for the charge boundary to refuse", async () => {
      expect(
        await readFrom({
          amountMoney: { amount: undefined, currency: "GBP" },
          id: "pay_123",
          status: "COMPLETED",
        }),
      ).toEqual({
        resource: {
          amountMoney: { amount: undefined, currency: "GBP" },
          id: "pay_123",
          orderId: undefined,
          refundedMoney: undefined,
          status: "COMPLETED",
        },
        status: "found",
      });
    });

    test("refuses a success response without its documented payment", async () => {
      expect(await readFrom(null)).toEqual({
        reason: "missing_documented_resource",
        status: "invalid",
      });
    });

    test("refuses malformed payment fields", async () => {
      expect(await readFrom({ id: "", status: "COMPLETED" })).toEqual({
        reason: "malformed_response",
        status: "invalid",
      });
    });

    test("refuses a payment with another id", async () => {
      expect(await readFrom({ id: "pay_other", status: "COMPLETED" })).toEqual({
        reason: "mismatched_id",
        status: "invalid",
      });
    });

    test("refuses an undocumented payment status", async () => {
      expect(await readFrom({ id: "pay_123", status: "REFUNDED" })).toEqual({
        reason: "unsupported_status",
        status: "invalid",
      });
    });

    test("reads every documented non-completed status", async () => {
      for (const status of ["APPROVED", "PENDING", "CANCELED", "FAILED"]) {
        expect(await readFrom({ id: "pay_123", status })).toEqual({
          resource: {
            amountMoney: undefined,
            id: "pay_123",
            orderId: undefined,
            refundedMoney: undefined,
            status,
          },
          status: "found",
        });
      }
    });

    for (const [statusCode, expected] of providerReadHttpCases) {
      test(`classifies HTTP ${statusCode}`, async () => {
        expect(await readFailure(new SquareApiError(statusCode))).toEqual(
          expected,
        );
      });
    }

    for (const reason of ["network_error", "timeout"] as const) {
      test(`classifies a ${reason} connection failure`, async () => {
        expect(await readFailure(new SquareConnectionError(reason))).toEqual({
          reason,
          status: "unavailable",
        });
      });
    }

    test("classifies invalid JSON as malformed", async () => {
      expect(await readFailure(new SquareProtocolError())).toEqual({
        reason: "malformed_response",
        status: "invalid",
      });
    });

    test("classifies schema failure as malformed", async () => {
      expect(await readFailure(squareBoundaryValidationError())).toEqual({
        reason: "malformed_response",
        status: "invalid",
      });
    });

    test("does not relabel an unknown internal failure as a network error", async () => {
      await expect(readFailure(new Error("internal bug"))).rejects.toThrow(
        "internal bug",
      );
    });
  });
});
