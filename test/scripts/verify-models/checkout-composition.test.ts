/** The checkout composition checker data: the production pricing functions
 *  supply every pass fact and every order fact, and the negative controls
 *  keep the safety verdicts honest. */

/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { sum } from "#fp";
import {
  checkoutCompositionModelData,
  compositionFacts,
  type PassFact,
  SCENARIOS,
  type UnitFact,
} from "#scripts/verify-models/checkout-composition.ts";
import { feeSubtotalFor } from "#shared/booking-fee.ts";
import { applyModifiers } from "#shared/checkout-pricing.ts";

/* jscpd:ignore-end */

const facts = compositionFacts();

const passFactsOf = (tag: string): PassFact[] =>
  facts.passFacts.filter((passFact) => passFact.orderTag === tag);

const unitFactsOf = (tag: string): UnitFact[] =>
  facts.unitFacts.filter((unitFact) => unitFact.orderTag === tag);

/** Every order's exact totals. The pin keeps the scenario table honest: a
 *  changed item, modifier, tag or answer stops the proof data here. */
const EXACT_ORDERS: Readonly<
  Record<
    string,
    Readonly<{
      readonly baseLineTotal: number;
      readonly extraTotal: number;
      readonly lineTotal: number;
      readonly numPasses: number;
      readonly remainingBalance: number;
      readonly subtotal: number;
      readonly total: number;
    }>
  >
> = {
  "a discount reduces the tickets": {
    baseLineTotal: 2000,
    extraTotal: 0,
    lineTotal: 1800,
    numPasses: 1,
    remainingBalance: 0,
    subtotal: 1800,
    total: 1800,
  },
  "a discount that exceeds the units": {
    baseLineTotal: 500,
    extraTotal: 0,
    lineTotal: 0,
    numPasses: 1,
    remainingBalance: 0,
    subtotal: 0,
    total: 0,
  },
  "a modifier quantity scales the discount": {
    baseLineTotal: 2000,
    extraTotal: 0,
    lineTotal: 1600,
    numPasses: 1,
    remainingBalance: 0,
    subtotal: 1600,
    total: 1600,
  },
  "a multiplier reduces the tickets": {
    baseLineTotal: 2000,
    extraTotal: 0,
    lineTotal: 1600,
    numPasses: 1,
    remainingBalance: 0,
    subtotal: 1600,
    total: 1600,
  },
  "a percent discount scales with the subtotal": {
    baseLineTotal: 2000,
    extraTotal: 0,
    lineTotal: 1800,
    numPasses: 1,
    remainingBalance: 0,
    subtotal: 1800,
    total: 1800,
  },
  "a reservation keeps a balance": {
    baseLineTotal: 2000,
    extraTotal: 0,
    lineTotal: 200,
    numPasses: 0,
    remainingBalance: 1800,
    subtotal: 2000,
    total: 200,
  },
  "a reservation with a discount keeps a balance": {
    baseLineTotal: 2000,
    extraTotal: 0,
    lineTotal: 180,
    numPasses: 1,
    remainingBalance: 1620,
    subtotal: 1800,
    total: 180,
  },
  "a scoped add-on raises one listing": {
    baseLineTotal: 3000,
    extraTotal: 300,
    lineTotal: 3000,
    numPasses: 1,
    remainingBalance: 0,
    subtotal: 3300,
    total: 3300,
  },
  "a scoped discount leaves other listings alone": {
    baseLineTotal: 3000,
    extraTotal: 0,
    lineTotal: 2900,
    numPasses: 1,
    remainingBalance: 0,
    subtotal: 2900,
    total: 2900,
  },
  "a single ticket": {
    baseLineTotal: 1000,
    extraTotal: 0,
    lineTotal: 1000,
    numPasses: 0,
    remainingBalance: 0,
    subtotal: 1000,
    total: 1000,
  },
  "a zero modifier changes nothing": {
    baseLineTotal: 1000,
    extraTotal: 0,
    lineTotal: 1000,
    numPasses: 1,
    remainingBalance: 0,
    subtotal: 1000,
    total: 1000,
  },
  "an add-on raises the order": {
    baseLineTotal: 2000,
    extraTotal: 500,
    lineTotal: 2000,
    numPasses: 1,
    remainingBalance: 0,
    subtotal: 2500,
    total: 2500,
  },
  "modifiers never compound": {
    baseLineTotal: 2000,
    extraTotal: 0,
    lineTotal: 1700,
    numPasses: 2,
    remainingBalance: 0,
    subtotal: 1700,
    total: 1700,
  },
};

