import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { resolveRefund } from "#shared/payment-state/refund.ts";
import type { ChargeLeg } from "#shared/payment-state/resources.ts";
import { chargeLeg, refundObservation, refundResource } from "./fixtures.ts";

const resolved = (charge: ChargeLeg) => resolveRefund(charge);

describe("refund resolver", () => {
  test("rejects invalid confirmed and observed money", () => {
    for (const charge of [
      chargeLeg({ confirmedRefunded: { amount: 101, currency: "GBP" } }),
      chargeLeg({ confirmedRefunded: { amount: 1, currency: "USD" } }),
      chargeLeg({
        refunds: [
          refundObservation({ amount: { amount: 101, currency: "GBP" } }),
        ],
      }),
      chargeLeg({
        refunds: [
          refundObservation({ amount: { amount: 100, currency: "USD" } }),
        ],
      }),
    ]) {
      expect(resolved(charge)).toEqual({
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
    expect(resolved(chargeLeg({ refunds: [first, second] }))).toEqual({
      amount: { amount: 0, currency: "GBP" },
      reason: "multiple_pending_refunds",
      status: "failed",
    });
  });

  test("retains a pending refund resource", () => {
    expect(
      resolved(
        chargeLeg({ refunds: [refundObservation({ status: "pending" })] }),
      ),
    ).toEqual({
      amount: { amount: 100, currency: "GBP" },
      refund: refundResource,
      status: "pending",
    });
  });

  test("reports a pending refund the provider has not named yet", () => {
    // SumUp says a refund is on its way before it says what it is called.
    expect(
      resolved(
        chargeLeg({
          refunds: [
            { amount: { amount: 100, currency: "GBP" }, status: "pending" },
          ],
        }),
      ),
    ).toEqual({
      amount: { amount: 100, currency: "GBP" },
      status: "pending",
    });
  });

  test("classifies full confirmed refunds with and without a refund id", () => {
    for (const refunds of [[refundObservation()], []]) {
      expect(
        resolved(
          chargeLeg({
            confirmedRefunded: { amount: 100, currency: "GBP" },
            refunds,
          }),
        ),
      ).toEqual({
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
          chargeLeg({
            confirmedRefunded: { amount: 40, currency: "GBP" },
            refunds,
          }),
        ),
      ).toEqual({
        amount: { amount: 40, currency: "GBP" },
        ...(refunds.length === 0 ? {} : { refund: refundResource }),
        status: "partial",
      });
    }
    expect(
      resolved(
        chargeLeg({ confirmedRefunded: { amount: 1, currency: "GBP" } }),
      ),
    ).toEqual({
      amount: { amount: 1, currency: "GBP" },
      status: "partial",
    });
  });

  test("classifies provider failure and missing observations", () => {
    expect(
      resolved(
        chargeLeg({
          refunds: [
            refundObservation({ reason: "rejected", status: "failed" }),
          ],
        }),
      ),
    ).toEqual({
      amount: { amount: 0, currency: "GBP" },
      reason: "provider_failed",
      refund: refundResource,
      status: "failed",
    });
    expect(resolved(chargeLeg())).toEqual({
      amount: { amount: 0, currency: "GBP" },
      reason: "not_observed",
      status: "failed",
    });
  });
});
