-------------------------- MODULE SumupRecovery --------------------------
EXTENDS Integers, ModelRules, SumupRecoveryData

\* \in means set membership. \cup combines sets and \ removes members.
\* /\ requires all listed conditions. \/ permits either alternative.
\* \A checks every example. \E asks for at least one example.
\* => requires its right condition whenever its left condition is true.
\* Type annotations describe value shapes for the checker.
\* This module names one model. EXTENDS imports integer notation, shared
\* rules and generated facts. SumUp is an external payment service, called
\* a provider. A checkout is one attempt to pay for a reservation.
\* Its provider checkout id lets the site ask SumUp about that attempt.
\* A callback is a message from the provider to the site about a checkout.
\* It is not the payment itself. A lost callback does not prove no payment.
\* A recovery row remembers the checkout so a later task can ask again.
\* Recoverable work means the site keeps that row and an allowed check.
\* It does not mean the site already has the money or has completed a refund.
\* staged means the local row exists but has no provider checkout id yet.
\* waiting means it has an id but no final payment answer.
\* owed means paid evidence exists but the site has not accounted for it.
\* finished means the site has accounted for it under the declared evidence.
\* unpaid means a definitive failed or expired answer, not mere silence.
\* For example, a waiting row with a lost callback still needs a later check.
\* Age alone supplies no answer about whether someone paid.
\* The words no, unknown and yes classify unaccounted money risk.
\* They are not amounts. This model has no currency or balance variable.
\* The example id stands for any nonempty provider id. Its text has no
\* special meaning. The empty-id example tests the distinct staged shape.
\*
\* == defines an expression, not an assignment. Safety is a condition on
\* current values. RecoveryStep, Age and Prune describe allowed changes.
\* A prime marks the next value. UNCHANGED keeps the current value.
\* Init defines starts. Next offers choices to the checker, not a task script.
\* The initial check tests Safety at Init. The inductive check tests that
\* each step from any abstract safe state preserves Safety.
\*
\* Keep a SumUp checkout recoverable when its callback never arrives.
\* For example, a paid checkout with no callback must not lose its row on age.
\* scripts/verify-models/sumup.ts: sumupDataFor executes RECOVERY_EVENTS over
\* RECOVERY_NODES in src/shared/payment/sumup-recovery-machine-spec.ts.
\* recoveryRowAfter uses recoveryMoveTo and recoveryNodeOf to preserve the
\* stored recovery_state and provider checkout id contract.
\* SumupRecoveryData supplies node money labels, representative row shapes,
\* queue/prune sets and accepted moves. Refused table cells supply no move.
\* Next also permits a pause. This model does not check each refusal result.
\* The domain uses five states and one representative id or empty id per state.
\* Provider event truth and declared money meanings are assumptions.
\* Init and one-step induction establish abstract safety for supplied facts at
\* any finite run length, not all stored data or all production inputs.
\* SQL races, actual task clocks, provider truth and eventual work are outside scope.
\* finished means money is accounted for. unpaid means a definitive unpaid result.
TerminalStates == {"finished", "unpaid"}

\* Select the states with a declared money answer. The braces form a set.
MoneyStates(answer) ==
  {fact.state : fact \in {entry \in RecoveryNodeFacts : entry.moneyOwed = answer}}

\* Unknown payment status is as unsafe to discard as known unaccounted money.
RiskStates == MoneyStates("unknown") \cup MoneyStates("yes")

\* Pin the declared labels to their application meaning, not just valid strings.
\* waiting has a provider id but no final answer. owed has unaccounted paid money.
\* staged has no provider id yet. Other states have no declared money risk.
MoneySemantics ==
  /\ MoneyStates("unknown") = {"waiting"}
  /\ MoneyStates("yes") = {"owed"}
  /\ MoneyStates("no") = RecoveryStates \ {"waiting", "owed"}

