# Pull request workflow

Use this workflow for every non-trivial feature, bug fix, or refactor. The work
must happen in this order. Do not start with implementation and discover the
behavior through review.

One assigned agent owns the plan from start to finish. The agent may use
subagents to research the codebase or challenge a detail, but it must assemble,
check, and present one complete plan itself. A person reviews that plan before
implementation starts.

The aim is a small pull request whose behavior is complete, whose invalid states
are hard to represent, and whose failure paths are decided before code exists.

## The three parts of a safe design

Do not ask one tool to solve three different problems:

1. **Schemas describe facts.** They validate what a value is and which facts
   must travel together. A `completed` payment, for example, must carry the
   actual payment id, amount, currency, account, parent, and proof.
2. **State transitions describe changes.** They say which command can move a
   record from one valid state to another and what the complete new state is.
3. **Transactions or revision checks protect races.** They stop two valid
   requests, or one stale request, from producing the wrong final state.

A strict schema cannot stop a stale form overwriting a newer choice. A
transaction cannot make incomplete provider facts complete. Design all three.

## Required order

### 1. State the current-system value

Write one sentence naming what becomes better if no later pull request ships.
Name the production route, worker, page, or write path that receives the change.

Bad:

> Add payment resource schemas for future use.

Good:

> Current Square callbacks reject a charge whose currency differs from the
> signed checkout currency.

If there is no immediate production value, redraw the slice. Do not build a
dormant foundation.

### 2. Fill in the behavior contract

Add the following sections to the feature plan. Use tables where there is more
than one case. Write `None` when a section truly does not apply; do not omit it.

#### Trusted facts

List every input and say why it may be trusted. Keep expected facts separate
from observed facts.

Examples:

- The signed checkout stores the expected amount and currency.
- The provider payment reports the amount and currency actually charged.
- A webhook signature proves the sender, but not that a later provider read will
  succeed.

Never substitute an expected fact for a missing observed fact.

#### Valid states

List every valid state and the facts required in that state. Use a discriminated
union when the variants carry different facts. Make impossible combinations
unrepresentable where practical.

Avoid optional fields that mean different things in different states. Prefer:

```typescript
type Result =
  | { kind: "completed"; payment: CompletedPayment }
  | { kind: "pending"; paymentId: string }
  | { kind: "failed"; reason: FailureReason }
  | { kind: "unavailable"; retryAt: string };
```

An unavailable read is not unpaid. Missing data is not an empty value.

#### Commands and events

List every action that can change the state. Include user commands, callbacks,
scheduled work, retries, migrations, and administrator repairs.

| Starting state | Command or event | Required result           |
| -------------- | ---------------- | ------------------------- |
| State name     | Action name      | Exact next state or error |

Every command must have one authoritative production implementation.

#### Failure table

List failures at every external and local boundary.

| Work completed  | Failure              | Required result          | Retry owner          |
| --------------- | -------------------- | ------------------------ | -------------------- |
| Nothing         | Provider unavailable | No local success         | Request or scheduler |
| Provider action | Local write fails    | Durable repair work      | Scheduler            |
| Local write     | Message fails        | Payment remains complete | Delivery worker      |

Pay special attention to the gap between external success and local success.
Never acknowledge work as complete unless the system can resume the unfinished
part.

#### Retry and replay table

For every command and event, answer:

- What stable identity makes it idempotent?
- What does an exact replay return?
- Who retries after interruption?
- What stops two workers doing the work together?
- Which failures are permanent?
- Can one failed item block later work?

#### Concurrency table

List operations that may overlap, including two copies of the same operation.

| Operation A     | Operation B       | Required result      | Protection          |
| --------------- | ----------------- | -------------------- | ------------------- |
| Save stale form | Save newer choice | Newer choice remains | Expected revision   |
| Scheduled retry | Callback replay   | One completion       | Claim or unique key |

A transaction protects statements that start together. An expected revision or
expected current value protects against input read before the transaction began.
Use both when both risks exist.

#### Owner choices

List genuine conflicts the system cannot decide safely. Define the required
choice, evidence shown, and effect of each option. Do not silently choose a
money or data outcome for the owner.

#### Security and privacy

State:

