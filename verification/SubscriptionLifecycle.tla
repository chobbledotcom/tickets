---------------------- MODULE SubscriptionLifecycle ----------------------
EXTENDS Apalache, Integers, ModelRules, SubscriptionRules, SubscriptionLifecycleData

\* A booking row links an attendee (a buyer) to a listing (a ticket). The row
\* keeps the status word that Stripe last reported for its subscription.
\* A renewal is a later payment of the plan. A ledger leg records its money.
\* The scheduled check asks Stripe about each live row. The owner can cancel a
\* live row from the Subscriptions page. Both commands write the status and
\* the paid renewals of the row.
\* For example, Stripe ends a subscription after one more paid renewal. The
\* row can become ended only in the write that also records that renewal.
\*
\* This model holds the state of one row and of its Stripe subscription. The
\* steps explore every order of Stripe changes, scheduled checks and owner
\* cancel requests. The other subscription models check one result at a time.
\*
\* scripts/verify-models/subscriptions/lifecycle.ts supplies the facts.
\* lifecycle-run.ts puts a row in each state. It runs runSubscriptionCheck or
\* cancelOwnerSubscription, and reads the row and the ledger afterwards. No
\* helper rebuilds that orchestration. The route of the cancel form only turns
\* the answer into a message. The Stripe replies are supplied assumptions.
\*
\* == defines a rule, not an assignment. A prime names the state after a step.
\* A model permits steps; it does not execute this text from top to bottom.

VARIABLES
  \* The status word that the booking row holds.
  \* @type: Str;
  stored,
  \* The status word that Stripe holds. This is not a database column.
  \* @type: Str;
  provider,
  \* The renewals that Stripe holds as paid. The model stops at one.
  \* @type: Int;
  paid,
  \* The renewals that the ledger holds for this row.
  \* @type: Int;
  recorded,
  \* FALSE remembers any command whose own result broke a law. A later good
  \* command cannot hide it. This flag is model evidence, not a column.
  \* @type: Bool;
  movesSafe

\* The producer lists each expected move before it runs that command, and
\* each move keeps its position in that list. The count here and the position
\* law in CommandStep mean that no move is absent and none has two results.
\* The witness lines require that the important results exist at all.
Coverage ==
  /\ Statuses = LiveStatuses \cup EndedStatuses
  /\ MovesCount = ExpectedMovesCount
  /\ \E m \in Moves :
       m.outcome = "cancelled" /\ m.recordedAfter > m.recorded
  /\ \E m \in Moves : m.outcome = "behind"
  /\ \E m \in Moves : m.outcome = "not_cancelled"
  /\ \E m \in Moves : m.outcome = "ended"
  /\ \E m \in Moves :
       /\ m.command = "check" /\ m.stored \in LiveStatuses
       /\ m.storedAfter \in EndedStatuses /\ m.recordedAfter > m.recorded
  /\ \E m \in Moves :
       /\ m.command = "check" /\ m.storedAfter \in LiveStatuses
       /\ m.storedAfter # m.stored

\* TypeOK bounds the paid renewals at one. It does not bound the ledger, so a
\* second record of one renewal reaches the law below.
TypeOK ==
  /\ stored \in Statuses
  /\ provider \in Statuses
  /\ paid \in {0, 1}
  /\ recorded \in Nat
  /\ movesSafe \in BOOLEAN

\* The ledger never holds a renewal that Stripe does not hold as paid. An
\* ended row needs an ended Stripe subscription, and it needs every paid
\* renewal in the ledger: the scheduled check never reads an ended row again.
StateSafe ==
  /\ recorded <= paid
  /\ (stored \in EndedStatuses =>
       (provider \in EndedStatuses /\ recorded = paid))

