-------------------------- MODULE SumupRecovery --------------------------
EXTENDS Integers, SumupRecoveryData

\* Purpose and limits
\* Follow one saved SumUp checkout row, one move at a time.
\* Keep rows with known or possible money that still needs a booking or refund.
\* Prune means delete an old row. This model uses only its age and state.
\* Remember past evidence so a later move cannot hide a bad result.
\* This does not prove SQL write conditions, competing writes, or stored task clocks.
\* It does not prove provider truth, callback delivery, or eventual task execution.
\* An event supplies an answer to the code. It does not prove that SumUp told the truth.
\*
\* Read the notation
\* MODULE names this set of rules. EXTENDS imports the names that it uses.
\* The final line of = signs ends the module.
\* == defines a name. = compares values, and # means they differ.
\* Equalities state conditions on values. They are not commands in line order.
\* A primed equality constrains the value after a step.
\* /\ requires every clause. \/ permits either clause. ~ means not.
\* => means that the right clause must hold when the left clause holds.
\* \in and \notin test set membership. \cup joins sets. \ removes members.
\* {entry \in Set : test} selects entries. {value : entry \in Set}
\* collects values. \A means every entry. \E means at least one entry.
\* Tuple columns start at 1, so move[5] reads the fifth column.
\* A prime marks the value after a step. UNCHANGED keeps the listed values.
\* <<...>> groups values into a tuple. IF chooses between THEN and ELSE.
\* BOOLEAN contains TRUE and FALSE. Str means a word. Bool means a truth value.
\* The type notes are checked inputs to Apalache, not only reader guidance.
\*
\* Data from the code
\* A representative is a sample record for one declared state.
\* The proof trusts that those samples cover the real cases that matter.
\* scripts/verify-models/sumup.ts builds SumupRecoveryData from the real
\* recovery declarations. The shared attempt collector clones each input
\* and runs every representative with every event through recoveryRowAfter.
\* Required moves run directly. A thrown error fails data generation.
\* Declared refusals use attemptTransition. A refusal returns no move fact.
\* An unexpectedly accepted attempt remains in the move facts.
\* Thus the model uses actual returned rows, not just declared destinations.
\* The direct machine tests check that declared refusals really refuse.
\*
\* RecoveryStates contains the declared recovery state names.
\* NoCheckoutIdState names staged, the state before a provider id exists.
\* CheckEvents contains event ids whose declared kind is check, excluding
\* checkout_created. CheckableStates contains states with a declared check
\* move. PrunableStates contains states whose prunable declaration is true.
\* RecoveryNodeFacts has columns: state name, money answer, prunable flag.
\* The money answer is no, unknown or yes.
\* It describes money that still needs a booking or refund.
\* Unknown cannot prove that money is present or that it is absent.
\* RecoveryRepresentatives has columns: declared node, representative tag,
\* stored recovery state, checkout-id presence, checkout-id agreement.
\* Agreement comes from recoveryCheckoutIdAgrees, not from presence alone:
\* staged needs no id, and every other state needs an id.
\* RecoveryMoves has columns: source state, representative tag, source
\* checkout-id presence, event id, returned state, returned checkout-id
\* presence, returned checkout-id agreement.
\* Tags identify sample records. They do not constrain later model steps.
\* Actual id strings are reduced to presence. Agreement stays a separate
\* observed result so a broken reader cannot hide behind that reduction.

\* A terminal row is closed as either accounted for or never paid.

TerminalStates == {"finished", "unpaid"}

\* Read the money declaration for each node with the requested answer.
MoneyStates(answer) ==
  {fact[1] : fact \in {entry \in RecoveryNodeFacts : entry[2] = answer}}

\* Both uncertainty and known unaccounted money require protection.
RiskStates == MoneyStates("unknown") \cup MoneyStates("yes")

\* Fix the intended money meanings independently of mutable declarations.
\* A row in waiting can lack its callback, so its money answer remains unknown.
\* Owed means a paid read left money unaccounted for. Every other state has
\* the answer no, including staged, where no provider id exists yet.
MoneySemantics ==
  /\ MoneyStates("unknown") = {"waiting"}
  /\ MoneyStates("yes") = {"owed"}
  /\ MoneyStates("no") = RecoveryStates \ {"waiting", "owed"}

\* Check the imported declarations and examples as part of the safety rule.
\* Each node fact must name a known state and a recognised money answer.
\* Its pruning flag must match membership in the imported pruning set.
\* Each representative must store its declared node, satisfy the real id
\* agreement reader, and carry an id exactly outside the no-id state.
\* These requirements are clauses of Safety, not filters that remove moves.
\* The base check must establish these requirements for the generated constants.
\* The induction check assumes them at its start and must preserve them.
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

