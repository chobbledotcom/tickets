import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import {
  RefundConflictDecisionSchema,
  ReturnedOrNotSentDecisionSchema,
  refundConflictDecision,
  refundConflictNeedsProviderCheck,
} from "#payment/refund-conflict-decision.ts";
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
  test("ordinary ambiguity has one exact decision tag", () => {
    expect(
      v.parse(ReturnedOrNotSentDecisionSchema, {
        kind: "returned_or_not_sent",
      }),
    ).toEqual({ kind: "returned_or_not_sent" });
  });

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
    const conflictingCurrencies = chargeMoneyWith({
      captured: { amount: 100, currency: "GBP" },
      confirmedRefunded: { amount: 40, currency: "USD" },
    });
    const foreignCapturedCurrency = chargeMoneyWith({
      captured: { amount: 100, currency: "USD" },
      confirmedRefunded: { amount: 0, currency: "USD" },
    });

    expect(refundConflictDecision(known, pending).kind).toBe("wait");
    expect(refundConflictDecision(known, tooMuch)).toEqual({
      captured: { amount: 1_000, currency: "GBP" },
      kind: "wait",
      refunded: { amount: 1_001, currency: "GBP" },
    });
    expect(refundConflictDecision(known, conflictingCurrencies)).toEqual({
      captured: { amount: 100, currency: "GBP" },
      kind: "wait",
      refunded: { amount: 40, currency: "USD" },
    });
    expect(
      refundConflictDecision(
        {
          captured: { amount: 100, currency: "GBP" },
          refunded: { amount: 0, currency: "USD" },
        },
        foreignCapturedCurrency,
      ),
    ).toMatchObject({ kind: "wait" });
  });

  test("evidence cannot move returned money backwards", () => {
    expect(
      refundConflictDecision(
        { ...known, refunded: { amount: 50, currency: "GBP" } },
        chargeMoney(),
      ).kind,
    ).toBe("wait");
  });

  test("a final decision requires positive captured money in one currency", () => {
    expect(
      v.parse(RefundConflictDecisionSchema, {
        captured: { amount: 1, currency: "GBP" },
        kind: "not_sent",
        refunded: { amount: 0, currency: "GBP" },
      }),
    ).toEqual({
      captured: { amount: 1, currency: "GBP" },
      kind: "not_sent",
      refunded: { amount: 0, currency: "GBP" },
    });
    expect(() =>
      v.parse(RefundConflictDecisionSchema, {
        captured: { amount: 0, currency: "GBP" },
        kind: "not_sent",
        refunded: { amount: 0, currency: "GBP" },
      }),
    ).toThrow("must prove no returned money");
    expect(() =>
      v.parse(RefundConflictDecisionSchema, {
        captured: { amount: 1_000, currency: "GBP" },
        kind: "not_sent",
        refunded: { amount: 0, currency: "USD" },
      }),
    ).toThrow("must prove no returned money");
  });

  test("returned and waiting decisions keep their exact money boundaries", () => {
    expect(
      v.parse(RefundConflictDecisionSchema, {
        captured: { amount: 1, currency: "GBP" },
        kind: "returned",
        refunded: { amount: 1, currency: "GBP" },
      }),
    ).toMatchObject({ kind: "returned", refunded: { amount: 1 } });
    expect(() =>
      v.parse(RefundConflictDecisionSchema, {
        captured: { amount: 1, currency: "GBP" },
        kind: "returned",
        refunded: { amount: 0, currency: "GBP" },
      }),
    ).toThrow("A returned conflict decision must carry exact returned money");
    expect(
      v.parse(RefundConflictDecisionSchema, {
        captured: { amount: 1, currency: "GBP" },
        kind: "wait",
        refunded: { amount: 0, currency: "GBP" },
      }),
    ).toMatchObject({ kind: "wait" });
    expect(() =>
      v.parse(RefundConflictDecisionSchema, {
        captured: { amount: 0, currency: "GBP" },
        kind: "wait",
        refunded: { amount: 0, currency: "GBP" },
      }),
    ).toThrow("A waiting conflict decision must carry captured money");
  });

  test("only inconclusive evidence needs another provider check", () => {
    expect(
      refundConflictNeedsProviderCheck({
        captured: { amount: 100, currency: "GBP" },
        kind: "wait",
        refunded: { amount: 0, currency: "GBP" },
      }),
    ).toBe(true);
    // A settled return — full or partial — is an owner decision, never a
    // recheck: the old partial-recheck exit was a provable no-op.
    expect(
      refundConflictNeedsProviderCheck({
        captured: { amount: 100, currency: "GBP" },
        kind: "returned",
        refunded: { amount: 40, currency: "GBP" },
      }),
    ).toBe(false);
    expect(
      refundConflictNeedsProviderCheck({
        captured: { amount: 100, currency: "GBP" },
        kind: "returned",
        refunded: { amount: 100, currency: "GBP" },
      }),
    ).toBe(false);
    expect(
      refundConflictNeedsProviderCheck({
        captured: { amount: 100, currency: "GBP" },
        kind: "not_sent",
        refunded: { amount: 0, currency: "GBP" },
      }),
    ).toBe(false);
  });
});