\* These laws read one command result. An ended row takes no command: no
\* request reaches Stripe and nothing changes. No command removes a recorded
\* renewal or posts a leg for another row. Only an accepted cancel request
\* changes what Stripe holds, and only from live to ended.
\* The owner reads "ended" for an ended row and no other row. "cancelled"
\* needs an ended row. "behind" needs an ended Stripe subscription and an
\* unchanged row.
\* @type: ($movesFact) => Bool;
MoveLaw(m) ==
  /\ m.otherLegs = 0
  /\ m.recordedAfter >= m.recorded
  /\ m.reads <= 1 /\ m.cancels <= 1 /\ m.invoiceReads <= 1
  /\ (m.stored \in EndedStatuses =>
       /\ m.storedAfter = m.stored /\ m.recordedAfter = m.recorded
       /\ m.providerAfter = m.provider
       /\ m.reads = 0 /\ m.cancels = 0 /\ m.invoiceReads = 0)
  /\ (m.providerAfter # m.provider =>
       /\ m.command = "cancel" /\ m.cancels = 1
       /\ m.provider \in LiveStatuses /\ m.providerAfter \in EndedStatuses)
  /\ (m.command = "check" => (m.cancels = 0 /\ m.outcome = "returned"))
  /\ (m.command = "cancel" =>
       /\ m.outcome \in {"cancelled", "behind", "not_cancelled", "ended"}
       /\ (m.outcome = "ended") = (m.stored \in EndedStatuses)
       /\ (m.outcome = "cancelled" => m.storedAfter \in EndedStatuses)
       /\ (m.outcome = "behind" =>
            (m.providerAfter \in EndedStatuses /\ m.storedAfter = m.stored))
       /\ (m.outcome = "not_cancelled" => m.storedAfter \in LiveStatuses))

\* The checker first checks Init. It then takes one Next step from any state
\* that satisfies Safety, not from a hand-picked reachable subset.
Safety == TypeOK /\ StateSafe /\ movesSafe

\* The checkout stores the status that Stripe reported, with no renewal yet.
\* A gap in the facts makes the first state unsafe.
Init ==
  /\ (\E initialStatus \in Statuses :
        /\ stored := initialStatus
        /\ provider := initialStatus)
  /\ paid := 0 /\ recorded := 0
  /\ movesSafe := Coverage

\* Stripe changes a live subscription to any status, and can take one renewal
\* payment. This step is an assumption about Stripe, not an observed fact. An
\* ended subscription does not change and takes no payment.
ProviderStep ==
  /\ provider \in LiveStatuses
  /\ (\E nextStatus \in Statuses : provider' := nextStatus)
  /\ (\E nextPaid \in {paid, 1} : paid' := nextPaid)
  /\ UNCHANGED <<stored, recorded, movesSafe>>

\* The fact starts from the current state.
\* @type: ($movesFact) => Bool;
StartsHere(m) ==
  /\ m.stored = stored /\ m.provider = provider
  /\ m.paid = paid /\ m.recorded = recorded

\* The checker reads one fact. Any fact can be read from any state, so no
\* start state hides a bad result. The fact must sit at its own position in
\* the expected list. When the fact starts from the current state, its real
\* command runs: the stored result becomes the next state. The integer choice
\* permits every fact. Paged row lookup bounds the symbolic choices.
CommandStep ==
  \E index \in MovesIndices :
    LET m == MovesAt(index) IN
    /\ movesSafe' :=
         ChecksStillPass(movesSafe, m.position = index /\ MoveLaw(m))
    /\ stored' := (IF StartsHere(m) THEN m.storedAfter ELSE stored)
    /\ provider' := (IF StartsHere(m) THEN m.providerAfter ELSE provider)
    /\ recorded' := (IF StartsHere(m) THEN m.recordedAfter ELSE recorded)
    /\ UNCHANGED paid

\* Next permits a Stripe change, a command, or a pause. No fairness rule
\* requires a check to run. This is safety, not completion.
Next == ProviderStep \/ CommandStep \/
        UNCHANGED <<stored, provider, paid, recorded, movesSafe>>

\* Limits: one row, one month plan of 600 with no tax, at most one renewal,
\* and all eight statuses. Commands run one after another on one site. A
\* command that overlaps another is the guarded write evidence of
\* SubscriptionCancellation, not this model. No provider network, scheduler
\* liveness, or Stripe truth is proved. Stripe replies must be truthful.
=============================================================================
