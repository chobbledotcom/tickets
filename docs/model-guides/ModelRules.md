# The shared rules behind every model

[Read the model](../../verification/ModelRules.tla).

This page explains four small rules that the other models share. Each rule turns one kind of evidence into a yes or no answer.

## The bad outcome it rules out

A refused action looks accepted, a sample sits in a state the machine does not declare, or a later success hides an earlier failure.

## The cast

| Word | Meaning |
| --- | --- |
| **attempt** | One attempted change from a source state to a target state. The target can break a rule. |
| **state label** | The label of the state before the attempt and the label after it. |
| **fact** | A result from the production code, turned into an example record. |
| **remembered verdict** | A model-only flag that remembers an earlier failed check. It is not an application status or a database field. |

## The walkthrough

### Step 1: A refusal leaves the state alone

The rule reads one attempt. An accepted attempt passes without a target-state check. A refused attempt must keep the same state label. A refusal that moves the label is a bug.

| Value | This step |
| --- | --- |
| `accepted` | FALSE |
| `sourceState` | pending |
| `targetState` | pending |
| `verdict` | TRUE |

**Model rule: [`RefusedActionKeepsState`](../../verification/ModelRules.tla#L23)**

```tla
RefusedActionKeepsState(attempt) ==
  IF attempt.accepted
  THEN TRUE
  ELSE attempt.sourceState = attempt.targetState
```

### Step 2: A sample must match its declared state

The rule compares the state that a machine declares with the state that a sample holds. A declared state that the machine does not allow returns FALSE. This stops a sample from standing for an invented state.

| Value | This step |
| --- | --- |
| `declaredState` | ending |
| `storedState` | ending |
| `allowedStates` | {pending, ending, gone, unwritten} |
| `verdict` | TRUE |

**Model rule: [`SampleMatchesDeclaredState`](../../verification/ModelRules.tla#L32)**

```tla
SampleMatchesDeclaredState(declaredState, storedState, allowedStates) ==
  IF declaredState \in allowedStates
  THEN storedState = declaredState
  ELSE FALSE
```

### Step 3: A later success cannot erase a failure

The rule joins the earlier verdict with the current verdict. Once the result is FALSE, it stays FALSE. A bad event therefore remains visible after a later good event.

| Value | This step |
| --- | --- |
| `previousChecksPassed` | TRUE |
| `currentCheckPassed` | FALSE |
| `next value` | FALSE |
| `a later check` | TRUE leaves the result FALSE |

**Model rule: [`ChecksStillPass`](../../verification/ModelRules.tla#L41)**

```tla
ChecksStillPass(previousChecksPassed, currentCheckPassed) ==
  IF previousChecksPassed
  THEN currentCheckPassed
  ELSE FALSE
```

### Step 4: Record the attempt and its verdict

This rule moves the model to the target label and remembers the verdict. It does not refuse an unsafe move. The safety rule of the calling model must reject that move.

| Value | This step |
| --- | --- |
| `state` | the current state label |
| `targetState` | the observed result label |
| `safe` | the remembered verdict after the step |

**Model rule: [`AttemptedEdge`](../../verification/ModelRules.tla#L55)**

```tla
AttemptedEdge(state, targetState, verdict, safe) ==
  /\ state' = targetState
  /\ safe' = ChecksStillPass(safe, verdict)
```

## The safety claim

The helper does not claim safety by itself. It supplies the pieces that a model joins into its own safety rule.

The model checks two things:

- The first state satisfies the claim.
- Every allowed step from a state that satisfies the claim keeps it.

Together, these checks cover every finite run of the model.

## What this model does not prove

- The helper has no state of its own, no start state, and no step relation.
- It makes no claim about a business lifecycle.
- Each model that uses a rule supplies its own facts and its own safety claim.

## How to read the model text

| Symbol | Meaning |
| --- | --- |
| `==` | This line defines a rule. It does not assign a value. |
| `x'` | The value of `x` after the step. |
| `/\` | Both conditions must hold. |
| `\/` | One of the conditions must hold. |
| `\A` | Every supplied value must satisfy the rule. |
| `\E` | At least one supplied value must satisfy the rule. |
| `\in` | The value belongs to the set. |
| `=>` | If the left condition holds, the right condition must hold. |

Read [the model verification guide](../model-verification.md) for the
method and its limits.
