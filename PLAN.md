# Payment aggregate integration plan

## Goal

Replace the current payment callback records with one durable payment system,
while taking the strongest parts of both branches:

- `origin/base/payment-aggregate` supplies the working end-to-end system:
  storage, claims, provider reads, reconciliation, booking completion, refunds,
  maintenance, migration, redaction, and owner pages.
- `origin/claude/great-fermi-l2n29f` supplies the stronger pure rules for money,
  provider observations, conflicts, stored records, and owner decisions.

The work will land on `main` as small, independently green PRs. We will not
merge either branch into `main`, and we will not use one branch as the base for
a giant cleanup PR.

## What the branch comparison established

### History

- `payment-aggregate` is 196 commits ahead of current `main` and changes 556
  files: 50,627 insertions and 15,675 deletions.
- `great-fermi` branched earlier, is seven commits behind current `main`, and
  changes 44 files: 6,905 insertions and 9 deletions.
- Their merge base with each other is `15e48fac7`.
- Neither branch contains the other. Git finds no patch-equivalent unique
  commits between them.
- A payment-aggregate commit whose message mentions merging great-fermi only
  merged `main`; it did not merge the great-fermi work.
- The basic payment table schema is already on `main`. Both branches build on
  that shared result.
- `main` already has a dormant six-table payment schema without runtime callers.
  The aggregate schema tables are `payment_sessions`,
  `payment_completion_effects`, `payment_completion_deliveries`,
  `payment_charges`, `payment_cases`, and `payment_case_decisions` (defined in
  `src/shared/db/migrations/schema/payments/`). Because that migration has
  shipped, do not add drop-and-recreate churn against these dormant aggregate
  tables. The first aggregate stack must give each of these tables a complete
  production role or drop it at the end of that stack. Existing tables are not
  permission to add unused repositories, codecs, indexes, or exports. These
  dormant aggregate tables are distinct from the legacy reader tables
  (`processed_payments`, `checkout_stages`, `sumup_checkouts` and related PII
  sources) that PR 13 reads as historical input and PR 16 drops.

### Architectural result

`payment-aggregate` is the operational base, but it must not be copied as-is.
Its own TODO records unresolved migration, ledger, refund, retention, provider,
and concurrency faults. Its coverage gate is also still incomplete.

`great-fermi` is the preferred model for overlapping pure payment rules. Its
best idea is one `outcomeOf` diagnosis shared by live resolution and validation
of stored evidence. However, its new payment-state modules have no production
callers. It is not a deployable feature and must not be merged as a standalone
layer of dead code.

## Non-negotiable delivery rules

1. Every PR must change fewer than 800 lines under `src/` in its final diff
   against its parent. Count production-code insertions plus deletions.
2. Tests, fixtures, and documentation may take the total diff above 2,000
   changed lines when that is needed for complete coverage and mutation testing.
   Keep them focused and remove duplication, but do not weaken tests to meet an
   overall line count.
3. Every PR must pass `nix develop -c deno task precommit` before review.
4. Every changed source file must pass targeted mutation testing before its PR
   is merged. Run the branch-level mutation gate after committing the PR.
5. Every new production export must have a production caller in the same PR. Do
   not copy great-fermi's test-only-export exemptions.
6. Every bug fix must include a regression test reproducing the bug.
7. Each PR must leave one production path for the behavior it changes. Do not
   add a second payment implementation for later cleanup.
8. Do not add aliases or compatibility wrappers between the two branches' names.
   Move every caller to the selected API and delete the displaced API.
9. Deployments are forward-only and fleet-wide. Do not support old application
   versions, code rollback, or mixed-version reads and writes. The roughly
   two-second edge handoff is not a compatibility window; migration work starts
   only after the new release is authoritative.
10. Recalculate the `src/` line count after formatting. If it reaches 800
    changed lines, split the production behavior before review.
11. Every PR must improve the system that is live when that PR merges. A test,
    schema, repository, or helper needed only by a later PR is not enough.
