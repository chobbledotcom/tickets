/* The refund reversal checker data: the production plan supplies every fact,
 * and the negative controls keep the safety verdicts honest. */

/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  doubleRecordData,
  nonInverseLegData,
  operatorMoneyReversalData,
  refundReversalModelData,
} from "#scripts/verify-models/refund-reversal.ts";
import { records } from "#test-utils/tla-data.ts";

/* jscpd:ignore-end */

const OUTCOMES = ["recorded", "review", "unrecorded"];

/** A group's state carried by each reversal fact, in one record. */
const group = (
  group: string,
  overrides: Record<string, string | boolean> = {},
): Record<string, string | boolean> => ({
  group,
  hasOperatorMoney: false,
  hasProviderPayment: true,
  paymentOnly: false,
  settled: true,
  ...overrides,
});

const reversalOf = (data: string): Record<string, string | boolean>[] =>
  records(data, "ReversalFacts");

describe("refund reversal checker data", () => {
  test("carries each account refund group's facts in its reversal fact", async () => {
    const reversals = reversalOf(await refundReversalModelData());
    // The fully-paid safe group is settled and reverses.
    expect(reversals).toContainEqual({
      ...group("safe"),
      alreadyRecorded: false,
      reverses: true,
    });
    // The underfunded unsafe group is unsettled.
    expect(reversals).toContainEqual({
      ...group("unsafe", { settled: false }),
      alreadyRecorded: false,
      reverses: false,
    });
    // The operator group carries operator money.
    expect(reversals).toContainEqual({
      ...group("operator", { hasOperatorMoney: true, settled: false }),
      alreadyRecorded: false,
      reverses: false,
    });
    // A provider cash leg with nothing else is payment-only.
    expect(reversals).toContainEqual({
      ...group("payment", { paymentOnly: true, settled: false }),
      alreadyRecorded: false,
      reverses: true,
    });
    // The tax group merges its booking and correction legs and stays settled.
    expect(reversals).toContainEqual({
      ...group("tax"),
      alreadyRecorded: false,
      reverses: true,
    });
  });

  test("reverses only the groups the production plan reverses", async () => {
    const reversals = reversalOf(await refundReversalModelData());
    // The replay of the safe group records nothing new.
    expect(reversals).toContainEqual({
      ...group("safe"),
      alreadyRecorded: true,
      reverses: false,
    });
    // No plan reverses a group the ledger already records.
    expect(
      reversals.filter(
        (reversal) =>
          reversal.alreadyRecorded === true && reversal.reverses === true,
      ),
    ).toEqual([]);
  });

  test("every posted refund leg is the exact inverse of a recorded original", async () => {
    const legs = records(await refundReversalModelData(), "LegFacts");
    expect(legs.length).toBeGreaterThan(0);
    for (const leg of legs) expect(leg.exactInverse).toBe(true);
  });

  test("each returned reference lands in exactly one outcome", async () => {
    const references = records(
      await refundReversalModelData(),
      "ReferenceFacts",
    );
    expect(references).toContainEqual({
      outcome: "recorded",
      reference: "pi-safe",
    });
    expect(references).toContainEqual({
      outcome: "review",
      reference: "pi-unsafe",
    });
    expect(references).toContainEqual({
      outcome: "review",
      reference: "pi-operator",
    });
    expect(references).toContainEqual({
      outcome: "unrecorded",
      reference: "pi-missing",
    });
    expect(references).toContainEqual({
      outcome: "recorded",
      reference: "pi-payment",
    });
    expect(references).toContainEqual({
      outcome: "recorded",
      reference: "pi-tax",
    });
    for (const reference of references) {
      expect(OUTCOMES).toContain(reference.outcome);
    }
  });

  test("the operator-money module reverses the operator group", async () => {
    const reversals = reversalOf(await operatorMoneyReversalData());
    expect(reversals).toContainEqual({
      ...group("operator", { hasOperatorMoney: true, settled: false }),
      alreadyRecorded: false,
      reverses: true,
    });
  });

  test("the non-inverse module carries a leg that reverses nothing", async () => {
    const legs = records(await nonInverseLegData(), "LegFacts");
    expect(legs.some((leg) => leg.exactInverse === false)).toBe(true);
  });

  test("the double-record module reverses a group the ledger already records", async () => {
    const reversals = reversalOf(await doubleRecordData());
    expect(reversals).toContainEqual({
      ...group("safe"),
      alreadyRecorded: true,
      reverses: true,
    });
  });
});