\* Validate supplied row shapes and prune labels. checkoutIdAgrees is an
\* observed reader verdict. Id presence is a separate observation.
\* SampleMatchesDeclaredState checks declared, stored and permitted state names.
RepresentativeFacts ==
  /\ \A fact \in RecoveryNodeFacts :
       /\ fact.state \in RecoveryStates
       /\ fact.moneyOwed \in {"no", "unknown", "yes"}
       /\ (fact.state \in PrunableStates) = fact.prunable
  /\ \A sample \in RecoveryRepresentatives :
       /\ SampleMatchesDeclaredState(sample.declaredState, sample.storedState,
                                      RecoveryStates)
       /\ sample.checkoutIdAgrees
       /\ sample.hasCheckoutId = (sample.storedState # NoCheckoutIdState)

\* A risky row must have at least one supplied check edge for its id shape.
\* This proves an abstract option exists, not that a worker eventually takes it.
HasEnabledCheck(state, hasId) ==
  \E move \in RecoveryMoves :
    /\ move.sourceState = state
    /\ move.sourceHasCheckoutId = hasId
    /\ move.eventId \in CheckEvents

\* A check must leave work checkable or reach a terminal state with no money risk.
\* @type: ($recoveryMovesFact) => Bool;
CheckPreservesWork(move) ==
  IF move.eventId \in CheckEvents
  THEN move.targetState \in CheckableStates \/
         (move.targetState \in TerminalStates /\ move.targetState \in MoneyStates("no"))
  ELSE TRUE

VARIABLES
  \* This is the abstract recovery_state word on the local checkout row.
  \* Its five labels describe evidence and outstanding work, not an amount.
  \* @type: Str;
  recoveryState,
  \* This records whether sumupId is nonempty, not the concrete provider id.
  \* @type: Bool;
  hasCheckoutId,
  \* This records the production reader's agreement with state/id consistency.
  \* @type: Bool;
  checkoutIdAgrees,
  \* This models whether the checkout row still exists.
  \* @type: Bool;
  rowRetained,
  \* This abstract age flag says the row has reached the cleanup threshold.
  \* It replaces a timestamp. It is not a count of seconds or a payment answer.
  \* @type: Bool;
  pruningAgeReached,
  \* This model-only flag records deletion of a row with money risk.
  \* @type: Bool;
  riskyDeletionSeen,
  \* This model-only flag preserves every failed check-output law.
  \* @type: Bool;
  checkHistorySafe,
  \* This model-only history records whether paid-but-unaccounted evidence arose.
  \* @type: Bool;
  owedStateSeen,
  \* This model-only history keeps the first finished or unpaid result.
  \* none means neither terminal result has occurred.
  \* @type: Str;
  firstTerminalState

\* The first terminal answer must survive every later move without replacement.
FirstTerminalResult(targetState) ==
  IF firstTerminalState = "none" /\ targetState \in TerminalStates
  THEN targetState
  ELSE firstTerminalState

\* Restrict state/history names and Boolean flags to their declared domains.
TypeOK ==
  /\ recoveryState \in RecoveryStates
  /\ hasCheckoutId \in BOOLEAN
  /\ checkoutIdAgrees \in BOOLEAN
  /\ rowRetained \in BOOLEAN
  /\ pruningAgeReached \in BOOLEAN
  /\ riskyDeletionSeen \in BOOLEAN
  /\ checkHistorySafe \in BOOLEAN
  /\ owedStateSeen \in BOOLEAN
  /\ firstTerminalState \in TerminalStates \cup {"none"}

\* Every state except staged must retain a provider id and pass its reader.
\* Id presence alone does not prove that the provider recognises that id.
CheckoutIdentityConsistent ==
  /\ checkoutIdAgrees
  /\ hasCheckoutId = (recoveryState # NoCheckoutIdState)

\* A row with unknown or owed money must survive and retain an enabled check.
RiskyMoneyKeepsQueuedWork ==
  /\ (recoveryState \in RiskStates => rowRetained)
  /\ (rowRetained /\ recoveryState \in RiskStates =>
       /\ recoveryState \in CheckableStates
       /\ HasEnabledCheck(recoveryState, hasCheckoutId))

\* Paid evidence permits only owed or finished thereafter. A terminal result
\* must not reverse, even if a later supplied event contradicts it.
PaidAndTerminalEvidencePreserved ==
  /\ (recoveryState = "owed" => owedStateSeen)
  /\ (owedStateSeen => recoveryState \in {"owed", "finished"})
  /\ (recoveryState \in TerminalStates) = (firstTerminalState # "none")
  /\ (firstTerminalState # "none" => recoveryState = firstTerminalState)

\* Safety combines input meaning, row identity, work retention and durable
\* evidence laws. The history flags keep an earlier failure visible.
Safety ==
  /\ TypeOK
  /\ MoneySemantics
  /\ RepresentativeFacts
  /\ CheckoutIdentityConsistent
  /\ ~riskyDeletionSeen
  /\ checkHistorySafe
  /\ RiskyMoneyKeepsQueuedWork
  /\ PaidAndTerminalEvidencePreserved

\* Start with a retained staged row, no provider id and no prior evidence.
Init ==
  /\ recoveryState = NoCheckoutIdState
  /\ hasCheckoutId = FALSE
  /\ checkoutIdAgrees = TRUE
  /\ rowRetained = TRUE
  /\ pruningAgeReached = FALSE
  /\ riskyDeletionSeen = FALSE
  /\ checkHistorySafe = TRUE
  /\ owedStateSeen = FALSE
  /\ firstTerminalState = "none"

\* Only a retained row can take a move with the same state and id-presence shape.
\* Apply every supplied output without a safety precondition. ChecksStillPass retains
\* a false verdict. The move updates row abstractions and evidence histories,
\* but neither ages nor deletes the row. A prime denotes the next value.
RecoveryStep ==
  /\ rowRetained
  /\ \E move \in RecoveryMoves :
       /\ move.sourceState = recoveryState
       /\ move.sourceHasCheckoutId = hasCheckoutId
       /\ recoveryState' = move.targetState
       /\ hasCheckoutId' = move.targetHasCheckoutId
       /\ checkoutIdAgrees' = move.targetCheckoutIdAgrees
       /\ checkHistorySafe' = ChecksStillPass(checkHistorySafe, CheckPreservesWork(move))
       /\ owedStateSeen' =
            (owedStateSeen \/ recoveryState = "owed" \/ move.targetState = "owed")
       /\ firstTerminalState' = FirstTerminalResult(move.targetState)
       /\ UNCHANGED <<rowRetained, pruningAgeReached, riskyDeletionSeen>>

\* Age can mark the prune threshold as reached at any time. It changes no row.
\* This deliberate abstraction checks safe deletion without a clock proof.
Age ==
  /\ pruningAgeReached' = TRUE
  /\ UNCHANGED <<recoveryState, hasCheckoutId, checkoutIdAgrees, rowRetained,
                 riskyDeletionSeen, checkHistorySafe, owedStateSeen, firstTerminalState>>

\* Only a retained, old row in a declared prunable state can be deleted.
\* Deletion uses no money-safety precondition, so a bad prune label remains detectable.
\* Keep state and evidence after deletion as model history, not stored columns.
Prune ==
  /\ rowRetained
  /\ pruningAgeReached
  /\ recoveryState \in PrunableStates
  /\ rowRetained' = FALSE
  /\ riskyDeletionSeen' = (riskyDeletionSeen \/ recoveryState \in RiskStates)
  /\ UNCHANGED <<recoveryState, hasCheckoutId, checkoutIdAgrees, pruningAgeReached,
                 checkHistorySafe, owedStateSeen, firstTerminalState>>

\* Next permits a move, age, prune or pause. A pause is a stutter step.
\* No rule forces a check, a provider answer or final completion.
Next == RecoveryStep \/ Age \/ Prune \/
        UNCHANGED <<recoveryState, hasCheckoutId, checkoutIdAgrees, rowRetained,
                    pruningAgeReached, riskyDeletionSeen, checkHistorySafe,
                    owedStateSeen, firstTerminalState>>

=============================================================================