12. Every PR description must name its immediate current-system value and the
    production route, worker, admin page, or write path that receives it.
13. If a planned slice cannot be wired into the current system below the line
    limit, split it vertically by behavior. Do not land dormant foundations.
14. A new durable case or due-work kind must ship with every owner action and
    scheduled recovery path it requires. Do not persist work that no live route
    or worker can finish.
15. A behavior-wide cutover may be preceded by small refactors that improve the
    current production path and replace its old mechanism immediately. It may
    not be preceded by an unused aggregate adapter or a second implementation.

Suggested size check:

```bash
git diff --numstat <parent>...HEAD -- src/
```

The PR description must state the summed `src/` insertions and deletions, plus
the total diff size for review context.

## Decided behavior

The answers in `QUESTIONS.md` are binding requirements:

- A failed checkout that shows captured money stops automatic work and creates
  an owner case. The owner must complete the booking or refund it.
- A completed refund counts immediately even when the provider's cumulative
  total lags. New overlapping refunds stay blocked while reconciliation reads
  the provider again.
- Every captured charge is stored, but more than one captured charge on one
  payment requires owner review.
- A queued owner email uses the current business address at send time. Its body
  and buyer facts remain the stored payment snapshot.
- An incomplete or contradictory legacy record is copied without invented facts,
  marked for owner review, and does not stop the rest of the migration.
- A buyer whose paid booking needs review sees that payment was received, that
  the booking needs review, and that they must not pay again. Reloading shows
  the same stable result.
- No aggregate checkout path becomes authoritative until the owner can view its
  evidence and perform every supported required action.
- Retry and replay rules apply only to duplicate callbacks or interrupted work
  handled by the current version. The system never emulates an older version's
  payment behavior.

## Target architecture

### Pure payment domain

Use one schema-first domain under `src/shared/payment-state/`:

- `words.ts`: canonical state and resource vocabularies.
- `resources.ts`: provider resources and integer minor-unit money.
- `observation.ts`: ownership proof and normalized provider readings.
- `conflict.ts`: exhaustive conflict kinds.
- `diagnose.ts`: the only function that judges settled money.
- `refund.ts`: pure refund accounting and resolution.
- `resolve.ts`: converts provider-read outcomes into payment outcomes.
- `lifecycle.ts`: validates durable payment outcomes.
- `decision.ts`: owner choices and immutable reviewed evidence.
- `record/`: rules checked at repository write boundaries.

Prefer the great-fermi versions, adapted to the aggregate's actual legacy
sources and runtime types. Do not retain payment-aggregate's duplicate
vocabularies or duplicate diagnosis.

### Persistence and runtime

Keep and harden payment-aggregate's:

- payment, charge, case, decision, effect, and delivery repositories;
- revision and lease guards;
- persist-before-provider checkout creation;
- provider-neutral create/read/refund contract;
- one claimed reconciliation path;
- durable booking and refund completion;
- scheduled recovery and owner alerts;
- owner payment-case pages;
- bounded legacy migration, backup, restore, and redaction.

Do not copy `payment-runtime/legacy-replay.ts`, `legacy-sumup.ts`,
`operator-legacy-read.ts`, or an equivalent runtime branch selected by record
age or origin. Migration code may decode an old stored format only to write a
canonical current payment or owner-review case. After that write, the current
payment engine is the only code allowed to read, reconcile, refund, complete, or
display it. Provenance and unknown facts may preserve evidence; they must not
dispatch to different runtime behavior.

Each write must validate the complete prospective record with the pure rules,
write with revision or lease fencing, and validate the returned row. There must
not be parallel raw-row and decoded-domain implementations of the same rule.

### Deployment model

Every payment-system release uses the fleet-wide `release` deployment. Do not
ship these commits through `alpha` or `beta`, and do not roll back to an older
application build. Bunny's roughly two-second script handoff is operational
overlap, not a supported mixed-version state; it must not cause a runtime
branch, schema adapter, or legacy replay path.