describe("checkout composition proof data", () => {
  test("carries one order fact per scenario, in scenario order", () => {
    expect(facts.orderFacts.map((orderFact) => orderFact.orderTag)).toEqual(
      SCENARIOS.map((scenario) => scenario.sampleTag),
    );
  });

  test("every order carries its exact totals", () => {
    for (const orderFact of facts.orderFacts) {
      expect(orderFact.feeCount).toBe(0);
      expect(orderFact.feeSubtotal).toBe(orderFact.subtotal);
      expect(orderFact).toMatchObject(EXACT_ORDERS[orderFact.orderTag]!);
    }
  });

  test("every order total equals line plus extra charges", () => {
    for (const orderFact of facts.orderFacts) {
      expect(orderFact.total).toBe(orderFact.lineTotal + orderFact.extraTotal);
    }
  });

  test("the add passes' extra charges equal the extras", () => {
    for (const orderFact of facts.orderFacts) {
      const addedTotal = sum(
        passFactsOf(orderFact.orderTag).map((passFact) => passFact.added),
      );
      // The check environment configures no booking fee, so the extras are
      // exactly the add passes' charges.
      expect(orderFact.extraTotal).toBe(addedTotal);
    }
  });

  test("no reservation balance goes below zero", () => {
    for (const orderFact of facts.orderFacts) {
      expect(orderFact.remainingBalance).toBeGreaterThanOrEqual(0);
    }
  });

  test("carries one pass fact per modifier of every order", () => {
    for (const scenario of SCENARIOS) {
      expect(passFactsOf(scenario.sampleTag).map((p) => p.passIndex)).toEqual(
        scenario.modifiers.map((_, index) => index + 1),
      );
    }
  });

  test("every pass reads the pre-modifier base", () => {
    for (const passFact of facts.passFacts) {
      expect(passFact.scopedSubtotal).toBe(passFact.origSubtotal);
    }
  });

  test("a reduce pass removes exactly the clamped amount and no unit drops below zero", () => {
    for (const passFact of facts.passFacts) {
      if (passFact.kind === "reduce") {
        const expected = Math.min(passFact.requested, passFact.currentSubtotal);
        expect(passFact.removed).toBe(expected);
        for (const unitFact of unitFactsOf(passFact.orderTag).filter(
          (unit) => unit.passIndex === passFact.passIndex,
        )) {
          expect(unitFact.reduced).toBeGreaterThanOrEqual(0);
          expect(unitFact.reduced).toBeLessThanOrEqual(unitFact.price);
        }
        // The units' losses add up to exactly the removed amount.
        expect(
          sum(
            unitFactsOf(passFact.orderTag)
              .filter((unit) => unit.passIndex === passFact.passIndex)
              .map((unit) => unit.price - unit.reduced),
          ),
        ).toBe(passFact.removed);
      } else {
        expect(passFact.removed).toBe(0);
      }
    }
  });

  test("every reduce pass touches at least one unit, and only reduce passes do", () => {
    const reduceKeys = new Set(
      facts.passFacts
        .filter((passFact) => passFact.kind === "reduce")
        .map((passFact) => `${passFact.orderTag}:${passFact.passIndex}`),
    );
    for (const unitFact of facts.unitFacts) {
      expect(reduceKeys.has(`${unitFact.orderTag}:${unitFact.passIndex}`)).toBe(
        true,
      );
    }
    for (const key of reduceKeys) {
      expect(
        facts.unitFacts.some(
          (unitFact) => `${unitFact.orderTag}:${unitFact.passIndex}` === key,
        ),
      ).toBe(true);
    }
  });

  test("every pass carries production's recorded base and its own pre-modifier base", () => {
    for (const scenario of SCENARIOS) {
      const applications = applyModifiers(
        scenario.items.map((item) => ({
          chargedUnitAmount: item.unitPrice,
          item,
          quantity: item.quantity,
        })),
        [...scenario.modifiers],
      ).applications;
      const passes = passFactsOf(scenario.sampleTag);
      expect(passes.map((passFact) => passFact.scopedSubtotal)).toEqual(
        applications.map((application) => application.scopedSubtotal),
      );
      expect(passes.map((passFact) => passFact.origSubtotal)).toEqual(
        applications.map((application) => application.scopedSubtotal),
      );
    }
  });

  test("the recorded fee basis agrees with the derived subtotal", () => {
    for (const scenario of SCENARIOS) {
      const orderFact = facts.orderFacts.find(
        (candidate) => candidate.orderTag === scenario.sampleTag,
      )!;
      const productionModifierTotal = applyModifiers(
        scenario.items.map((item) => ({
          chargedUnitAmount: item.unitPrice,
          item,
          quantity: item.quantity,
        })),
        [...scenario.modifiers],
      ).modifierTotal;
      expect(orderFact.subtotal).toBe(
        feeSubtotalFor({ items: scenario.items }) + productionModifierTotal,
      );
      expect(orderFact.feeSubtotal).toBe(orderFact.subtotal);
    }
  });

  test("the data module carries the fact tables under their own names", async () => {
    const data = await checkoutCompositionModelData();
    expect(data).toContain("MODULE CheckoutCompositionData");
    expect(data).toContain("Orders ==");
    expect(data).toContain("Passes ==");
    expect(data).toContain("Units ==");
  });
});
