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
  unpairedLegData,
} from "#scripts/verify-models/refund-reversal.ts";
import { members, records } from "#test-utils/tla-data.ts";

/* jscpd:ignore-end */

const OUTCOMES = ["recorded", "review", "unrecorded"];

/** A group's state carried by each reversal fact, in one record. */
const group = (
  name: string,
  overrides: Record<string, string | boolean> = {},
): Record<string, string | boolean> => ({
  group: name,
  hasOperatorMoney: false,
  hasProviderPayment: true,
  paymentOnly: false,
  reverses: false,
  round: "first",
  settled: true,
  ...overrides,
});

const reversalOf = (data: string): Record<string, string | boolean>[] =>
  records(data, "ReversalFacts");

describe("refund reversal checker data", () => {
  test("carries each account refund group's facts in its first-plan fact", async () => {
    const reversals = reversalOf(await refundReversalModelData());
    // The fully-paid safe group is settled and reverses.
    expect(reversals).toContainEqual({ ...group("safe"), reverses: true });
    // The underfunded unsafe group is unsettled.
    expect(reversals).toContainEqual(
      group("unsafe", { reverses: false, settled: false }),
    );
    // The operator group carries operator money.
    expect(reversals).toContainEqual(
      group("operator", {
        hasOperatorMoney: true,
        reverses: false,
        settled: false,
      }),
    );
    // A provider cash leg with nothing else is payment-only.
    expect(reversals).toContainEqual(
      group("payment", { paymentOnly: true, reverses: true, settled: false }),
    );
    // The tax group merges its booking and correction legs and stays settled.
    expect(reversals).toContainEqual({ ...group("tax"), reverses: true });
  });

  test("the replay plan reverses nothing the first plan recorded", async () => {
    const reversals = reversalOf(await refundReversalModelData());
    // The replay of the safe group records nothing new.
    expect(reversals).toContainEqual(
      group("safe", { reverses: false, round: "replay" }),
    );
    // No replay fact reverses again.
    expect(
      reversals.filter(
        (reversal) => reversal.round === "replay" && reversal.reverses === true,
      ),
    ).toEqual([]);
  });

  test("every posted refund leg pairs with a recorded original", async () => {
    const data = await refundReversalModelData();
    const legs = records(data, "LegFacts");
    const originals = members(data, "OriginalLegs");
    expect(legs.length).toBeGreaterThan(0);
    for (const leg of legs) {
      expect(leg.exactInverse).toBe(true);
      expect(originals).toContain(leg.original);
    }
  });

  test("each returned reference lands in exactly one outcome per round", async () => {
    const data = await refundReversalModelData();
    const references = records(data, "ReferenceFacts");
    // The first plan's outcomes.
    expect(references).toContainEqual({
      outcome: "recorded",
      reference: "pi-safe",
      round: "first",
    });
    expect(references).toContainEqual({
      outcome: "review",
      reference: "pi-unsafe",
      round: "first",
    });
    expect(references).toContainEqual({
      outcome: "review",
      reference: "pi-operator",
      round: "first",
    });
    expect(references).toContainEqual({
      outcome: "unrecorded",
      reference: "pi-missing",
      round: "first",
    });
    expect(references).toContainEqual({
      outcome: "recorded",
      reference: "pi-payment",
      round: "first",
    });
    expect(references).toContainEqual({
      outcome: "recorded",
      reference: "pi-tax",
      round: "first",
    });
    // Every (round, reference) pair the fixtures feed appears exactly once.
    const pairs = (facts: Record<string, string | boolean>[]): string[] =>
      facts.map((fact) => `${fact.round} ${fact.reference}`).sort();
    expect(pairs(references)).toEqual(
      pairs(records(data, "ExpectedReferences")),
    );
    for (const reference of references) {
      expect(OUTCOMES).toContain(reference.outcome);
    }
  });

  test("the operator-money module reverses the operator group", async () => {
    const reversals = reversalOf(await operatorMoneyReversalData());
    expect(reversals).toContainEqual(
      group("operator", {
        hasOperatorMoney: true,
        reverses: true,
        settled: false,
      }),
    );
  });

  test("the non-inverse module carries a leg that inverts nothing", async () => {
    const legs = records(await nonInverseLegData(), "LegFacts");
    expect(legs.filter((leg) => leg.exactInverse === false).length).toBe(1);
  });

  test("the unpaired module carries a leg with no recorded original", async () => {
    const data = await unpairedLegData();
    const legs = records(data, "LegFacts");
    const originals = members(data, "OriginalLegs");
    const unpaired = legs.filter(
      (leg) => !originals.includes(`${leg.original}`),
    );
    expect(unpaired.length).toBe(1);
    expect(unpaired[0]?.exactInverse).toBe(true);
  });

  test("the double-record module reverses a group the first plan recorded", async () => {
    const reversals = reversalOf(await doubleRecordData());
    expect(reversals).toContainEqual(
      group("safe", { reverses: true, round: "replay" }),
    );
  });
});