Deploy the aggregate write cutover first. Start forward data migration only in a
later fleet-wide release after that cutover has completed.

## Work sequence

The estimates below are total-diff review targets, not hard limits. Complete
tests may exceed them; every file under `src/` counts toward the 800-line source
limit, including locales and checked-in assets. Deliver the work as several
completed stacks of three to seven independently useful PRs. Merge and rebase a
stack before opening the next dependency layer.

The numbered items are behavior requirements, not a required PR count. Combine
or remove them whenever that eliminates dormant foundations, compatibility
paths, or deferred cleanup.

The expected stack boundaries are PRs 1-4, PRs 5-11, and PRs 12-16. Change a
boundary when a dependency demands it, but keep each stack within three to seven
green PRs and finish activating or removing its schema before merging it.

For every stage, ask: "If all later PRs were cancelled, what became better for
the people or operators using this version?" The `Current-system value` answer
must be observable in a production route, worker, page, stored invariant, or
security boundary. Future reuse, tests alone, documentation alone, and an unused
database abstraction do not qualify.

### Phase 0: improve and specify the current payment path

#### PR 1: Lock the chosen safety behavior

Budget: 800-1,300 changed lines.

- Turn every answer from `QUESTIONS.md` into a named acceptance rule.
- Fix the current path so disabling new sales does not disable refunds or
  reconciliation for money already taken.
- Add focused regression tests for callback replay, provider outages, booking
  completion, and refunds.
- Reconcile the branches' TODO findings and assign each live finding to a PR.

Current-system value: existing payments remain refundable when sales are off,
and the current behavior is protected before it is rewritten.

#### PR 2: Use one money and resource vocabulary now

Budget: 1,200-1,600 changed lines.

- Adapt great-fermi's `words.ts`, `resources.ts`, and `validation/kind.ts`.
- Replace current provider money/resource parsing with these schemas.
- Bring only exports used by the current provider code in this PR.

Current-system value: current callbacks reject malformed amounts, currencies,
and blank provider IDs consistently across providers.

#### PR 3: Check provider ownership on the current path

Budget: 1,200-1,700 changed lines.

- Adapt great-fermi's strict provider observation boundary.
- Allow an unrecorded child only when it is a charge under the same pending
  checkout.
- Wire SumUp's current callback path first and block unknown unsigned callbacks
  from causing unbounded provider reads.

Current-system value: current SumUp callbacks cannot attach unrelated resources
or be used to amplify outbound requests.

#### PR 4: Use one diagnosis for current settled money

Budget: 1,300-1,800 changed lines.

- Adapt `conflict.ts`, `diagnose.ts`, and `refund.ts`.
- Count a completed refund immediately while blocking overlap until the
  provider's cumulative total catches up.
- Treat multiple captures as a conflict and reject duplicate resources, wrong
  currencies, wrong parents, over-refunds, and money on a free checkout.
- Replace the current callback and refund classification with `outcomeOf`.

Current-system value: the live system stops repeat refunds and detects captured
money combinations it currently misses.

#### PR 5: Resolve current payment cases end to end

Budget: 1,700-2,500 changed lines.

- Adapt great-fermi's `resolve.ts` and `lifecycle.ts`, and rerun `outcomeOf`
  whenever stored evidence is validated.
- Adapt aggregate case storage, great-fermi's case and decision rules, and only
  the repository operations used by this workflow.
- Turn each current durable payment issue into a revisioned case. Show affected
  buyers that payment was received, review is needed, and they must not pay
  again; make reload return the same result.
- Alert only the current unsent revision, retry unattended alert work on
  schedule, and let one permanent failure leave later work runnable.
- Add owner-only list and detail routes showing money, evidence, attempts, and
  affected records. Gate every link with its target's permission and existence
  rules.
