import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { resolveRefund } from "#shared/payment/refund.ts";
import type { ChargeMoney } from "#shared/payment/resources.ts";
import {
  chargeMoneyWith,
  refundObservation,
  refundResource,
} from "#test-utils/payment-state.ts";

const resolved = (charge: ChargeMoney) => resolveRefund(charge);

describe("refund resolver", () => {
  test("rejects invalid confirmed and observed money", () => {
    for (const charge of [
      chargeMoneyWith({ confirmedRefunded: { amount: 101, currency: "GBP" } }),
      chargeMoneyWith({ confirmedRefunded: { amount: 1, currency: "USD" } }),
      chargeMoneyWith({
        refunds: [
          refundObservation({ amount: { amount: 101, currency: "GBP" } }),
        ],
      }),
      chargeMoneyWith({
        refunds: [
          refundObservation({ amount: { amount: 100, currency: "USD" } }),
        ],
      }),
    ]) {
      expect(resolved(charge)).toStrictEqual({
        amount: charge.confirmedRefunded,
        reason: "invalid_amount",
        status: "failed",
      });
    }
  });

  test("rejects more than one pending refund", () => {
    // Amounts that fit inside the money taken, so this reaches the rule about
    // two refunds at once rather than the one about the money not adding up.
    const first = refundObservation({
      amount: { amount: 10, currency: "GBP" },
      status: "pending",
    });
    const second = refundObservation({
      amount: { amount: 10, currency: "GBP" },
      refund: { ...refundResource, id: "re_2" },
      status: "pending",
    });
    expect(
      resolved(chargeMoneyWith({ refunds: [first, second] })),
    ).toStrictEqual({
      amount: { amount: 0, currency: "GBP" },
      reason: "multiple_pending_refunds",
      status: "failed",
    });
  });

  test("retains a pending refund resource", () => {
    expect(
      resolved(
        chargeMoneyWith({
          refunds: [refundObservation({ status: "pending" })],
        }),
      ),
    ).toStrictEqual({
      amount: { amount: 100, currency: "GBP" },
      refund: refundResource,
      status: "pending",
    });
  });

  test("reports a pending refund the provider has not named yet", () => {
    // SumUp says a refund is on its way before it says what it is called.
    expect(
      resolved(
        chargeMoneyWith({
          refunds: [
            { amount: { amount: 100, currency: "GBP" }, status: "pending" },
          ],
        }),
      ),
    ).toStrictEqual({
      amount: { amount: 100, currency: "GBP" },
      status: "pending",
    });
  });

  test("classifies full confirmed refunds with and without a refund id", () => {
    for (const refunds of [[refundObservation()], []]) {
      expect(
        resolved(
          chargeMoneyWith({
            confirmedRefunded: { amount: 100, currency: "GBP" },
            refunds,
          }),
        ),
      ).toStrictEqual({
        amount: { amount: 100, currency: "GBP" },
        ...(refunds.length === 0 ? {} : { refund: refundResource }),
        status: "completed",
      });
    }
  });

  test("classifies partial confirmed refunds with and without a refund id", () => {
    for (const refunds of [
      [refundObservation({ amount: { amount: 40, currency: "GBP" } })],
      [],
    ]) {
      expect(
        resolved(
          chargeMoneyWith({
            confirmedRefunded: { amount: 40, currency: "GBP" },
            refunds,
          }),
        ),
      ).toStrictEqual({
        amount: { amount: 40, currency: "GBP" },
        ...(refunds.length === 0 ? {} : { refund: refundResource }),
        status: "partial",
      });
    }
    expect(
      resolved(
        chargeMoneyWith({ confirmedRefunded: { amount: 1, currency: "GBP" } }),
      ),
    ).toStrictEqual({
      amount: { amount: 1, currency: "GBP" },
      status: "partial",
    });
  });

  test("classifies provider failure and missing observations", () => {
    expect(
      resolved(
        chargeMoneyWith({
          refunds: [
            refundObservation({ reason: "rejected", status: "failed" }),
          ],
        }),
      ),
    ).toStrictEqual({
      amount: { amount: 0, currency: "GBP" },
      reason: "provider_failed",
      refund: refundResource,
      status: "failed",
    });
    expect(resolved(chargeMoneyWith())).toStrictEqual({
      amount: { amount: 0, currency: "GBP" },
      reason: "not_observed",
      status: "failed",
    });
  });
});

describe("money back that the cumulative total has not caught up with", () => {
  // The provider says the refund finished; its running total still reads
  // zero. Reading that as "no refund seen" would call the charge refundable
  // and let a second refund go out — with no idempotency key on SumUp, that
  // is the buyer's money sent back twice.
  test("counts a finished refund the cumulative total has not caught up with", () => {
    expect(
      resolved(
        chargeMoneyWith({
          confirmedRefunded: { amount: 0, currency: "GBP" },
          refunds: [refundObservation()],
        }),
      ).status,
    ).toBe("completed");
  });

  // A failure hidden behind "partly refunded" is a failure nobody retries.
  test("reports a refund the provider could not finish over money already back", () => {
    expect(
      resolved(
        chargeMoneyWith({
          confirmedRefunded: { amount: 40, currency: "GBP" },
          refunds: [
            refundObservation({
              amount: { amount: 40, currency: "GBP" },
            }),
            refundObservation({
              amount: { amount: 30, currency: "GBP" },
              reason: "provider_failed",
              refund: { ...refundResource, id: "re_2" },
              status: "failed",
            }),
          ],
        }),
      ),
    ).toStrictEqual({
      amount: { amount: 40, currency: "GBP" },
      reason: "provider_failed",
      refund: { ...refundResource, id: "re_2" },
      status: "failed",
    });
  });
});
