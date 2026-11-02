-------------------------- MODULE SquareLinkEnd --------------------------
EXTENDS ModelRules, SquareLinkEndData

\* \E asks for at least one example. \A asks for every example.
\* /\ requires both conditions and \/ permits either. \in means set membership.
\* => means the right condition is required when the left condition is true.
\* Type annotations describe value shapes for the checker.
\* This module names one model. EXTENDS imports shared rules and generated
\* facts. Square is an external payment service, called a provider.
\* A checkout is one attempt to pay for a reservation. Its payment link
\* opens the provider page where a customer can pay.
\* A cancel handle is the local row with the details needed to end that link.
\* It is not money and it is not proof that the link has ended.
\* A worker is a background task. A claim gives one worker a temporary
\* right to process a row. That right is a lease and expires after a limit.
\* unwritten means no handle has been created yet. pending means a handle
\* awaits a worker. ending means a worker has a lease and has asked Square
\* to end the link. gone means the handle has been deleted.
\* The two absent-row states differ because a deleted handle must not return.
\* A provider reply answers a request. A webhook is a provider callback,
\* a separate message to the site about a payment. Such a message can be late.
\* Native expiry is the provider's own limit on how long a link accepts pay.
\* Retention is how long the site keeps a row before age cleanup permits
\* deletion. The retry margin allows time for late provider messages.
\* For example, a success status with no cancellation id is not enough
\* evidence to delete the handle. pending preserves a way to try again.
\* Ages below are names for time intervals, not actual timestamps.
\* Reply examples cover distinct reply shapes, not all possible messages.
\* This model has no payment amount or currency variable.
\*
\* == defines an expression, not an assignment. Conditions such as Safety
\* test current values. Actions such as ApplyAttempt relate current values
\* to next values. A prime marks a next value. UNCHANGED preserves a value.
\* Init defines starts. Next offers checker choices, not an executable script.
\* The initial check tests Safety at Init. The inductive check tests that
\* each step from any abstract safe state preserves Safety.
\*
\* Keep a cancel handle while a Square checkout can still accept payment.
\* A 200 reply with no cancelled_order_id can leave the link payable. That
\* reply must not delete the only handle that lets the site end the link.
\* scripts/verify-models/square.ts: squareDataFor executes LINK_END_EVENTS
\* over LINK_END_NODES in src/shared/payment/square-link-end-machine-spec.ts.
\* Those events use squareLinkEndMoveTo. Reply witnesses call
\* squareLinkEndEventOf in src/shared/square/link-end.ts.
\* SquareLinkEndData supplies state/attempt tables, independently labelled
\* reply witnesses and age facts from configured lifetime and retention limits.
\* The domain has four states, representative rows, eight reply shapes and
\* selected ages just before, at and after native, retention and margin cutoffs.
\* Native lifetime, webhook retry margin and truthful provider evidence are
\* assumptions. Age facts reconstruct cutoffs. They do not execute prune SQL.
\* Init and one-step induction establish abstract safety for supplied facts at
\* any finite run length, not all replies or production inputs. SQL races,
\* actual clocks, requests still in flight and eventual completion remain outside scope.
\* LocalEvents names events that need no delete-reply example.
\* RetryEvents names events that return a leased handle to pending.
\* ConclusiveEvidence names reply facts that establish link end or payment.
\* Only cancelled, missing or paid evidence establishes link end.
LocalEvents ==
  {"checkout_created", "claim_due", "payment_completed", "lease_expired"}
RetryEvents == {"delete_inconclusive", "lease_expired"}
ConclusiveEvidence == {"cancelled", "missing", "paid"}

\* Find the supplied age record with this abstract age name (\E means some).
\* @type: (Str, Set($ageFactsFact)) => Bool;
AgeMatches(ageState, samples) ==
  \E sample \in samples : sample.ageState = ageState

\* Native expiry bounds possible payment. This does not ask Square for status.
MayPay(ageState) ==
  AgeMatches(ageState, {sample \in AgeFacts : sample.mayPay})

\* Actual configured retention determines whether age cleanup can delete a row.
Prunable(ageState) ==
  AgeMatches(ageState, {sample \in AgeFacts : sample.prunable})

\* The separate required margin includes native lifetime and webhook retries.
RequiredMargin(ageState) ==
  AgeMatches(ageState, {sample \in AgeFacts : sample.requiredMarginElapsed})

