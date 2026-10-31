/** The checkout composition negative controls: each corruption rewrites the
 *  fact its failure mode names, and each corruption throws when its victim
 *  fact is missing. */

/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type {
  OrderFact,
  PassFact,
} from "#scripts/verify-models/checkout-composition.ts";
import {
  compoundingDiscountData,
  corruptCompositionData,
  overshootDiscountData,
  staleFeeData,
} from "#scripts/verify-models/composition-corruptions.ts";
import { records } from "#test-utils/tla-data.ts";

/* jscpd:ignore-end */

type DataRecord = Record<string, string | boolean | number>;

const recordsOf = (data: string, name: string): DataRecord[] =>
  records(data, name) as DataRecord[];

describe("checkout composition negative controls", () => {
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
      added: 0,
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
      added: 0,
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
});
