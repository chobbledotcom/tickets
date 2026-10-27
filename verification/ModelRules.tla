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

=============================================================================
