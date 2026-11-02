---------------------------- MODULE LargestRemainderSplit ----------------------------
\* This module describes whole-unit allocation after the first rounded shares.
\* EXTENDS imports integer arithmetic, finite-set helpers, and example facts.
EXTENDS Integers, FiniteSets, LargestRemainderSplitData

\* An allocation divides one amount between parts. A part is one recipient,
\* such as one ticket unit or one tax line. A weight is its share of the basis.
\* For weights 1 and 2, the second part has twice the first part's share.
\* A minor currency unit is the smallest whole money unit, such as one penny.
\* A deposit is the amount paid now when the customer owes the rest later.
\*
\* Fractions cannot become half a penny or half a reserved place.
\* Each part first receives its proportional share rounded down, called its floor.
\* The amount left after those floors must still go to eligible parts.
\* Eligible means the caller's rule permits one extra unit for that part.
\* A cap is its maximum permitted allocation, such as its full ticket price.
\* For example, split 100 pennies into three equal parts. The floors total 99.
\* One part receives the last penny, so the total remains 100, not 99 or 101.
\* bumped remembers that recipient. A part receives at most one extra unit.
\* The model starts with the floors already supplied, not with raw money input.
\*
\* scripts/verify-models/largest-remainder-split.ts generates
\* LargestRemainderSplitData from selected splitCases.
\* SplitCases holds the leftover count and whether price caps apply.
\* SplitParts holds each part's floor, cap, and eligibility verdict.
\* floorShares reconstructs floors from weights with JavaScript arithmetic.
\* These are derived facts, not observed results of the production allocator.
\*
\* The production allocator is largestRemainderAllocation in
\* src/shared/largest-remainder.ts. It sorts by remainder and tie-break value.
\* This model allows any eligible award order. It checks unit conservation
\* and caps, not that production chooses the correct recipients or order.
\* The facts must supply enough eligible parts and correct floors.
\* Direct tests must check those facts and production arithmetic separately.
\* Fractional amounts remain outside this integer model.
\* Selected large values do not establish arithmetic correctness for all inputs.

\* The largest supported number of parts per case, not an amount of money.
\* An award to a part past this bound violates TypeOK.
MaxParts == 6

VARIABLES
  \* The identity of the selected allocation case, not a production row id.
  \* @type: Str;
  current,
  \* Whether this case requires a per-part price cap.
  \* @type: Bool;
  capped,
  \* The original number of whole units left after the floors.
  \* A unit can be a minor currency unit or one reserved place.
  \* @type: Int;
  leftover,
  \* The units still owed after the model's awards.
  \* @type: Int;
  remaining,
  \* One-based indexes of parts that received one extra unit.
  \* @type: Set(Int);
  bumped,
  \* A model-only fault flag: units remain but no eligible part can receive one.
  \* @type: Bool;
  stranded

\* Collect the case identities from the generated records.
\* A case tag is a label for one prepared example, not a real order identity.
\* A fact is an example record that the TypeScript producer supplies to TLA.
\* \in means "is a member of". The braces construct a set.
CaseTags == {caseFact.caseTag : caseFact \in SplitCases}

\* Keep only part records for this case. Identity prevents cross-case awards.
PartsOf(tag) == {partFact \in SplitParts : partFact.caseTag = tag}

\* Restrict value shapes. SUBSET permits any set of supported part indexes.
\* Name == expression defines a condition or value. It is not an assignment.
\* These conditions alone do not establish conservation or valid caps.
TypeOK ==
  /\ current \in CaseTags
  /\ capped \in BOOLEAN
  /\ leftover \in Int
  /\ remaining \in Int
  /\ bumped \in SUBSET (1..MaxParts)
  /\ stranded \in BOOLEAN

\* Outstanding units plus awards must equal the original leftover count.
\* Cardinality counts the distinct awarded parts, each of which gets one unit.
\* This law uses the supplied leftover count. It does not validate the floors.
UnitsStayAccounted ==
  /\ remaining >= 0
  /\ remaining + Cardinality(bumped) = leftover

\* Every awarded part in a capped case must stay at or below its cap.
\* \A checks every part. => applies the rule only to an awarded part.
\* ~capped exempts uncapped cases. Eligibility comes from AwardStep's guard.
AwardStaysWithinCap ==
  \A partFact \in PartsOf(current) :
    partFact.partIndex \in bumped =>
      ~capped \/ partFact.floor + 1 <= partFact.cap

\* The selected case must exist, and its cap flag and leftover count must match.
\* This stops induction from a state with invented case facts.
CurrentCaseFactsHold ==
  \E caseFact \in SplitCases :
    /\ caseFact.caseTag = current
    /\ capped = caseFact.capped
    /\ leftover = caseFact.leftover

\* Safety names the conditions that must all stay true, including no stranded unit.
\* /\ means "and". The checker first tests Init, then a Next step from every
\* state that satisfies Safety. Both checks cover any finite sequence of these
\* abstract steps. They do not run the production allocator or validate its floors.
Safety ==
  /\ TypeOK
  /\ CurrentCaseFactsHold
  /\ UnitsStayAccounted
  /\ AwardStaysWithinCap
  /\ ~stranded

\* Start after the floor shares, before any extra unit award.
\* \E lets the checker select any supplied case.
\* Primes describe the initial output values in this initialisation action.
Init ==
  \E caseFact \in SplitCases :
    /\ current' = caseFact.caseTag
    /\ capped' = caseFact.capped
    /\ leftover' = caseFact.leftover
    /\ remaining' = caseFact.leftover
    /\ bumped' = {}
    /\ stranded' = FALSE

\* Award one unit only to an eligible part that has not received an extra unit.
\* A prime marks a value after the step. UNCHANGED preserves the other values.
\* The checker considers all eligible choices, not the production sort order.
AwardStep ==
  \E partFact \in SplitParts :
    /\ partFact.caseTag = current
    /\ partFact.eligible
    /\ partFact.partIndex \notin bumped
    /\ remaining >= 1
    /\ bumped' = bumped \cup {partFact.partIndex}
    /\ remaining' = remaining - 1
    /\ UNCHANGED <<current, capped, leftover, stranded>>

\* Expose a fault when units remain but every eligible part already has an award.
\* The safety check must reject a step that sets stranded to TRUE.
\* Exclusion of this fault does not prove eventual completion.
StrandStep ==
  /\ remaining >= 1
  /\ \A partFact \in PartsOf(current) :
       partFact.eligible => partFact.partIndex \in bumped
  /\ stranded' = TRUE
  /\ UNCHANGED <<current, capped, leftover, remaining, bumped>>

\* \/ permits any enabled award, fault step, or step with no change.
\* No fairness condition forces awards. A run can remain unchanged forever.
Next ==
  AwardStep \/ StrandStep \/
  UNCHANGED <<current, capped, leftover, remaining, bumped, stranded>>

=============================================================================