\* A fresh checkout must still be payable and below both cleanup boundaries.
AgeStartIsFresh ==
  /\ AgeStart \in AgeStates
  /\ MayPay(AgeStart)
  /\ ~Prunable(AgeStart)
  /\ ~RequiredMargin(AgeStart)

\* Every age name needs one unambiguous fact. Actual cleanup must wait beyond
\* the required margin, and that margin must lie after native expiry.
AgeSamplesCoverStates ==
  /\ \A ageState \in AgeStates :
       \E fact \in AgeFacts : fact.ageState = ageState
  /\ \A fact \in AgeFacts :
       /\ fact.ageState \in AgeStates
       /\ (fact.prunable => fact.requiredMarginElapsed)
       /\ (fact.requiredMarginElapsed => ~fact.mayPay)
  /\ \A left, right \in AgeFacts :
       left.ageState = right.ageState => left = right

\* Age edges can stay put or advance, but no passed boundary must reverse.
TimePreservesPassedBoundaries ==
  \A move \in AgeMoves :
    /\ move.sourceAge \in AgeStates
    /\ move.targetAge \in AgeStates
    /\ (~MayPay(move.sourceAge) => ~MayPay(move.targetAge))
    /\ (Prunable(move.sourceAge) => Prunable(move.targetAge))
    /\ (RequiredMargin(move.sourceAge) => RequiredMargin(move.targetAge))

\* These input laws expose unsafe cutoff facts even before any action.
AgeData ==
  /\ AgeStartIsFresh
  /\ AgeSamplesCoverStates
  /\ TimePreservesPassedBoundaries

\* Each declared state needs a concrete representative with the same stored word.
\* unwritten and gone are virtual states, not square_link_ends.state values.
RepresentativeCoverage ==
  /\ \A sample \in LinkRepresentatives :
       SampleMatchesDeclaredState(sample.declaredState, sample.storedState, LinkStates)
  /\ \A state \in LinkStates :
       \E sample \in LinkRepresentatives : sample.declaredState = state

\* Require an attempt for each representative/event pair, plus valid joins.
\* Accepted and refused attempts both remain in the generated table.
AttemptCoverage ==
  /\ \A attempt \in LinkAttempts :
       /\ \E sample \in LinkRepresentatives :
            /\ sample.declaredState = attempt.sourceState
            /\ sample.sampleTag = attempt.sampleTag
       /\ \E event \in LinkEvents : event.eventId = attempt.eventId
  /\ \A sample \in LinkRepresentatives, event \in LinkEvents :
       \E attempt \in LinkAttempts :
         /\ attempt.sourceState = sample.declaredState
         /\ attempt.eventId = event.eventId
         /\ attempt.sampleTag = sample.sampleTag

\* Every event must be local or have a reply witness, and none moves money.
\* This model concerns handle retention, not the payment ledger itself.
EventCoverage ==
  /\ LocalEvents \subseteq {event.eventId : event \in LinkEvents}
  /\ \A reply \in ReplyFacts :
       \E event \in LinkEvents : event.eventId = reply.eventId
  /\ \A event \in LinkEvents : ~event.movesMoney
  /\ \A event \in LinkEvents :
       event.eventId \in LocalEvents \/
         \E reply \in ReplyFacts : reply.eventId = event.eventId

\* Stored handles are exactly pending and ending. Virtual endpoints are disjoint.
InputFacts ==
  /\ LinkStates = HandleStates \cup {"unwritten", "gone"}
  /\ HandleStates \cap {"unwritten", "gone"} = {}
  /\ RepresentativeCoverage
  /\ AttemptCoverage
  /\ EventCoverage

\* Match actual classifier output to evidence labelled independently in fixtures.
\* Unreadable or incomplete success replies prove no end. 404 proves missing.
\* @type: ($replyFactsFact) => Bool;
ReplyAgrees(reply) ==
  CASE reply.expectedEvidence = "none" -> reply.eventId = "delete_inconclusive"
    [] reply.expectedEvidence = "cancelled" -> reply.eventId = "delete_answered_cancelled"
    [] reply.expectedEvidence = "missing" -> reply.eventId = "delete_answered_missing"
    [] reply.expectedEvidence = "paid" -> reply.eventId = "delete_refused_paid"
    [] OTHER -> FALSE