- Ship all valid actions with the first case: keep unchanged, complete a proven
  booking, refund remaining money, and confirm an existing full refund. Re-read
  the provider, require the current revision and evidence, and complete both
  payment state and Money before closing a refund decision.
- Model the required choice and reviewed evidence as one discriminated union;
  persist the reason, evidence snapshot, claim, attempt, and result.
- If the source limit requires more than one PR, split by complete case kind.
  Each slice must include detection, stable buyer result, alert, owner page,
  every action for that kind, and scheduled recovery before it merges.
- Remove the displaced classifier and every superseded case path.

Current-system value: every current payment problem the app can create is
visible, actionable, recoverable, and cannot invite the buyer to pay twice.

### Phase 1: cut each live operation over for all providers and callers

Do not migrate Stripe, Square, and SumUp in separate PRs. A behavior cutover
updates all three provider adapters and every entry point, then deletes the old
implementation for that behavior. Shared provider contracts are exhaustive
records keyed by provider, so adding or omitting a provider is a compile error.

#### PR 6: Make aggregate checkout creation authoritative

Budget: 1,500-2,200 changed lines.

- Save immutable expected money and booking intent before every provider call.
- Claim creation, use one payment identity and idempotency key, and adopt the
  original provider resource after an uncertain response.
- Return the same buyer URL on replay and release or schedule every failed
  claim.
- Move Stripe, Square, and SumUp checkout creation together. Keep SumUp's local
  payment, checkout, and transaction IDs distinct and use stored currency.
- Delete every replaced checkout-creation path and old SumUp checkout writer.

Current-system value: no live checkout can lose its local intent or create a
second provider checkout after an interrupted request.

#### PR 7: Make aggregate payment reads authoritative

Budget: 1,700-2,400 changed lines.

- Move all provider reads behind one strict observation contract. Cover missing,
  invalid, unavailable, pending, paid, free, and failed results.
- Retrieve Square payment IDs named by the order instead of scanning a short
  list. Validate every resource's account, currency, amount, and parent.
- Route signed callbacks, buyer returns, manual refresh, owner-case refresh, and
  scheduled retries through one claimed reconciliation function that reads,
  resolves, and persists once.
- Store every charge identity once, reject cross-payment reuse, and open a case
  for multiple captures. Persist evidence, charges, state, due time, revision,
  and case changes in one transaction.
- Cut live writers and readers over to the aggregate, but keep old payment
  tables readable as historical source until PR 14 has copied each row. Delete
  only the displaced production readers; keep migration readers reachable so
  payments not yet copied remain visible on panels, exports, and statistics and
  refund targets can still be derived from old records.
- After the last live writer moves, install the migration write fence that
  forbids new production writes to old payment tables. The fence must not block
  the refund-completion write path (`processed_payments.provider_refunded_at`
  via `markPaymentReferencesProviderRefunded`), so schedule it only after the PR
  8 refund cutover, or scope it in this PR to exclude refund-completion columns.
  Verify that fence before committing an aggregate write.

Current-system value: every live route, worker, page, and export gets the same
authoritative answer for the same payment.

#### PR 8: Make aggregate refunds authoritative

Budget: 1,500-2,200 changed lines.

- Move Stripe, Square, and SumUp refund request/read behavior together.
- Put individual, bulk, balance, automatic, case-decision, and migrated-payment
  refunds through one one-or-many engine.
- Persist provider refund identity before local completion. Queue and schedule
  repair when provider success is followed by a local failure.
- Keep refunds available while new sales are disabled, and make callback and
  admin replay idempotent.
- Delete every replaced refund path and prove no production caller uses it.

Current-system value: every refund has the same retry, evidence, and Money
guarantees and cannot move money twice.

### Phase 2: make each completion effect durable when introduced

Every durable effect below includes its bounded due-work query and scheduled
runner in the same PR. Request paths may try work immediately, but they are not
the only recovery mechanism.

#### PR 9: Resume paid booking completion

Budget: 1,500-2,200 changed lines.

