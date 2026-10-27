-------------------------- MODULE SquareLinkEnd --------------------------
EXTENDS ModelRules, SquareLinkEndData

\* Samples cover relevant shapes; provider evidence and configured lifetime are trusted.
\* Replies are admitted only while ending; SQL races, clocks and liveness are outside scope.
LocalEvents ==
  {"checkout_created", "claim_due", "payment_completed", "lease_expired"}
RetryEvents == {"delete_inconclusive", "lease_expired"}
ConclusiveEvidence == {"cancelled", "missing", "paid"}

\* @type: (Str, Set($ageFactsFact)) => Bool;
AgeMatches(ageState, samples) ==
  \E sample \in samples : sample.ageState = ageState

MayPay(ageState) ==
  AgeMatches(ageState, {sample \in AgeFacts : sample.mayPay})

Prunable(ageState) ==
  AgeMatches(ageState, {sample \in AgeFacts : sample.prunable})

RequiredMargin(ageState) ==
  AgeMatches(ageState, {sample \in AgeFacts : sample.requiredMarginElapsed})

AgeStartIsFresh ==
  /\ AgeStart \in AgeStates
  /\ MayPay(AgeStart)
  /\ ~Prunable(AgeStart)
  /\ ~RequiredMargin(AgeStart)

AgeSamplesCoverStates ==
  /\ \A ageState \in AgeStates :
       \E fact \in AgeFacts : fact.ageState = ageState
  /\ \A fact \in AgeFacts :
       /\ fact.ageState \in AgeStates
       /\ (fact.prunable => fact.requiredMarginElapsed)
       /\ (fact.requiredMarginElapsed => ~fact.mayPay)
  /\ \A left, right \in AgeFacts :
       left.ageState = right.ageState => left = right

TimePreservesPassedBoundaries ==
  \A move \in AgeMoves :
    /\ move.sourceAge \in AgeStates
    /\ move.targetAge \in AgeStates
    /\ (~MayPay(move.sourceAge) => ~MayPay(move.targetAge))
    /\ (Prunable(move.sourceAge) => Prunable(move.targetAge))
    /\ (RequiredMargin(move.sourceAge) => RequiredMargin(move.targetAge))

AgeData ==
  /\ AgeStartIsFresh
  /\ AgeSamplesCoverStates
  /\ TimePreservesPassedBoundaries

RepresentativeCoverage ==
  /\ \A sample \in LinkRepresentatives :
       SampleMatchesDeclaredState(sample.declaredState, sample.storedState, LinkStates)
  /\ \A state \in LinkStates :
       \E sample \in LinkRepresentatives : sample.declaredState = state

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

EventCoverage ==
  /\ LocalEvents \subseteq {event.eventId : event \in LinkEvents}
  /\ \A reply \in ReplyFacts :
       \E event \in LinkEvents : event.eventId = reply.eventId
  /\ \A event \in LinkEvents : ~event.movesMoney
  /\ \A event \in LinkEvents :
       event.eventId \in LocalEvents \/
         \E reply \in ReplyFacts : reply.eventId = event.eventId

InputFacts ==
  /\ LinkStates = HandleStates \cup {"unwritten", "gone"}
  /\ HandleStates \cap {"unwritten", "gone"} = {}
  /\ RepresentativeCoverage
  /\ AttemptCoverage
  /\ EventCoverage

\* @type: ($replyFactsFact) => Bool;
ReplyAgrees(reply) ==
  CASE reply.expectedEvidence = "none" -> reply.eventId = "delete_inconclusive"
    [] reply.expectedEvidence = "cancelled" -> reply.eventId = "delete_answered_cancelled"
    [] reply.expectedEvidence = "missing" -> reply.eventId = "delete_answered_missing"
    [] reply.expectedEvidence = "paid" -> reply.eventId = "delete_refused_paid"
    [] OTHER -> FALSE

\* @type: ($linkAttemptsFact) => Bool;
RetryReturnsToQueue(attempt) ==
  IF attempt.eventId \in RetryEvents
  THEN /\ (attempt.sourceState = "ending" => attempt.accepted)
       /\ (attempt.accepted =>
            /\ attempt.sourceState = "ending"
            /\ attempt.targetState = "pending")
  ELSE TRUE

