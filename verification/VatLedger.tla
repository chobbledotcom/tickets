---------------------------- MODULE VatLedger ----------------------------
EXTENDS ModelRules, VatLedgerData

\* Production assess/reassess/refund functions supply every attempted edge.
\* Settings range independently of active/refunded booking state. Equality facts
\* compare concrete assessments, fixed bases and revisions before abstraction.
\* Arithmetic scope: represented minor-unit samples, not arbitrary-number proof.
\* This does not prove SQL atomicity, provider truth or legal VAT compliance.
VARIABLES
  \* @type: Str;
  bookingState,
  \* @type: Bool;
  allAttemptsSafe

TypeOK == bookingState \in VatStates /\ allAttemptsSafe \in BOOLEAN

\* @type: ($vatAttemptsFact) => Bool;
SafeAttempt(attempt) ==
  /\ attempt.arithmetic
  /\ attempt.basisKept
  /\ attempt.settingCorrect
  /\ attempt.revisionCorrect
  /\ attempt.assessmentCorrect
  /\ attempt.terminal
  /\ attempt.refusalCorrect
  /\ attempt.noProviderCall
  /\ attempt.safe

Safety == TypeOK /\ allAttemptsSafe

Init ==
  /\ bookingState = "active"
  /\ allAttemptsSafe = (\A sample \in VatInitial : sample.safe)

VatStep ==
  \E attempt \in VatAttempts :
    /\ attempt.sourceState = bookingState
    /\ AttemptedEdge(bookingState, attempt.targetState, SafeAttempt(attempt), allAttemptsSafe)

Next == VatStep \/ UNCHANGED <<bookingState, allAttemptsSafe>>

\* Unrestricted induction: every safe abstract state, not a bounded path prefix.
InductionStart == Safety
=============================================================================
