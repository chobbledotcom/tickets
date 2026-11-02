---------------------------- MODULE CheckoutComposition ----------------------------
EXTENDS Integers, ModelRules, CheckoutCompositionData

\* This module defines a mathematical model. EXTENDS imports integer rules,
\* shared checks and generated facts. == defines a name, not an assignment.
\* Checkout prices the customer's selected tickets before a provider handles
\* payment. A listing is a ticket offer with a price. An order collects
\* selected listings, their quantities and extra charges.
\* A unit is one ticket within a quantity. A line combines units with the
\* same charge. A modifier is a price rule, such as a discount or an add-on.
\* A pass is one modifier's effect in the ordered list of modifiers.
\* Scope is the set of listings that the modifier covers. Fixed means a
\* currency amount. Percent means a share of the original scoped subtotal.
\* Multiply means a factor on that subtotal. The effect can add a charge,
\* reduce ticket prices or leave them unchanged, labelled add, reduce or zero.
\* A fee is a non-ticket extra charge for the order. A deposit is the part
\* paid now for a reservation. remainingBalance is the amount still owed.
\* All money facts use integer currency minor units. For GBP, 100 means one
\* pound. Quantities count tickets, pass indexes count modifier positions,
\* and feeCount counts fee lines, not pounds or percent.
\* For example, two tickets at 1000 give a 2000 subtotal. Two ten-percent
\* discounts each request 200 from that original base, not 200 then 180.
\* If the final ticket subtotal is 1600 and the deposit is 160, the ticket
\* balance is 1440. Extra lines are separate components of the charge now.

\* Check selected ticket orders across modifier passes and the final fee.
\* For example, two percent discounts must use the original scoped price,
\* not a price reduced by the first discount. An excessive discount must
\* leave a zero price, not a negative charge.
\* scripts/verify-models/checkout-composition.ts produces the three fact sets.
\* factsFor calls priceCheckout and ticketPaymentBreakdown in
\* src/shared/checkout-pricing.ts. applyPass reconstructs pass and unit facts.
\* It shares allocateDiscount with production, plus modifierDelta and
\* modifierCoversListing from src/shared/price-modifier.ts. These shared
\* calculations are assumed correct here, not independent arithmetic evidence.
\* Orders holds order totals. Passes holds modifier effects. Units holds
\* discount-unit prices. Money fields use integer currency minor units.
\* orderTag is a scenario identity, not a stored order id. passIndex preserves
\* modifier order. unitIndex preserves distinct units within a scoped pass.
\* Listing identity does not survive into Units, so totals do not prove
\* correct per-listing scope or per-unit attribution.
\* Scenarios cover selected fixed, percent, multiply, zero, scoped and
\* excessive modifiers, plus deposits. They do not cover all numeric inputs.
\* Separate allocator or tax models do not establish a composed checkout
\* proof without an explicit join of their amounts and identities.
\* Induction covers supplied facts and abstract steps, not all production
\* orders, provider charges, SQL writes, tax correctness or eventual progress.

\* ComposedChange expands at most six pass effects. Wider orders lose later
\* effects from this sum. This is a fixed model bound, not a checkout limit.
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

\* Collect scenario tags from Orders. Equal tags collapse as TLA set members.
\* The producer must supply distinct identities and complete fact joins.
OrderTags == {orderFact.orderTag : orderFact \in Orders}

\* TypeOK bounds the tag and value kinds. CurrentOrderHolds supplies the
\* tighter pass-index boundary needed by the abstract machine.
TypeOK ==
  /\ current \in OrderTags
  /\ passIndex \in Int
  /\ feeApplied \in BOOLEAN
  /\ allFactsSafe \in BOOLEAN

\* The current scenario must exist. Its next index stays between the first
\* pass and the position after the last pass. A final fee check requires that
\* latter position. \E means at least one order fact satisfies these rules.
CurrentOrderHolds ==
  \E orderFact \in Orders :
    /\ orderFact.orderTag = current
    /\ passIndex >= 1
    /\ passIndex <= orderFact.numPasses + 1
    /\ feeApplied => passIndex = orderFact.numPasses + 1

\* Read added charges minus removed discounts for one scenario/pass pair.
\* CHOOSE selects one row that matches. Complete, unique rows are producer
\* obligations, not checked here. A missing row is not a zero-effect pass.
\* @type: (Str, Int) => Int;
PassChange(tag, index) ==
  LET passFact == CHOOSE pf \in Passes :
        pf.orderTag = tag /\ pf.passIndex = index
  IN passFact.added - passFact.removed

