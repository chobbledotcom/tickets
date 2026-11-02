----------------------------- MODULE JointState -----------------------------
EXTENDS Integers, ModelRules, JointStateData

\* This module defines one mathematical model. EXTENDS imports integer rules,
\* shared checks and generated facts. == defines a name, not an assignment.
\* A payment is customer money handled by an external payment provider.
\* A session identifies one checkout attempt. A provider callback is a
\* message about its result. A refund sends money back to the customer.
\* Refund authority is the durable record that controls one refund request.
\* It keeps the request identity and the evidence for what happens next.
\* A reference identifies a provider payment. Its index connects that
\* payment to local records. Provider-qualified means that the provider is
\* part of the identity, so equal text from two providers is not one payment.
\* A temporary payment row keeps local work for the session. A claim gives
\* one worker control of that row's work. It is not evidence of a refund.
\* A review is a case that needs an operator decision. An obligation is
\* money owed for an order. Returned cash does not itself clear local work.
\* The ledger is the durable account record. Local refund records describe
\* the money return there, separately from the provider result.

\* Couple one temporary payment row to one durable refund authority.
\* For example, a callback can owe local refund records after provider cash
\* returns. Row deletion at that point loses unfinished local work.
\* scripts/verify-models/model.ts produces JointStateData through paymentModel
\* and modelData. It derives RowMoves from currentContracts and calls the
\* REFUND_EVENTS transitions over REFUND_NODES representatives.
\* Production rules include armRefundSend and rearmKeyedRefund in
\* src/shared/payment/refund-authority.ts, plus refundLifecycleFor in
\* src/shared/payment/refund-authority-lifecycle.ts.
\* Representative coverage and indexed-reference admission are assumptions.
\* The model has one implicit provider-qualified request. It has no amount,
\* actual key, generation number, timestamp or SQL transaction.
\* Induction proves safety of supplied abstract edges, not every concrete
\* state, provider truth, concurrent writes or eventual refund completion.

\* The labels stand for representative records, not arbitrary strings.
\* Row labels combine live work: claim means worker control, review means
\* an operator case, and unrecorded means local money records remain due.
\* A combined label such as claim_review includes both kinds of work.
\* free has no live work or terminal result. settled has a terminal result
\* and no live work. These labels do not report provider cash by themselves.
\* Authority absent means no durable refund request. ready permits an
\* attempt. send_armed records that the exact request can reach the provider.
\* observing waits for evidence. check needs a provider check.
\* choice_open needs an owner choice between return and no send.
\* choice_returned and choice_not_sent keep the corresponding evidence.
\* returned means cash came back but local records remain due.
\* recorded means those local records are complete.
\* Representatives separate keyed requests, keyless requests and expired
\* replay windows because their permitted actions differ. A key identifies
\* the same provider request on a repeat attempt. A replay repeats that exact
\* request, not a fresh refund. No amount or currency exists in this model.
VARIABLES
  \* Label for the temporary row's current combination of work or result.
  \* @type: Str;
  rowState,
  \* Label for the durable refund request's current evidence and permission.
  \* @type: Str;
  authorityState,
  \* TRUE after the indexed payment reference is attached. It never leaves.
  \* @type: Bool;
  referencePresent,
  \* Remember whether each money-send edge ended with durable send permission.
  \* This proof flag is not stored. Once FALSE, it stays FALSE.
  \* @type: Bool;
  allSendsArmed,
  \* Remember whether money-send edges kept the same refund request identity.
  \* This proof flag is not stored. Once FALSE, it stays FALSE.
  \* @type: Bool;
  allRequestsPreserved,
  \* Remember whether each replay used the same key within its time window.
  \* This proof flag is not stored. Once FALSE, it stays FALSE.
  \* @type: Bool;
  allReplaysSafe,
  \* Remember whether only money-send events armed or replayed a request.
  \* This proof flag is not stored. Once FALSE, it stays FALSE.
  \* @type: Bool;
  onlyMoneySends,
  \* TRUE after abstract row deletion. This flag stops later work. The model
  \* keeps the old labels for inspection rather than a stored deletion row.
  \* @type: Bool;
  rowDeleted

\* Generated domains bound the labels. Each remaining value is Boolean.
TypeOK ==
  /\ rowState \in RowStates
  /\ authorityState \in AuthorityStates
  /\ referencePresent \in BOOLEAN
  /\ allSendsArmed \in BOOLEAN
  /\ allRequestsPreserved \in BOOLEAN
  /\ allReplaysSafe \in BOOLEAN
  /\ onlyMoneySends \in BOOLEAN
  /\ rowDeleted \in BOOLEAN

\* A row claim or any extant authority needs the shared reference first.
\* => means implication: an unclaimed row imposes no claim requirement.
ClaimRequiresReference == rowState \in ClaimedRows => referencePresent
AuthorityRequiresReference == authorityState # "absent" => referencePresent

