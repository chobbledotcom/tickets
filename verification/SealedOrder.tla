-------------------------- MODULE SealedOrder --------------------------
EXTENDS Apalache, Integers, ModelRules, SealedOrderData

\* This module names one mathematical model. EXTENDS imports integer rules,
\* shared checks and generated facts. A name followed by == defines a rule.
\* It does not assign a value as an application statement does.
\* A checkout is one attempt to pay for an order. A session identifies it.
\* A sealed order is the whole order of a Stripe or Square checkout, kept in
\* the checkout_bundles table. Only the provider holds the token that opens
\* it. A delivery is one provider callback, or one visit of the buyer to the
\* return page. Both read the order and give the same answer.
\* The temporary payment row remembers a reservation or a final result.
\* The ledger is the durable account record of money. A leg is one entry in
\* it. A booking and a refunded placeholder both write legs. A refund for an
\* order that fails its checks writes none.

\* When a session is settled, the sealed order is replaced by a receipt
\* with no personal details. Later the prune deletes the row. Callbacks and
\* return visits can arrive at any time, and two can overlap.
\* The bad outcomes: a second ticket, a ticket made from a receipt, a
\* lost-order alarm for a session that is already settled, a lost order of a
\* session that is not settled with no alarm, or a refund of a lost order. For example, the webhook books, the receipt replaces the
\* order, the prune deletes it, and a late return visit must not raise the
\* alarm.
\* scripts/verify-models/sealed-order.ts builds SealedOrderData. It keys the
\* bundle states on BundleRead in src/shared/db/checkout-bundles.ts and the
\* answers on CallbackOutcome in src/features/api/payment-callback.ts.
\* For a delivery with no readable order, the producer executes two
\* production decisions: standingOf in
\* src/features/api/payment-processing/session-standing.ts and
\* callbackAnswerFor in src/features/api/payment-processing/missing-order.ts.
\* The rows that get a receipt come from settlesSession in
\* src/features/api/payment-processing/index.ts, run on one result for each
\* row state. Those facts are observed decisions.
\* For a delivery that reads an order or a receipt, the producer transcribes
\* handleReservationConflict and replaySessionFromLedger in
\* src/features/api/payment-processing/index.ts.
\* Those facts are transcribed. No fact is an observed callback result or an
\* SQL race result. The refunds field of every fact is false by
\* transcription: no missing-order branch calls a provider. The integration
\* tests in test/integration/server/webhooks/sealed-order-gone.test.ts hold
\* the refund list empty for each lost order.
\* The proof checks Init against Safety, then checks that each Next step
\* from any state that satisfies Safety keeps Safety. This is induction. It
\* does not prove all production inputs, durable atomicity or completion.

\* One unnamed session represents every delivery. No amount, provider
\* payload or clock appears. The prune and the row deletion can happen at
\* any time, which covers every timing the real clocks allow.
VARIABLES
  \* The sealed row. order is the whole order, receipt is the copy with no
  \* personal details, and gone is a pruned row or one that will not open.
  \* @type: Str;
  bundle,
  \* The temporary payment row. none is absent, reserved is an unresolved
  \* reservation, finalized holds a booking, and failed holds a final
  \* handled outcome such as a refunded placeholder.
  \* @type: Str;
  row,
  \* The durable ledger. unrecorded means no legs for the session. recorded
  \* means at least one leg.
  \* @type: Str;
  ledger,
  \* Number of abstract ticket creations for the session, in whole tickets.
  \* @type: Int;
  bookings,
  \* Remember whether every delivery so far kept the alarm for a session that
  \* is not settled. This proof flag is not stored. Once FALSE, it stays FALSE.
  \* @type: Bool;
  noFalseAlarm,
  \* Remember whether every lost order so far was refused with no refund.
  \* @type: Bool;
  noLostOrderRefund,
  \* Remember whether every lost order of a session that is not settled so
  \* far raised the alarm.
  \* @type: Bool;
  noMissedAlarm,
  \* Remember whether every ticket so far came from a whole order.
  \* @type: Bool;
  noReceiptBooking

\* Membership in a generated set uses \in. The count domain rejects a second
\* ticket even when a step leaves the ledger label unchanged.
TypeOK ==
  /\ bundle \in BundleStates
  /\ row \in RowStates
  /\ ledger \in LedgerStates
  /\ bookings \in 0..1
  /\ noFalseAlarm \in BOOLEAN
  /\ noLostOrderRefund \in BOOLEAN
  /\ noMissedAlarm \in BOOLEAN
  /\ noReceiptBooking \in BOOLEAN