- who may perform each action;
- which links each role may see;
- which secrets or personal fields cross each boundary;
- when sensitive facts can be redacted;
- which untrusted inputs could cause provider or database work.

### 3. Design the shared contract

Choose the smallest shared interface that makes every case explicit.

- Parse external input into a strict valibot schema at the boundary.
- Use exhaustive variants instead of `null`, defaults, or branch fallthrough.
- Put rules shared by all providers or record kinds in one pure function.
- Keep expected facts and observed facts as different fields or types.
- Keep IO in a thin shell around pure data-in/data-out rules.
- Define one command API for related state changes.
- Use a revision, claim, unique key, or conditional write for races.

Do not make a schema wider merely to look complete. Every field must be needed
by the current behavior, and every required current fact must be present.

### 4. Challenge the design yourself

The assigned agent must try to break its own contract before presenting the
plan. It may ask a subagent to investigate a risk, but responsibility for every
answer stays with the assigned agent. At a minimum, ask:

- What if the external call succeeds and the local write fails?
- What if the callback is replayed?
- What if the follow-up read fails after a signed success event?
- What if the amount, currency, parent, account, or resource id is wrong?
- What if two requests run together?
- What if one request uses a stale form or stale revision?
- What if the user reloads after an interruption?
- What if the same resource appears on another record?
- What if one queued item fails permanently?
- What does the buyer or operator see in every unfinished state?

Resolve every unanswered question in the contract. Do not leave it for code
review.

### 5. Draw vertical pull requests

Split by a complete behavior or invariant, not by files or architecture layers.

Good slices:

- Every provider rejects blank resource ids.
- A failed provider read can never become an unpaid result.
- Every provider validates the money actually charged.
- Stale provider-setting requests cannot replace newer choices.

Bad slices:

- Add types.
- Add repositories.
- Add helpers for a later route.
- Add one provider while keeping a parallel implementation for the others.

For each pull request, record:

- the current-system value and production caller;
- the old path deleted or replaced;
- expected source files and source-line budget;
- database and provider call budget;
- its place in a stack;
- the contract rows it completes.

Keep each PR under the repository's source-line limit. If a complete behavior
does not fit, split by a smaller complete invariant. Do not split one invariant
into dormant layers.

### 6. Ask a human to approve the plan

After the assigned agent has completed the behavior contract, shared contract,
adversarial review, and PR slices, it must stop and present the plan to a human.
Do not write tests or implementation code yet.

The review request must summarize:

- the current-system value;
- trusted facts and observed facts;
- valid states and state transitions;
- failures, retries, replays, and races;
- genuine owner choices;
- security and privacy boundaries;
- proposed vertical PRs and source budgets;
- the tests that will prove each contract row;
- every question where a product choice is still possible.

The human must explicitly approve the plan. Silence, a previous broad goal, or
approval of an earlier draft is not approval of the current contract. If the
human changes a decision, the agent updates the plan, repeats its own challenge,
and asks for approval again.

### 7. Write behavior tests first

Turn the contract tables into tests before implementation.

- Use direct unit tests for pure rules and every branch that must stay covered.
- Use table-driven provider conformance tests for one shared contract.
- Test exact persisted state after commands.
- Test stale revisions and meaningful concurrent interleavings directly.
- Test retry and replay with the same stable identity.
- Add a regression test that fails for the reported bug before fixing it.
- Use Cucumber for the user journey, not as the only source-line coverage.

Confirm each new regression test fails for the expected reason. A test that was
green before implementation does not prove the missing behavior.

### 8. Implement the hardest invariant first

Build the pure rule and shared contract before route wiring. Then connect the
real production caller and delete the displaced path in the same PR.

While implementing:

- keep one source of truth;
- let invalid expected data throw at its boundary;
- preserve genuinely unavailable or pending states;
- do expensive or external work outside database transactions;
- make the final state change atomic;
- do not add compatibility wrappers for internal callers;
- do not add exports used only by tests.

### 9. Use fast feedback while behavior is moving

Run the narrowest useful checks during implementation:

- the direct test file for the changed rule;
- the focused route or integration test;
- the affected Cucumber feature;
- formatting, lint, or type-check for the changed files when useful.

