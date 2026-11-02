--------------------------- MODULE PaymentReview ---------------------------
EXTENDS ModelRules, PaymentReviewData

\* /\ requires both conditions. \in means set membership. \E selects at
\* least one supplied example. IF/THEN/ELSE chooses the applicable condition.
\* Type annotations describe value shapes for the checker.
\* This module names one model. EXTENDS imports shared rules and generated
\* facts. A payment is money for a booking, the sale for a reservation.
\* A payment row is the site's record of that payment. A review case is a
\* recorded disagreement that needs the site owner's attention, not a refund.
\* The review slot is the optional case field on one payment row.
\* none means no case. open means a case the owner has not acknowledged.
\* seen means the owner has acknowledged that exact case, not resolved it.
\* A case id distinguishes one disagreement from a later disagreement.
\* Its reason states which evidence is absent.
\* A reference identifies a provider payment. shared_reference means more
\* than one row claims that reference, so the site cannot treat each as a
\* separate payment. A unique reference supplies the declared retirement proof.
\* An obligation is an amount that must be returned. The refund ledger is
\* the site's record of that duty and the amounts returned against it.
\* partially_returned_obligation means only part of that duty is satisfied.
\* For example, a partial return still needs a case after the owner sees it.
\* Only evidence that all is returned and recorded retires that reason.
\* No amount or currency unit appears in this model. It checks case identity
\* and evidence labels, not balances or the provider's actual transfers.
\*
\* == defines an expression, not an assignment. Conditions such as Safety
\* test current values. ReviewStep relates current values to next values
\* through AttemptedEdge. A prime in a shared action marks a next value.
\* Init describes starts. Next offers checker choices, not an executable
\* workflow. The initial check tests Safety at Init. The inductive check
\* tests that each step from any abstract safe state keeps Safety true.
\* An invariant is such a condition that stays true across all model steps.
\*
\* Preserve the owner's review case until the declared evidence retires it.
\* For example, acknowledgement must not replace the case with a new case id.
\* scripts/verify-models/review.ts: reviewDataFor executes REVIEW_EVENTS over
\* REVIEW_NODES in src/shared/payment/review-machine-spec.ts. That source uses
\* openPaymentReview and acknowledgePaymentReview from
\* src/shared/payment/review.ts, plus reason-specific retirement guards.
\* PaymentReviewData supplies node descriptions, event meanings and accepted
\* and refused attempts. Concrete case ids and reasons are compared before
\* abstraction. The state name retains status and reason, not the actual id.
\* Representatives cover no case, an open case and a seen case for each of
\* the two declared reasons. Their completeness and retirement evidence are
\* assumptions, not proof that external evidence is true.
\* shared_reference retires on a unique reference. partially_returned_obligation
\* retires once all money is returned and recorded. The machine supplies these
\* events as evidence. The model does not establish the underlying money facts.
\* Init and one-step induction establish abstract safety for supplied facts
\* at any finite run length. They do not prove all production inputs, SQL
\* races, provider truth, eventual review or any money transfer.
VARIABLES
  \* This is the optional case on one payment row. Its abstract name retains
  \* none, open or seen plus the reason. It omits the concrete case id.
  \* @type: Str;
  reviewState,
  \* This model-only flag retains every earlier failed attempt verdict.
  \* @type: Bool;
  allAttemptsSafe

\* The abstract slot must have a supplied state name. The history flag is Boolean.
TypeOK ==
  /\ reviewState \in ReviewStates
  /\ allAttemptsSafe \in BOOLEAN

\* A case that survives an accepted action must retain its concrete id and reason.
\* @type: ($reviewNodesFact, $reviewNodesFact, $reviewAttemptsFact) => Bool;
HeldCaseKeepsIdentity(before, after, attempt) ==
  IF before.held /\ after.held
  THEN attempt.sameCaseId /\ attempt.sameReason
  ELSE TRUE

\* A new case requires an empty slot, starts unseen and uses the event's reason.
\* @type: ($reviewNodesFact, $reviewNodesFact, $reviewEventsFact) => Bool;
OpensUnseenCase(before, after, event) ==
  /\ ~before.held
  /\ after.held
  /\ ~after.seen
  /\ after.reason = event.reason

\* Owner acknowledgement changes an unseen held case to a seen held case.
\* @type: ($reviewNodesFact, $reviewNodesFact) => Bool;
AcknowledgesUnseenCase(before, after) ==
  /\ before.held
  /\ ~before.seen
  /\ after.held
  /\ after.seen

\* Retirement removes only a held case whose reason matches the evidence.
\* @type: ($reviewNodesFact, $reviewNodesFact, $reviewEventsFact) => Bool;
RetiresMatchingCase(before, after, event) ==
  /\ before.held
  /\ before.reason = event.reason
  /\ ~after.held

\* Dispatch by the declared operation. An unknown operation has no safe outcome.
\* @type: ($reviewNodesFact, $reviewNodesFact, $reviewEventsFact) => Bool;
AcceptedReviewAction(before, after, event) ==
  IF event.action = "open"
  THEN OpensUnseenCase(before, after, event)
  ELSE IF event.action = "acknowledge"
       THEN AcknowledgesUnseenCase(before, after)
       ELSE IF event.action = "retire"
            THEN RetiresMatchingCase(before, after, event)
            ELSE FALSE

\* A refusal must preserve both abstract status and concrete case identity.
\* RefusedActionKeepsState comes from the shared ModelRules helper.
\* @type: ($reviewAttemptsFact) => Bool;
RefusalKeepsCase(attempt) ==
  /\ RefusedActionKeepsState(attempt)
  /\ attempt.sameCaseId
  /\ attempt.sameReason

\* Join an attempt to its source, target and event descriptions (\E means some).
\* No review event can declare a money move. Accepted and refused outcomes
\* obey separate laws, so a refusal is evidence rather than an omitted edge.
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

\* Safety requires valid state and a history with no failed review law.
Safety == TypeOK /\ allAttemptsSafe

\* Start with no review and no failed attempt. No actual database row is created.
Init ==
  /\ reviewState = "none"
  /\ allAttemptsSafe = TRUE

\* Select any fact at the current state. AttemptedEdge applies its target and
\* retains SafeAttempt through ModelRules, even when that verdict is false.
ReviewStep ==
  \E attempt \in ReviewAttempts :
    /\ attempt.sourceState = reviewState
    /\ AttemptedEdge(reviewState, attempt.targetState, SafeAttempt(attempt), allAttemptsSafe)

\* Next permits an attempt or a pause. UNCHANGED preserves both values.
\* No rule forces an owner or the system to act. A pause is a stutter step.
Next == ReviewStep \/ UNCHANGED <<reviewState, allAttemptsSafe>>

=============================================================================