\* @type: ($linkAttemptsFact) => Bool;
CreationDoesNotRecreate(attempt) ==
  IF attempt.accepted /\ attempt.eventId = "checkout_created"
  THEN attempt.sourceState = "unwritten"
  ELSE TRUE

\* @type: ($linkAttemptsFact) => Bool;
SafeAttempt(attempt) ==
  /\ RefusedActionKeepsState(attempt)
  /\ (attempt.sourceState = "gone" => attempt.targetState = "gone")
  /\ RetryReturnsToQueue(attempt)
  /\ CreationDoesNotRecreate(attempt)

VARIABLES
  \* @type: Str;
  handleState,
  \* @type: Str;
  sampledAge,
  \* @type: Bool;
  checkoutCreated,
  \* @type: Bool;
  linkEndEstablished,
  \* @type: Bool;
  handleRemovalSeen,
  \* @type: Bool;
  attemptHistorySafe,
  \* @type: Bool;
  replyHistorySafe,
  \* @type: Bool;
  removalHistorySafe

TypeOK ==
  /\ handleState \in LinkStates
  /\ sampledAge \in AgeStates
  /\ checkoutCreated \in BOOLEAN
  /\ linkEndEstablished \in BOOLEAN
  /\ handleRemovalSeen \in BOOLEAN
  /\ attemptHistorySafe \in BOOLEAN
  /\ replyHistorySafe \in BOOLEAN
  /\ removalHistorySafe \in BOOLEAN

CheckoutHistoryConsistent ==
  /\ checkoutCreated = (handleState # "unwritten")
  /\ (linkEndEstablished => checkoutCreated)
  /\ (~checkoutCreated => sampledAge = AgeStart)
  /\ handleRemovalSeen = (handleState = "gone")

PayableLinkKeepsHandle(created, ended, targetState) ==
  IF created /\ ~ended /\ MayPay(sampledAge)
  THEN targetState \in HandleStates
  ELSE TRUE

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

Init ==
  /\ handleState = "unwritten"
  /\ sampledAge = AgeStart
  /\ checkoutCreated = FALSE
  /\ linkEndEstablished = FALSE
  /\ handleRemovalSeen = FALSE
  /\ attemptHistorySafe = TRUE
  /\ replyHistorySafe = TRUE
  /\ removalHistorySafe = TRUE

\* Independent end evidence survives refusals; unsafe outputs are applied, not filtered.
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

LocalStep ==
  \E attempt \in LinkAttempts :
    /\ attempt.sourceState = handleState
    /\ attempt.eventId \in LocalEvents
    /\ ApplyAttempt(attempt, checkoutCreated /\ attempt.eventId = "payment_completed")
    /\ UNCHANGED replyHistorySafe

ReplyStep ==
  /\ handleState = "ending"
  /\ \E reply \in ReplyFacts, attempt \in LinkAttempts :
       /\ attempt.sourceState = handleState
       /\ attempt.eventId = reply.eventId
       /\ ApplyAttempt(attempt, reply.expectedEvidence \in ConclusiveEvidence)
       /\ replyHistorySafe' = ChecksStillPass(replyHistorySafe, ReplyAgrees(reply))

Age ==
  /\ checkoutCreated
  /\ \E move \in AgeMoves :
       /\ move.sourceAge = sampledAge
       /\ sampledAge' = move.targetAge
  /\ UNCHANGED <<handleState, checkoutCreated, linkEndEstablished, handleRemovalSeen,
                 attemptHistorySafe, replyHistorySafe, removalHistorySafe>>

\* Actual retention controls deletion; Safety separately checks the required margin.
Prune ==
  /\ handleState \in HandleStates
  /\ Prunable(sampledAge)
  /\ handleState' = "gone"
  /\ handleRemovalSeen' = TRUE
  /\ UNCHANGED <<sampledAge, checkoutCreated, linkEndEstablished, attemptHistorySafe,
                 replyHistorySafe, removalHistorySafe>>

Next == LocalStep \/ ReplyStep \/ Age \/ Prune \/
        UNCHANGED <<handleState, sampledAge, checkoutCreated, linkEndEstablished,
                    handleRemovalSeen, attemptHistorySafe, replyHistorySafe,
                    removalHistorySafe>>

InductionStart == Safety
=============================================================================
