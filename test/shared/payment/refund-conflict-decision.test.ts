import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { refundConflictDecision } from "#shared/payment/refund-conflict-decision.ts";
import {
  chargeMoney,
  chargeMoneyWith,
  partlyRefundedCharge,
  refundObservation,
} from "#test-utils/payment-state.ts";

const known = {
  captured: { amount: 1_000, currency: "GBP" as const },
  refunded: { amount: 0, currency: "GBP" as const },
};

describe("payment > provider-conflict decision", () => {
  test("a clean mismatched capture can adopt exact money and retry", () => {
    expect(refundConflictDecision(known, chargeMoney(2_000))).toEqual({
      captured: { amount: 2_000, currency: "GBP" },
      kind: "not_sent",
      refunded: { amount: 0, currency: "GBP" },
    });
  });

  test("a partial return can record only the exact money returned", () => {
    expect(refundConflictDecision(known, partlyRefundedCharge())).toEqual({
      captured: { amount: 100, currency: "GBP" },
      kind: "returned",
      refunded: { amount: 40, currency: "GBP" },
    });
  });

  test("pending or invalid money must be checked again", () => {
    const pending = chargeMoneyWith({
      refunds: [refundObservation({ status: "pending" })],
    });
    const tooMuch = chargeMoney(1_000, 1_001);

    expect(refundConflictDecision(known, pending).kind).toBe("wait");
    expect(refundConflictDecision(known, tooMuch)).toEqual({
      captured: { amount: 1_000, currency: "GBP" },
      kind: "wait",
      refunded: { amount: 1_001, currency: "GBP" },
    });
  });

  test("evidence cannot move returned money backwards", () => {
    expect(
      refundConflictDecision(
        { ...known, refunded: { amount: 50, currency: "GBP" } },
        chargeMoney(),
      ).kind,
    ).toBe("wait");
  });
});
