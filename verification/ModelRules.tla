---------------------------- MODULE ModelRules ----------------------------

\* @type: ({ accepted: Bool, sourceState: Str, targetState: Str, a }) => Bool;
RefusedActionKeepsState(attempt) ==
  IF attempt.accepted
  THEN TRUE
  ELSE attempt.sourceState = attempt.targetState

\* @type: (Str, Str, Set(Str)) => Bool;
SampleMatchesDeclaredState(declaredState, storedState, allowedStates) ==
  IF declaredState \in allowedStates
  THEN storedState = declaredState
  ELSE FALSE

\* A later success cannot erase an earlier failure.
\* @type: (Bool, Bool) => Bool;
ChecksStillPass(previousChecksPassed, currentCheckPassed) ==
  IF previousChecksPassed
  THEN currentCheckPassed
  ELSE FALSE

\* One attempted edge: the machine lands on the edge's target and the safety
\* ledger carries the machine's own verdict. Which attempts exist and what
\* their verdict means stay with each machine.
\* @type: (Str, Str, Bool, Bool) => Bool;
AttemptedEdge(state, targetState, verdict, safe) ==
  /\ state' = targetState
  /\ safe' = ChecksStillPass(safe, verdict)

=============================================================================
