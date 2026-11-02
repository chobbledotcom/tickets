------------------------- MODULE SharedGroupCapacity -------------------------
EXTENDS Integers, SharedGroupCapacityData

\* A listing is an item that a customer can book, such as an event or a
\* session on a chosen date. A session is one occurrence of an activity.
\* A place is one unit of bookable capacity. An attendee is a
\* customer record. A row is one stored line that links a customer to a
\* listing and records a quantity. One row can reserve several places.
\* Counts here measure places, not customer records or database rows.
\* A group collects listings under a common capacity limit, such as a shared
\* room. Shared means both listings belong to that group. A parent is the
\* main listing. Its required child is another listing that the buyer must
\* book with it. Parent and child describe a product relation, not an adult
\* and a child. One pair reserves one place on each listing, so it uses two
\* places from every group they share.
\* A static cap is the group's total limit independent of date. Remaining
\* capacity is its free-place count in the caller's date context. A daily
\* listing can need a date before this free count exists. No date value or
\* calendar calculation appears here. dateLess means an absent result, not
\* a particular date. With several shared groups, the smallest known value
\* is the limit. A tighter group that only one listing uses is not shared.
\*
\* MODULE names this specification. EXTENDS imports integer rules and the
\* generated Data facts. Each fact records pure function results for one
\* finite example, not a database event. == defines an expression, not an
\* assignment. A condition describes current state. An action relates that
\* state to next values marked with a prime. The checker explores choices
\* allowed by the expressions, not an executable sales workflow.
\* A parent ticket and its required child each use one shared group place.
\* For example, three free places admit one pair, not two pairs. A static
\* group cap of one must refuse a pair even before a buyer selects a date.
\* scripts/verify-models/shared-group-capacity.ts supplies GroupFacts through
\* factFor. It calls sharedGroupRemaining and sharedGroupCapacity from
\* src/shared/group-capacity.ts, then parentAndChildFitGroup and
\* ticketsThatFitInPool from src/shared/booking/model.ts.
\* The finite cases cover no group, several shared groups, tighter unshared
\* groups, absent caps, absent date totals, and free-place bounds zero to five.
\* These are pure function outputs over supplied maps, not database reads.
\* dateLess means no shared remaining value exists. It also covers no pool.
\* It does not by itself assert that a real daily slot lacks a date.
\* The model has one parent and one child, not a whole child-choice search.
\* It does not prove group map completeness, SQL writes, or concurrent sales.

\* All variables are abstract sale-loop state, not storage columns.
VARIABLES
  \* Free places in the shared pool. Zero is a dummy when dateLess is TRUE,
  \* not evidence that a real pool is full.
  \* @type: Int;
  remaining,
  \* Total shared group limit in places. Zero is a dummy if hasStaticCap
  \* is FALSE. A present zero cap really does permit no places.
  \* @type: Int;
  staticCap,
  \* TRUE means there is no shared free-place result, also if no pool exists.
  \* @type: Bool;
  dateLess,
  \* TRUE means the shared static limit exists, even when that limit is zero.
  \* @type: Bool;
  hasStaticCap,
  \* Whole parent/child pairs sold by this abstract loop. One pair uses two
  \* group places. This is not money, people or a count of stored rows.
  \* @type: Int;
  sold

\* The producer derives these finite bounds from its facts. \in means set
\* membership. 0..MaxSold contains whole pair counts, not person counts.
TypeOK ==
  /\ remaining \in 0..MaxRemaining
  /\ staticCap \in 0..MaxStaticCap
  /\ dateLess \in BOOLEAN
  /\ hasStaticCap \in BOOLEAN
  /\ sold \in 0..MaxSold

\* \A means every supplied fact. Each known pool's reported whole-pair count
\* must consume at most its free places. The loop must retain a non-negative
\* balance. This does not assert that the reported count is the largest fit.
NoOverfill ==
  /\ (\A fact \in GroupFacts :
        ~fact.dateLess =>
          fact.fits * PARENT_CHILD_GROUP_UNITS <= fact.remaining)
  /\ (~dateLess => remaining >= 0)

\* With no remaining value, the static cap alone can rule out a pair. A cap
\* below PARENT_CHILD_GROUP_UNITS must make allowed false and sold stay zero.
\* A missing static cap is not a cap of zero. hasStaticCap distinguishes it.
NoDateLessSoldOutPair ==
  /\ (\A fact \in GroupFacts :
        fact.dateLess /\ fact.hasStaticCap =>
          (fact.allowed => fact.staticCap >= PARENT_CHILD_GROUP_UNITS))
  /\ (dateLess /\ hasStaticCap /\ staticCap < PARENT_CHILD_GROUP_UNITS =>
        sold = 0)

\* Safety is the condition that must remain true in all allowed states.
\* The initial check asks whether Init implies Safety. The inductive check
\* asks whether any Safety state followed by one Next step still satisfies
\* Safety. This includes states not reached from Init and proves these laws
\* for the supplied facts, not every production map.
Safety ==
  /\ TypeOK
  /\ NoOverfill
  /\ NoDateLessSoldOutPair

\* Init defines each permitted start. \E means at least one fact matches.
\* The checker selects any fact, copies its context and starts with no sales.
\* This checks every supplied scenario, not just one example. Numeric group
\* IDs in the producer distinguish membership examples, not real rooms.
\* Facts omit those IDs because only their capacity results matter here.
Init ==
  \E fact \in GroupFacts :
    /\ remaining = fact.remaining
    /\ staticCap = fact.staticCap
    /\ dateLess = fact.dateLess
    /\ hasStaticCap = fact.hasStaticCap
    /\ sold = 0

\* One sale must match the initial pool: current free places plus places
\* already sold equal fact.remaining. The context flags and cap must match.
\* The allow gate, two-place balance and whole-pair ceiling must all pass.
\* Otherwise this action refuses the sale. A prime denotes the next value.
\* The step consumes two places, adds one pair and preserves the context.
\* dateLess facts have dummy remaining zero and fits zero, so this loop sells
\* no date-less pair. Their useful check is the static-cap law above.
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

\* Next defines the permitted changes. UNCHANGED permits no value change.
\* No rule requires an eventual sale. Safety does not prove that stock sells
\* out or that a buyer completes an order.
Next ==
  SellStep \/ UNCHANGED <<remaining, staticCap, dateLess, hasStaticCap, sold>>

=============================================================================
