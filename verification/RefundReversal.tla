---------------------------- MODULE RefundReversal ----------------------------
EXTENDS Integers, ModelRules, RefundReversalData

\* One attendee's returned provider refund planned against the ledger. The
\* plan groups the attendee's legs into account refund groups (bookings merged
\* with their tax assessments) and decides which groups reverse and where each
\* returned reference lands. Every fact comes from the production plan and
\* ledger functions, so a reversal rule or a leg-inverse check that slips there
\* makes the checker reject the derived facts.
VARIABLES
  \* @type: Bool;
  allPlansSafe,
  \* @type: Bool;
  legsSafe,
  \* @type: Bool;
  refsSafe

TypeOK ==
  /\ allPlansSafe \in BOOLEAN
  /\ legsSafe \in BOOLEAN
  /\ refsSafe \in BOOLEAN

\* A group reverses only when the production eligibility holds: it carries
\* provider cash, no operator money, and it is payment-only or settled. Each
\* reversal fact carries its group's facts, so the checker can read them
\* without a lookup.
\* @type: ($reversalFactsFact) => Bool;
CanReverse(fact) ==
  /\ fact.hasProviderPayment
  /\ ~fact.hasOperatorMoney
  /\ (fact.paymentOnly \/ fact.settled)

\* One group's decision from a production plan. A group the ledger already
\* records never reverses again, so a second identical refund records nothing
\* and never credits twice.
\* @type: ($reversalFactsFact) => Bool;
SafeReversal(fact) ==
  /\ ~(fact.alreadyRecorded /\ fact.reverses)
  /\ fact.reverses => CanReverse(fact)

Safety ==
  /\ TypeOK
  /\ allPlansSafe
  /\ legsSafe
  /\ refsSafe

Init ==
  /\ allPlansSafe = TRUE
  /\ legsSafe = TRUE
  /\ refsSafe = TRUE

\* One group's reversal decision from a production plan.
PlanStep ==
  \E fact \in ReversalFacts :
    /\ allPlansSafe' = ChecksStillPass(allPlansSafe, SafeReversal(fact))
    /\ legsSafe' = legsSafe
    /\ refsSafe' = refsSafe

\* One posted refund leg. Every posted leg must be the exact inverse of a
\* recorded original leg.
LegStep ==
  \E leg \in LegFacts :
    /\ allPlansSafe' = allPlansSafe
    /\ legsSafe' = ChecksStillPass(legsSafe, leg.exactInverse)
    /\ refsSafe' = refsSafe

\* One returned reference. Every reference lands in exactly one outcome:
\* recorded, review, or unrecorded.
RefStep ==
  \E ref \in ReferenceFacts :
    /\ allPlansSafe' = allPlansSafe
    /\ legsSafe' = legsSafe
    /\ refsSafe' =
         ChecksStillPass(refsSafe, ref.outcome \in ReferenceOutcomes)

Next == PlanStep \/ LegStep \/ RefStep \/
  UNCHANGED <<allPlansSafe, legsSafe, refsSafe>>

\* Unrestricted induction: every safe abstract state, not a bounded path prefix.
InductionStart == Safety
=============================================================================
