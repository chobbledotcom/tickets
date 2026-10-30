------------------------- MODULE LargestRemainderSplit -------------------------
EXTENDS Integers, ModelRules, LargestRemainderSplitData

\* The largest remainder split allocates a whole amount across weighted parts.
\* The parts sum exactly to the amount, every part takes its floor share or one
\* minor unit more, no part goes below zero, and a cap guards every part it
\* applies to. The production largestRemainderAllocation function supplies every
\* generated fact; the model proves the four invariants over those facts.
VARIABLES
  \* @type: Bool;
  allAllocationsExact

TypeOK == allAllocationsExact \in BOOLEAN

\* @type: ($splitFactsFact) => Bool;
AllocationIsExact(fact) ==
  /\ fact.conserved
  /\ fact.bounded
  /\ fact.nonNegative
  /\ fact.capped

Safety == TypeOK /\ allAllocationsExact

Init ==
  /\ allAllocationsExact =
       (\A fact \in SplitFacts : AllocationIsExact(fact))

\* A split settles one fact. The latch only ever turns off, so one unsafe fact
\* fails the model for any run length.
\* @type: ($splitFactsFact) => Bool;
ConsiderFact(fact) ==
  ChecksStillPass(allAllocationsExact, AllocationIsExact(fact))

SplitStep ==
  \E fact \in SplitFacts :
    allAllocationsExact' = ConsiderFact(fact)

Next == SplitStep \/ UNCHANGED <<allAllocationsExact>>

\* Unrestricted induction: every safe abstract state, not a bounded path prefix.
InductionStart == Safety
=============================================================================
