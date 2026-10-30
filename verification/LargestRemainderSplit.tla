---------------------------- MODULE LargestRemainderSplit ----------------------------
EXTENDS Integers, FiniteSets, LargestRemainderSplitData

\* The largest remainder split gives a whole amount to weighted parts in two
\* phases. Every part first takes its proportional floor. The award loop then
\* gives the leftover units, one each, to the parts the case's own guard still
\* allows. The facts carry each part's floor and cap and the guard's verdict;
\* the generator derives them from the raw weights, never from a stored
\* allocation.
\*
\* Two fact contracts back the induction, and the generator tests pin both:
\* the guard leaves room for every owed unit, and an eligible part of a capped
\* case has room under its cap for the one extra unit. The corrupted runs
\* prove the checker reacts when a contract breaks.

\* The widest case the facts may carry. A part index past this width breaks
\* TypeOK in the award step, so the clean check fails until the width grows.
MaxParts == 5

VARIABLES
  \* @type: Str;
  current,
  \* @type: Bool;
  capped,
  \* @type: Int;
  leftover,
  \* @type: Int;
  remaining,
  \* @type: Set(Int);
  bumped,
  \* @type: Bool;
  stranded

CaseTags == {caseFact.caseTag : caseFact \in SplitCases}

PartsOf(tag) == {partFact \in SplitParts : partFact.caseTag = tag}

TypeOK ==
  /\ current \in CaseTags
  /\ capped \in BOOLEAN
  /\ leftover \in Int
  /\ remaining \in Int
  /\ bumped \in SUBSET (1..MaxParts)
  /\ stranded \in BOOLEAN

\* Every awarded unit stays accounted: what the loop still owes plus what it
\* has awarded is the case's leftover. When the loop finishes, the parts hold
\* the whole amount.
UnitsStayAccounted == remaining + Cardinality(bumped) = leftover

\* A capped case never awards a part past its cap. An uncapped case bounds
\* the award by the guard's own verdicts.
AwardStaysWithinCap ==
  \A partFact \in PartsOf(current) :
    partFact.partIndex \in bumped =>
      ~capped \/ partFact.floor + 1 <= partFact.cap

\* The state's case facts agree with the case's own record.
CurrentCaseFactsHold ==
  \E caseFact \in SplitCases :
    /\ caseFact.caseTag = current
    /\ capped = caseFact.capped
    /\ leftover = caseFact.leftover

Safety ==
  /\ TypeOK
  /\ CurrentCaseFactsHold
  /\ UnitsStayAccounted
  /\ AwardStaysWithinCap
  /\ ~stranded

Init ==
  \E caseFact \in SplitCases :
    /\ current' = caseFact.caseTag
    /\ capped' = caseFact.capped
    /\ leftover' = caseFact.leftover
    /\ remaining' = caseFact.leftover
    /\ bumped' = {}
    /\ stranded' = FALSE

\* One award. The order is the model's free choice, so the invariants hold
\* for every order the loop can pick.
AwardStep ==
  \E partFact \in SplitParts :
    /\ partFact.caseTag = current
    /\ partFact.eligible
    /\ partFact.partIndex \notin bumped
    /\ remaining >= 1
    /\ bumped' = bumped \cup {partFact.partIndex}
    /\ remaining' = remaining - 1
    /\ UNCHANGED <<current, capped, leftover, stranded>>

\* The loop owes a unit that no eligible part can receive. With honest facts
\* this step is unreachable, so a clean check proves the loop always finishes.
StrandStep ==
  /\ remaining >= 1
  /\ \A partFact \in PartsOf(current) :
       partFact.eligible => partFact.partIndex \in bumped
  /\ stranded' = TRUE
  /\ UNCHANGED <<current, capped, leftover, remaining, bumped>>

Next ==
  AwardStep \/ StrandStep \/
  UNCHANGED <<current, capped, leftover, remaining, bumped, stranded>>

InductionStart == Safety
=============================================================================
