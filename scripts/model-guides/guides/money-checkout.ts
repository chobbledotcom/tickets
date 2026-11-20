import type { ModelGuide } from "#scripts/model-guides/types.ts";

/** One priced checkout through its modifier passes and final fee check. */
/* jscpd:ignore-start -- static data, not code */
export const checkoutComposition: ModelGuide = {
  badOutcome:
    "A second discount reads a price that the first discount reduced. Or a discount takes a unit below zero, or the booking fee reads a subtotal that the modifiers changed.",
  cast: [
    {
      meaning:
        "One example checkout with its selected listings, quantities and modifiers.",
      term: "order",
    },
    {
      meaning: "One modifier's effect at one position in the ordered list.",
      term: "pass",
    },
    {
      meaning:
        "The original price sum of the units that one modifier covers, before any modifier.",
      term: "scoped subtotal",
    },
    {
      meaning:
        "A modifier with a negative change. It reduces the covered ticket units.",
      term: "reduce pass",
    },
    {
      meaning: "The part of the order that the customer pays now.",
      term: "deposit",
    },
    {
      meaning: "The subtotal that the booking fee reads.",
      term: "fee basis",
    },
    {
      meaning:
        "One prepared record from the producer. The tag is a scenario name, not a stored order id.",
      term: "fact",
    },
  ],
  claim:
    "This page follows one priced checkout through its modifier passes and its final fee check. Each pass reads the original price of the units it covers. A discount never removes more than those units hold. The final subtotal matches the list prices plus every pass effect, and the deposit plus the balance matches that subtotal.",
  limits: [
    "ComposedChange expands at most six pass effects. A wider order loses later effects from this sum.",
    "The model uses the production discount allocation and modifier delta. It does not check their arithmetic independently.",
    "Listing identity does not survive into the unit facts. The model does not prove per-listing scope or per-unit attribution.",
    "The scenarios do not cover every numeric input, tax correctness, provider charges, SQL writes or eventual progress.",
    "The fee basis is reconstructed from the fee subtotal and the application deltas. It detects inconsistent facts, not every stale production basis. These scenarios do not prove a nonzero fee.",
  ],
  module: "CheckoutComposition",
  safety:
    "Every accepted pass keeps the original scoped price, removes at most the current scoped price, and never takes a unit below zero. The final check ties the subtotal, the total, the deposit balance and the fee basis together.",
  steps: [
    {
      code: [
        {
          path: "scripts/verify-models/checkout-composition.ts",
          symbol: "compositionFacts",
        },
      ],
      rules: ["Init", "TypeOK", "OrderTags"],
      title: "Start on one example order",
      values: [
        { name: "current", value: "a discount reduces the tickets" },
        { name: "passIndex", value: "1" },
        { name: "feeApplied", value: "FALSE" },
        { name: "allFactsSafe", value: "TRUE" },
        { name: "OrderTags", value: "One tag for each of 13 sample orders." },
      ],
      what: "Init selects one supplied order at its first pass. OrderTags collects the scenario tags from the order facts. The producer prices every scenario through priceCheckout and records one order fact for each. A tag is an example name, not a stored order id.",
    },
    {
      code: [
        {
          path: "src/shared/checkout-pricing.ts",
          symbol: "priceCheckout",
        },
        {
          path: "src/shared/checkout-pricing.ts",
          symbol: "applyModifiers",
        },
      ],
      rules: ["CurrentOrderHolds", "PassStep", "PassChange"],
      title: "One pass reads the original scoped price",
      values: [
        { name: "order", value: "modifiers never compound" },
        {
          name: "pass 1",
          value:
            "scopedSubtotal 2000, origSubtotal 2000, requested 200, removed 200.",
        },
        {
          name: "pass 2",
          value:
            "scopedSubtotal 2000, origSubtotal 2000, currentSubtotal 1800, requested 100, removed 100.",
        },
      ],
      what: "CurrentOrderHolds keeps the pass index between one and the position after the last pass. PassStep takes the pass fact for the current tag and index. PassChange reads added minus removed. applyModifiers applies each pass to the original scoped subtotal, so the second discount does not read the 1800 price that the first one left.",
    },
    {
      code: [
        {
          path: "src/shared/checkout-pricing.ts",
          symbol: "allocateDiscount",
        },
        {
          path: "src/shared/price-modifier.ts",
          symbol: "modifierDelta",
        },
      ],
      rules: ["SafePass", "ComposedChange", "MaxPasses"],
      title: "A reduce pass stays inside its units",
      values: [
        {
          name: "a discount that exceeds the units",
          value:
            "requested 1000, currentSubtotal 500, removed 500, unit reduced 0.",
        },
        {
          name: "a discount reduces the tickets",
          value: "requested 200, removed 200.",
        },
        {
          name: "composed change",
          value: "-300 for the two discounts in modifiers never compound.",
        },
        { name: "MaxPasses", value: "6" },
      ],
      what: "SafePass requires a reduce pass to remove the requested amount capped at the current scoped price. The model reads removed from the production unit prices, and every reduced unit stays between zero and its prior price. allocateDiscount spreads the removal by largest remainder. ComposedChange sums at most six pass positions, so a wider order stays outside this model.",
    },
    {
      code: [
        {
          path: "src/shared/booking-fee.ts",
          symbol: "feeSubtotalFor",
        },
        {
          path: "src/shared/checkout-pricing.ts",
          symbol: "priceCheckout",
        },
        {
          path: "src/shared/checkout-pricing.ts",
          symbol: "ticketPaymentBreakdown",
        },
      ],
      rules: ["FeeStep", "SafeOrder"],
      title: "The final check recomposes the order",
      values: [
        {
          name: "a reservation keeps a balance",
          value:
            "baseLineTotal 2000, subtotal 2000, total 200, remainingBalance 1800.",
        },
        {
          name: "modifiers never compound",
          value:
            "baseLineTotal 2000, composed change -300, subtotal 1700, feeSubtotal 1700.",
        },
        { name: "feeCount", value: "At most one fee line." },
      ],
      what: "FeeStep runs once, only at the position after the last pass. SafeOrder recomposes the subtotal from the list prices and the pass effects. Total plus balance must equal the subtotal, and the charge lines plus the extras must equal the total. The fee basis must equal the final subtotal. feeSubtotalFor supplies the subtotal before the modifiers, and priceCheckout adds the recorded net change.",
    },
    {
      code: [
        {
          path: "scripts/verify-models/composition-corruptions.ts",
          symbol: "compoundingDiscountData",
        },
        {
          path: "scripts/verify-models/composition-corruptions.ts",
          symbol: "staleFeeData",
        },
      ],
      rules: ["Safety", "Next"],
      title: "The joined safety claim",
      values: [
        {
          name: "compounding control",
          value:
            "The second pass records scopedSubtotal 1800 against origSubtotal 2000. The checker rejects the data.",
        },
        {
          name: "stale fee control",
          value:
            "feeSubtotal 2000 against subtotal 1700. The checker rejects the data.",
        },
        {
          name: "failed verdict",
          value: "A FALSE allFactsSafe value never returns to TRUE.",
        },
      ],
      what: "Safety joins the value domains, the pass boundary and the kept verdict. Next permits one pass, the final check or no change. The compounding control makes the second discount read the reduced price. The stale fee control makes the fee read the list price. Safety refuses both, so the checker must find a counterexample.",
    },
  ],
  title: "Pricing one checkout without compounding its discounts",
};

