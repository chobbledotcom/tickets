------------------------- MODULE BookingReplay -------------------------
EXTENDS Integers, ModelRules, BookingReplayData

\* One payment session delivered more than once. The durable booking ledger
\* and the temporary processed_payments row record different facts, and they
\* can drift: the row is pruned by stale cleanup or deleted after retention,
\* while the ledger keeps the money record. The ledger is the replay
\* authority. Once it records the booking as honoured, no delivery books
\* again and no delivery requests a refund, no matter what happened to the
\* temporary row.
VARIABLES
  \* @type: Str;
  ledger,
  \* @type: Str;
  row,
  \* @type: Int;
  bookings,
  \* @type: Bool;
  noRefundAfterHonoured

TypeOK ==
  /\ ledger \in LedgerStates
  /\ row \in RowStates
  /\ bookings \in 0..1
  /\ noRefundAfterHonoured \in BOOLEAN

\* A delivery asks for a new refund against an honoured booking.
\* @type: ($deliveryFactsFact) => Bool;
RefundsWhenHonoured(fact) == fact.ledgerBefore = "booked" /\ fact.refunds

\* The ledger turns booked exactly when a booking is created. The coupling
\* keeps the invariant inductive: a state never holds a booking count that
\* its ledger does not explain, so a delivery cannot book again against a
\* count the ledger forgot.
LedgerMatchesBookings ==
  (bookings >= 1) = (ledger = "booked")

Safety ==
  /\ TypeOK
  /\ noRefundAfterHonoured
  /\ LedgerMatchesBookings

Init ==
  /\ ledger = "unrecorded"
  /\ row = "none"
  /\ bookings = 0
  /\ noRefundAfterHonoured = TRUE

\* One delivery settles one (ledger, row) pair. The outcome comes from the
\* reservation, outcome and ledger replay code that generated the facts. A
\* delivery that books twice or refunds an honoured ledger raises the
\* bookings counter past one or latches the refund flag off, and the check
\* then fails at the next state.
DeliveryStep ==
  \E fact \in DeliveryFacts :
    /\ fact.ledgerBefore = ledger
    /\ fact.rowBefore = row
    /\ ledger' = fact.ledgerAfter
    /\ row' = fact.rowAfter
    /\ bookings' = bookings + IF fact.books THEN 1 ELSE 0
    /\ noRefundAfterHonoured' =
         ChecksStillPass(noRefundAfterHonoured, ~RefundsWhenHonoured(fact))

\* Stale reservation cleanup removes an abandoned in-flight reservation. It
\* only prunes an unresolved row; a finalized row is never stale work.
StaleCleanup ==
  /\ row = "reserved"
  /\ row' = "none"
  /\ UNCHANGED <<ledger, bookings, noRefundAfterHonoured>>

\* Later deletion of a temporary tracking row (retention or an operator)
\* removes a completed booking's row. The durable ledger keeps the replay
\* protection, so a later delivery still replays the honoured booking.
DeleteRow ==
  /\ row = "finalized"
  /\ row' = "none"
  /\ UNCHANGED <<ledger, bookings, noRefundAfterHonoured>>

Next ==
  DeliveryStep \/ StaleCleanup \/ DeleteRow \/
  UNCHANGED <<ledger, row, bookings, noRefundAfterHonoured>>

InductionStart == Safety
=============================================================================