- Persist the exact capacity, attendee, answer, modifier, package, balance, and
  Money effects before running them; snapshot paid facts so listing edits cannot
  change delivery.
- Complete each effect idempotently, schedule unfinished work, and prevent one
  permanent failure from starving later payments.
- Fence listing deletion and repoint affected payment work during attendee
  merges in this same cutover.

Current-system value: interrupted paid bookings resume without charging,
booking, or recording Money twice and cannot be orphaned by an admin action.

#### PR 10: Resume automatic refund completion

Budget: 1,300-1,900 changed lines.

- Persist the refund path used when paid booking completion cannot be honoured.
- Record provider refund and local Money completion as separate durable effects
  handled by the refund engine from PR 8.
- Schedule unfinished provider and Money work with explicit provider, database,
  and total subrequest budgets.

Current-system value: a provider refund that succeeds before a local failure is
repaired without waiting for a buyer or owner request.

#### PR 11: Resume messages and outgoing webhooks

Budget: 1,300-1,900 changed lines.

- Store prepared message and webhook bodies plus buyer facts before delivery.
- Resolve the owner recipient from the current business address at send time.
- Attempt and schedule each delivery independently; mark permanent failures
  without blocking later work.

Current-system value: delayed messages use the right owner address and recover
without one failed destination blocking the queue.

#### PR 12: Resume paid site assignment and renewal

Budget: 1,400-2,000 changed lines.

- Persist site assignment and renewal effects before remote work.
- Serialize concurrent paid renewals, keep remote calls outside transactions,
  and schedule unfinished work within the subrequest budget.
- Repoint queued site work during attendee merges in this same cutover.

Current-system value: paid site delivery and renewal recover safely after an
interruption, concurrent payment, or attendee merge.

### Phase 3: migrate history forward after the write cutover

Old tables are read-only migration input in this phase. No production payment
route, page, refund, reconciliation, or completion path may read them.

#### PR 13: Verify migration and old-backup readiness

Budget: 1,200-1,800 changed lines.

- Read `processed_payments`, `checkout_stages`, `sumup_checkouts`, attendee PII,
  and merge references into one lossless migration model without writing cases.
- Group one provider payment before pagination, convert old timestamps, and
  report contradictions through operator diagnostics or backup verification.
- Back up databases before migration. Restore an old schema only into the
  current application, where the same forward migration consumes it.
- Never deploy old code, recreate an old runtime, or interpret a payment using
  old behavior.

Current-system value: operators can prove a live database or old backup is safe
to migrate before changing payment history.

#### PR 14: Copy all old payment sources into current records

Budget: 1,700-2,500 changed lines.

- Begin only in a later fleet-wide release after aggregate writes are
  authoritative and old tables have remained unchanged.
- Copy every old source by stable cursor in bounded, verified pages. Never split
  one provider payment across pages or mistake an empty joined page for the end.
- Preserve unknown or contradictory facts without inventing values. Create a
  complete owner-review case using the PR 5 workflow and continue later rows.
- Expose each copied payment immediately through the existing current reader,
  result recovery, case, and refund paths. Include migrated charges in attendee
  refund targets and require owner evidence for ambiguous account assignment.
- Record verified progress and release leases within the call budget. Make the
  operation idempotent so interruption resumes from the same source cursor.

Current-system value: all historical payments become usable by the one current
payment engine without stopping on malformed history.

### Phase 4: retention and removal

#### PR 15: Redact terminal payment secrets

Budget: 1,200-1,800 changed lines.

- Redact intent, evidence, ticket tokens, and completion payloads only after all
  work that needs them is terminal.
- Cover completed balances, fully refunded payments, and delivered tickets.
- Page cleanup so one bad record cannot block later eligible rows.

Current-system value: deployed sites retain accounting history while removing
buyer secrets and ticket credentials they no longer need.

#### PR 16: Retire old payment storage

Budget: 1,000-1,600 changed lines, mostly deletions.