\* A row that holds a booking or a final outcome.
FinalRows == {"finalized", "failed"}

\* A session is settled when its row holds a final result or its ledger holds
\* a leg. This is the read that sessionStanding makes.
\* @type: (Str, Str) => Bool;
Settled(rowState, ledgerState) ==
  rowState \in FinalRows \/ ledgerState = "recorded"

\* An alarm is false when the session it names is already settled.
\* @type: ($deliveryFactsFact) => Bool;
AlarmsWhenSettled(fact) ==
  fact.alarms /\ Settled(fact.rowBefore, fact.ledgerBefore)

\* A lost order of a session that is not settled must reach the admin.
\* @type: ($deliveryFactsFact) => Bool;
MissesAlarm(fact) ==
  /\ fact.bundle = "gone"
  /\ ~Settled(fact.rowBefore, fact.ledgerBefore)
  /\ ~fact.alarms

\* A lost order must answer retryably and must never send money back.
\* @type: ($deliveryFactsFact) => Bool;
RefundsLostOrder(fact) == fact.alarms /\ fact.refunds

\* A receipt holds no buyer, so a ticket made from it is wrong.
\* @type: ($deliveryFactsFact) => Bool;
BooksFromReceipt(fact) == fact.books /\ fact.bundle = "receipt"

\* A ticket and a booked row need ledger legs, because one batch writes them
\* together. A failed row may have none. This law also supplies the
\* induction premise.
LedgerMatchesSettlement ==
  /\ (bookings >= 1) => (ledger = "recorded")
  /\ (row = "finalized") => (ledger = "recorded")

\* A receipt exists only for a settled session. A receipt written while the
\* session is open would let a later delivery book from it.
ReceiptOnlyWhenSettled ==
  (bundle = "receipt") => Settled(row, ledger)

\* Safety combines the domains, the two state relations and the three kept
\* verdicts. It must stay true in every model state. It is often called an
\* invariant. It does not require provider truth or eventual completion.
Safety ==
  /\ TypeOK
  /\ noFalseAlarm
  /\ noLostOrderRefund
  /\ noMissedAlarm
  /\ noReceiptBooking
  /\ LedgerMatchesSettlement
  /\ ReceiptOnlyWhenSettled

\* Start after checkout and before the first delivery. The sealed order
\* exists, and there is no row and no ledger leg.
Init ==
  /\ bundle := "order"
  /\ row := "none"
  /\ ledger := "unrecorded"
  /\ bookings := 0
  /\ noFalseAlarm := TRUE
  /\ noLostOrderRefund := TRUE
  /\ noMissedAlarm := TRUE
  /\ noReceiptBooking := TRUE

\* Select a supplied fact whose bundle, row and ledger match the current
\* state. \E means that at least one fact supplies the step. These are
\* checker choices, not instructions that run a callback. Unprimed names are
\* current values. A prime marks the next value. /\ requires every condition.
\* The fact sets the row and the ledger and adds its ticket. A delivery never
\* changes the sealed row. ChecksStillPass keeps any earlier failed verdict.
DeliveryStep ==
  \E fact \in DeliveryFacts :
    /\ fact.bundle = bundle
    /\ fact.rowBefore = row
    /\ fact.ledgerBefore = ledger
    /\ row' := fact.rowAfter
    /\ ledger' := fact.ledgerAfter
    /\ bookings' := bookings + IF fact.books THEN 1 ELSE 0
    /\ noFalseAlarm' := ChecksStillPass(noFalseAlarm, ~AlarmsWhenSettled(fact))
    /\ noLostOrderRefund' :=
         ChecksStillPass(noLostOrderRefund, ~RefundsLostOrder(fact))
    /\ noMissedAlarm' := ChecksStillPass(noMissedAlarm, ~MissesAlarm(fact))
    /\ noReceiptBooking' :=
         ChecksStillPass(noReceiptBooking, ~BooksFromReceipt(fact))
    /\ UNCHANGED bundle