\* The queue needs more than membership in a named checkable set.
\* Find an actual accepted check for this state and this id-presence shape.
\* This tests whether work is enabled, not whether a worker will run it.
HasEnabledCheck(state, hasId) ==
  \E move \in RecoveryMoves :
    /\ move[1] = state
    /\ move[3] = hasId
    /\ move[4] \in CheckEvents

\* Model memory
\* row stores the recovery state, not an entire database record.
\* hasCheckoutId records presence. checkoutIdAgrees records the real reader's
\* answer about the returned row. Safety checks both answers independently.
\* present says the row is retained. A deleted row keeps its other evidence.
\* old says the row has reached the age for deletion. No clock value is modelled.
\* deletedRisk remembers any deletion while money was unknown or owed.
\* checksSafe starts true and stays false after any unsafe check output.
\* paidSeen remembers a visit to owed, which means a paid read left money unaccounted for.
\* It does not record every paid response. A paid result can go straight to finished.
\* terminal remembers the first finished or unpaid result, or none before
\* either occurs. Later steps cannot overwrite that first terminal witness.
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

\* Give every state field its allowed range, including retained evidence.
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

\* Safety checks
\* Require valid field types, fixed money meanings, and consistent examples.
\* Require the reader's id agreement and the independently stated presence
\* rule. Neither mere presence nor the reader's answer replaces the other.
\* No risky deletion occurs. Every check output must retain checkable work
\* or reach a terminal state with no money owed.
\* Unknown and owed rows must remain present, belong to the queue's declared
\* state set, and have an actual enabled check for their id-presence shape.
\* Owed needs paid evidence. After a visit to owed, only owed or finished is allowed.
\* A later unpaid result must not erase that known paid evidence.
\* A terminal row keeps its first finished or unpaid state word.
\* Its current word must still match that first result. This catches a change after closure.
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

\* storeSumupCheckout starts with staged and an empty provider id.
\* The row exists, is not old, and has no failure or paid/terminal history.
\* No claim about next_check_at follows from this initial state.
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

\* Choose any accepted move matching the retained row and id presence.
\* Every matching event is possible. This does not choose when a task runs.
\* Copy the returned state, id presence, and reader agreement without an
\* output-safety guard. Unsafe accepted outputs must remain observable.
\* For a check, keep checksSafe true only if the result stays checkable or
\* reaches a terminal state whose money answer is no. Non-check events do
\* not add this check-output obligation. A false result persists forever.
\* Record visits to owed and the first terminal result. These histories
\* expose owed-to-unpaid moves and reopened terminals even on later steps.
\* Recovery changes neither retention nor age nor the deletion history.
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

\* Allow any row to reach the pruning age, with no upper age bound.
\* Repeating Age is allowed, even after deletion. Age changes no money
\* answer, enables no check, and cannot clear any history.
Age ==
  /\ old' = TRUE
  /\ UNCHANGED <<row, hasCheckoutId, checkoutIdAgrees, present, deletedRisk,
                 checksSafe, paidSeen, terminal>>

\* Delete only a present, old row in the declared pruning set.
\* No money-safety guard filters the deletion. If that declaration becomes
\* unsafe, deletedRisk becomes true and stays true, violating Safety.
\* Keep the pre-delete row and its other evidence so deletion cannot erase
\* the very facts that demonstrate a failure.
Prune ==
  /\ present
  /\ old
  /\ row \in PrunableStates
  /\ present' = FALSE
  /\ deletedRisk' = (deletedRisk \/ row \in RiskStates)
  /\ UNCHANGED <<row, hasCheckoutId, checkoutIdAgrees, old, checksSafe,
                 paidSeen, terminal>>

\* Each step recovers, ages, prunes, or leaves every field unchanged.
\* The unchanged choice permits a pause forever. No rule requires progress.
Next == RecoveryStep \/ Age \/ Prune \/
        UNCHANGED <<row, hasCheckoutId, checkoutIdAgrees, present, old,
                    deletedRisk, checksSafe, paidSeen, terminal>>

\* Proof checks
\* scripts/verify-models.ts checks Init at length zero against Safety.
\* It separately checks one Next step from InductionStart against Safety.
\* InductionStart means every state that satisfies Safety, not only states reached from Init.
\* No guessed limit restricts the number of prior moves or the row's age.
\* Together, the initial-state check and unrestricted preservation check
\* establish Safety for every finite sequence of the model's steps.
\* An enabled check must preserve work or end safely.
\* That available step does not promise execution or a final provider answer. In particular,
\* this is not a progress claim for staged rows or for the real queue.
InductionStart == Safety
=============================================================================
