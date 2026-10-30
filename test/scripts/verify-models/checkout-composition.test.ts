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
  compoundingDiscountData,
  corruptCompositionData,
  type OrderFact,
  overshootDiscountData,
  type PassFact,
  SCENARIOS,
  staleFeeData,
  type UnitFact,
} from "#scripts/verify-models/checkout-composition.ts";
import { feeSubtotalFor } from "#shared/booking-fee.ts";
import { applyModifiers } from "#shared/checkout-pricing.ts";
import { records } from "#test-utils/tla-data.ts";

/* jscpd:ignore-end */

type DataRecord = Record<string, string | boolean | number>;

const facts = compositionFacts();

const passFactsOf = (tag: string): PassFact[] =>
  facts.passFacts.filter((passFact) => passFact.orderTag === tag);

const unitFactsOf = (tag: string): UnitFact[] =>
  facts.unitFacts.filter((unitFact) => unitFact.orderTag === tag);

const recordsOf = (data: string, name: string): DataRecord[] =>
  records(data, name) as DataRecord[];

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
  "a reservation keeps a balance": {
    baseLineTotal: 2000,
    extraTotal: 0,
    lineTotal: 200,
    numPasses: 0,
    remainingBalance: 1800,
    subtotal: 2000,
    total: 200,
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

  test("corrupting the second pass compounds on the first", async () => {
    const data = await corruptCompositionData("compounding");
    const passes = recordsOf(data, "Passes");
    const second = passes.find(
      (passFact) =>
        passFact.orderTag === "modifiers never compound" &&
        Number(passFact.passIndex) === 2,
    )!;
    expect(second.scopedSubtotal).toBe(second.currentSubtotal);
    expect(second.scopedSubtotal).not.toBe(second.origSubtotal);
  });

  test("corrupting the discount overshoots the units", async () => {
    const data = await corruptCompositionData("overshooting discount");
    const passes = recordsOf(data, "Passes");
    const victim = passes.find(
      (passFact) => passFact.orderTag === "a discount that exceeds the units",
    )!;
    expect(Number(victim.removed)).toBe(Number(victim.requested));
    expect(Number(victim.removed)).toBeGreaterThan(
      Number(victim.currentSubtotal),
    );
  });

  test("corrupting the fee basis charges a stale subtotal", async () => {
    const data = await corruptCompositionData("stale fee");
    const orders = recordsOf(data, "Orders");
    const victim = orders.find(
      (orderFact) => orderFact.orderTag === "modifiers never compound",
    )!;
    expect(victim.feeSubtotal).toBe(victim.baseLineTotal);
    expect(victim.feeSubtotal).not.toBe(victim.subtotal);
  });

  test("throws when the pass to corrupt is missing", async () => {
    await expect(
      corruptCompositionData("compounding", {
        orderFacts: [],
        passFacts: [],
        unitFacts: [],
      }),
    ).rejects.toThrow(
      'The composition holds no second pass for "modifiers never compound". There is no pass to corrupt.',
    );
  });

  test("throws when the discount to corrupt has no overshoot", async () => {
    const singlePass: PassFact = {
      currentSubtotal: 500,
      kind: "reduce",
      orderTag: "a discount that exceeds the units",
      origSubtotal: 500,
      passIndex: 1,
      removed: 500,
      requested: 200,
      scopedSubtotal: 500,
    };
    await expect(
      corruptCompositionData("overshooting discount", {
        orderFacts: [],
        passFacts: [singlePass],
        unitFacts: [],
      }),
    ).rejects.toThrow(
      'The "a discount that exceeds the units" discount does not exceed its units. There is no overshoot to corrupt.',
    );
  });

  test("throws when the order to corrupt is missing", async () => {
    await expect(
      corruptCompositionData("stale fee", {
        orderFacts: [],
        passFacts: [],
        unitFacts: [],
      }),
    ).rejects.toThrow(
      'The composition holds no "modifiers never compound" order. There is no fee basis to corrupt.',
    );
  });

  test("throws when the second pass reads no reduced subtotal", async () => {
    const secondPass: PassFact = {
      currentSubtotal: 2000,
      kind: "reduce",
      orderTag: "modifiers never compound",
      origSubtotal: 2000,
      passIndex: 2,
      removed: 100,
      requested: 100,
      scopedSubtotal: 2000,
    };
    await expect(
      corruptCompositionData("compounding", {
        orderFacts: [],
        passFacts: [secondPass],
        unitFacts: [],
      }),
    ).rejects.toThrow(
      'The second "modifiers never compound" pass reads no reduced subtotal. There is no compounding to corrupt.',
    );
  });

  test("throws when the discount to corrupt is missing", async () => {
    await expect(
      corruptCompositionData("overshooting discount", {
        orderFacts: [],
        passFacts: [],
        unitFacts: [],
      }),
    ).rejects.toThrow(
      'The composition holds no pass for "a discount that exceeds the units". There is no discount to corrupt.',
    );
  });

  test("throws when the fee basis is not stale", async () => {
    const orderFact: OrderFact = {
      baseLineTotal: 1700,
      extraTotal: 0,
      feeCount: 0,
      feeSubtotal: 1700,
      lineTotal: 1700,
      numPasses: 2,
      orderTag: "modifiers never compound",
      remainingBalance: 0,
      subtotal: 1700,
      total: 1700,
    };
    await expect(
      corruptCompositionData("stale fee", {
        orderFacts: [orderFact],
        passFacts: [],
        unitFacts: [],
      }),
    ).rejects.toThrow(
      'The "modifiers never compound" fee basis equals the final subtotal. There is no stale basis to corrupt.',
    );
  });

  test("the negative-control data sources build the corrupted modules", async () => {
    const compounding = await compoundingDiscountData();
    const overshoot = await overshootDiscountData();
    const stale = await staleFeeData();
    expect(compounding).toContain("MODULE CheckoutCompositionData");
    expect(overshoot).toContain("MODULE CheckoutCompositionData");
    expect(stale).toContain("MODULE CheckoutCompositionData");
  });

  test("the data module carries the fact tables under their own names", async () => {
    const data = await checkoutCompositionModelData();
    expect(data).toContain("MODULE CheckoutCompositionData");
    expect(data).toContain("Orders ==");
    expect(data).toContain("Passes ==");
    expect(data).toContain("Units ==");
  });
});