- Release only after every fleet database reports all source rows copied and
  verified, and no production caller outside migration reads an old table.
- Drop old tables and delete the migration reader, progress gates, old codecs,
  stale TODO entries, temporary exemptions, and dead exports together.
- Run full coverage, quality audit, Cucumber specs, exhaustive targeted
  mutations, and the final branch mutation gate.
- Update operator and database documentation.

Current-system value: the deployed app has one smaller payment implementation,
faster cold starts, and no ambiguity about which path is authoritative.

## Known faults that must be assigned, not lost

These findings from the branches are mandatory inputs to the assigned PRs:

| Finding                                                                    | Owning PR |
| -------------------------------------------------------------------------- | --------- |
| SumUp identities split across migration pages                              | 14        |
| A merged migration page mistaken for end-of-input                          | 14        |
| Old rows changing after the aggregate write cutover                        | 7, 14     |
| Deleted booking rows blocking migration forever                            | 14        |
| Attendee-only payment references skipped after an empty aggregate exists   | 14        |
| Ticket-use state resurrected during migration                              | 14        |
| Cross-payment duplicate provider charges                                   | 7         |
| Pending and completed refunds together exceeding captured money            | 4, 8      |
| Completed provider refunds missing from Money                              | 8, 10     |
| Owner refund decisions closing a case without closing Money                | 5, 8      |
| Bulk provider success followed by local failure having no repair path      | 8, 10     |
| Refund-all conflicting forever with unfinished completion                  | 8, 10     |
| One failed decision blocking all reconciliation                            | 5, 7      |
| Account lookup failure retaining a claim                                   | 7         |
| Migrated charges omitted from refund targets                               | 14        |
| Disabling new payments also disabling existing-payment refunds             | 1         |
| Concurrent renewals racing                                                 | 12        |
| Delayed completion rebuilding facts from edited live data                  | 9         |
| SumUp return IDs interpreted differently by different routes               | 6, 7      |
| Unknown unsigned SumUp callbacks triggering outbound reads                 | 3         |
| Square fallback reads scanning too short a list                            | 7         |
| Delayed work using live currency rather than stored currency               | 6         |
| Permanent provider or delivery errors retrying forever or blocking a queue | 5, 7, 11  |
| Queued site work retaining a deleted attendee ID after merge               | 12        |
| Listing attachments deleted before a payment fence succeeds                | 9         |
| Old payment-reference readers surviving after migration                    | 7, 16     |
| Terminal buyer details, completion data, or ticket tokens never redacting  | 15        |

If implementation reveals that one of these findings is incorrect, close it with
a short proof in the relevant PR. Do not silently omit it.

## Review strategy

Each PR description should contain exactly these review aids:

- behavior added or replaced;
- source branch and paths used as reference;
- old path deleted, or the named fleet migration whose inert source table still
  requires it;
- changed-line count;
- database and provider call count where relevant;
- tests and mutation commands run;
- which known faults the PR closes;
- its immediate current-system value and exact production caller.

Within each vertical PR, review pure schemas, transactions, provider parsing,
and orchestration as distinct commits where that helps. Do not turn those code
layers into independently merged dormant foundations. Migration reads remain a
separate boundary because they consume an inert stored format, not because they
provide a second payment runtime.

## Definition of done

- Every behavior requirement is merged in dependency order through completed
  stacks of three to seven PRs.
- Every PR changes fewer than 800 lines under `src/`.
- One production payment path remains.
- All three providers use one canonical read/refund contract.
- Every provider action and local ledger action is independently durable and
  resumable.
- Genuine ambiguity requires an explicit owner choice.
- Old backups migrate forward into the current version; old code is never
  redeployed and mixed application versions are never supported.
- Payment secrets and buyer details redact after all required work is terminal.
- `nix develop -c deno task precommit` passes.
- Full coverage is 100% and deterministic.
- Changed-source mutation score is 100%.
- Cucumber payment stories pass.
- No payment review finding or question remains open.
