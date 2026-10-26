-------------------------- MODULE SumupRecovery --------------------------
EXTENDS Integers, ModelRules, SumupRecoveryData

\* Samples cover relevant row shapes; supplied events do not prove provider truth.
\* This model excludes SQL races, task clocks and eventual worker execution.
TerminalStates == {"finished", "unpaid"}

MoneyStates(answer) ==
  {fact.state : fact \in {entry \in RecoveryNodeFacts : entry.moneyOwed = answer}}

RiskStates == MoneyStates("unknown") \cup MoneyStates("yes")

MoneySemantics ==
  /\ MoneyStates("unknown") = {"waiting"}
  /\ MoneyStates("yes") = {"owed"}
  /\ MoneyStates("no") = RecoveryStates \ {"waiting", "owed"}

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

HasEnabledCheck(state, hasId) ==
  \E move \in RecoveryMoves :
    /\ move.sourceState = state
    /\ move.sourceHasCheckoutId = hasId
    /\ move.eventId \in CheckEvents

\* @type: ($recoveryMovesFact) => Bool;
CheckPreservesWork(move) ==
  IF move.eventId \in CheckEvents
  THEN move.targetState \in CheckableStates \/
         (move.targetState \in TerminalStates /\ move.targetState \in MoneyStates("no"))
  ELSE TRUE

VARIABLES
  \* @type: Str;
  recoveryState,
  \* @type: Bool;
  hasCheckoutId,
  \* @type: Bool;
  checkoutIdAgrees,
  \* @type: Bool;
  rowRetained,
  \* @type: Bool;
  pruningAgeReached,
  \* @type: Bool;
  riskyDeletionSeen,
  \* @type: Bool;
  checkHistorySafe,
  \* @type: Bool;
  owedStateSeen,
  \* @type: Str;
  firstTerminalState

FirstTerminalResult(targetState) ==
  IF firstTerminalState = "none" /\ targetState \in TerminalStates
  THEN targetState
  ELSE firstTerminalState

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

CheckoutIdentityConsistent ==
  /\ checkoutIdAgrees
  /\ hasCheckoutId = (recoveryState # NoCheckoutIdState)

RiskyMoneyKeepsQueuedWork ==
  /\ (recoveryState \in RiskStates => rowRetained)
  /\ (rowRetained /\ recoveryState \in RiskStates =>
       /\ recoveryState \in CheckableStates
       /\ HasEnabledCheck(recoveryState, hasCheckoutId))

PaidAndTerminalEvidencePreserved ==
  /\ (recoveryState = "owed" => owedStateSeen)
  /\ (owedStateSeen => recoveryState \in {"owed", "finished"})
  /\ (recoveryState \in TerminalStates) = (firstTerminalState # "none")
  /\ (firstTerminalState # "none" => recoveryState = firstTerminalState)

Safety ==
  /\ TypeOK
  /\ MoneySemantics
  /\ RepresentativeFacts
  /\ CheckoutIdentityConsistent
  /\ ~riskyDeletionSeen
  /\ checkHistorySafe
  /\ RiskyMoneyKeepsQueuedWork
  /\ PaidAndTerminalEvidencePreserved

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

\* Apply observed outputs without a safety guard; failures remain in history.
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

Age ==
  /\ pruningAgeReached' = TRUE
  /\ UNCHANGED <<recoveryState, hasCheckoutId, checkoutIdAgrees, rowRetained,
                 riskyDeletionSeen, checkHistorySafe, owedStateSeen, firstTerminalState>>

\* Deletion uses only age and the declared pruning state, not money safety.
Prune ==
  /\ rowRetained
  /\ pruningAgeReached
  /\ recoveryState \in PrunableStates
  /\ rowRetained' = FALSE
  /\ riskyDeletionSeen' = (riskyDeletionSeen \/ recoveryState \in RiskStates)
  /\ UNCHANGED <<recoveryState, hasCheckoutId, checkoutIdAgrees, pruningAgeReached,
                 checkHistorySafe, owedStateSeen, firstTerminalState>>

Next == RecoveryStep \/ Age \/ Prune \/
        UNCHANGED <<recoveryState, hasCheckoutId, checkoutIdAgrees, rowRetained,
                    pruningAgeReached, riskyDeletionSeen, checkHistorySafe,
                    owedStateSeen, firstTerminalState>>

InductionStart == Safety
=============================================================================
