------------------------- MODULE SharedGroupCapacity -------------------------
EXTENDS Integers, SharedGroupCapacityData

\* A parent and its one required child share capped groups. One parent+child
\* order takes PARENT_CHILD_GROUP_UNITS spots in every capped group they both
\* belong to. The model sells orders one at a time into one shared group, and
\* the production capacity functions supply every decision as a fact: the
\* shared remaining spots, the shared static cap, whether the pair fits at
\* all, and how many whole orders the pool holds.
VARIABLES
  \* @type: Int;
  remaining,
  \* @type: Int;
  staticCap,
  \* @type: Bool;
  dateLess,
  \* @type: Bool;
  hasStaticCap,
  \* @type: Int;
  sold

TypeOK ==
  /\ remaining \in 0..MaxRemaining
  /\ staticCap \in 0..MaxStaticCap
  /\ dateLess \in BOOLEAN
  /\ hasStaticCap \in BOOLEAN
  /\ sold \in 0..MaxSold

\* No parent+child order overfills the shared group. The whole orders the
\* production fit function reports consume at most the remaining spots, and
\* the sell loop never lets a real pool drain below zero.
NoOverfill ==
  /\ (\A fact \in GroupFacts :
        ~fact.dateLess =>
          fact.fits * PARENT_CHILD_GROUP_UNITS <= fact.remaining)
  /\ (~dateLess => remaining >= 0)

\* A date-less surface reads no per-date remaining, so only the static cap
\* gates it. The production allow gate refuses a pair whose shared static cap
\* is below two spots, and the sell loop never places an order the gate
\* refuses.
NoDateLessSoldOutPair ==
  /\ (\A fact \in GroupFacts :
        fact.dateLess /\ fact.hasStaticCap =>
          (fact.allowed => fact.staticCap >= PARENT_CHILD_GROUP_UNITS))
  /\ (dateLess /\ hasStaticCap /\ staticCap < PARENT_CHILD_GROUP_UNITS =>
        sold = 0)

Safety ==
  /\ TypeOK
  /\ NoOverfill
  /\ NoDateLessSoldOutPair

Init ==
  \E fact \in GroupFacts :
    /\ remaining = fact.remaining
    /\ staticCap = fact.staticCap
    /\ dateLess = fact.dateLess
    /\ hasStaticCap = fact.hasStaticCap
    /\ sold = 0

\* A buyer places one parent+child order. The code allows it when the
\* production allow gate passes, the pool still holds the two spots the order
\* needs, and the sold count has not reached the production fit ceiling.
SellStep ==
  \E fact \in GroupFacts :
    /\ fact.dateLess = dateLess
    /\ fact.staticCap = staticCap
    /\ fact.hasStaticCap = hasStaticCap
    /\ fact.remaining = remaining + PARENT_CHILD_GROUP_UNITS * sold
    /\ fact.allowed
    /\ remaining >= PARENT_CHILD_GROUP_UNITS
    /\ sold < fact.fits
    /\ remaining' = remaining - PARENT_CHILD_GROUP_UNITS
    /\ sold' = sold + 1
    /\ UNCHANGED <<staticCap, dateLess, hasStaticCap>>

Next ==
  SellStep \/ UNCHANGED <<remaining, staticCap, dateLess, hasStaticCap, sold>>

InductionStart == Safety
=============================================================================
