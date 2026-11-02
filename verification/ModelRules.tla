---------------------------- MODULE ModelRules ----------------------------
\* A model describes possible application states and the events between them.
\* A state is the set of current variable values, not necessarily a stored row.
\* A rule states a condition that those values or an event must satisfy.
\* This module holds shared rules, not an independent application lifecycle.
\* Callers import these definitions with EXTENDS ModelRules.
\* Name == expression defines a rule. It does not assign a variable.
\* Type comments tell Apalache the expected input and result types.
\* Bool is TRUE or FALSE. Str is text. Set(Str) is a set of text values.
\*
\* A producer turns selected production outcomes into example records, or facts.
\* A verdict is TRUE when a fact passes a rule, and FALSE when it fails.
\* This helper has no generated facts, Init, Next, or separate safety claim.
\* Each caller supplies its event meanings, facts, and required Safety condition.

\* A refused attempt must leave the declared state unchanged.
\* sourceState is the label before the attempt. targetState is the label after it.
\* accepted distinguishes a permitted event from a refused one.
\* An accepted attempt passes this rule without a target-state check.
\* The caller must check accepted moves against its own business rules.

\* @type: ({ accepted: Bool, sourceState: Str, targetState: Str, a }) => Bool;
RefusedActionKeepsState(attempt) ==
  IF attempt.accepted
  THEN TRUE
  ELSE attempt.sourceState = attempt.targetState

\* A production sample must match the declared state, which must be allowed.
\* For example, a refund result must match a state that its machine declares.
\* \in means membership. An unknown declared state returns FALSE.
\* @type: (Str, Str, Set(Str)) => Bool;
SampleMatchesDeclaredState(declaredState, storedState, allowedStates) ==
  IF declaredState \in allowedStates
  THEN storedState = declaredState
  ELSE FALSE

\* Remember every failed check. A later success must not erase an earlier fault.
\* For example, checks TRUE, FALSE, TRUE must leave the remembered result FALSE.
\* This Boolean is model evidence, not an application status or database field.
\* @type: (Bool, Bool) => Bool;
ChecksStillPass(previousChecksPassed, currentCheckPassed) ==
  IF previousChecksPassed
  THEN currentCheckPassed
  ELSE FALSE

\* Record one attempted move and retain its safety verdict.
\* An edge is one attempted change from a source state to a target state.
\* targetState is its observed result label, even if that result breaks a rule.
\* safe is the caller's remembered result. verdict is this attempt's result.
\* A prime names the value after the step. /\ requires both updates together.
\* Example: a refund step reaches its declared target but breaks an identity rule.
\* Its FALSE verdict remains visible even after a later valid step.
\* This rule does not refuse an unsafe move. The caller's Safety must reject it.
\* @type: (Str, Str, Bool, Bool) => Bool;
AttemptedEdge(state, targetState, verdict, safe) ==
  /\ state' = targetState
  /\ safe' = ChecksStillPass(safe, verdict)

=============================================================================