\* An automatic replay needs a keyed request, the same request identity and
\* a send time within its finite replay window. The producer compares these
\* concrete fields before it emits the three Boolean verdicts.
\* @type: ($authMovesFact) => Bool;
ReplaySafe(move) ==
  ~move.replay \/ (move.keyed /\ move.requestKept /\ move.inWindow)

\* Only a money event can replay or enter send_armed. Evidence that no send
\* took place and owner decisions must not masquerade as a fresh money send.
\* @type: ($authMovesFact) => Bool;
OnlyMoneySends(move) ==
  ~move.movesMoney => (~move.replay /\ move.targetState # "send_armed")

\* The lifecycle-derived set includes absent authority and completed states
\* with local records complete. A completed provider refund alone is not enough.
\* @type: (Str) => Bool;
Prunable(state) == state \in PrunableStates

\* Safety combines reference admission, all transition verdicts and the
\* deletion boundary. It does not require a row claim for callback work.
Safety ==
  /\ TypeOK
  /\ allSendsArmed
  /\ allRequestsPreserved
  /\ allReplaysSafe
  /\ onlyMoneySends
  /\ ClaimRequiresReference
  /\ AuthorityRequiresReference
  /\ (rowDeleted => Prunable(authorityState))

\* Init defines the abstract start state with no authority or reference,
\* no deletion and no failed verdict. Safety is a condition on one state.
\* The proof checks Init against Safety, then every Next action from any
\* Safety state against Safety again. This is the abstract induction check.
\* It does not establish every possible concrete record or database write.
Init ==
  /\ rowState = RowStart
  /\ authorityState = "absent"
  /\ referencePresent = FALSE
  /\ allSendsArmed = TRUE
  /\ allRequestsPreserved = TRUE
  /\ allReplaysSafe = TRUE
  /\ onlyMoneySends = TRUE
  /\ rowDeleted = FALSE

\* Abstract reference admission changes only its presence. The action has no
\* absence guard, so repeat attachment is harmless. Uniqueness is assumed,
\* not established through an index write in this machine.
AttachReference ==
  /\ referencePresent' = TRUE
  /\ UNCHANGED <<rowState, authorityState, allSendsArmed, allRequestsPreserved,
                 allReplaysSafe, onlyMoneySends, rowDeleted>>

\* Choose a generated row edge from the present label. Refuse entry to a
\* claimed label without a reference. The authority and verdicts stay fixed.
RowStep ==
  \E move \in RowMoves :
    /\ move.sourceState = rowState
    /\ (move.targetState \in ClaimedRows => referencePresent)
    /\ rowState' = move.targetState
    /\ UNCHANGED <<authorityState, referencePresent, allSendsArmed,
                   allRequestsPreserved, allReplaysSafe,
                   onlyMoneySends, rowDeleted>>

\* Choose a generated authority edge only after reference admission.
\* Callback refund work needs no held row claim. \E means at least one edge
\* supplies a checker choice, not an executable workflow. Unprimed names
\* denote current values. Primed names denote next values. /\ requires all
\* conditions. The edge changes the authority label and keeps its four checks
\* through ChecksStillPass. No source edge or reference means no such action.
AuthStep ==
  \E move \in AuthMoves :
    /\ move.sourceState = authorityState
    /\ referencePresent
    /\ authorityState' = move.targetState
    /\ allSendsArmed' = ChecksStillPass(allSendsArmed, move.armed)
    /\ allRequestsPreserved' = ChecksStillPass(allRequestsPreserved, move.requestKept)
    /\ allReplaysSafe' = ChecksStillPass(allReplaysSafe, ReplaySafe(move))
    /\ onlyMoneySends' = ChecksStillPass(onlyMoneySends, OnlyMoneySends(move))
    /\ UNCHANGED <<rowState, referencePresent, rowDeleted>>

\* Delete only once and only at a lifecycle-approved authority label.
\* It sets the deletion flag, not the abstract row label or durable authority.
\* Unfinished work and returned cash with local records due must be refused.
Delete ==
  /\ ~rowDeleted
  /\ Prunable(authorityState)
  /\ rowDeleted' = TRUE
  /\ UNCHANGED <<rowState, authorityState, referencePresent, allSendsArmed,
                 allRequestsPreserved, allReplaysSafe,
                 onlyMoneySends>>

\* Next defines allowed actions, not a condition on one state. It allows
\* reference, row and authority work only before deletion. \/ offers choices.
\* After deletion, only delay remains. UNCHANGED means no value changes.
\* No rule requires a send, observation or local record to occur.
Next ==
  (~rowDeleted /\ (AttachReference \/ RowStep \/ AuthStep)) \/ Delete \/
  UNCHANGED <<rowState, authorityState, referencePresent, allSendsArmed,
              allRequestsPreserved, allReplaysSafe, onlyMoneySends,
              rowDeleted>>

=============================================================================