\* A delivery that reads an order and finds no row and no leg reserves the
\* row. This exposes the gap before the outcome. A second delivery in the
\* gap finds the reserved row and takes the held fact.
ReserveStep ==
  /\ bundle # "gone"
  /\ row = "none"
  /\ ledger = "unrecorded"
  /\ row' := "reserved"
  /\ UNCHANGED <<bundle, ledger, bookings, noFalseAlarm, noLostOrderRefund,
                 noMissedAlarm, noReceiptBooking>>

\* The reserved delivery books. One batch writes the ticket, the legs and the
\* finalized row. This step assumes that atomic boundary. The kept verdict
\* records a ticket made from a receipt.
SettleBooked ==
  /\ row = "reserved"
  /\ ledger = "unrecorded"
  /\ row' := "finalized"
  /\ ledger' := "recorded"
  /\ bookings' := bookings + 1
  /\ noReceiptBooking' := ChecksStillPass(noReceiptBooking, bundle # "receipt")
  /\ UNCHANGED <<bundle, noFalseAlarm, noLostOrderRefund, noMissedAlarm>>

\* The reserved delivery ends with a final handled outcome, and the row
\* records it. A sold-out refund keeps a placeholder with legs. A refund for
\* an order that fails its checks writes no leg.
SettleFailed ==
  /\ row = "reserved"
  /\ ledger = "unrecorded"
  /\ row' := "failed"
  /\ \E legs \in LedgerStates : ledger' := legs
  /\ UNCHANGED <<bundle, bookings, noFalseAlarm, noLostOrderRefund,
                 noMissedAlarm, noReceiptBooking>>

\* The payment row goes from one of the named states and nothing else
\* changes. The sealed row and the ledger stay as they are.
\* @type: (Set(Str)) => Bool;
RowGoes(fromRows) ==
  /\ row \in fromRows
  /\ row' := "none"
  /\ UNCHANGED <<bundle, ledger, bookings, noFalseAlarm, noLostOrderRefund,
                 noMissedAlarm, noReceiptBooking>>

\* A retryable failure or the stale cleanup releases a reserved row. The whole
\* order stays, so the provider's retry can book.
ReleaseReserved == RowGoes({"reserved"})

\* After the outcome, keepOrderReceipt replaces the order with a receipt. It
\* is a separate write, so a crash can leave the order in place. A replay of
\* the final row writes it again. A supplied fact names each row state after
\* which production writes the receipt.
KeepReceipt ==
  \E fact \in ReceiptFacts :
    /\ fact.rowBefore = row
    /\ bundle = "order"
    /\ bundle' := "receipt"
    /\ UNCHANGED <<row, ledger, bookings, noFalseAlarm, noLostOrderRefund,
                   noMissedAlarm, noReceiptBooking>>

\* The prune deletes the sealed row once its windows are over. The model lets
\* it happen at any time. A row that will not open has the same effect.
PruneBundle ==
  /\ bundle # "gone"
  /\ bundle' := "gone"
  /\ UNCHANGED <<row, ledger, bookings, noFalseAlarm, noLostOrderRefund,
                 noMissedAlarm, noReceiptBooking>>

\* Retention can delete a final row, but only after the sealed row: the
\* bundle is never kept longer than a payment row (bundleRetentionMs in
\* src/shared/db/checkout-bundles.ts), and it is written first. The ledger
\* keeps any legs, so a later delivery still reads a booked session as
\* settled. A failed session with no leg is then forgotten, and a later
\* delivery raises the alarm for it.
DeleteRow ==
  /\ bundle = "gone"
  /\ RowGoes(FinalRows)

\* Next defines the allowed actions, unlike Safety, which describes one state.
\* \/ offers alternatives. UNCHANGED permits delay. No rule requires an
\* enabled action to occur, so completion is not proved.
Next ==
  \/ DeliveryStep
  \/ ReserveStep
  \/ SettleBooked
  \/ SettleFailed
  \/ ReleaseReserved
  \/ KeepReceipt
  \/ PruneBundle
  \/ DeleteRow
  \/ UNCHANGED <<bundle, row, ledger, bookings, noFalseAlarm,
                 noLostOrderRefund, noMissedAlarm, noReceiptBooking>>

\* Limits: one session, one sealed row, and the four row and two ledger
\* labels. The model assumes the atomic booking batch. It does not prove SQL
\* atomicity, provider truth, or that a callback ever arrives. A delivery that
\* finds a reserved row and a pruned order raises the alarm. The model allows
\* it, because that session is not settled yet.
=============================================================================
