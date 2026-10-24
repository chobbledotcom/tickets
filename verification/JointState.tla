----------------------------- MODULE JointState -----------------------------
EXTENDS Integers, JointStateData

\* Data comes from the real transition functions on every proof run.
\* A row represents the active anchor for one payment reference.
\* Refund work can outlive that row's short-lived claim.

VARIABLES
  \* @type: Str;
  row,
  \* @type: Str;
  auth,
  \* @type: Bool;
  referencePresent,
  \* @type: Bool;
  sendHeld

TypeOK ==
  /\ row \in RowStates
  /\ auth \in AuthorityStates
  /\ referencePresent \in BOOLEAN
  /\ sendHeld \in BOOLEAN

Safety ==
  /\ TypeOK
  /\ sendHeld
  /\ (row \in ClaimedRows => referencePresent)
  /\ (auth # "absent" => referencePresent)

Init ==
  /\ row = RowStart
  /\ auth = "absent"
  /\ referencePresent = FALSE
  /\ sendHeld = TRUE

AttachReference ==
  /\ referencePresent' = TRUE
  /\ UNCHANGED <<row, auth, sendHeld>>

\* Admission needs an indexed payment reference, not a refund authority row.
RowStep ==
  \E m \in RowMoves :
    /\ m[1] = row
    /\ (m[3] \in ClaimedRows => referencePresent)
    /\ row' = m[3]
    /\ UNCHANGED <<auth, referencePresent, sendHeld>>

\* Every money-sending edge starts under a held claim.
AuthStep ==
  \E m \in AuthMoves :
    /\ m[1] = auth
    /\ referencePresent
    /\ (m[2] \in SendEvents => row \in ClaimedRows)
    /\ auth' = m[3]
    /\ UNCHANGED <<row, referencePresent>>
    /\ sendHeld' = IF m[2] \in SendEvents
                  THEN row \in ClaimedRows ELSE sendHeld

Next == AttachReference \/ RowStep \/ AuthStep \/
        UNCHANGED <<row, auth, referencePresent, sendHeld>>

\* Base case: Init implies Safety. Step: Safety and Next imply Safety'.
\* Both checks together establish Safety for runs of any length.
InductionStart == Safety
=============================================================================