/** One whole-unit allocation after the first rounded shares. */
export const largestRemainderSplit: ModelGuide = {
  badOutcome:
    "One unit disappears in the award loop, or a part takes a unit past its cap, or units remain with no eligible part to take them.",
  cast: [
    {
      meaning: "One recipient, such as one ticket unit or one tax line.",
      term: "part",
    },
    {
      meaning: "The proportional share of one part, rounded down.",
      term: "floor",
    },
    {
      meaning: "The whole units still owed after every part takes its floor.",
      term: "leftover",
    },
    {
      meaning:
        "The caller's guard permits one extra unit for that part. A part at its cap is not eligible.",
      term: "eligible",
    },
    {
      meaning: "The maximum allocation for one part, such as its full price.",
      term: "cap",
    },
    {
      meaning: "The set of parts that received one extra unit.",
      term: "bumped",
    },
    {
      meaning:
        "A model fault flag. It means that units remain but no eligible part can receive one.",
      term: "stranded",
    },
  ],
  claim:
    "This page follows one whole-unit allocation after the floor shares. Every leftover unit goes to one eligible part. The awarded units plus the units still owed equal the original leftover. No part goes past its cap.",
  limits: [
    "The model starts after the floors. It does not validate the floor arithmetic or the production recipient order.",
    "The facts must supply enough eligible parts and correct floors. Direct tests must check those facts and the production arithmetic.",
    "Selected cases do not establish arithmetic correctness for all inputs. Fractional amounts stay outside this integer model.",
    "No fairness rule forces awards. The model checks safety, not eventual completion.",
  ],
  module: "LargestRemainderSplit",
  safety:
    "Every accepted award keeps the unit count, the per-part caps and the case facts. A stranded unit is a fault, so the model refuses it.",
  steps: [
    {
      code: [
        {
          path: "scripts/verify-models/largest-remainder-split.ts",
          symbol: "splitFacts",
        },
      ],
      rules: ["Init", "TypeOK", "CaseTags"],
      title: "Start after the floor shares",
      values: [
        { name: "current", value: "a part at its cap receives no more" },
        { name: "capped", value: "TRUE" },
        { name: "leftover", value: "1" },
        { name: "remaining", value: "1" },
        { name: "bumped", value: "{}" },
        { name: "stranded", value: "FALSE" },
      ],
      what: "Init selects one supplied case after every part takes its floor share. CaseTags holds the case names. TypeOK bounds the case, the leftover count, the awarded set and the fault flag. The producer computes the floors from the raw weights with JavaScript arithmetic, and the model receives no answer.",
    },
    {
      code: [
        {
          path: "src/shared/largest-remainder.ts",
          symbol: "largestRemainderAllocation",
        },
      ],
      rules: ["CurrentCaseFactsHold", "AwardStep"],
      title: "Award one unit to an eligible part",
      values: [
        { name: "case", value: "a part at its cap receives no more" },
        { name: "part 1", value: "floor 666, cap 666, eligible FALSE" },
        { name: "part 2", value: "floor 1333, cap 1334, eligible TRUE" },
        { name: "remaining", value: "1, then 0" },
        { name: "bumped", value: "{} then {2}" },
      ],
      what: "CurrentCaseFactsHold ties the cap flag and the leftover count to the supplied case. AwardStep gives one unit to one eligible part that has no unit yet. The model allows any eligible choice, not the production sort order. largestRemainderAllocation ranks the parts by remainder and tie-break value in production.",
    },
    {
      code: [
        {
          path: "src/shared/reservation-amount.ts",
          symbol: "allocateReservationDeposit",
        },
        {
          path: "src/shared/largest-remainder.ts",
          symbol: "largestRemainderAllocation",
        },
      ],
      rules: ["UnitsStayAccounted", "AwardStaysWithinCap"],
      title: "The awards stay inside the caps",
      values: [
        { name: "leftover", value: "1" },
        { name: "remaining", value: "0" },
        { name: "bumped", value: "{2}" },
        { name: "accounting", value: "0 + 1 = 1" },
        { name: "part 2", value: "1333 + 1 = 1334, cap 1334" },
        {
          name: "reservation case",
          value: "floors [3, 0, 0], awards {2, 3}, result [3, 1, 1].",
        },
      ],
      what: "UnitsStayAccounted requires the remaining units plus the awarded parts to equal the leftover count. AwardStaysWithinCap requires each awarded part to stay at or below its cap. allocateReservationDeposit passes the capacity guard and the cart-order tie-break to the production allocator. In the reservation case, parts 2 and 3 take the two leftover units and reach their capacities.",
    },
    {
      code: [
        {
          path: "scripts/verify-models/largest-remainder-split.ts",
          symbol: "corruptSplitData",
        },
      ],
      rules: ["PartsOf", "StrandStep"],
      title: "Units with no eligible part are a fault",
      values: [
        { name: "case", value: "a part at its cap receives no more" },
        { name: "leftover", value: "2 after the corrupted fact." },
        { name: "remaining", value: "1" },
        { name: "bumped", value: "{2}" },
        { name: "eligible parts without a unit", value: "0" },
        { name: "stranded", value: "TRUE. Safety fails." },
      ],
      what: "PartsOf keeps the parts of each case apart, so an award cannot cross cases. StrandStep exposes a fault when units remain and every eligible part already has a unit. The unconserved accounting control adds one owed unit to this case. The model then reaches the fault step, and the checker must reject the data.",
    },
    {
      code: [
        {
          path: "scripts/verify-models/largest-remainder-split.ts",
          symbol: "splitFacts",
        },
        {
          path: "src/shared/reservation-amount.ts",
          symbol: "allocateReservationDeposit",
        },
      ],
      rules: ["MaxParts", "Safety", "Next"],
      title: "Six parts and the joined claim",
      values: [
        { name: "case", value: "tax across lines and modifiers" },
        { name: "amount", value: "267" },
        { name: "floors", value: "[118, 79, 44, 14, 7, 2]" },
        { name: "leftover", value: "3" },
        { name: "awards", value: "{1, 3, 4}" },
        { name: "result", value: "[119, 79, 45, 15, 7, 2]" },
        { name: "MaxParts", value: "6" },
      ],
      what: "MaxParts bounds one case at six parts, and the tax case uses all six. Safety joins the type, case, accounting and cap rules and refuses a stranded flag. Next permits an award, the fault step or no change. No fairness rule forces awards, so the model does not prove that the loop finishes.",
    },
  ],
  title: "Splitting whole units without a lost penny or a broken cap",
};
/* jscpd:ignore-end */
