------------------------- MODULE BookingReplay -------------------------
EXTENDS Integers, ModelRules, BookingReplayData

\* This module names one mathematical model. EXTENDS imports integer rules,
\* shared checks and generated facts. A name followed by == defines a rule.
\* It does not assign a value as an application statement does.
\* A payment is money the customer pays through an external provider.
\* A session identifies one checkout attempt. A provider callback is a
\* message to the application about that attempt. Delivery means receipt of
\* that message. Replay means an answer from an earlier result, not a new sale.
\* A listing is a ticket offer. An attendee is the stored owner of a ticket.
\* The ledger is the durable account record of money and amounts owed.
\* A leg is one transfer entry between accounts. An event group connects
\* related legs to the same business event, such as this session's sale.
\* The temporary payment row remembers a reservation or its result. It is
\* separate from those durable money entries.

\* A provider can deliver the same paid session twice. For example, a late
\* callback can arrive after processed_payments loses its temporary row.
\* A second ticket or a refund of the live ticket is wrong.
\* scripts/verify-models/booking.ts builds BookingReplayData. It calls
\* classifyBookingLedger in src/shared/session-ledger.ts for three ledger
\* labels, then transcribes the delivery branches into DeliveryFacts.
\* The branches are replaySessionFromLedger, replaySuccess and
\* handleReservationConflict in src/features/api/payment-processing/index.ts.
\* These are not observed end-to-end callback results or SQL race results.
\* One implicit session identity stands for its ledger event group and row.
\* No amount or provider request identity appears in this abstraction.
\* The abstract proof checks Init against Safety, then checks that each Next
\* step from any state that satisfies Safety preserves Safety. This is
\* induction. It does not prove all production inputs, durable atomicity or
\* eventual completion.
 
\* One unnamed session represents all deliveries here. The small label table
\* separates absent money records, a live ticket and records with no owner.
\* It is not a list of every provider payload or every possible database row.
VARIABLES
  \* Durable session state. unrecorded means no legs. booked means legs with
  \* a live attendee owner. orphaned means legs with no live attendee owner.
  \* @type: Str;
  ledger,
  \* Temporary row state. none means absent. reserved means an unresolved
  \* reservation. finalized means a successful result with its attendee id.
  \* @type: Str;
  row,
  \* Number of abstract ticket creations for this session, in whole tickets.
  \* This counts creation effects, not a query of current attendee rows.
  \* @type: Int;
  bookings,
  \* Remember whether every delivery so far avoided a refund of a live ticket.
  \* This proof flag is not stored. Once FALSE, it stays FALSE.
  \* @type: Bool;
  noRefundAfterHonoured

\* Membership in a generated set uses \in. The count domain rejects a
\* second ticket even when a delivery leaves the ledger label unchanged.
TypeOK ==
  /\ ledger \in LedgerStates
  /\ row \in RowStates
  /\ bookings \in 0..1
  /\ noRefundAfterHonoured \in BOOLEAN

\* A refund is unsafe here only when the pre-delivery ledger says booked.
\* The model does not assess refunds for a fresh or orphaned session.
\* @type: ($deliveryFactsFact) => Bool;
RefundsWhenHonoured(fact) == fact.ledgerBefore = "booked" /\ fact.refunds

\* The count and ledger must agree in every safe abstract state. This law
\* also supplies the induction premise. It does not scan corrupt stored rows.
LedgerMatchesBookings ==
  (bookings >= 1) = (ledger = "booked")

\* Safety combines the domains, the durable/count relation and the kept
\* refund verdict. It is a condition that must stay true in every model
\* state, often called an invariant. It does not require provider truth or
\* eventual completion.
Safety ==
  /\ TypeOK
  /\ noRefundAfterHonoured
  /\ LedgerMatchesBookings

\* Start before the first delivery, with no durable legs or temporary row.
Init ==
  /\ ledger = "unrecorded"
  /\ row = "none"
  /\ bookings = 0
  /\ noRefundAfterHonoured = TRUE

\* Select a supplied fact whose two source labels match the current state.
\* \E means that at least one fact supplies the step. These are checker
\* choices, not instructions that execute a callback. Unprimed names mean
\* current values. A prime marks the next value. /\ requires every condition.
\* The fact replaces both labels and adds its ticket effect to the count.
\* ChecksStillPass keeps any earlier failed verdict.
\* A held or replayed delivery has no ticket or refund effect in clean facts.
DeliveryStep ==
  \E fact \in DeliveryFacts :
    /\ fact.ledgerBefore = ledger
    /\ fact.rowBefore = row
    /\ ledger' = fact.ledgerAfter
    /\ row' = fact.rowAfter
    /\ bookings' = bookings + IF fact.books THEN 1 ELSE 0
    /\ noRefundAfterHonoured' =
         ChecksStillPass(noRefundAfterHonoured, ~RefundsWhenHonoured(fact))

\* Expose the gap after reserveSession but before its outcome. Only an
\* unrecorded session with no row can enter this abstract gap. The new row
\* is reserved. All other values stay fixed. A duplicate delivery then has
\* the held outcome in DeliveryFacts, rather than a second ticket.
ReserveStep ==
  /\ ledger = "unrecorded"
  /\ row = "none"
  /\ row' = "reserved"
  /\ UNCHANGED <<ledger, bookings, noRefundAfterHonoured>>

\* Only the unresolved reservation can take this abstract success path.
\* It adds one ticket and sets both durable and temporary success labels.
\* src/db/processed-payments.ts describes createBookingAtomic and its
\* batch finalisation contract. This step assumes that atomic boundary.
\* Fresh refund outcomes and terminal-failure rows are outside this model.
SettleReserved ==
  /\ ledger = "unrecorded"
  /\ row = "reserved"
  /\ ledger' = "booked"
  /\ row' = "finalized"
  /\ bookings' = bookings + 1
  /\ noRefundAfterHonoured' = noRefundAfterHonoured

\* Cleanup can remove a reserved row, but not a finalised row. No clock or
\* lease owner appears here. Durable legs and both verdict values stay fixed.
StaleCleanup ==
  /\ row = "reserved"
  /\ row' = "none"
  /\ UNCHANGED <<ledger, bookings, noRefundAfterHonoured>>

\* Abstract retention or operator deletion can remove a finalised row.
\* The ledger remains booked, so a later delivery must replay, not refund.
\* This is a permitted disturbance, not evidence of a production retention job.
DeleteRow ==
  /\ row = "finalized"
  /\ row' = "none"
  /\ UNCHANGED <<ledger, bookings, noRefundAfterHonoured>>

\* Next defines allowed actions, unlike Safety, which describes one state.
\* It permits a delivery, a reservation, its settlement, either row loss,
\* or no change. \/ offers alternatives. UNCHANGED permits delay.
\* No rule requires an enabled action to occur, so completion is not proved.
Next ==
  DeliveryStep \/ ReserveStep \/ SettleReserved \/ StaleCleanup \/ DeleteRow \/
  UNCHANGED <<ledger, row, bookings, noRefundAfterHonoured>>

=============================================================================
