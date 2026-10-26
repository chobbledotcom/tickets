----------------------------- MODULE JointState -----------------------------
EXTENDS Integers, ModelRules, JointStateData

\* Representative coverage and indexed-reference admission are trusted inputs.
\* The reference can appear once and is never removed.
VARIABLES
  \* @type: Str;
  rowState,
  \* @type: Str;
  authorityState,
  \* @type: Bool;
  referencePresent,
  \* @type: Bool;
  allSendsArmed,
  \* @type: Bool;
  allRequestsPreserved

TypeOK ==
  /\ rowState \in RowStates
  /\ authorityState \in AuthorityStates
  /\ referencePresent \in BOOLEAN
  /\ allSendsArmed \in BOOLEAN
  /\ allRequestsPreserved \in BOOLEAN

ClaimRequiresReference == rowState \in ClaimedRows => referencePresent
AuthorityRequiresReference == authorityState # "absent" => referencePresent

Safety ==
  /\ TypeOK
  /\ allSendsArmed
  /\ allRequestsPreserved
  /\ ClaimRequiresReference
  /\ AuthorityRequiresReference

Init ==
  /\ rowState = RowStart
  /\ authorityState = "absent"
  /\ referencePresent = FALSE
  /\ allSendsArmed = TRUE
  /\ allRequestsPreserved = TRUE

AttachReference ==
  /\ referencePresent' = TRUE
  /\ UNCHANGED <<rowState, authorityState, allSendsArmed, allRequestsPreserved>>

RowStep ==
  \E move \in RowMoves :
    /\ move.sourceState = rowState
    /\ (move.targetState \in ClaimedRows => referencePresent)
    /\ rowState' = move.targetState
    /\ UNCHANGED <<authorityState, referencePresent, allSendsArmed, allRequestsPreserved>>

\* Callback refund work does not require a held row claim.
AuthStep ==
  \E move \in AuthMoves :
    /\ move.sourceState = authorityState
    /\ referencePresent
    /\ authorityState' = move.targetState
    /\ allSendsArmed' = ChecksStillPass(allSendsArmed, move.armed)
    /\ allRequestsPreserved' = ChecksStillPass(allRequestsPreserved, move.requestKept)
    /\ UNCHANGED <<rowState, referencePresent>>

Next == AttachReference \/ RowStep \/ AuthStep \/
        UNCHANGED <<rowState, authorityState, referencePresent, allSendsArmed, allRequestsPreserved>>

InductionStart == Safety
=============================================================================
