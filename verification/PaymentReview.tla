--------------------------- MODULE PaymentReview ---------------------------
EXTENDS ModelRules, PaymentReviewData

\* Representative coverage and reason-specific retirement evidence are trusted.
\* Case identity and reason equality compare actual values before abstraction.
VARIABLES
  \* @type: Str;
  reviewState,
  \* @type: Bool;
  allAttemptsSafe

TypeOK ==
  /\ reviewState \in ReviewStates
  /\ allAttemptsSafe \in BOOLEAN

\* @type: ($reviewNodesFact, $reviewNodesFact, $reviewAttemptsFact) => Bool;
HeldCaseKeepsIdentity(before, after, attempt) ==
  IF before.held /\ after.held
  THEN attempt.sameCaseId /\ attempt.sameReason
  ELSE TRUE

\* @type: ($reviewNodesFact, $reviewNodesFact, $reviewEventsFact) => Bool;
OpensUnseenCase(before, after, event) ==
  /\ ~before.held
  /\ after.held
  /\ ~after.seen
  /\ after.reason = event.reason

\* @type: ($reviewNodesFact, $reviewNodesFact) => Bool;
AcknowledgesUnseenCase(before, after) ==
  /\ before.held
  /\ ~before.seen
  /\ after.held
  /\ after.seen

\* @type: ($reviewNodesFact, $reviewNodesFact, $reviewEventsFact) => Bool;
RetiresMatchingCase(before, after, event) ==
  /\ before.held
  /\ before.reason = event.reason
  /\ ~after.held

\* @type: ($reviewNodesFact, $reviewNodesFact, $reviewEventsFact) => Bool;
AcceptedReviewAction(before, after, event) ==
  IF event.action = "open"
  THEN OpensUnseenCase(before, after, event)
  ELSE IF event.action = "acknowledge"
       THEN AcknowledgesUnseenCase(before, after)
       ELSE IF event.action = "retire"
            THEN RetiresMatchingCase(before, after, event)
            ELSE FALSE

\* @type: ($reviewAttemptsFact) => Bool;
RefusalKeepsCase(attempt) ==
  /\ RefusedActionKeepsState(attempt)
  /\ attempt.sameCaseId
  /\ attempt.sameReason

\* @type: ($reviewAttemptsFact) => Bool;
SafeAttempt(attempt) ==
  \E before \in ReviewNodes, after \in ReviewNodes, event \in ReviewEvents :
    /\ before.state = attempt.sourceState
    /\ after.state = attempt.targetState
    /\ event.eventId = attempt.eventId
    /\ ~event.movesMoney
    /\ IF attempt.accepted
       THEN /\ HeldCaseKeepsIdentity(before, after, attempt)
            /\ AcceptedReviewAction(before, after, event)
       ELSE RefusalKeepsCase(attempt)

Safety == TypeOK /\ allAttemptsSafe

Init ==
  /\ reviewState = "none"
  /\ allAttemptsSafe = TRUE

ReviewStep ==
  \E attempt \in ReviewAttempts :
    /\ attempt.sourceState = reviewState
    /\ AttemptedEdge(reviewState, attempt.targetState, SafeAttempt(attempt), allAttemptsSafe)

Next == ReviewStep \/ UNCHANGED <<reviewState, allAttemptsSafe>>

InductionStart == Safety
=============================================================================
