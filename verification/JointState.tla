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
  onlyMoneySends,
  \* @type: Bool;
  rowDeleted

TypeOK ==
  /\ rowState \in RowStates
  /\ authorityState \in AuthorityStates
  /\ referencePresent \in BOOLEAN
  /\ allSendsArmed \in BOOLEAN
  /\ allRequestsPreserved \in BOOLEAN
  /\ allReplaysSafe \in BOOLEAN
  /\ onlyMoneySends \in BOOLEAN
  /\ rowDeleted \in BOOLEAN

ClaimRequiresReference == rowState \in ClaimedRows => referencePresent
AuthorityRequiresReference == authorityState # "absent" => referencePresent

\* @type: ($authMovesFact) => Bool;
ReplaySafe(move) ==
  ~move.replay \/ (move.keyed /\ move.requestKept /\ move.inWindow)

\* Only a move that sends money can arm a send or be the automatic replay.
\* Conclusive not-sent evidence and owner decisions are not money moves, so
\* they never re-arm a send and never replay.
\* @type: ($authMovesFact) => Bool;
OnlyMoneySends(move) ==
  ~move.movesMoney => (~move.replay /\ move.targetState # "send_armed")

\* @type: (Str) => Bool;
Prunable(state) == state \in PrunableStates

Safety ==
  /\ TypeOK
  /\ allSendsArmed
  /\ allRequestsPreserved
  /\ allReplaysSafe
  /\ onlyMoneySends
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
  /\ onlyMoneySends = TRUE
  /\ rowDeleted = FALSE

AttachReference ==
  /\ referencePresent' = TRUE
  /\ UNCHANGED <<rowState, authorityState, allSendsArmed, allRequestsPreserved,
                 allReplaysSafe, onlyMoneySends, rowDeleted>>

RowStep ==
  \E move \in RowMoves :
    /\ move.sourceState = rowState
    /\ (move.targetState \in ClaimedRows => referencePresent)
    /\ rowState' = move.targetState
    /\ UNCHANGED <<authorityState, referencePresent, allSendsArmed,
                   allRequestsPreserved, allReplaysSafe,
                   onlyMoneySends, rowDeleted>>

\* Callback refund work does not require a held row claim.
AuthStep ==
  \E move \in AuthMoves :
    /\ move.sourceState = authorityState
    /\ referencePresent
    /\ authorityState' = move.targetState
    /\ allSendsArmed' = ChecksStillPass(allSendsArmed, move.armed)
    /\ allRequestsPreserved' = ChecksStillPass(allRequestsPreserved, move.requestKept)
    /\ allReplaysSafe' = ChecksStillPass(allReplaysSafe, ReplaySafe(move))
    /\ onlyMoneySends' = ChecksStillPass(onlyMoneySends, OnlyMoneySends(move))
    /\ UNCHANGED <<rowState, referencePresent, rowDeleted>>

\* Deletion needs the refund authority fully recorded. Unfinished work and
\* returned money with local recording due are never eligible.
Delete ==
  /\ ~rowDeleted
  /\ Prunable(authorityState)
  /\ rowDeleted' = TRUE
  /\ UNCHANGED <<rowState, authorityState, referencePresent, allSendsArmed,
                 allRequestsPreserved, allReplaysSafe,
                 onlyMoneySends>>

Next ==
  (~rowDeleted /\ (AttachReference \/ RowStep \/ AuthStep)) \/ Delete \/
  UNCHANGED <<rowState, authorityState, referencePresent, allSendsArmed,
              allRequestsPreserved, allReplaysSafe, onlyMoneySends,
              rowDeleted>>

InductionStart == Safety
=============================================================================