\* Inconclusive replies and expired leases must requeue ending, and cannot
\* acquire a handle from any other state.
\* @type: ($linkAttemptsFact) => Bool;
RetryReturnsToQueue(attempt) ==
  IF attempt.eventId \in RetryEvents
  THEN /\ (attempt.sourceState = "ending" => attempt.accepted)
       /\ (attempt.accepted =>
            /\ attempt.sourceState = "ending"
            /\ attempt.targetState = "pending")
  ELSE TRUE

\* A checkout creation can write only the initial handle, never recreate a lost one.
\* @type: ($linkAttemptsFact) => Bool;
CreationDoesNotRecreate(attempt) ==
  IF attempt.accepted /\ attempt.eventId = "checkout_created"
  THEN attempt.sourceState = "unwritten"
  ELSE TRUE

\* Refusals preserve state, gone stays gone, and retries/creation obey their laws.
\* @type: ($linkAttemptsFact) => Bool;
SafeAttempt(attempt) ==
  /\ RefusedActionKeepsState(attempt)
  /\ (attempt.sourceState = "gone" => attempt.targetState = "gone")
  /\ RetryReturnsToQueue(attempt)
  /\ CreationDoesNotRecreate(attempt)

VARIABLES
  \* This is the handle's row state. pending has no worker lease and ending
  \* has a lease. unwritten and gone have no row, before creation or after deletion.
  \* @type: Str;
  handleState,
  \* This is a model age interval name, not a stored clock or timestamp.
  \* AgeFacts supplies the payment and cleanup limits for that interval.
  \* @type: Str;
  sampledAge,
  \* This model-only flag remembers that checkout creation occurred.
  \* It distinguishes a deleted handle from a handle that never existed.
  \* @type: Bool;
  checkoutCreated,
  \* This model-only flag remembers conclusive end or payment evidence.
  \* It records the supplied evidence, not an independent provider enquiry.
  \* @type: Bool;
  linkEndEstablished,
  \* This model-only flag remembers that the handle was deleted at least once.
  \* @type: Bool;
  handleRemovalSeen,
  \* This model-only flag stays false after any failed transition law.
  \* @type: Bool;
  attemptHistorySafe,
  \* This model-only flag stays false after any reply classifier mismatch.
  \* @type: Bool;
  replyHistorySafe,
  \* This model-only flag stays false after an unsafe handle removal.
  \* Removal is unsafe while payment is possible and no end evidence exists.
  \* @type: Bool;
  removalHistorySafe

\* Restrict row state, age bucket and model histories to their declared domains.
TypeOK ==
  /\ handleState \in LinkStates
  /\ sampledAge \in AgeStates
  /\ checkoutCreated \in BOOLEAN
  /\ linkEndEstablished \in BOOLEAN
  /\ handleRemovalSeen \in BOOLEAN
  /\ attemptHistorySafe \in BOOLEAN
  /\ replyHistorySafe \in BOOLEAN
  /\ removalHistorySafe \in BOOLEAN

