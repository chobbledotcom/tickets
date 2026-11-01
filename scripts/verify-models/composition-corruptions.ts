/** The checkout composition checker's negative controls: one corrupted proof
 *  data set per failure mode. Each corruption throws when its victim fact is
 *  missing, and the facts are injectable so the tests can reach the throws. */

/* jscpd:ignore-start -- imports */
import {
  type CompositionFacts,
  checkoutCompositionData,
  compositionFacts,
} from "#scripts/verify-models/checkout-composition.ts";
import {
  corruptOneFact,
  type ModelDataSource,
} from "#scripts/verify-models/data.ts";

/* jscpd:ignore-end */

/** The two-discount order whose second pass the compounding corruption
 *  rewrites to read the reduced subtotal. */
const COMPOUND_TAG = "modifiers never compound";

/** The single-unit order whose discount the overshoot corruption inflates
 *  past the units it reduces. */
const OVERSHOOT_TAG = "a discount that exceeds the units";

/** The failure modes the checker must reject. */
export type Corruption = "compounding" | "overshooting discount" | "stale fee";

const corruptions: Readonly<
  Record<Corruption, (facts: CompositionFacts) => CompositionFacts>
> = {
  compounding: ({ orderFacts, passFacts, unitFacts }) => ({
    orderFacts,
    passFacts: corruptOneFact(
      passFacts,
      (fact) => fact.orderTag === COMPOUND_TAG && fact.passIndex === 2,
      `The composition holds no second pass for "${COMPOUND_TAG}". There is no pass to corrupt.`,
      (fact) => {
        if (fact.currentSubtotal === fact.origSubtotal) {
          throw new Error(
            `The second "${COMPOUND_TAG}" pass reads no reduced subtotal. There is no compounding to corrupt.`,
          );
        }
        return { ...fact, scopedSubtotal: fact.currentSubtotal };
      },
    ),
    unitFacts,
  }),
  "overshooting discount": ({ orderFacts, passFacts, unitFacts }) => {
    const victim = passFacts.find((fact) => fact.orderTag === OVERSHOOT_TAG);
    if (!victim) {
      throw new Error(
        `The composition holds no pass for "${OVERSHOOT_TAG}". There is no discount to corrupt.`,
      );
    }
    if (victim.requested <= victim.currentSubtotal) {
      throw new Error(
        `The "${OVERSHOOT_TAG}" discount does not exceed its units. There is no overshoot to corrupt.`,
      );
    }
    return {
      orderFacts,
      passFacts: passFacts.map((fact) =>
        fact.orderTag === OVERSHOOT_TAG
          ? { ...fact, removed: fact.requested }
          : fact,
      ),
      unitFacts,
    };
  },
  "stale fee": ({ orderFacts, passFacts, unitFacts }) => {
    const victim = orderFacts.find((fact) => fact.orderTag === COMPOUND_TAG);
    if (!victim) {
      throw new Error(
        `The composition holds no "${COMPOUND_TAG}" order. There is no fee basis to corrupt.`,
      );
    }
    if (victim.baseLineTotal === victim.subtotal) {
      throw new Error(
        `The "${COMPOUND_TAG}" fee basis equals the final subtotal. There is no stale basis to corrupt.`,
      );
    }
    return {
      orderFacts: orderFacts.map((fact) =>
        fact.orderTag === COMPOUND_TAG
          ? { ...fact, feeSubtotal: fact.baseLineTotal }
          : fact,
      ),
      passFacts,
      unitFacts,
    };
  },
};

/** One corrupted proof-data set. The checker must report a counterexample
 *  for it, or the clean verdicts prove nothing. */
export const corruptCompositionData = async (
  corruption: Corruption,
  facts: CompositionFacts = compositionFacts(),
): Promise<string> => {
  const { orderFacts, passFacts, unitFacts } = corruptions[corruption](facts);
  return checkoutCompositionData(orderFacts, passFacts, unitFacts);
};

/** One negative-control data source for the given failure mode. */
const corruptDataFor =
  (corruption: Corruption): ModelDataSource =>
  () =>
    corruptCompositionData(corruption);

/** The data module with the second discount compounding on the first. */
export const compoundingDiscountData: ModelDataSource =
  corruptDataFor("compounding");

/** The data module with a discount that overshoots the units it reduces. */
export const overshootDiscountData: ModelDataSource = corruptDataFor(
  "overshooting discount",
);

/** The data module with a booking fee charged on a stale subtotal. */
export const staleFeeData: ModelDataSource = corruptDataFor("stale fee");
