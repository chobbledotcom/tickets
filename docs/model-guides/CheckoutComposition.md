# Pricing one checkout without compounding its discounts

[Read the model](../../verification/CheckoutComposition.tla).

This page follows one priced checkout through its modifier passes and its final fee check. Each pass reads the original price of the units it covers. A discount never removes more than those units hold. The final subtotal matches the list prices plus every pass effect, and the deposit plus the balance matches that subtotal.

## The bad outcome it rules out

A second discount reads a price that the first discount reduced. Or a discount takes a unit below zero, or the booking fee reads a subtotal that the modifiers changed.

## The cast

| Word | Meaning |
| --- | --- |
| **order** | One example checkout with its selected listings, quantities and modifiers. |
| **pass** | One modifier's effect at one position in the ordered list. |
| **scoped subtotal** | The original price sum of the units that one modifier covers, before any modifier. |
| **reduce pass** | A modifier with a negative change. It reduces the covered ticket units. |
| **deposit** | The part of the order that the customer pays now. |
| **fee basis** | The subtotal that the booking fee reads. |
| **fact** | One prepared record from the producer. The tag is a scenario name, not a stored order id. |

## The walkthrough

### Step 1: Start on one example order

Init selects one supplied order at its first pass. OrderTags collects the scenario tags from the order facts. The producer prices every scenario through priceCheckout and records one order fact for each. A tag is an example name, not a stored order id.

| Value | This step |
| --- | --- |
| `current` | a discount reduces the tickets |
| `passIndex` | 1 |
| `feeApplied` | FALSE |
| `allFactsSafe` | TRUE |
| `OrderTags` | One tag for each of 13 sample orders. |

