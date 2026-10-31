---------------------------- MODULE CheckoutComposition ----------------------------
EXTENDS Integers, ModelRules, CheckoutCompositionData

\* One order's checkout composition: work units per ticket, a sequence of
\* modifier passes (each adds an extra line, reduces per-unit amounts, or
\* changes nothing), then the booking fee and the breakdown. The machine
\* walks one order's passes in order, and the fee step recomposes the
\* order's price from its passes: the gross list total plus the add-on
\* charges and minus the removed discounts. The fee step then checks the
\* order's final facts against that composed price. Every pass fact and
\* every order fact comes from the production pricing functions, so a slip
\* in the composition rules makes the checker reject the derived facts. The
\* largest-remainder split itself stays with LargestRemainderSplit.tla;
\* this model consumes its exactness as the discount facts.

\* The widest pass count the facts may carry. A pass index past this width
\* contributes nothing to the composed price, so a wider order breaks the
\* subtotal check until the width grows.
MaxPasses == 6

VARIABLES
  \* @type: Str;
  current,
  \* @type: Int;
  passIndex,
  \* @type: Bool;
  feeApplied,
  \* @type: Bool;
  allFactsSafe

OrderTags == {orderFact.orderTag : orderFact \in Orders}

TypeOK ==
  /\ current \in OrderTags
  /\ passIndex \in Int
  /\ feeApplied \in BOOLEAN
  /\ allFactsSafe \in BOOLEAN

\* The machine stays inside one order's composition: the modifier passes and
\* then the fee step.
CurrentOrderHolds ==
  \E orderFact \in Orders :
    /\ orderFact.orderTag = current
    /\ passIndex >= 1
    /\ passIndex <= orderFact.numPasses + 1
    /\ feeApplied => passIndex = orderFact.numPasses + 1

\* The net price change of one pass: the add charge minus the removed
\* discount. The generator test pins one pass row per index of every order.
\* @type: (Str, Int) => Int;
PassChange(tag, index) ==
  LET passFact == CHOOSE pf \in Passes :
        pf.orderTag = tag /\ pf.passIndex = index
  IN passFact.added - passFact.removed

\* The net change every pass of an order makes to its gross total.
\* @type: (Str, Int) => Int;
ComposedChange(tag, numPasses) ==
  (IF 1 <= numPasses THEN PassChange(tag, 1) ELSE 0)
    + (IF 2 <= numPasses THEN PassChange(tag, 2) ELSE 0)
    + (IF 3 <= numPasses THEN PassChange(tag, 3) ELSE 0)
    + (IF 4 <= numPasses THEN PassChange(tag, 4) ELSE 0)
    + (IF 5 <= numPasses THEN PassChange(tag, 5) ELSE 0)
    + (IF 6 <= numPasses THEN PassChange(tag, 6) ELSE 0)

\* One modifier pass is safe when it reads the pre-modifier base, its
\* discount removes exactly the clamped amount, and no unit drops below
\* zero.
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

\* One order's final facts are safe when they match the composition of its
\* passes. The subtotal equals the gross list total plus the add-on charges
\* and minus the removed discounts. The upfront charge plus the owed
\* balance equals that subtotal. The total equals the line charges plus the
\* extra charges. The fee runs once, on the final modified subtotal. The
\* reservation balance never goes below zero.
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

Safety ==
  /\ TypeOK
  /\ CurrentOrderHolds
  /\ allFactsSafe

Init ==
  \E orderFact \in Orders :
    /\ current' = orderFact.orderTag
    /\ passIndex' = 1
    /\ feeApplied' = FALSE
    /\ allFactsSafe' = TRUE

\* One modifier pass of the current order. The pass's own facts decide
\* whether the safety ledger stays green.
PassStep ==
  \E passFact \in Passes :
    /\ passFact.orderTag = current
    /\ passFact.passIndex = passIndex
    /\ current' = current
    /\ passIndex' = passIndex + 1
    /\ feeApplied' = feeApplied
    /\ allFactsSafe' = ChecksStillPass(allFactsSafe, SafePass(passFact))

\* The booking fee step, after every pass. The order's own facts decide
\* whether the safety ledger stays green.
FeeStep ==
  \E orderFact \in Orders :
    /\ orderFact.orderTag = current
    /\ passIndex = orderFact.numPasses + 1
    /\ ~feeApplied
    /\ current' = current
    /\ passIndex' = passIndex
    /\ feeApplied' = TRUE
    /\ allFactsSafe' = ChecksStillPass(allFactsSafe, SafeOrder(orderFact))

Next ==
  PassStep \/ FeeStep \/
  UNCHANGED <<current, passIndex, feeApplied, allFactsSafe>>

InductionStart == Safety
=============================================================================
