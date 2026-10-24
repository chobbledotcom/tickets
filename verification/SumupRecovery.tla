-------------------------- MODULE SumupRecovery --------------------------
EXTENDS Integers, SumupRecoveryData

\* The data generator executes recoveryRowAfter for every representative/event
\* pair. A checkout id is abstracted to presence, not to a different move table.
\* This is the sequential machine and its age-only prune policy. SQL fencing,
\* persisted scheduling clocks, provider truth and eventual task execution are
\* outside this proof and remain covered by their direct tests.

TerminalStates == {"finished", "unpaid"}

MoneyStates(answer) ==
  {fact[1] : fact \in {entry \in RecoveryNodeFacts : entry[2] = answer}}

RiskStates == MoneyStates("unknown") \cup MoneyStates("yes")

\* These are the money meanings to prove, not conclusions copied from the
\* mutable owesMoney declarations. In particular, a lost callback leaves a
\* waiting checkout unknown, and an owed checkout has already been read PAID.
MoneySemantics ==
  /\ MoneyStates("unknown") = {"waiting"}
  /\ MoneyStates("yes") = {"owed"}
  /\ MoneyStates("no") = RecoveryStates \ {"waiting", "owed"}

RepresentativeFacts ==
  /\ \A fact \in RecoveryNodeFacts :
       /\ fact[1] \in RecoveryStates
       /\ fact[2] \in {"no", "unknown", "yes"}
       /\ (fact[1] \in PrunableStates) = fact[3]
  /\ \A rep \in RecoveryRepresentatives :
       /\ rep[1] \in RecoveryStates
       /\ rep[1] = rep[3]
       /\ rep[5]
       /\ rep[4] = (rep[3] # NoCheckoutIdState)

HasEnabledCheck(state, hasId) ==
  \E move \in RecoveryMoves :
    /\ move[1] = state
    /\ move[3] = hasId
    /\ move[4] \in CheckEvents

VARIABLES
  \* @type: Str;
  row,
  \* @type: Bool;
  hasCheckoutId,
  \* @type: Bool;
  checkoutIdAgrees,
  \* @type: Bool;
  present,
  \* @type: Bool;
  old,
  \* @type: Bool;
  deletedRisk,
  \* @type: Bool;
  checksSafe,
  \* @type: Bool;
  paidSeen,
  \* @type: Str;
  terminal

TypeOK ==
  /\ row \in RecoveryStates
  /\ hasCheckoutId \in BOOLEAN
  /\ checkoutIdAgrees \in BOOLEAN
  /\ present \in BOOLEAN
  /\ old \in BOOLEAN
  /\ deletedRisk \in BOOLEAN
  /\ checksSafe \in BOOLEAN
  /\ paidSeen \in BOOLEAN
  /\ terminal \in TerminalStates \cup {"none"}

Safety ==
  /\ TypeOK
  /\ MoneySemantics
  /\ RepresentativeFacts
  /\ checkoutIdAgrees
  /\ hasCheckoutId = (row # NoCheckoutIdState)
  /\ ~deletedRisk
  /\ checksSafe
  /\ (row \in RiskStates => present)
  /\ (present /\ row \in RiskStates =>
       /\ row \in CheckableStates
       /\ HasEnabledCheck(row, hasCheckoutId))
  /\ (row = "owed" => paidSeen)
  /\ (paidSeen => row \in {"owed", "finished"})
  /\ (row \in TerminalStates) = (terminal # "none")
  /\ (terminal # "none" => row = terminal)

\* storeSumupCheckout inserts this state with an empty checkout id. No claim
\* about next_check_at is inferred from a state name or representative.
Init ==
  /\ row = NoCheckoutIdState
  /\ hasCheckoutId = FALSE
  /\ checkoutIdAgrees = TRUE
  /\ present = TRUE
  /\ old = FALSE
  /\ deletedRisk = FALSE
  /\ checksSafe = TRUE
  /\ paidSeen = FALSE
  /\ terminal = "none"

\* No output-safety guard filters a real accepted move. The sticky witnesses
\* make a bad check result, owed-to-unpaid move or reopened terminal visible.
RecoveryStep ==
  /\ present
  /\ \E move \in RecoveryMoves :
       /\ move[1] = row
       /\ move[3] = hasCheckoutId
       /\ row' = move[5]
       /\ hasCheckoutId' = move[6]
       /\ checkoutIdAgrees' = move[7]
       /\ checksSafe' =
            (checksSafe /\
              (move[4] \notin CheckEvents \/
               move[5] \in CheckableStates \/
               (move[5] \in TerminalStates /\ move[5] \in MoneyStates("no"))))
       /\ paidSeen' = (paidSeen \/ row = "owed" \/ move[5] = "owed")
       /\ terminal' = IF terminal = "none" /\ move[5] \in TerminalStates
                       THEN move[5] ELSE terminal
       /\ UNCHANGED <<present, old, deletedRisk>>

\* Age has no upper bound in the abstraction: every retained row can become
\* arbitrarily old. Age never changes its money answer or enables a check.
Age ==
  /\ old' = TRUE
  /\ UNCHANGED <<row, hasCheckoutId, checkoutIdAgrees, present, deletedRisk,
                 checksSafe, paidSeen, terminal>>

\* Keep the pre-delete row and its risk as permanent evidence. A bad pruning
\* declaration must violate Safety, not erase the row that demonstrates it.
Prune ==
  /\ present
  /\ old
  /\ row \in PrunableStates
  /\ present' = FALSE
  /\ deletedRisk' = (deletedRisk \/ row \in RiskStates)
  /\ UNCHANGED <<row, hasCheckoutId, checkoutIdAgrees, old, checksSafe,
                 paidSeen, terminal>>

Next == RecoveryStep \/ Age \/ Prune \/
        UNCHANGED <<row, hasCheckoutId, checkoutIdAgrees, present, old,
                    deletedRisk, checksSafe, paidSeen, terminal>>

\* Base: Init implies Safety. Step: Safety and Next imply Safety'. No guessed
\* reachability or age bound restricts the induction hypothesis. Enabled
\* checks retain work or reach a safe terminal; this is not a progress claim
\* for staged rows, nor a promise that a provider ever gives a final answer.
InductionStart == Safety
=============================================================================
