# Payment aggregate integration plan

## Goal

Replace the current payment callback records with one durable payment system,
built from the strongest parts of two branches, delivered to `main` as pull
requests that each leave a complete, smoke-testable system. This file is the
working plan: status, binding rules, decided behavior, milestones, and the fault
ledger.

## Sources

- `origin/base/payment-aggregate` (#1962) is the operational reference: storage,
  claims, provider reads, reconciliation, booking completion, refunds,
  maintenance, migration, redaction, and owner pages. It is never merged or
  copied as-is — its own TODO records unresolved faults and its coverage gate is
  incomplete.
- `origin/claude/great-fermi-l2n29f` (#1973) is the reference for pure payment
  rules: money, provider observations, conflicts, stored records, and owner
  decisions. Its best idea is one `outcomeOf` diagnosis shared by live
  resolution and validation of stored evidence. It has no production callers and
  never merges as a standalone layer.
- Neither branch contains the other (merge base `15e48fac7`), and neither merges
  into `main`. Work lands as fresh milestone pull requests.

## Where we are

| Milestone                               | Status                                                                                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1 safety behavior (was PR 1)           | Merged as #2020. Also landed the M2 pure modules: `src/shared/payment/money.ts`, `resource-id.ts`, `refund-state.ts`, and `validated-session.ts`. |
| M2 money/resource vocabulary (was PR 2) | Core modules merged inside #2020. Any provider parsing still off those schemas rides with M3 or M4.                                               |
| M3 provider ownership (was PR 3)        | In flight. Merged slices so far: #2048 (payment processing core), #2050 (bounded registration delivery).                                          |
| M11 verifier slice (was PR 13)          | Started early in #2056 — the verifier is read-only and parallelizable.                                                                            |
| M4–M10 and M12–M13                      | Not started.                                                                                                                                      |

Budgets below count `src/` lines only. Observed totals run 4–15x the `src/`
figure once tests, stories, and catalog copy are included (#2020: 714 src lines,
10,519 total), so this plan no longer publishes total-diff estimates — they were
consistently wrong and governed nothing.

## Delivery rules

1. **Every merged PR stands alone indefinitely.** Each merge leaves one complete
   production system the owner can smoke test, with no dormant foundations, no
   release trains, and no code activated only by a later PR. Every new
   production export has a production caller in the same PR. A durable case or
   due-work kind ships with every owner action and scheduled recovery path it
   needs — or links to a still-live admin tool that resolves it. Each PR must
   improve the system that is live when it merges; a test, schema, repository,
   or helper needed only by a later PR does not qualify.
2. **One production path per behavior.** Migrate every caller and delete the
   displaced implementation in the same PR. No aliases or compatibility wrappers
   between the branches' names. The only sanctioned bridge is a named
   staged-migration adapter with a recorded removal milestone (currently two,
   both removed in M11: the M6 legacy read-through and the M7 legacy-refund
   adapter).
3. **Size.** Keep each PR under 800 changed `src/` lines (insertions plus
   deletions, recounted after formatting). One exception: an atomic cutover that
   would otherwise need a throwaway compatibility layer may exceed the cap — a
   bigger honest PR beats building a bridge in one PR and demolishing it in the
   next. Say so in the description. PR_WORKFLOW.md's "repository source-line
   limit" is this rule, exception included. Tests, fixtures, and documentation
   do not count against the cap; never weaken them to shrink a diff.
4. **Gates.** `nix develop -c deno task precommit` passes before review. Run
   targeted mutation on the payment modules the PR changed and list the runs in
   the description. The branch-level
   `nix develop -c deno task precommit:mutation` gate runs before merge as
   AGENTS.md requires. The gate is mandatory; a waiver is the owner's call
   alone, made case by case — never the implementer's — and the description
   records it plus the targeted runs that stand in for it.
5. **Every bug fix ships a regression test** reproducing the bug.
6. **Deployments are forward-only and fleet-wide**, on the `release` tier only.
   No old-version support, no code rollback, no mixed-version reads or writes.
   Bunny's roughly two-second script handoff is operational overlap, not a
   compatibility window — it must not cause a runtime branch, schema adapter, or
   legacy replay path. Data migration starts only in a later release, after the
   write cutover is authoritative.
7. **The dormant aggregate tables are already shipped** (`payment_sessions`,
   `payment_completion_effects`, `payment_completion_deliveries`,
   `payment_charges`, `payment_cases`, `payment_case_decisions`, defined in
   `src/shared/db/migrations/schema/payments/`). Do not add drop-and-recreate
   churn against them. Each must hold a complete production role by the end of
   Stack B or be dropped there — except `payment_completion_deliveries`, whose
   role arrives with M9 immediately after the stack; if M9 ends up not using it,
   M9 drops it. Their existence is not permission to land unused repositories,
   codecs, indexes, or exports.
8. **Port the source branch's tests** when adapting one of its modules; adapt
   existing tests rather than authoring from scratch. Never copy great-fermi's
   test-only-export exemptions.
9. **PR descriptions state**: the immediate current-system value and the exact
   production route, worker, page, or write path that receives it; the summed
   `src/` line count; the database and provider call budget whenever the slice
   touches providers or adds queries (Bunny's hard limit is 50 subrequests per
   request); the fault-ledger rows closed; the tests and mutation commands run;
   and the old path deleted (or the named staged-migration adapter that
   remains). The full field list is in steps 2, 5, and 6 of `PR_WORKFLOW.md`.
   Review pure schemas, transactions, provider parsing, and orchestration as
   distinct commits where that helps.

Size check:

```bash
git diff --numstat <parent>...HEAD -- src/
```

## Decided behavior

These binding product decisions are requirements. Each attaches to the milestone
that ships the behavior:

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
  evidence and perform every supported required action. Until a case kind's own
  page action ships (M7/M8), a supported action may be a link to a still-live
  admin tool that genuinely resolves that case kind.
- Retry and replay rules apply only to duplicate callbacks or interrupted work
  handled by the current version. The system never emulates an older version's
  payment behavior.

## Target architecture

### Pure rules (adapt from great-fermi)

All pure payment rules live in `src/shared/payment/`, beside the modules that
already landed — do not open a second directory. Landed: `money.ts` (integer
minor-unit money), `resource-id.ts`, `refund-state.ts`, `validated-session.ts`.
Still to adapt, named by job (final filenames may differ): provider observation
(ownership proof and normalized readings), conflict kinds (exhaustive),
`outcomeOf` diagnosis (the only judge of settled money), refund accounting,
resolution of provider-read outcomes into payment outcomes, lifecycle validation
of durable outcomes, owner decisions with immutable reviewed evidence, and
record rules checked at repository write boundaries. Do not retain
payment-aggregate's duplicate vocabularies or duplicate diagnosis.

### Persistence and runtime (keep and harden from payment-aggregate)

Payment, charge, case, decision, effect, and delivery repositories; revision and
lease guards; persist-before-provider checkout creation; the provider-neutral
create/read/refund contract; one claimed reconciliation path; durable booking
and refund completion; scheduled recovery and owner alerts; owner payment-case
pages; bounded legacy migration, backup, restore, and redaction.

Do not copy `payment-runtime/legacy-replay.ts`, `legacy-sumup.ts`,
`operator-legacy-read.ts`, or any equivalent runtime branch selected by record
age or origin. Migration code may decode an old stored format only to write a
canonical current payment or owner-review case; after that write, only the
current engine reads, reconciles, refunds, completes, or displays it. Provenance
and unknown facts may preserve evidence; they must not dispatch to different
runtime behavior. Every write validates the complete prospective record with the
pure rules, writes with revision or lease fencing, and validates the returned
row. There must not be parallel raw-row and decoded-domain implementations of
the same rule.

## Milestones

Milestones are behavior units, not a PR count: one milestone may land as several
standalone PRs (M3 already has), and each PR still satisfies every delivery rule
on its own. Stacks follow the AGENTS.md stacked-PR rules (three to seven PRs,
merged bottom-up). Provider cutovers move Stripe, Square, and SumUp together
behind exhaustive records keyed by provider, so adding or omitting a provider is
a compile error.

### Stack A — finish the current path (M3–M5)

#### M3: Check provider ownership on the current path (was PR 3, in flight)

Src target: remainder of ~800.

- Adapt the strict provider observation boundary. Allow an unrecorded child only
  when it is a charge under the same pending checkout.
- Wire SumUp's current callback path first; block unknown unsigned callbacks
  from causing unbounded provider reads.

Standalone value: current SumUp callbacks cannot attach unrelated resources or
be used to amplify outbound requests.

#### M4: One diagnosis for settled money — fail-closed cutovers only (was PR 4)

Src target: 400–700.

- Adapt the conflict, `outcomeOf`, and refund-accounting pure modules.
  `outcomeOf` replaces the current callback and refund classification as the
  only judge of settled money on the current path.
- Cut live only the outcomes whose remedy is refuse-and-record: block new
  overlapping refunds until the provider's cumulative total catches up while
  counting a completed refund immediately; reject duplicate resources, wrong
  currencies, wrong parents, over-refunds, and money on a free checkout.
- Conflicts that need an owner decision (multiple captures and kin): detect,
  record, and alert through the existing error classes, but keep today's
  behavior — these outcomes are not cut over, today's classifier keeps governing
  them, and no automatic work is stopped or stranded before an owner can act.
  The case workflow arrives one merge later (M5) and the page actions with
  M7/M8. Build no owner tooling on the legacy engines.

Standalone value: the live system stops repeat refunds and detects captured
money combinations it currently misses, with one classifier where there were
two.

#### M5: Payment cases — visible, stable, acknowledgeable (was PR 5, slimmed)

Src target: 500–800.

- Adapt the resolve, lifecycle, and decision pure rules, rerunning `outcomeOf`
  whenever stored evidence is validated, plus the case and decision repositories
  (only the operations used here).
- Every durable payment problem `outcomeOf` reports becomes a revisioned case.
  Affected buyers see the stable result decided above; reload returns the same
  answer.
- Owner-only list and detail routes show money, evidence, attempts, and affected
  records, with every link gated by its target's permission and existence rules.
  Alert only the current unsent revision; retry unattended alert work on
  schedule; one permanent failure leaves later work runnable.
- The recorded decision here is acknowledge/keep-unchanged, persisted with
  reason and evidence snapshot as the start of the decision union. Do not build
  money-moving case actions on the legacy engines: the case page links to the
  still-live admin tools (refunds, booking management) that genuinely resolve
  each case kind today. The case-page refund and completion actions ship with
  the engines that perform them (M7, M8).
- A case re-checks its evidence on schedule and whenever its payment's records
  change: when a refund or completion done through a linked tool removes the
  problem, rerunning `outcomeOf` closes the case and updates the buyer's result.
  The links genuinely resolve the case, not only the money.
- Guard attendee merge and delete against records with an open case: repoint or
  settle before the destructive step.

Standalone value: every payment problem the current app can create is visible,
alerted, buyer-safe, and resolvable through live tools.

### Stack B — the aggregate cutover (M6–M8)

This stack ends with every dormant aggregate table holding its production role
or dropped. Old payment tables stay readable through the legacy read-through
adapter until M11 copies them; they are historical input, never a second
runtime.

#### M6: Aggregate checkout creation and reads become authoritative (was PRs 6+7)

Src target: 1,200–1,800 — the sanctioned atomic-cutover exception. Creation and
reads move in one merge precisely so no `sumup_checkouts` projection, no legacy
checkout-metadata preservation, and no projection-repair machinery ever exist.

The M6 release itself carries the restore-deploy guard (as its own commit is
fine): `.github/workflows/restore-deploy.yml` refuses to deploy a commit that
predates the aggregate cutover onto a database aggregate releases have written,
documented in the operator restore guide beside the backup's recorded commit.
The guard is live before the first aggregate write can happen in production.

- Creation: save immutable expected money and booking intent before every
  provider call; claim creation; one payment identity and idempotency key; adopt
  the original provider resource after an uncertain response; return the same
  buyer URL on replay; release or schedule every failed claim. All three
  providers at once. SumUp keeps its local payment, checkout, and transaction
  IDs distinct and uses stored currency. Store the provider on each charge so
  multi-provider history stays refundable.
- Reads: every provider read goes behind one strict observation contract
  covering missing, invalid, unavailable, pending, paid, free, and failed.
  Square payment IDs are named by the order, not scanned from a short list.
  Validate each resource's account, currency, amount, and parent; an account
  lookup failure releases its claim.
- One claimed reconciliation function serves signed callbacks, buyer returns,
  manual refresh, case refresh, and scheduled retries: it reads, resolves via
  `outcomeOf`, and persists once — evidence, charges, state, due time, revision,
  and case changes in a single transaction. Store every charge identity once and
  reject cross-payment reuse. Multiple captures open an M5 case.
- The aggregate readers replace `resolveWebhookSession` and `retrieveSession`
  for every caller — signed webhook callbacks, buyer return and cancel pages,
  and paid-session validation — and the displaced methods leave the
  `PaymentProvider` interface and all three provider implementations in this
  same cutover. The readers feed the existing completion contract
  (`src/shared/payment/validated-session.ts`), so the legacy completion, refund,
  finalize, and maintenance writers keep working unchanged — and keep writing
  their own rows — until M7 and M8. No write fence lands here.
- Adopt or expire every in-flight pre-cutover checkout (all three providers)
  atomically and idempotently: same claim, identity, and validation rules;
  concurrent callbacks and migration runs bind to one claim; defined outcomes
  for paid, pending, expired, and unavailable sessions. No paid checkout is
  stranded without an aggregate row.
- Keep uncopied old-table rows visible through the legacy read-through — the
  second sanctioned staged-migration adapter (delivery rule 2), one bounded
  contract serving panels, exports, statistics, and refund targets, removed in
  M11 — and delete only the displaced production readers.

Standalone value: no live checkout can lose its intent or create a second
provider checkout after an interrupted request, and every route, worker, page,
and export gets the same authoritative answer for the same payment.

#### M7: Aggregate refunds become authoritative (was PR 8)

Src target: 700–1,000 (may use the cutover exception if the adapter pushes it
over).

- Move Stripe, Square, and SumUp refund request/read behavior together.
  Individual, bulk, balance, automatic, and case-decision refunds run through
  one one-or-many engine. The migrated-payment caller arrives in M11, when
  migrated payments first exist.
- Persist provider refund identity before local completion; queue and schedule
  repair when provider success is followed by a local failure; keep callback and
  admin replay idempotent; keep refunds available while new sales are disabled.
- The M5 case actions that move money land here: refund remaining money, and
  confirm an existing full refund. Re-read the provider, require the current
  revision and evidence, and complete both payment state and Money before
  closing the decision.
- Legacy adapter (one of the two sanctioned staged-migration adapters; removed
  in M11): uncopied `processed_payments` rows and attendee-only legacy
  references resolved by `src/shared/db/payment-references.ts` route through the
  new engine. The adapter updates the old row's `provider_refunded_at`
  atomically inside the refund transaction — or the read-through consults the
  new refund record — so a completed refund never resurfaces as refundable. It
  fails closed into an owner case when the same provider reference spans
  multiple attendees, and when an attendee-only reference lacks a deterministic
  provider, account, captured amount, currency, or completion state. Those
  fail-closed cases carry their own required decision, shipped here: the owner
  supplies verified provider, account, and amount evidence — after which the
  refund proceeds through the engine — or rejects the refund. This is the same
  owner-evidence rule M11 applies to ambiguous account assignment.
- Delete every replaced refund path and prove no production caller remains.

Standalone value: every refund has the same retry, evidence, and Money
guarantees and cannot move money twice.

#### M8: Durable paid completion, including its failure path (was PRs 9+10)

Src target: 1,000–1,500 — cutover exception; the success and failure paths are
one machine and merge together.

- Persist the exact capacity, attendee, answer, modifier, package, balance, and
  Money effects before running them; snapshot paid facts so listing edits cannot
  change delivery. Complete each effect idempotently, schedule unfinished work,
  and stop one permanent failure from starving later payments.
- When completion cannot be honoured, persist the chosen refund path and record
  the provider refund and local Money completion as separate durable effects
  driven by the M7 engine, with explicit provider, database, and total
  subrequest budgets.
- The M5 complete-a-proven-booking case action lands here.
- Fence listing deletion against pending payment work; repoint payment work and
  open cases during attendee merges. Move the maintenance writers off the old
  tables — and the admin action itself always completes: merge, delete, and
  prune succeed for attendees with uncopied historical rows, and only the legacy
  row's own removal waits. Each writer verifies a row is copied before deleting
  it and otherwise leaves the row for M11 to copy and prune;
  `deleteAllStaleReservations` is gated the same way, so no path ever deletes an
  uncopied legacy row. Before a merge or delete completes for an attendee whose
  payment history is not yet copied, the attendee-held migration facts — legacy
  payment references and the payment-identifying facts M11 reads, still
  encrypted — are preserved in a durable migration snapshot that M11 consumes
  (or that attendee's payments are canonicalized on the spot), so completing the
  deletion loses nothing the copy needs.
- Install the legacy write fence, now that the last routine legacy writer has
  moved, with exactly one exemption until M11: the M7 adapter's
  refund-completion marker. Verify the fence atomically inside the committing
  transaction (shared transaction, advisory lock, or epoch token); fail and
  retry the write if the epoch moves.

Standalone value: interrupted paid bookings resume without charging, booking, or
recording Money twice; a provider refund that outruns a local failure repairs
itself; and no admin action can orphan payment work.

### Group C — follow-on durable effects (M9–M10)

These two are not a literal stack: each is an independent single PR on top of
merged M8 (M10 does not depend on M9), merging directly to main or riding as a
top layer of Stack B — AGENTS.md's three-to-seven rule applies to real stacks.
Both are new effect kinds on M8's machinery — bounded due-work query and
scheduled runner included, request paths as first attempt only.

#### M9: Durable messages and outgoing webhooks (was PR 11)

Src target: 300–600. Store prepared message and webhook bodies plus buyer facts
before delivery; resolve the owner recipient from the current business address
at send time; attempt and schedule each delivery independently; mark permanent
failures without blocking later work.

Standalone value: the M8 completion runner's messages and webhooks use the
current owner address, recover on schedule after an interruption, and one
permanently failing destination no longer blocks the rest of the queue.

#### M10: Durable site assignment and renewal (was PR 12)

Src target: 300–600. Persist site assignment and renewal effects before remote
work; serialize concurrent paid renewals; keep remote calls outside
transactions; repoint queued site work during attendee merges; schedule
unfinished work within explicit provider, database, and total subrequest
budgets.

Standalone value: paid site delivery and renewal recover safely after an
interruption, a concurrent payment, or an attendee merge.

### Stack D — history and retirement (M11–M13)

#### M11: Verify, then copy all payment history forward (was PRs 13+14)

Src target: verifier 400–600; copy 800–1,200 (cutover exception). The verifier
is read-only and parallelizable — #2056 already started it; the copy releases
only after M8 is authoritative fleet-wide.

- Verifier: read `processed_payments`, `checkout_stages`, `sumup_checkouts`,
  attendee PII, merge references, and the M8 deletion snapshots into one
  lossless model without writing cases. Group one provider payment before
  pagination; convert old timestamps; report contradictions through operator
  diagnostics and backup verification. Attendee PII is owner-key-encrypted: the
  run sits behind an owner-authenticated step and reaches the key only through
  the existing request-scoped private-key path
  (`src/shared/session-private-key.ts`) — never a pasted or persisted key
  string. Unwrapped key material stays out of migration state, progress records,
  logs, audits, and backups; decrypted PII lives only in run-bounded caches
  cleared when the run ends; record key provenance and access audits, not the
  key. If the key is unavailable, block the migration and preserve the source
  rows — never silently skip charges. Back up databases before migrating.
  Restore an old schema only into the current application, where this same
  forward migration consumes it.
- Copy precondition: old tables unchanged since M8's fence except the adapter's
  versioned refund-completion writes. The copy-consistency protocol is
  fence-and-drain: pause `applyAttendeeMerge`, `deleteAttendee`, the prune task,
  and `deleteAllStaleReservations` for the duration of the copy. The M7 adapter
  is the only permitted concurrent writer, and the cursor detects and replays
  its versioned writes before marking a row verified. Lease ownership, renewal,
  and timeout details are fixed in the M11 behavior contract (`PR_WORKFLOW.md`)
  before the first cursor page.
- Copy every source by stable cursor in bounded, verified pages. Never split one
  provider payment across pages; never mistake an empty joined page for the end;
  deleted booking rows do not block; ticket-use state is not resurrected;
  attendee-only references are copied, not skipped. Preserve unknown or
  contradictory facts without inventing values — create a complete M5 case and
  continue. Require owner evidence for ambiguous account assignment. Delete each
  M8 deletion snapshot the moment its payment is copied and verified — the same
  gate as any source row, idempotent across interrupted or restored runs — so no
  duplicate buyer facts outlive the migration; M13 verifies none remain.
- Each copied payment is immediately served by the current readers, result
  recovery, cases, and refunds; migrated charges join attendee refund targets
  through the M7 engine in this same release. Record verified progress and
  release leases within the call budget; interruption resumes from the same
  cursor.
- Retire the M7 adapter only after every row is verified and a final
  reconciliation pass has caught any refund that completed between verification
  and drain.

Standalone value: operators can prove a live database or old backup is safe to
migrate, and all history becomes usable by the one current engine without
stopping on malformed rows.

#### M12: Redact terminal payment secrets (was PR 15)

Src target: 400–700. Redact intent, evidence, ticket tokens, completion
payloads, and the stored delivery records from M9 — prepared message and webhook
bodies plus their buyer facts — only after all work that needs them is terminal,
including deliveries that permanently failed; cover completed balances, fully
refunded payments, and delivered tickets; page cleanup so one bad record cannot
block later eligible rows.

Standalone value: deployed sites keep accounting history while shedding buyer
secrets and ticket credentials they no longer need.

#### M13: Retire old payment storage (was PR 16)

Src target: 600–1,000, mostly deletions. Release only after every fleet database
reports all source rows copied and verified and no production caller outside
migration reads an old table.

- Drop the old tables and delete the migration reader, progress gates, old
  codecs, stale TODO entries, temporary exemptions, and dead exports together —
  except a restore-only reader and codec path (or a restore-time conversion
  step, documented in the operator restore guide) so a pre-aggregate backup
  still migrates forward.
- The table-drop migration must not be an unconditional `DROP TABLE` in
  `initDb`: a restore of an old backup would drop `processed_payments`,
  `checkout_stages`, and `sumup_checkouts` before the retained reader has
  anything to read. Make the drop conditional on verified copy progress, or
  convert at restore time before schema migrations run.
- Run full coverage, the quality audit, Cucumber specs, exhaustive targeted
  mutation, and the final branch mutation gate. Update operator and database
  documentation.

Standalone value: one smaller payment implementation, faster cold starts, and no
ambiguity about which path is authoritative.

## Fault ledger

Every row is a mandatory input to its owning milestone: close it with a
mechanism and a regression test, or — if implementation proves the finding wrong
— with a short proof in the PR. Never silently drop one.

| #   | Finding                                                                                | Owner           |
| --- | -------------------------------------------------------------------------------------- | --------------- |
| F1  | Disabling new payments also disabled existing-payment refunds                          | Closed by #2020 |
| F2  | Unknown unsigned SumUp callbacks triggering outbound reads                             | M3              |
| F3  | Pending and completed refunds together exceeding captured money                        | M4, M7          |
| F4  | One failed decision blocking all reconciliation                                        | M5, M6          |
| F5  | Permanent provider or delivery errors retrying forever or blocking a queue             | M5, M6, M9      |
| F6  | Attendee merge or delete removing records with an open case or unfinished work         | M5, M8          |
| F7  | Restore-deploy workflow allowing incompatible code onto a migrated database            | M6              |
| F8  | Cross-payment duplicate provider charges                                               | M6              |
| F9  | Account lookup failure retaining a claim                                               | M6              |
| F10 | SumUp return IDs interpreted differently by different routes                           | M6              |
| F11 | Square fallback reads scanning too short a list                                        | M6              |
| F12 | Delayed work using live currency rather than stored currency                           | M6              |
| F13 | Charges without a stored provider unrefundable after a provider switch (#2020 gap)     | M6              |
| F14 | In-flight pre-cutover checkouts paid after the cutover, stranded without a row         | M6              |
| F15 | Old rows changing after the aggregate write cutover                                    | M6, M8, M11     |
| F16 | Old payment-reference readers surviving after migration                                | M6, M13         |
| F17 | Owner refund decisions closing a case without closing Money                            | M7              |
| F18 | Completed provider refunds missing from Money                                          | M7, M8          |
| F19 | Bulk provider success followed by local failure having no repair path                  | M7, M8          |
| F20 | Refund-all conflicting forever with unfinished completion                              | M7, M8          |
| F21 | The same provider reference on two attendees refunded twice through bulk refunds       | M7              |
| F22 | An adapter-completed refund resurfacing as refundable on an uncopied row               | M7              |
| F23 | Attendee-only payment references skipped, or refunded without verified facts           | M7, M11         |
| F24 | Delayed completion rebuilding facts from edited live data                              | M8              |
| F25 | Listing attachments deleted before a payment fence succeeds                            | M8              |
| F26 | `deleteAllStaleReservations` deleting uncopied legacy rows under the fence or mid-copy | M8, M11         |
| F27 | Concurrent renewals racing                                                             | M10             |
| F28 | Queued site work retaining a deleted attendee ID after merge                           | M10             |
| F29 | SumUp identities split across migration pages                                          | M11             |
| F30 | A merged migration page mistaken for end-of-input                                      | M11             |
| F31 | Deleted booking rows blocking migration forever                                        | M11             |
| F32 | Ticket-use state resurrected during migration                                          | M11             |
| F33 | Migrated charges omitted from refund targets                                           | M11             |
| F34 | Late refund-completion writes landing after a row was copied and verified              | M11             |
| F35 | Migration silently skipping charges whose PII key or source is unavailable             | M11             |
| F36 | Terminal buyer details, completion data, or ticket tokens never redacting              | M12             |
| F37 | An unconditional table drop destroying a restored old backup before it migrates        | M13             |
| F38 | Attendee merge or delete destroying attendee-held payment facts before the copy        | M8, M11         |

## Done means

- Every milestone is merged in dependency order — through stacks of three to
  seven PRs where the work is stacked, or as the independent single PRs Group C
  names — each merge standing alone under the delivery rules.
- One production payment path remains; all three providers share one canonical
  create/read/refund contract; every provider action and local Money action is
  independently durable and resumable; genuine ambiguity requires an explicit
  owner choice.
- Old backups migrate forward into the current version; the restore-deploy guard
  refuses pre-aggregate code on a forward-migrated database; old code is never
  redeployed and mixed application versions are never supported.
- Payment secrets and buyer details redact once all required work is terminal.
- `nix develop -c deno task precommit` passes; coverage is 100% and
  deterministic; changed-source mutation score is 100%; Cucumber payment stories
  pass; every fault-ledger row and open question is closed.