Do not repeatedly run the full suite or mutation gate while the behavior is
still changing. Those checks prove a stable candidate; they are expensive ways
to discover that the design is unfinished.

### 10. Stop and redesign when patches spread

Stop adding local fixes and return to the behavior contract when any of these
happens:

- review finds two cross-cutting state or concurrency bugs;
- two routes need slightly different versions of the same rule;
- a new optional field changes meaning by state;
- the same failure is handled in more than one layer;
- tests require many special cases to set up one state;
- source churn approaches the PR limit before the behavior is complete.

Update the plan first. Replace the weak shared contract rather than stacking
guards around it. Ask the human to approve the changed contract before resuming
implementation.

### 11. Review the complete diff

Before the expensive gates, inspect the whole PR against its parent.

Check that:

- every contract row has production code and a test;
- every new export has a production caller;
- no old parallel path remains;
- no failure becomes `null`, empty, unpaid, or successful by default;
- SQL selects only needed columns and writes complete state atomically;
- links have the same permission and existence rules as their targets;
- user copy is plain, translated, and consistent;
- comments describe current constraints rather than development history;
- the source-line count remains below the limit;
- unrelated cleanup is absent or recorded separately.

### 12. Run final gates once the candidate is stable

Run focused mutation testing for the changed pure rules first. Kill meaningful
survivors with stronger behavior assertions, not tests of implementation detail.

Then run the repository's final checks:

```bash
nix develop -c deno task precommit
nix develop -c deno task precommit:mutation
```

Commit any final source changes before running `precommit:mutation`. The
mutation gate scopes to the branch's committed diff (`origin/main...HEAD`) and
deliberately ignores the worktree and index, so uncommitted edits are not
mutated and would only be covered by a later commit's ordinary pre-commit gate,
which does not re-run mutation testing. After any later commit, rerun
`precommit:mutation` to restore that coverage.

Do not use mutation testing to invent the behavior contract. It can show that an
existing assertion is weak; it cannot show that a missing state, race, or
external failure was never designed.

### 13. Finish the pull request

- Rebase or synchronize the branch with its current parent before running the
  final gates in step 12. If a lower stacked layer changed or merged since step
  12 ran, the rebase changes the final diff, so rerun both `precommit` and
  `precommit:mutation` afterward; CI does not run mutation testing, so watching
  it does not replace the post-rebase gate.
- Recalculate source and total changed lines against that parent.
- Push and watch CI.
- Read every review comment before resolving it.
- Reply with the mechanism and regression test, or explain why it is incorrect.
- Record valid out-of-scope work in `TODO.md` and link it from the reply.
- Re-run the design checklist when review finds a new state or failure.
- Rewrite the title and description to match the final behavior.

The final description must name:

- behavior added or replaced;
- current-system value and exact production caller;
- trusted and observed facts affected;
- old path deleted;
- source and total changed-line counts;
- database and provider call counts where relevant;
- tests and mutation commands run;
- known fault or plan rows completed.

### 14. Merge a stack from the bottom

Do not merge an upper PR while its parent is moving or unapproved. After the
bottom PR changes or merges, synchronize every higher layer, rerun its source
count, and let CI test the real final diff.

Do not keep repairing the same conflict across a long stack. Keep stacks short,
finish them, and then begin the next stack.

## Ready to code

Implementation may start only when all of these are true:

- The current-system value and production caller are named.
- Trusted facts and observed facts are separate.
- Valid states and required facts are listed.
- Commands and events have exact results.
- External/local failure gaps have recovery owners.
- Retry, replay, and concurrency behavior is decided.
- Genuine owner choices are explicit.
- Security and privacy boundaries are stated.
- The adversarial review has no unanswered question.
- The PR is a complete vertical behavior within its source budget.
- The tests that will prove the contract are named.
- A human explicitly approved the latest version of the plan.

## Done

A pull request is done only when:

- every planned contract row is implemented and tested;
- the live system has one path for the changed behavior;
- invalid states are rejected at their boundary;
- stale and concurrent work cannot overwrite newer state;
- interrupted external work has a durable recovery path where required;
- every review thread has been read, answered, and resolved;
- the branch is current with its parent;
- source churn is below the limit;
- final local gates and CI pass;
- the title and description explain what actually shipped.
