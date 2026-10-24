----------------------------- MODULE JointState -----------------------------
EXTENDS Integers, JointStateData

\* Data comes from real transitions on each proof run.
\* Callbacks can refund before an attendee anchor exists.

VARIABLES
  \* @type: Str;
  row,
  \* @type: Str;
  auth,
  \* @type: Bool;
  referencePresent,
  \* @type: Bool;
  sendArmed,
  \* @type: Bool;
  requestKept

TypeOK ==
  /\ row \in RowStates
  /\ auth \in AuthorityStates
  /\ referencePresent \in BOOLEAN
  /\ sendArmed \in BOOLEAN
  /\ requestKept \in BOOLEAN

Safety ==
  /\ TypeOK
  /\ sendArmed
  /\ requestKept
  /\ (row \in ClaimedRows => referencePresent)
  /\ (auth # "absent" => referencePresent)

Init ==
  /\ row = RowStart
  /\ auth = "absent"
  /\ referencePresent = FALSE
  /\ sendArmed = TRUE
  /\ requestKept = TRUE

AttachReference ==
  /\ referencePresent' = TRUE
  /\ UNCHANGED <<row, auth, sendArmed, requestKept>>

\* Claim admission requires an indexed reference. Database tests check this guard.
RowStep ==
  \E m \in RowMoves :
    /\ m[1] = row
    /\ (m[3] \in ClaimedRows => referencePresent)
    /\ row' = m[3]
    /\ UNCHANGED <<auth, referencePresent, sendArmed, requestKept>>

\* Safety observes real edge results. It does not filter out unsafe results.
AuthStep ==
  \E m \in AuthMoves :
    /\ m[1] = auth
    /\ referencePresent
    /\ auth' = m[3]
    /\ sendArmed' = (sendArmed /\ m[4])
    /\ requestKept' = (requestKept /\ m[5])
    /\ UNCHANGED <<row, referencePresent>>

Next == AttachReference \/ RowStep \/ AuthStep \/
        UNCHANGED <<row, auth, referencePresent, sendArmed, requestKept>>

\* The base case and inductive step cover runs of any length.
InductionStart == Safety
=============================================================================
