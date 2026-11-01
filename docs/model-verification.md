# Model verification

Use this guide when you add or review a model under `verification/`.
A model checks a stated abstract system. It does not prove the whole application.
Keep the claim, the source evidence, and the limits together in the review.

## State the claim before you write the model

Write down:

1. The production functions and writes that the claim covers.
2. What each abstract state, event, identifier, and amount means.
3. The safety law and the conditions under which it must hold.
4. The selected domain and the cases outside it.
5. The assumptions that the generator and checker cannot establish.
6. The database, provider, and scheduling tests that check the remaining boundary.

Separate these three kinds of fact:

| Kind | Meaning | Example |
| --- | --- | --- |
| Observed | A production call or stored read returned this value. | A capacity write affected one row. |
| Expected | A separate rule says this value must hold. | A refund leg must invert its recorded original. |
| Assumed | The model takes this condition as an input. | A provider reply is truthful, or a clock cutoff has the stated meaning. |

Do not label a reconstructed value as an observation. Name the source call for
an observation. Explain how you derive an expectation. Record an assumption even
when it is reasonable. A registry context entry makes source available for
review. It does not prove that a model matches that source.

## Build facts that can expose a fault

Execute the production decision or transition. Preserve refused outcomes as
well as accepted outcomes. Project exhaustive decision unions with an exhaustive
switch or mapped record. A new production case must force a fact rule update.
Do not silently skip a failed transition or replace a missing row with a safe
value. Extraction must fail when the evidence is missing.

Check arithmetic with an independent law. For integer proportional allocation,
derive each floor as `amount * weight div totalWeight` with exact arithmetic.
Check conservation, non-negative outstanding units, caps, and remainder order
separately. Calling the allocator twice is not an independent oracle. Repeating
its floating-point expression can repeat its defect. Safe integer inputs do not
make their product safe. State how zero totals, negative inputs, fractions,
overflow, ties, and exhausted caps are handled.

Choose the domain by risk, not by convenient small numbers. Include zero, one,
exact boundaries, one below and above a boundary, unequal weights, equal
remainders, and large values near arithmetic limits. Include scoped modifiers,
multiple lines, deposits, and rounding where the claim needs them. A selected
finite domain is not a proof for all prices or quantities. Integer model facts
cannot cover fractional inputs by omission.

### Keep identity until the law no longer needs it

TLA sets remove equal records. The record renderer also removes duplicate record
text. Decide whether the table represents distinct events or distinct verdicts.
For verdicts, merging equal records can be correct. For events, keep the event,
row, group, round, pass, or unit identity needed to count and join them.

A correct order total can hide a charge assigned to the wrong listing. A correct
refund total can hide two reversals of one original and none of another. Check
per-item attribution and join completeness before you sum. Do not infer that
all references were classified from a table that contains only returned rows.
Build the expected universe separately and require exactly one outcome for each
member. Document any deliberate loss of identity.

## Check induction and non-vacuity

`deno task verify:models` checks each registered model in two parts:

- At length zero, `Init` must satisfy `Safety`.
- At length one, an unrestricted state satisfying `Safety` takes a `Next` step,
  and the result must still satisfy `Safety`.

The second part starts directly from `Safety`, not from a hand-picked reachable
subset. Together these obligations establish safety for any finite run length
of the supplied abstract system, when the obligations succeed. A bounded run
from `Init` alone establishes only the checked bound. Neither form expands the
generated production domain or proves that production implements the model.

Check that the initial states and important actions exist. An empty fact set, an
impossible guard, or an invariant that excludes the bad input can make a check
vacuous. Check source and target coverage, refused edges, and reachable examples
in generator tests. A clean checker result alone does not establish non-vacuity.

Every model declaration needs named negative controls. Each control must produce
an invariant violation and a trace. A parser error, checker crash, timeout, or
missing trace is an execution failure, not a successful control. A control that
changes no fact must fail the run.

Use an initial control for corrupted domain or accounting facts. For example,
negative outstanding units must violate initial safety. They must not disappear
because the induction premise excludes them. Use step controls for an unsafe
transition. Model-level fact corruption checks whether the invariant detects a
bad fact. Producer-level fault injection checks whether a production defect
reaches the facts at all. Use both where that boundary matters.

These checks concern safety: something bad does not happen. They do not establish
liveness: work eventually runs, retries eventually finish, or a provider replies.
A liveness claim needs explicit scheduling and fairness assumptions and a
separate suitable check. Lease expiry does not cancel a request in flight.

