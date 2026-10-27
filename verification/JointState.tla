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
  allRequestsPreserved,
  \* @type: Bool;
  allReplaysSafe,
  \* @type: Bool;
  allReplayEvidenceDistinct,
  \* @type: Bool;
  rowDeleted

TypeOK ==
  /\ rowState \in RowStates
  /\ authorityState \in AuthorityStates
  /\ referencePresent \in BOOLEAN
  /\ allSendsArmed \in BOOLEAN
  /\ allRequestsPreserved \in BOOLEAN
  /\ allReplaysSafe \in BOOLEAN
  /\ allReplayEvidenceDistinct \in BOOLEAN
  /\ rowDeleted \in BOOLEAN

ClaimRequiresReference == rowState \in ClaimedRows => referencePresent
AuthorityRequiresReference == authorityState # "absent" => referencePresent

\* The conclusive not-sent evidence and the two owner decisions are separate
\* from an automatic replay. None may re-arm a send.
NotSentOrOwnerEvents ==
  {"proved_not_sent", "owner_confirms_not_sent", "owner_confirms_returned"}

\* @type: ($authMovesFact) => Bool;
ReplaySafe(move) ==
  ~move.replay \/ (move.keyed /\ move.requestKept /\ move.inWindow)

\* @type: ($authMovesFact) => Bool;
NotSentOrOwnerDistinct(move) ==
  IF move.eventId \in NotSentOrOwnerEvents
  THEN ~move.replay /\ move.targetState # "send_armed"
  ELSE TRUE

\* @type: (Str) => Bool;
Prunable(state) == state \in PrunableStates

Safety ==
  /\ TypeOK
  /\ allSendsArmed
  /\ allRequestsPreserved
  /\ allReplaysSafe
  /\ allReplayEvidenceDistinct
  /\ ClaimRequiresReference
  /\ AuthorityRequiresReference
  /\ (rowDeleted => Prunable(authorityState))

Init ==
  /\ rowState = RowStart
  /\ authorityState = "absent"
  /\ referencePresent = FALSE
  /\ allSendsArmed = TRUE
  /\ allRequestsPreserved = TRUE
  /\ allReplaysSafe = TRUE
  /\ allReplayEvidenceDistinct = TRUE
  /\ rowDeleted = FALSE

AttachReference ==
  /\ referencePresent' = TRUE
  /\ UNCHANGED <<rowState, authorityState, allSendsArmed, allRequestsPreserved,
                 allReplaysSafe, allReplayEvidenceDistinct, rowDeleted>>

RowStep ==
  \E move \in RowMoves :
    /\ move.sourceState = rowState
    /\ (move.targetState \in ClaimedRows => referencePresent)
    /\ rowState' = move.targetState
    /\ UNCHANGED <<authorityState, referencePresent, allSendsArmed,
                   allRequestsPreserved, allReplaysSafe,
                   allReplayEvidenceDistinct, rowDeleted>>

\* Callback refund work does not require a held row claim.
AuthStep ==
  \E move \in AuthMoves :
    /\ move.sourceState = authorityState
    /\ referencePresent
    /\ authorityState' = move.targetState
    /\ allSendsArmed' = ChecksStillPass(allSendsArmed, move.armed)
    /\ allRequestsPreserved' = ChecksStillPass(allRequestsPreserved, move.requestKept)
    /\ allReplaysSafe' = ChecksStillPass(allReplaysSafe, ReplaySafe(move))
    /\ allReplayEvidenceDistinct' =
         ChecksStillPass(allReplayEvidenceDistinct, NotSentOrOwnerDistinct(move))
    /\ UNCHANGED <<rowState, referencePresent, rowDeleted>>

\* Deletion needs the refund authority fully recorded. Unfinished work and
\* returned money with local recording due are never eligible.
Delete ==
  /\ ~rowDeleted
  /\ Prunable(authorityState)
  /\ rowDeleted' = TRUE
  /\ UNCHANGED <<rowState, authorityState, referencePresent, allSendsArmed,
                 allRequestsPreserved, allReplaysSafe,
                 allReplayEvidenceDistinct>>

Next ==
  (~rowDeleted /\ (AttachReference \/ RowStep \/ AuthStep)) \/ Delete \/
  UNCHANGED <<rowState, authorityState, referencePresent, allSendsArmed,
              allRequestsPreserved, allReplaysSafe, allReplayEvidenceDistinct,
              rowDeleted>>

InductionStart == Safety
=============================================================================