\* Sum net effects at the six explicit positions that fall within numPasses.
\* @type: (Str, Int) => Int;
ComposedChange(tag, numPasses) ==
  (IF 1 <= numPasses THEN PassChange(tag, 1) ELSE 0)
    + (IF 2 <= numPasses THEN PassChange(tag, 2) ELSE 0)
    + (IF 3 <= numPasses THEN PassChange(tag, 3) ELSE 0)
    + (IF 4 <= numPasses THEN PassChange(tag, 4) ELSE 0)
    + (IF 5 <= numPasses THEN PassChange(tag, 5) ELSE 0)
    + (IF 6 <= numPasses THEN PassChange(tag, 6) ELSE 0)

\* Compare the observed application base with the reconstructed original
\* scoped subtotal. A reduce pass must remove exactly the requested amount,
\* capped at the current scoped price. Each supplied unit's reduced field is
\* its price after the discount, not the amount removed. It stays within
\* zero and its prior price. Add and zero passes must remove nothing.
\* These checks do not independently verify add amounts or unit coverage.
\* @type: ($passesFact) => Bool;
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

\* Recompose the final subtotal from list prices and pass effects.
\* The charge now plus the deposit balance must equal that subtotal. Charge
\* lines plus extras must equal the charge now. The balance stays non-negative.
\* feeCount permits zero or one fee line. It does not require a nonzero fee.
\* feeSubtotal is reconstructed from feeSubtotalFor in src/shared/booking-fee.ts
\* and application deltas, not an observed fee-calculation argument.
\* Its equality detects inconsistent facts, not every stale production basis.
\* These scenarios do not establish nonzero fee calculation coverage.
\* @type: ($ordersFact) => Bool;
SafeOrder(orderFact) ==
  /\ orderFact.subtotal =
       orderFact.baseLineTotal
       + ComposedChange(orderFact.orderTag, orderFact.numPasses)
  /\ orderFact.total + orderFact.remainingBalance = orderFact.subtotal
  /\ orderFact.total = orderFact.lineTotal + orderFact.extraTotal
  /\ orderFact.feeCount <= 1
  /\ orderFact.feeSubtotal = orderFact.subtotal
  /\ orderFact.remainingBalance >= 0

\* Safety combines value domains, a valid next-pass position and the kept
\* verdict. It is a condition on one abstract state, not a checkout action.
\* The proof checks its initial relation and preservation by each Next step
\* from any Safety state. That is induction over these abstract rules.
Safety ==
  /\ TypeOK
  /\ CurrentOrderHolds
  /\ allFactsSafe

\* Select any supplied order at its first pass with no final check or failure.
\* \E means at least one fact supplies the choice. These are checker choices,
\* not a workflow that executes checkout. The primes in this existing Init
\* relation denote next values, not ordinary unprimed start-state conditions.
\* An order with no modifiers starts at its final-check index.
Init ==
  \E orderFact \in Orders :
    /\ current' = orderFact.orderTag
    /\ passIndex' = 1
    /\ feeApplied' = FALSE
    /\ allFactsSafe' = TRUE

\* Select the fact for the current tag and next pass index. Unprimed names
\* denote current values. Primed names denote next values. /\ requires all
\* conditions. Advance one index and keep SafePass through ChecksStillPass.
\* All other state stays fixed. No fact means no pass step. Facts must stop
\* at numPasses because this action has no separate final-index condition
\* or condition that refuses a step after feeApplied.
PassStep ==
  \E passFact \in Passes :
    /\ passFact.orderTag = current
    /\ passFact.passIndex = passIndex
    /\ current' = current
    /\ passIndex' = passIndex + 1
    /\ feeApplied' = feeApplied
    /\ allFactsSafe' = ChecksStillPass(allFactsSafe, SafePass(passFact))

\* Only the position after all passes, with no prior final check, admits this
\* step. Retain SafeOrder and mark the check complete. Tag and index stay fixed.
\* This step checks existing facts. It does not call the production fee code.
FeeStep ==
  \E orderFact \in Orders :
    /\ orderFact.orderTag = current
    /\ passIndex = orderFact.numPasses + 1
    /\ ~feeApplied
    /\ current' = current
    /\ passIndex' = passIndex
    /\ feeApplied' = TRUE
    /\ allFactsSafe' = ChecksStillPass(allFactsSafe, SafeOrder(orderFact))

\* Next defines permitted actions. \/ offers a pass or a final check.
\* UNCHANGED also permits no change. No rule forces every pass or the final
\* check to occur, so eventual completion is not proved.
Next ==
  PassStep \/ FeeStep \/
  UNCHANGED <<current, passIndex, feeApplied, allFactsSafe>>

=============================================================================