**Model rule: [`Init`](../../verification/CheckoutComposition.tla#L170)**

```tla
Init ==
  \E orderFact \in Orders :
    /\ current' = orderFact.orderTag
    /\ passIndex' = 1
    /\ feeApplied' = FALSE
    /\ allFactsSafe' = TRUE
```

**Model rule: [`TypeOK`](../../verification/CheckoutComposition.tla#L79)**

```tla
TypeOK ==
  /\ current \in OrderTags
  /\ passIndex \in Int
  /\ feeApplied \in BOOLEAN
  /\ allFactsSafe \in BOOLEAN
```

**Model rule: [`OrderTags`](../../verification/CheckoutComposition.tla#L75)**

```tla
OrderTags == {orderFact.orderTag : orderFact \in Orders}
```

**Production code: [`scripts/verify-models/checkout-composition.ts#compositionFacts`](../../scripts/verify-models/checkout-composition.ts#L376)**

```ts
export const compositionFacts = (): CompositionFacts => { ... }
```

Source fingerprint: `sha256:2121d0590fe8ebe7`

### Step 2: One pass reads the original scoped price

CurrentOrderHolds keeps the pass index between one and the position after the last pass. PassStep takes the pass fact for the current tag and index. PassChange reads added minus removed. applyModifiers applies each pass to the original scoped subtotal, so the second discount does not read the 1800 price that the first one left.

| Value | This step |
| --- | --- |
| `order` | modifiers never compound |
| `pass 1` | scopedSubtotal 2000, origSubtotal 2000, requested 200, removed 200. |
| `pass 2` | scopedSubtotal 2000, origSubtotal 2000, currentSubtotal 1800, requested 100, removed 100. |

**Model rule: [`CurrentOrderHolds`](../../verification/CheckoutComposition.tla#L88)**

```tla
CurrentOrderHolds ==
  \E orderFact \in Orders :
    /\ orderFact.orderTag = current
    /\ passIndex >= 1
    /\ passIndex <= orderFact.numPasses + 1
    /\ feeApplied => passIndex = orderFact.numPasses + 1
```

**Model rule: [`PassStep`](../../verification/CheckoutComposition.tla#L183)**

```tla
PassStep ==
  \E passFact \in Passes :
    /\ passFact.orderTag = current
    /\ passFact.passIndex = passIndex
    /\ current' = current
    /\ passIndex' = passIndex + 1
    /\ feeApplied' = feeApplied
    /\ allFactsSafe' = ChecksStillPass(allFactsSafe, SafePass(passFact))
```

**Model rule: [`PassChange`](../../verification/CheckoutComposition.tla#L99)**

```tla
PassChange(tag, index) ==
  LET passFact == CHOOSE pf \in Passes :
        pf.orderTag = tag /\ pf.passIndex = index
  IN passFact.added - passFact.removed
```

**Production code: [`src/shared/checkout-pricing.ts#priceCheckout`](../../src/shared/checkout-pricing.ts#L398)**

```ts
export const priceCheckout = (intent: CheckoutIntent): PricedOrder => { ... }
```

Source fingerprint: `sha256:b01b4ef75de422bc`

**Production code: [`src/shared/checkout-pricing.ts#applyModifiers`](../../src/shared/checkout-pricing.ts#L373)**

```ts
export const applyModifiers = (
  lines: PricedLine[],
  specs: ModifierSpec[],
): ModifierResult => { ... }
```

Source fingerprint: `sha256:6636590c58ba5228`

### Step 3: A reduce pass stays inside its units

SafePass requires a reduce pass to remove the requested amount capped at the current scoped price. The model reads removed from the production unit prices, and every reduced unit stays between zero and its prior price. allocateDiscount spreads the removal by largest remainder. ComposedChange sums at most six pass positions, so a wider order stays outside this model.

| Value | This step |
| --- | --- |
| `a discount that exceeds the units` | requested 1000, currentSubtotal 500, removed 500, unit reduced 0. |
| `a discount reduces the tickets` | requested 200, removed 200. |
| `composed change` | -300 for the two discounts in modifiers never compound. |
| `MaxPasses` | 6 |

**Model rule: [`SafePass`](../../verification/CheckoutComposition.tla#L121)**

```tla
SafePass(passFact) ==
  /\ passFact.kind \in {"add", "reduce", "zero"}
  /\ passFact.scopedSubtotal = passFact.origSubtotal
  /\ passFact.kind = "reduce" =>
       /\ passFact.requested >= 0
       /\ passFact.removed =
            IF passFact.requested < passFact.currentSubtotal
            THEN passFact.requested
            ELSE passFact.currentSubtotal
       /\ \A unitFact \in Units :
            unitFact.orderTag = passFact.orderTag /\
            unitFact.passIndex = passFact.passIndex =>
              /\ unitFact.reduced >= 0
              /\ unitFact.reduced <= unitFact.price
  /\ passFact.kind \in {"add", "zero"} => passFact.removed = 0
```

**Model rule: [`ComposedChange`](../../verification/CheckoutComposition.tla#L106)**

```tla
ComposedChange(tag, numPasses) ==
  (IF 1 <= numPasses THEN PassChange(tag, 1) ELSE 0)
    + (IF 2 <= numPasses THEN PassChange(tag, 2) ELSE 0)
    + (IF 3 <= numPasses THEN PassChange(tag, 3) ELSE 0)
    + (IF 4 <= numPasses THEN PassChange(tag, 4) ELSE 0)
    + (IF 5 <= numPasses THEN PassChange(tag, 5) ELSE 0)
    + (IF 6 <= numPasses THEN PassChange(tag, 6) ELSE 0)
```

**Model rule: [`MaxPasses`](../../verification/CheckoutComposition.tla#L51)**

```tla
MaxPasses == 6

\* Scenario tags distinguish examples such as one ticket, a scoped discount
\* and a reservation with a balance. They are not customer order identifiers.
\* Listing ids 1 and 2 separate covered and uncovered offers in scoped cases.
\* Representative examples exercise different rules without every possible
\* order or numeric input. All variables below are model-only proof state.
VARIABLES
  \* Tag of the selected example order whose facts this path checks.
  \* @type: Str;
  current,
  \* Position of the next modifier pass, from 1 to the position after the
  \* last pass. This is a count position, not a modifier database id.
  \* @type: Int;
  passIndex,
  \* TRUE after the final order check. It is not a fee charge or stored flag.
  \* @type: Bool;
  feeApplied,
  \* Remember whether all facts checked so far passed. FALSE stays FALSE.
  \* @type: Bool;
  allFactsSafe
```

**Production code: [`src/shared/checkout-pricing.ts#allocateDiscount`](../../src/shared/checkout-pricing.ts#L185)**

```ts
export const allocateDiscount = (units: number[], amount: number): number[] => { ... }
```

Source fingerprint: `sha256:04aee647b306b3c1`

**Production code: [`src/shared/price-modifier.ts#modifierDelta`](../../src/shared/price-modifier.ts#L116)**

```ts
export const modifierDelta = (
  base: number,
  kind: CalcKind,
  value: number,
): number => { ... }
```

Source fingerprint: `sha256:a55965bdfdb229a8`

### Step 4: The final check recomposes the order

FeeStep runs once, only at the position after the last pass. SafeOrder recomposes the subtotal from the list prices and the pass effects. Total plus balance must equal the subtotal, and the charge lines plus the extras must equal the total. The fee basis must equal the final subtotal. feeSubtotalFor supplies the subtotal before the modifiers, and priceCheckout adds the recorded net change.

| Value | This step |
| --- | --- |
| `a reservation keeps a balance` | baseLineTotal 2000, subtotal 2000, total 200, remainingBalance 1800. |
| `modifiers never compound` | baseLineTotal 2000, composed change -300, subtotal 1700, feeSubtotal 1700. |
| `feeCount` | At most one fee line. |

**Model rule: [`FeeStep`](../../verification/CheckoutComposition.tla#L195)**

```tla
FeeStep ==
  \E orderFact \in Orders :
    /\ orderFact.orderTag = current
    /\ passIndex = orderFact.numPasses + 1
    /\ ~feeApplied
    /\ current' = current
    /\ passIndex' = passIndex
    /\ feeApplied' = TRUE
    /\ allFactsSafe' = ChecksStillPass(allFactsSafe, SafeOrder(orderFact))
```

**Model rule: [`SafeOrder`](../../verification/CheckoutComposition.tla#L146)**

```tla
SafeOrder(orderFact) ==
  /\ orderFact.subtotal =
       orderFact.baseLineTotal
       + ComposedChange(orderFact.orderTag, orderFact.numPasses)
  /\ orderFact.total + orderFact.remainingBalance = orderFact.subtotal
  /\ orderFact.total = orderFact.lineTotal + orderFact.extraTotal
  /\ orderFact.feeCount <= 1
  /\ orderFact.feeSubtotal = orderFact.subtotal
  /\ orderFact.remainingBalance >= 0
```

**Production code: [`src/shared/booking-fee.ts#feeSubtotalFor`](../../src/shared/booking-fee.ts#L35)**

```ts
export const feeSubtotalFor = (intent: {
  items: ReadonlyArray<{ unitPrice: number; quantity: number }>;
  feeSubtotal?: number;
}): number => ...
```

Source fingerprint: `sha256:cbb2c3f9762f575d`

**Production code: [`src/shared/checkout-pricing.ts#priceCheckout`](../../src/shared/checkout-pricing.ts#L398)**

```ts
export const priceCheckout = (intent: CheckoutIntent): PricedOrder => { ... }
```

Source fingerprint: `sha256:b01b4ef75de422bc`

**Production code: [`src/shared/checkout-pricing.ts#ticketPaymentBreakdown`](../../src/shared/checkout-pricing.ts#L455)**

```ts
export const ticketPaymentBreakdown = (
  intent: CheckoutIntent,
): TicketPaymentBreakdown => { ... }
```

Source fingerprint: `sha256:e12793953acf928a`

### Step 5: The joined safety claim

Safety joins the value domains, the pass boundary and the kept verdict. Next permits one pass, the final check or no change. The compounding control makes the second discount read the reduced price. The stale fee control makes the fee read the list price. Safety refuses both, so the checker must find a counterexample.

| Value | This step |
| --- | --- |
| `compounding control` | The second pass records scopedSubtotal 1800 against origSubtotal 2000. The checker rejects the data. |
| `stale fee control` | feeSubtotal 2000 against subtotal 1700. The checker rejects the data. |
| `failed verdict` | A FALSE allFactsSafe value never returns to TRUE. |

**Model rule: [`Safety`](../../verification/CheckoutComposition.tla#L160)**

```tla
Safety ==
  /\ TypeOK
  /\ CurrentOrderHolds
  /\ allFactsSafe
```

**Model rule: [`Next`](../../verification/CheckoutComposition.tla#L208)**

```tla
Next ==
  PassStep \/ FeeStep \/
  UNCHANGED <<current, passIndex, feeApplied, allFactsSafe>>
```

**Production code: [`scripts/verify-models/composition-corruptions.ts#compoundingDiscountData`](../../scripts/verify-models/composition-corruptions.ts#L109)**

```ts
export const compoundingDiscountData: ModelDataSource =
  corruptDataFor("compounding");
```

Source fingerprint: `sha256:b99bcf9f310eb275`

**Production code: [`scripts/verify-models/composition-corruptions.ts#staleFeeData`](../../scripts/verify-models/composition-corruptions.ts#L118)**

```ts
export const staleFeeData: ModelDataSource = corruptDataFor("stale fee");
```

Source fingerprint: `sha256:c19b1f9ab30bf24d`

## The safety claim

Every accepted pass keeps the original scoped price, removes at most the current scoped price, and never takes a unit below zero. The final check ties the subtotal, the total, the deposit balance and the fee basis together.

The model checks two things:

- The first state satisfies the claim.
- Every allowed step from a state that satisfies the claim keeps it.

Together, these checks cover every finite run of the model.

## What this model does not prove

- ComposedChange expands at most six pass effects. A wider order loses later effects from this sum.
- The model uses the production discount allocation and modifier delta. It does not check their arithmetic independently.
- Listing identity does not survive into the unit facts. The model does not prove per-listing scope or per-unit attribution.
- The scenarios do not cover every numeric input, tax correctness, provider charges, SQL writes or eventual progress.
- The fee basis is reconstructed from the fee subtotal and the application deltas. It detects inconsistent facts, not every stale production basis. These scenarios do not prove a nonzero fee.

## How to read the model text

| Symbol | Meaning |
| --- | --- |
| `==` | This line defines a rule. It does not assign a value. |
| `x'` | The value of `x` after the step. |
| `/\` | Both conditions must hold. |
| `\/` | One of the conditions must hold. |
| `\A` | Every supplied value must satisfy the rule. |
| `\E` | At least one supplied value must satisfy the rule. |
| `\in` | The value belongs to the set. |
| `=>` | If the left condition holds, the right condition must hold. |

Read [the model verification guide](../model-verification.md) for the
method and its limits.