\* Tie history to row existence. Before creation, time must stay at its start.
\* Removal is final, so its history agrees with the current gone state.
CheckoutHistoryConsistent ==
  /\ checkoutCreated = (handleState # "unwritten")
  /\ (linkEndEstablished => checkoutCreated)
  /\ (~checkoutCreated => sampledAge = AgeStart)
  /\ handleRemovalSeen = (handleState = "gone")

\* Before native expiry, a created link with no end evidence must keep a handle.
\* Check the proposed target against the current age, not just the source row.
PayableLinkKeepsHandle(created, ended, targetState) ==
  IF created /\ ~ended /\ MayPay(sampledAge)
  THEN targetState \in HandleStates
  ELSE TRUE

\* Safety combines input coverage, age laws, permanent verdicts and handle
\* retention. Every retained handle must also remain in the task's checkable set.
Safety ==
  /\ TypeOK
  /\ InputFacts
  /\ AgeData
  /\ attemptHistorySafe
  /\ replyHistorySafe
  /\ removalHistorySafe
  /\ CheckoutHistoryConsistent
  /\ PayableLinkKeepsHandle(checkoutCreated, linkEndEstablished, handleState)
  /\ (handleState \in HandleStates => handleState \in CheckableStates)
  /\ (Prunable(sampledAge) => RequiredMargin(sampledAge))

\* Start before creation, at fresh age, with no evidence and no failed verdict.
Init ==
  /\ handleState = "unwritten"
  /\ sampledAge = AgeStart
  /\ checkoutCreated = FALSE
  /\ linkEndEstablished = FALSE
  /\ handleRemovalSeen = FALSE
  /\ attemptHistorySafe = TRUE
  /\ replyHistorySafe = TRUE
  /\ removalHistorySafe = TRUE

\* Apply the observed target even when unsafe. Never filter a bad edge out.
\* Conclusive evidence survives a refused transition. Creation, end and removal
\* histories only accumulate. ChecksStillPass keeps any false verdict false.
\* Age stays fixed. A prime denotes the next-state value.
\* @type: ($linkAttemptsFact, Bool) => Bool;
ApplyAttempt(attempt, conclusive) ==
  LET createdAfter == (checkoutCreated \/
        (attempt.accepted /\ attempt.eventId = "checkout_created"))
      endedAfter == (linkEndEstablished \/ conclusive)
  IN /\ handleState' = attempt.targetState
     /\ checkoutCreated' = createdAfter
     /\ linkEndEstablished' = endedAfter
     /\ handleRemovalSeen' = (handleRemovalSeen \/ attempt.targetState = "gone")
     /\ attemptHistorySafe' = ChecksStillPass(attemptHistorySafe, SafeAttempt(attempt))
     /\ removalHistorySafe' =
          ChecksStillPass(removalHistorySafe,
            PayableLinkKeepsHandle(createdAfter, endedAfter, attempt.targetState))
     /\ UNCHANGED sampledAge

\* Match a local event at the current state. Payment completion establishes end
\* evidence only after creation. The attempt verdict still checks any refusal.
LocalStep ==
  \E attempt \in LinkAttempts :
    /\ attempt.sourceState = handleState
    /\ attempt.eventId \in LocalEvents
    /\ ApplyAttempt(attempt, checkoutCreated /\ attempt.eventId = "payment_completed")
    /\ UNCHANGED replyHistorySafe

\* Admit a delete reply only while ending. Join its classifier event to an
\* attempt, apply the output and retain any independent evidence mismatch.
ReplyStep ==
  /\ handleState = "ending"
  /\ \E reply \in ReplyFacts, attempt \in LinkAttempts :
       /\ attempt.sourceState = handleState
       /\ attempt.eventId = reply.eventId
       /\ ApplyAttempt(attempt, reply.expectedEvidence \in ConclusiveEvidence)
       /\ replyHistorySafe' = ChecksStillPass(replyHistorySafe, ReplyAgrees(reply))

\* Only a created checkout can age. Follow an age step that never goes backwards.
\* Leave the handle and all evidence histories unchanged.
Age ==
  /\ checkoutCreated
  /\ \E move \in AgeMoves :
       /\ move.sourceAge = sampledAge
       /\ sampledAge' = move.targetAge
  /\ UNCHANGED <<handleState, checkoutCreated, linkEndEstablished, handleRemovalSeen,
                 attemptHistorySafe, replyHistorySafe, removalHistorySafe>>

\* Delete only a handle that exists beyond actual retention, not merely an expired
\* lease. Safety checks the independent margin and payable-link rule. No safety
\* precondition here hides an unsafe cutoff from the checker.
Prune ==
  /\ handleState \in HandleStates
  /\ Prunable(sampledAge)
  /\ handleState' = "gone"
  /\ handleRemovalSeen' = TRUE
  /\ UNCHANGED <<sampledAge, checkoutCreated, linkEndEstablished, attemptHistorySafe,
                 replyHistorySafe, removalHistorySafe>>

\* Next permits a local event, reply, age, cleanup or pause. UNCHANGED means
\* all listed values stay equal. No rule forces a task or reply to occur.
\* The pause is also called a stutter step.
Next == LocalStep \/ ReplyStep \/ Age \/ Prune \/
        UNCHANGED <<handleState, sampledAge, checkoutCreated, linkEndEstablished,
                    handleRemovalSeen, attemptHistorySafe, replyHistorySafe,
                    removalHistorySafe>>

=============================================================================