## Focused exemplars

These examples show useful patterns. They are not endorsements of every claim
or every possible input in their files.

### TwoWorkers: production decisions, abstract interleavings

Read `scripts/verify-models/two-workers.ts` and
`verification/TwoWorkers.tla`. `takeFacts` calls `decideClaim` and `holdsTheRow`
from `src/shared/payment/claim.ts`. `settleFacts` uses `settleAccepts`, which
calls `settledRowState` for the checking phase and `claimHeldBy` for the changed
phase probe. `fencesFor` changes command identity, write time, and phase
separately. This keeps each fence comparison observable.

The model explores competing runs over one row using those decisions. The
fixtures use two workers and selected timestamps. They do not execute a database
race. SQL admission, atomic claim writes, provider requests, and stale-worker
settlement still need database and concurrency tests.

### AttendeeCapacity: run SQL and read stored results

Read `scripts/verify-models/attendee-capacity.ts`,
`attendee-capacity-seed.ts` in the same directory, and
`verification/AttendeeCapacity.tla`. `fitsFor` executes the statement from
`lineStatementFor`. `batchFactFor` runs `buildAttendeeEditBatch` in write mode
and reads committed totals through `storedAfter`. The seed uses the production
schema. This is stronger evidence than a second implementation of a SQL guard.

The fixtures cover one attendee, two representative slots with caps three and
two, null dates, and selected package paths. They do not establish every group
capacity rule or dated-slot rule. Keep shared-group and date tests separate.
Only the recognised capacity guard failure can become a refusal fact. Unexpected
SQL, schema, connection, or extraction errors must propagate. A refusal fact is
not by itself evidence that every earlier write rolled back: inspect stored
state in rollback tests, including a fitting write followed by a refused write.

### DoorScan: exhaustive decision projection

Read `scripts/verify-models/door-scan.ts` and `verification/DoorScan.tla`.
`factsOf` calls `decideScan` from
`src/features/admin/scan-decision.ts` and handles every decision kind. `admitFacts`
selects representative rows, picks, and admission gates. For an admission,
`heldBefore` sums the booking rows on the listing before adding the admitted
count. This avoids treating the first row as the whole booking.

The facts check decision outcomes for the selected listings and rows. They do
not execute the admission write, authenticate staff, or establish race safety.
Keep write, permission, and concurrent-scan tests at those boundaries.

### RefundReversal: post the plan before checking replay

Read `scripts/verify-models/refund-reversal.ts` and
`verification/RefundReversal.tla`. `planFor` calls `computeAttendeeRefunds`
from `src/shared/refund-ledger/plan.ts`.
`postThenPlan` posts the returned groups through `postTransferGroups`, then
calls the planner again. `ledgerLegs` reads through `transfersByAccounts`.
`deriveFacts` uses that grown ledger for replay facts. `pairedOriginal` fails
if a posted leg has no recorded inverse partner. `planFacts` keeps round and
group identities and derives reference outcomes against a separate universe.

This pattern checks selected per-account refund groups and replay cases. It does
not turn a group law into a whole-attendee or whole-order law. Review group
merging, reference joins, operator-money classification, and original-leg
identity. Provider refunds, concurrent plans, and crash windows between durable
writes need their own tests.

### ModelRules and record renderers: share plumbing, not the oracle

`verification/ModelRules.tla` supplies `RefusedActionKeepsState`,
`SampleMatchesDeclaredState`, `ChecksStillPass`, and `AttemptedEdge`.
`ChecksStillPass` keeps an earlier failure visible after later successful steps.
The caller still owns the attempted edges and the meaning of each verdict.

In `scripts/verify-models/data.ts`, use `tlaRecords`, `tlaRecordModuleFor`, and
`tlaSchemaOf` to bind field schemas, type notes, and record output. Integer facts
must reject fractions, unsafe integers, NaN, and infinities with field context.
Negative safe integers must render as valid TLA values. Schema and renderer
checks are not business oracles. Do not share a business calculation between the
implementation and its only expectation.

### Arithmetic and checkout: limits that must remain visible

