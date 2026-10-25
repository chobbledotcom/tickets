----------------------------- MODULE JointState -----------------------------
EXTENDS Integers, JointStateData

\* Purpose and limits
\* Follow one payment row and the record that controls its refund.
\* The code calls that refund control record an authority.
\* A claim means that one worker holds permission to change the payment row.
\* A claim and an authority need not exist together.
\* A provider callback can start refund work before an attendee row exists.
\*
\* This proof checks the recorded outcomes of declared moves.
\* It does not send money, execute SQL, or compare real payment identifiers.
\* The reference can appear once and never disappears in this model.
\* Database tests must check that real claims require that indexed reference.
\* Retry deadlines, competing workers and eventual completion are outside this proof.
\* A preserved replay deadline does not prove that a send occurs before it.
\*
\* Read the notation
\* MODULE names this set of rules. EXTENDS imports the names that it uses.
\* The final line of = signs ends the module.
\* A state is one snapshot of all variables below, not only the row word.
\* A rule says which conditions hold. Its lines are not commands in order.
\* == defines a rule. = compares values. # means different.
\* A name with a final ' means its value in the next snapshot.
\* A name without that mark means its value in the current snapshot.
\* /\ means all these conditions hold. \/ permits either alternative.
\* => means that the condition on the left requires the one on the right.
\* \in means membership of a set. \E chooses any member that fits the rule.
\* <<...>> is an ordered list. Index 1 is its first column.
\* UNCHANGED keeps the listed variables equal across the step.
\* Str means a word. Bool means TRUE or FALSE.
\* The type notes are checked inputs to Apalache, not only reader guidance.
\*
\* Data from the code
\* A representative is a sample record for one declared state.
\* The proof trusts that those samples cover the real cases that matter.
\* EXTENDS imports standard number names and the fresh JointStateData facts.
\* scripts/verify-models/model.ts builds those facts on every proof run.
\* RowStates lists the payment row words. RowStart is their declared start.
\* AuthorityStates lists refund authority words plus the virtual word "absent".
\* ClaimedRows lists row states whose representative records hold a claim.
\*
\* RowMoves has this column order:
\*   <<source row word, event name, target row word>>.
\* It comes from the current machine declarations through currentContracts().
\* The event name identifies a move. This model does not branch on that name.
\*
\* AuthMoves has this column order:
\*   <<source authority word, event name, target authority word, armed, kept>>.
\* The generator executes refund events over their representative records.
\* It records successful outcomes. The proof trusts representative coverage.
\* For a declared money-send event, armed checks that its result is send_armed.
\* For that event, kept compares request generation, identity and capability.
\* A keyed request must also keep the same replay deadline.
\* Both flags are TRUE for events that declare no money movement.
\* These flags compare real results. They do not replace a bad result.
\* The generator also adds a virtual charge_created move from "absent".
\* That move represents creation of the authority, not a provider operation.
\*
\* Model memory

VARIABLES
  \* The payment row's current state word. Its claim is separate from auth.
  \* @type: Str;
  row,
  \* The authority's current state word. "absent" means that no authority exists.
  \* @type: Str;
  auth,
  \* Whether an indexed payment reference exists, without its actual value.
  \* @type: Bool;
  referencePresent,
  \* Whether every money-send move so far returned an armed authority.
  \* @type: Bool;
  sendArmed,
  \* Whether every money-send move so far kept the required request fields.
  \* @type: Bool;
  requestKept

\* TypeOK restricts each value to its allowed words or truth values.
\* A word can have the right text type but still be an unknown state.
TypeOK ==
  /\ row \in RowStates
  /\ auth \in AuthorityStates
  /\ referencePresent \in BOOLEAN
  /\ sendArmed \in BOOLEAN
  /\ requestKept \in BOOLEAN

\* Safety checks
\* Safety combines the allowed shapes with the rules that must always hold.
\* The history flags must stay TRUE, even after later successful moves.
\* A held claim and an existing authority each require the indexed reference.
\* Safety does not require an authority and a held claim to exist together.
Safety ==
  /\ TypeOK
  /\ sendArmed
  /\ requestKept
  /\ (row \in ClaimedRows => referencePresent)
  /\ (auth # "absent" => referencePresent)

\* Start with the declared row state and no authority or reference.
\* The history flags start TRUE because no bad move has occurred.
\* They do not mean that a refund is already armed or has already run.
Init ==
  /\ row = RowStart
  /\ auth = "absent"
  /\ referencePresent = FALSE
  /\ sendArmed = TRUE
  /\ requestKept = TRUE

\* Make the indexed reference available without a change to either record.
\* No action removes it. Its lifetime is an explicit model assumption.
AttachReference ==
  /\ referencePresent' = TRUE
  /\ UNCHANGED <<row, auth, sendArmed, requestKept>>

\* Choose a real row move whose source matches the current row word.
\* A move into a claimed state requires the reference before the step.
\* This admission condition is an assumption that database tests must check.
\* The proof does not establish that SQL enforces the condition.
RowStep ==
  \E m \in RowMoves :
    /\ m[1] = row
    /\ (m[3] \in ClaimedRows => referencePresent)
    /\ row' = m[3]
    /\ UNCHANGED <<auth, referencePresent, sendArmed, requestKept>>

\* Choose an observed authority move with the right source and a reference.
\* No held row claim is required. This permits independent callback work.
\* Adopt the actual target and combine its flags with all earlier outcomes.
\* TRUE /\ FALSE becomes FALSE. A later TRUE cannot erase that failure.
\* Do not require armed or kept here. An unsafe result must remain reachable.
AuthStep ==
  \E m \in AuthMoves :
    /\ m[1] = auth
    /\ referencePresent
    /\ auth' = m[3]
    /\ sendArmed' = (sendArmed /\ m[4])
    /\ requestKept' = (requestKept /\ m[5])
    /\ UNCHANGED <<row, referencePresent>>

\* One step attaches a reference, moves one record, or changes nothing.
\* The final alternative permits a pause. It promises no eventual progress.
Next == AttachReference \/ RowStep \/ AuthStep \/
        UNCHANGED <<row, auth, referencePresent, sendArmed, requestKept>>

\* Proof checks
\* scripts/verify-models.ts first checks that every Init state satisfies Safety.
\* It then starts from every state that satisfies Safety, not only reachable ones.
\* One unrestricted next step must preserve Safety from each such state.
\* That second run also covers legal states that this model cannot reach.
\* Together, the two checks establish Safety for any finite number of steps.
\* A one-step run from Init alone cannot establish that result.
InductionStart == Safety
=============================================================================
