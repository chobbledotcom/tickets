---------------------------- MODULE RefundReversal ----------------------------
EXTENDS FiniteSets, ModelRules, RefundReversalData

\* One attendee's returned provider refund planned against the ledger. The
\* ledger starts with the booking legs. The first plan reverses the groups
\* the eligibility admits and posts their refund legs. The replay plan runs
\* over the grown ledger and must reverse nothing the ledger records. Every
\* fact comes from the production plan and ledger functions, so a reversal
\* rule or a leg-inverse check that slips there makes the checker reject the
\* derived facts.
\* Scope: this model states the per-group rule only. Production's
\* whole-account return can reverse a group that fails the per-group rule.
\* This model does not prove provider refund truth or SQL atomicity.
VARIABLES
  \* @type: Str;
  round,
  \* @type: Set(Str);
  recorded,
  \* @type: Bool;
  allPlansSafe,
  \* @type: Bool;
  legsSafe

TypeOK ==
  /\ round \in RoundNames
  /\ recorded \in SUBSET GroupLabels
  /\ allPlansSafe \in BOOLEAN
  /\ legsSafe \in BOOLEAN

\* A group reverses only when the production eligibility holds: it carries
\* provider cash, no operator money, and it is payment-only or settled. Each
\* reversal fact carries its group's facts, so the checker can read them
\* without a lookup.
\* @type: ($reversalFactsFact) => Bool;
CanReverse(fact) ==
  /\ fact.hasProviderPayment
  /\ ~fact.hasOperatorMoney
  /\ (fact.paymentOnly \/ fact.settled)

\* One group's reversal decision from a production plan. The recorded set,
\* not a fact field, says which groups the ledger already records, so a
\* second identical refund cannot reverse again.
\* @type: ($reversalFactsFact) => Bool;
SafeReversal(fact) ==
  /\ ~((fact.group \in recorded) /\ fact.reverses)
  /\ fact.reverses => CanReverse(fact)

\* Every posted refund leg is the exact inverse of a recorded original leg
\* and names the original it inverts.
\* @type: ($legFactsFact) => Bool;
SafeLeg(leg) == leg.exactInverse /\ leg.original \in OriginalLegs

\* Every plan evaluation lands each returned reference in exactly one of the
\* three production outcomes.
ReferencePartition ==
  /\ \A fact \in ReferenceFacts : fact.outcome \in ReferenceOutcomes
  /\ \A expected \in ExpectedReferences :
       Cardinality({fact \in ReferenceFacts :
         fact.round = expected.round /\ fact.reference = expected.reference}) = 1

Safety ==
  /\ TypeOK
  /\ allPlansSafe
  /\ legsSafe
  /\ ReferencePartition

Init ==
  /\ round = "first"
  /\ recorded = {}
  /\ allPlansSafe = TRUE
  /\ legsSafe = TRUE

\* One plan round: every fact of the round passes its check, and a failing
\* check latches its family's flag down. The first plan records the groups it
\* reverses and hands the ledger to the replay; the replay changes nothing
\* the ledger records.
PlanRound(r) ==
  /\ allPlansSafe' = ChecksStillPass(allPlansSafe,
       \A fact \in ReversalFacts : fact.round = r => SafeReversal(fact))
  /\ legsSafe' = ChecksStillPass(legsSafe,
       \A leg \in LegFacts : leg.round = r => SafeLeg(leg))
  /\ IF r = "first"
     THEN
       /\ recorded' = {reversal.group :
           reversal \in {fact \in ReversalFacts :
             fact.round = r /\ fact.reverses}}
       /\ round' = "replay"
     ELSE
       UNCHANGED <<round, recorded>>

\* The first plan runs over the fixture ledger. The guard keeps the plan
\* ahead of the ledger: nothing is recorded before it runs, so a reversal
\* fact never meets a recorded set it did not fill.
FirstPlan ==
  /\ round = "first"
  /\ recorded = {}
  /\ PlanRound("first")

\* The replay plan runs over the ledger the first plan's refunds joined. A
\* group the first plan recorded must not reverse again, and its legs must
\* still pair with a recorded original.
ReplayPlan ==
  /\ round = "replay"
  /\ PlanRound("replay")

Next == FirstPlan \/ ReplayPlan \/
  UNCHANGED <<round, recorded, allPlansSafe, legsSafe>>

\* Unrestricted induction: every safe abstract state, not a bounded path prefix.
InductionStart == Safety
=============================================================================
