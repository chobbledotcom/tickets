import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { ProviderRead } from "#payment/provider-read.ts";
import { providerDetail, transportError } from "#payment/transport-error.ts";
import { squareApi } from "#shared/square/api.ts";
import type { SquarePayment } from "#shared/square/wire.ts";
import { providerReadHttpCases } from "#test-utils/provider-failure-cases.ts";
import {
  withSquareAnswer,
  withSquareClient,
} from "#test-utils/square/fixtures.ts";
import { describeSquare } from "#test-utils/square/harness.ts";
import { squareBoundaryValidationError } from "#test-utils/square/outcomes.ts";

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

    // Square states a money object with both halves or not at all. A half of
    // one is an answer we cannot read, and reading it as "nothing was
    // refunded" would tell the refund guard money is still owed.
    test("refuses money Square only partly states", async () => {
      const read = await withSquareAnswer(
        {
          payment: {
            amount_money: { currency: "GBP" },
            id: "pay_123",
            status: "COMPLETED",
          },
        },
        () => squareApi.readPayment("pay_123"),
      );
      expect(read).toEqual({
        reason: "malformed_response",
        status: "invalid",
      });
    });

    test("reads the money Square states into minor units", async () => {
      const read = await withSquareAnswer(
        {
          payment: {
            amount_money: { amount: 5000, currency: "GBP" },
            id: "pay_123",
            refunded_money: { amount: 1000, currency: "GBP" },
            status: "COMPLETED",
          },
        },
        () => squareApi.readPayment("pay_123"),
      );
      expect(read).toEqual({
        resource: {
          amountMoney: { amount: 5000n, currency: "GBP" },
          id: "pay_123",
          orderId: undefined,
          refundedMoney: { amount: 1000n, currency: "GBP" },
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

    test("refuses a payment Square named with no id", async () => {
      const read = await withSquareAnswer(
        { payment: { id: "", status: "COMPLETED" } },
        () => squareApi.readPayment("pay_123"),
      );
      expect(read).toEqual({
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
        expect(
          await readFailure(
            transportError.answered(providerDetail.square(), statusCode),
          ),
        ).toEqual(expected);
      });
    }

    for (const reason of ["network_error", "timeout"] as const) {
      test(`classifies a ${reason} connection failure`, async () => {
        expect(
          await readFailure(
            transportError.unreachable(providerDetail.square(), reason),
          ),
        ).toEqual({
          reason,
          status: "unavailable",
        });
      });
    }

    test("classifies invalid JSON as malformed", async () => {
      expect(
        await readFailure(transportError.unusable(providerDetail.square())),
      ).toEqual({
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