In `scripts/verify-models/largest-remainder-split.ts`, `splitCases` selects the
domain, `floorShares` derives floors, `owedUnits` derives outstanding units, and
`eligibleFor` reads the configured guard. `verification/LargestRemainderSplit.tla`
models an award loop over those facts. It does not execute and observe every
result of the production allocator. In particular, the floating-point floor
expression can lose precision even for safe integer operands. Non-negative
outstanding accounting is necessary, but adding that invariant does not fix the
production allocator or make the arithmetic unbounded. Use exact independent
arithmetic and direct allocator tests for that boundary.

In `scripts/verify-models/checkout-composition.ts`, `factsFor` calls
`priceCheckout` and `ticketPaymentBreakdown`. `applyPass` reconstructs pass and
unit facts. The producer also shares `allocateDiscount`, `modifierDelta`, and
`modifierCoversListing` with production. Review that shared trust explicitly.
Totals alone do not establish correct per-listing scope or per-unit attribution.

The fee basis in `factsFor` is reconstructed from `feeSubtotalFor` and application
deltas. It is not an observed argument to the fee calculation. The scenarios do
not establish nonzero booking-fee calculation coverage. A corrupted fee-basis
fact shows invariant sensitivity, not that the producer observes a stale fee basis
from production. `CheckoutComposition` is not a full checkout or tax proof. A
separate tax model does not close this gap without an explicit join of price,
fee, tax policy, rounding, charge, and stored-ledger meanings.

## Join models at real boundaries

For each model pair, name the shared identifiers, units, amounts, and timing.
Show that one model's output satisfies the next model's assumptions. Check that
every relevant row participates in the join and that multiplicity is correct.
Separate passing models do not establish their composition.

Use SQL tests for constraints, affected-row guards, transaction rollback, and
races. Use fault injection at the database boundary for crash windows. Keep
provider contract tests and stored-data scans. A model of valid transitions does
not detect all corrupt stored data and does not establish provider truth.

## Author and reviewer procedure

1. State the claim and limits. Read the relevant focused exemplar.
2. Add the maintained module to `VERIFICATION_MODULES` in
   `scripts/verify-models/registry.ts`. Declare it as a model or helper. A model
   owns its lazy data producer and nonempty named controls with `initial` or
   `step` phases. A helper has no invented machine or control obligations.
3. Declare the generator, local helper, and production source needed for review.
   Context is limited to TS, JS, and TLA source under `src/`, `scripts/`, and
   `verification/`. Do not use escaping paths, symlinks, environment files,
   credentials, databases, customer records, or generated facts as context.
   Reading registry metadata must not execute a producer or load application IO.
4. Add deterministic generator and fault-injection tests for the evidence
   boundary. Add real negative controls for the claimed laws.
5. Use the pinned devenv environment and the repository's check-run procedure
   from `AGENTS.md`. Run the commands below. Inspect traces and artifacts, not
   only exit codes. Report the commands actually run and their results.
6. Review independent oracles, domain bounds, identity loss, non-vacuity, SQL
   boundaries, and model joins. State unresolved assumptions in the review.

```sh
deno task check:tla
deno task verify:models
deno task cpd:tla
deno task grade:code verification/TwoWorkers.tla
deno task grade:code verification --no-jev
```

`check:tla` checks registration, module identity, model/helper classification,
control declarations, and allowed context paths and files. It has no baseline or
ignore list. It does not parse all TLA semantics or prove production fidelity.

`verify:models` runs the Apalache obligations and declared controls. A checker
error must fail the run. Use the artifact paths in its output to inspect a
failure. No successful run is claimed by this guide.

`cpd:tla` runs the existing jscpd adapter over all maintained TLA models and
helpers at a zero-percent threshold. It preserves diagnostic source locations
and compares tokens without comments. It preserves identifiers, literals, and
prime marks. Its configured minimum token size limits detection. Renamed or
algebraically equivalent rules can escape clone detection. Extract a shared
pure rule when its meaning is shared. Do not merge independent business oracles
just to remove similar text. `deno task cpd` includes the TLA check.

`grade:code` accepts individual TLA files, `verification/`, and mixed source
targets. With no target it still grades `src/`. `--no-jev` makes no JEV request.
TLA uses its own mechanical criteria, not TypeScript or JSX criteria. Existing
JSON, CSV, and batch reporting remain available through the grader's options.

JEV reviews supplied source and declared context. It does not execute a producer
or see generated facts. A missing key or unavailable request must remain visible
as a mechanical-only or unavailable assessment. JEV and all code grades are
advisory. They are not deterministic proof gates and are no substitute for
Apalache, independent arithmetic checks, SQL tests, or evidence from execution.
