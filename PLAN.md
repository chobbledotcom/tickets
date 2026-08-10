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

| Milestone                               | Status                                                                                                                                             |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1 safety behavior (was PR 1)           | Merged as #2020. Also landed the M2 pure modules: `src/shared/payment/money.ts`, `resource-id.ts`, `refund-state.ts`, and `validated-session.ts`.  |
| M2 money/resource vocabulary (was PR 2) | Core modules merged inside #2020. Any provider parsing still off those schemas rides with M3 or M4.                                                |
| M3 provider ownership (was PR 3)        | Complete: #2048 (payment processing core), #2050 (bounded registration delivery), #2060 (observation boundary + SumUp callback wiring; F2 closed). |
| M11 verifier slice (was PR 13)          | Started early in #2056 — the verifier is read-only and parallelizable.                                                                             |
| M4–M10 and M12–M13                      | Not started.                                                                                                                                       |

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
   AGENTS.md requires — no per-PR waivers. If an exceptional cutover genuinely
   cannot run the branch gate, the owner first changes the policy in AGENTS.md;
   this plan cannot loosen a repository rule.
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

## Data laws

Eight laws govern how every part of this program behaves around data. Each
milestone contract instantiates them for the data it touches and says which law
admits each new state, consumer, or fact — so a review finding of one of these
shapes is answered by the law, and a design that satisfies them up front rules
the shape out as a class. M4's concurrency section ("the reference row is one
state machine") is the first instantiation; M5's cases, M6's aggregate rows,
M7's refund jobs, M8's completions, and M11's migration copies are all data
these laws bind.

1. **One authority per fact.** Each fact has one canonical representation and
   one place that computes it; every other appearance derives from that copy and
   is regenerated, never restated. Two definitions of one value — a second
   judge, a second serialization, a second total — are a defect even while they
   agree.
2. **Facts carry provenance: signed, stored, or observed — never ambient.** A
   decision consumes only facts the datum carries, evidence a read proved, or
   values signed at creation. Live settings may order a search; they never
   decide a fact. A fact nothing carries is explicitly not evaluable, or an
   honest failure naming what is missing — never filled from today's
   configuration.
3. **Identity is immutable; everything else is an attribute.** Compare, merge,
   deduplicate, and index by the smallest immutable identity. A changed
   attribute updates its datum in place and is itself a recordable event; it
   never mints a second datum.
4. **Stored state is a declared machine with a total lifecycle.** Every state
   names what creates it, every consumer that must recognize it — readers and
   writers alike, including cleanup, merge, delete, restore, and replay — what
   retires it, and how it ages out under retention. A consumer that cannot read
   the authoritative record routes on a mirror written in the same statement,
   never on a proxy. A state and all its consumers ship in one slice.
5. **Decisions bind to complete, versioned evidence.** A path that acts reads
   the full declared evidence shape for its source — no path decides on less
   than the source's declared observation — and every consequential write is
   fenced on the exact evidence it judged: changed evidence forces a re-judge,
   and recorded evidence only grows, by merge, never replacement.
6. **Data never moves to weaker protection.** A fact under a stronger key or
   boundary is never copied under a weaker one. Cross-boundary comparison uses
   one-way codes; a plaintext mirror carries a state word, never contents.
7. **External parties are capability records.** What a provider guarantees — an
   idempotency key, a cumulative total, an event authority — is declared once,
   and every behavior derives from the declared capability, never a per-party
   arm, so a new party inherits the whole discipline by declaration.
8. **Atomicity before compensation.** Facts that must agree and live in this
   database change in ONE atomic write — the same statement, or one libsql batch
   or interactive transaction, which commit whole and roll back whole, with a
   conditional write's affected-rows count deciding a winner (the helpers in
   AGENTS.md's Transactions and Batches section). Never write one half and
   defend the gap with a check, a retry, or a repair pass. Guards, fences,
   staleness rules, and re-judges are reserved for the one gap atomicity cannot
   close — an external call or a concurrent request in the middle — and each one
   names the gap it spans. When a review offers "add a guard, or make the write
   atomic", atomic wins.

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
  currencies, wrong parents, over-refunds, and money on a free checkout. Every
  refund entry point claims the payment's complete reference set all-or-none
  before any provider call (a row-less legacy reference gets its row minted by
  the claim), so concurrent refund runs serialize locally for every provider —
  SumUp has no idempotency key, and a keyless refund whose answer is lost stays
  claimed until evidence or a safe timeout resolves it.
- The stored payment row is one declared state machine — claims with owner
  scope, owner-review markers, committed evidence, terminal outcomes — bound by
  six laws every consumer follows (the contract's concurrency section).
  Committed evidence only grows by merge. Judgments use only signed, stored, or
  provider-proven facts, never today's settings: a stored reference's provider
  is carried, or discovered by a validated read and tagged on the terminal
  write, and a reference no credentialed provider validates fails honestly —
  refundable from the provider dashboard — until M6's backfill tags it (the M4
  slice of F13); a stored reference's judgment reads no live site currency (the
  M4 slice of F12). M6's stored provider and currency close both for every row.
  Each provider has one declared evidence shape that every money-moving path
  supplies whole — for Square, the payment plus its order's captured-tender
  sweep, so an admin refund or refresh sees a sibling capture even when no
  callback redelivery ever revealed it. Writers follow the same routing: an
  attendee merge or delete fails closed while a refund claim or staged refund is
  live on any affected row (the M4 slice of F6).
- Every refund run — bulk or single attendee — is admitted against the request's
  remaining subrequest budget before any provider call, priced at each adapter's
  physical worst case; an oversized run refuses whole with zero provider calls
  and a plain reason on every row. This is the M4 slice of F53; the paged engine
  that processes arbitrarily large runs is M7's.
- Conflicts the system must not resolve on its own (multiple captures and kin):
  `outcomeOf` is the only classifier here too — the displaced classifier is
  deleted in this same merge, so two judges can never disagree about the same
  money. One handler maps these outcomes onto the decided behaviors: every
  multi-charge observation is an owner-review case — when the captures sum to
  the signed total and nothing else is wrong, the booking proceeds and the owner
  is alerted through the existing error classes (the decided automatic
  exception; automatic refunds act on single-charge observations only) — while
  partial-refund evidence on a booking, or a multi-charge observation that also
  fails validation, parks with the buyer retained and the manual-check answer.
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
  the engines that perform them (M7, M8). A case kind ships here only when a
  live tool genuinely resolves it. For captured money on a failed booking, the
  in-app refund route cannot act on the stored quantity-0 placeholder, so that
  case links to the provider's own dashboard refund and closes once the refund
  reaches the payment's records (provider callback or the scheduled re-check); a
  kind with no genuine live resolution keeps M4's detect-and-alert behavior
  until its engine action ships.
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
fine): once the cutover release has shipped,
`.github/workflows/restore-deploy.yml` refuses to deploy any commit that
predates the aggregate cutover — regardless of what the restored database
contains, because a pre-cutover backup carries no aggregate marker and its
recorded commit would restart the legacy writers. Restoring an old backup means
loading it into the current application, which migrates it forward (M11's
restore contract). Document this in the operator restore guide beside the
backup's recorded commit; the guard is live before the first aggregate write can
happen in production.

- Creation: save immutable expected money and booking intent before every
  provider call; claim creation; one payment identity and idempotency key; adopt
  the original provider resource after an uncertain response; return the same
  buyer URL on replay; release or schedule every failed claim. All three
  providers at once. SumUp keeps its local payment, checkout, and transaction
  IDs distinct and uses stored currency. A checkout spanning several listings
  stays one payment with one shared order: the stored intent allocates the
  ticket-line money across its listing lines exactly — the existing
  largest-remainder rules make the parts sum to the whole — and keeps every
  booking fee or price-modifier extra as its own fact, never folded into a
  listing's share, because Money credits those to their own accounts. Listing
  lines plus extras sum to the payment total, reconciliation validates money
  against that allocation, and no listing is ever credited the full payment or
  another line's fee; the shared order is never collapsed. A deposit
  (reservation) checkout stores two levels for every line and extra: the amount
  charged now, whose parts sum to this payment's total, and the full obligation
  it represents, so the later balance payment knows what remains and the full
  modifier fact is never lost to the deposit fraction — today's pricing folds
  the deposit share into ticket lines while Money records the whole modifier,
  and both facts must survive as themselves. One canonical allocator produces
  this record for the whole payment — every listing line, every extra, and every
  price-modifier application as its own signed fact, discount or surcharge, even
  where today's pricing folds it into line prices — in one pass, each part with
  a stable identity. A reservation's deposit and balance payments share one
  booking-level obligation identity: the line, extra, and modifier identities
  are created once, under that obligation, when the deposit's allocation is
  stored, and the balance payment's allocation references those same identities
  — the full obligation is stored once and referenced, never duplicated, which
  is what lets M7 cancel it exactly once and M8 lease every payment that shares
  it. The record is stored with the payment: reconciliation, refund routing, and
  balance completion read the stored allocation and never re-derive it, so no
  two consumers can disagree about a part. Today's ticket-only
  `allocateReservationDeposit` does not survive the move. Store the provider on
  each aggregate charge: M6's own reconciliation reads it to validate and
  deduplicate charge identity, and the M7 engine routes refunds by it, closing
  the multi-provider gap for every stored charge. M4's slice covers the live
  path: new references are tagged at write time, an untagged reference's
  provider is discovered by a validated read and tagged on its terminal write,
  and a reference no credentialed provider validates stays an honest unresolved
  row — dashboard-refundable — until this backfill tags it from aggregate
  evidence.
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
- From this merge on, the aggregate never references a deleted attendee:
  `applyAttendeeMerge` repoints aggregate payment sessions, charges, and cases
  to the surviving attendee inside its transaction, and `deleteAttendee` settles
  or repoints aggregate rows before the attendee row goes — today both touch
  only the legacy tables. M8 extends the same guarantee to durable effects and
  queued work. Settling is also how folded facts survive deletion in this
  window: before any legacy deletion path — `deleteAttendee`, merge's row moves,
  the prune task — removes a legacy row that carries local completion facts for
  a sale the aggregate represents, it records those facts on the aggregate
  record, so no deletion strips the combined answer. A pre-cutover sale with no
  aggregate row keeps today's deletion and retention lifecycle until M8's fence
  freezes the old tables as the migration source. That boundary is deliberate,
  not a gap: in this window the old tables are still the live store, so an
  operator delete or a retention prune removes data exactly as the live system
  does today, and holding those rows longer would keep buyer data past today's
  privacy rules. Today's prune never touches the accounting backbone — it
  deletes only failed, reference-less, orphaned, or cash-refunded rows past
  retention — and M11, like a backup, copies what exists when the fence rises,
  never what was deliberately removed before it.
- The aggregate readers replace `resolveWebhookSession` and `retrieveSession`
  for every caller — signed webhook callbacks, buyer return and cancel pages,
  and paid-session validation — and the displaced methods leave the
  `PaymentProvider` interface and all three provider implementations in this
  same cutover. The readers feed the existing completion contract
  (`src/shared/payment/validated-session.ts`), so the legacy completion, refund,
  finalize, and maintenance writers keep working unchanged — and keep writing
  their own rows — until M7 and M8. Those legacy writers never touch aggregate
  rows directly; the aggregate learns of their effects the way it learns
  everything, by reading the provider — every legacy completion or refund is
  followed by the provider's own callback or the scheduled re-read, which the
  claimed reconciliation folds into the aggregate — except where the provider
  declares no push for the fact (data law 7): SumUp fires no refund callback and
  a settled row has no scheduled re-read, so the legacy refund writer records a
  DURABLE due-reconciliation row for the reference it just refunded, in the same
  transaction as its refund result — the aggregate's own due-work kind, never
  the request-scoped pending-work list — on the API and admin refund paths alike
  (a writer-through trigger for pull-only facts, not a second author: the
  aggregate still records only what the provider read proves). A legacy write
  can therefore lag one reconciliation but never leave the aggregate permanently
  stale, for push and pull-only providers alike. No write fence lands here.
- Adopt or expire every in-flight pre-cutover checkout (all three providers)
  atomically and idempotently: same claim, identity, and validation rules;
  concurrent callbacks and migration runs bind to one claim; defined outcomes
  for paid, pending, expired, and unavailable sessions. No paid checkout is
  stranded without an aggregate row.
- Keep uncopied old-table rows visible through the legacy read-through — the
  second sanctioned staged-migration adapter (delivery rule 2), one bounded
  contract serving panels, exports, statistics, and refund targets, removed in
  M11 — and delete only the displaced production readers. The read-through
  returns one answer per provider-qualified payment identity: every post-cutover
  sale is written to both stores until M7 and M8 retire the legacy writers, so a
  legacy row the aggregate already represents folds into the aggregate answer
  instead of appearing as a second sale — never counted or offered for refund
  twice. Folding is not dropping: until M8 moves completion, that legacy row
  still owns the sale's local completion facts — the attendee it booked, the
  ticket result, a recorded local failure — which no provider read can supply,
  so the combined answer keeps them visible.

Standalone value: no live checkout can lose its intent or create a second
provider checkout after an interrupted request, and every route, worker, page,
and export gets the same authoritative answer for the same payment.

#### M7: Aggregate refunds become authoritative (was PR 8)

Src target: 700–1,000 (may use the cutover exception if the adapter pushes it
over).

- Move Stripe, Square, and SumUp refund request/read behavior together.
  Individual, bulk, balance, automatic, and case-decision refunds run through
  one one-or-many engine. On a multi-listing payment, refund Money is recorded
  against the payment's stored per-listing allocation — never the whole payment
  to one listing. The bulk arm runs to explicit provider, database, and total
  subrequest budgets. The whole job — every payment identity it will refund,
  plus a cursor — commits as durable due work before the first provider call;
  each request then refunds a bounded page, records each payment's result in the
  same transaction, and advances the cursor only past payments with a terminal
  result. Terminal means the provider confirmed the refund or permanently
  refused it — a permanent refusal becomes owner-review work, never silently
  done. A transient failure (provider unreachable, rate limited) is not
  terminal: it stays due for bounded retries and escalates to owner review when
  they run out, so one stuck payment can neither spin forever nor be finished
  around. Every refund item persists its provider idempotency key with the job
  before the first call and reuses it on every retry — the shipped
  `pending_refund_idempotency_key` column — so a provider call that succeeded
  just before a lost local commit can never refund the same money twice. A crash
  mid-run therefore leaves a job that still names every untouched payment — a
  large refund-all can never end with an initial subset refunded and nothing
  recorded. Today's `processRefundBatch` loops every group unbounded, and that
  shape does not survive the move. Each queued page is self-contained: it
  carries the provider-qualified payment identities, amounts, and allocation
  facts it acts on — never a live attendee lookup. Refunding a reservation
  separates two kinds of reversal: each payment page returns and reverses only
  the cash that payment actually moved (the deposit's charge, the balance's
  charge), while the booking-level obligation — sale, modifier, and fee facts
  shared by all of that reservation's payments — is cancelled exactly once,
  idempotently, however many payments the refund touches. That cancellation is
  recorded as a completion effect under one stable booking-level identity,
  claimed atomically with the refund result, so recovery retries it when the
  provider reversal succeeded but the local write failed — and can never run it
  twice. The buyer gets back what they paid, nothing is reversed twice, and a
  cancelled booking leaves no debt behind. Each queued item also stores the
  payment-evidence revision it was built from, and the claiming transaction
  re-runs the outcome and blocking-case checks before every provider call: a
  payment whose evidence moved on — a second captured charge, an external
  refund, a newly opened case — parks as owner-review work instead of being
  refunded from a stale snapshot. While an attendee has unfinished refund pages,
  merging or deleting that attendee fails closed naming the pending work — a
  merge posts its own Money adjustments, and replaying a pre-merge allocation
  after them could reverse income twice. This fence outlives M8 for refund
  pages: repointing cannot make a frozen pre-merge allocation safe to replay
  after the merge's own adjustments, so merges stay refused until the refund
  work settles or the owner cancels it — M8's general repointing covers only
  queued work whose facts a merge leaves unchanged. The migrated-payment caller
  arrives in M11, when migrated payments first exist.
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
  atomically inside the refund transaction, stamping a monotonic version in the
  same write — or the read-through consults the new refund record, keyed by the
  provider's refund identity — so a completed refund never resurfaces as
  refundable, and M11's cursor can compare the version and refund identities
  against what it copied and replay any completion that landed after the copy.
  It fails closed into an owner case when the same provider reference spans
  multiple attendees, and when an attendee-only reference lacks a deterministic
  provider, account, captured amount, currency, or completion state. Those
  fail-closed cases carry their own required decision, shipped here: the owner
  supplies verified evidence for every missing fact the condition names —
  provider, account, captured amount, currency, and completion state, any of
  which the engine's provider re-read may confirm or supply deterministically —
  and, when one reference spans several attendees, assigns the charge to exactly
  one attendee — after which the refund proceeds through the engine; or the
  owner rejects the refund. This is the same owner-evidence rule M11 applies to
  ambiguous account assignment.
- Delete every replaced refund path and prove no production caller remains.

Standalone value: every refund has the same retry, evidence, and Money
guarantees and cannot move money twice.

#### M8: Durable paid completion, including its failure path (was PRs 9+10)

Src target: 1,000–1,500 — cutover exception; the success and failure paths are
one machine and merge together.

- Persist the exact capacity, attendee, answer, modifier, package, balance, and
  Money effects before running them; snapshot paid facts so listing edits cannot
  change delivery. Complete each effect idempotently, schedule unfinished work,
  and stop one permanent failure from starving later payments. A multi-listing
  payment draws each line's capacity, tickets, and Money from M6's stored
  allocation, but the commit is all lines or none in one transaction — as
  `createBookingAtomic` commits the shared order today — so one line selling out
  after payment sends the whole completion down the failure path (refund or
  owner case) rather than half-booking the order. That refund is an
  unhonoured-payment refund: it returns cash only and posts no booking-level
  obligation cancellation, because the all-or-none commit never posted the
  obligation — a cancellation runs only with proof the booking obligation effect
  completed. Before the effect runner claims its first payment, an idempotent
  cutover pass adopts the M6-window history: an aggregate payment the legacy
  path already completed has its folded result marked done, never re-booked or
  re-posted to Money; a paid aggregate payment with no completion result becomes
  due work; and a paid payment whose folded result records a completion failure
  becomes the matching durable failure effect — its chosen refund path or an
  owner case — never marked done and never re-run as a fresh booking. So pre-M8
  unfinished completions gain durable recovery instead of being stranded. The
  pass runs only after the write fence has risen and in-flight legacy commits
  have drained or failed, and the runner revision-rechecks the folded state when
  claiming each payment, so a legacy commit that landed between scan and claim
  is honoured, never redone. Adoption also gates on a completion-safe
  `outcomeOf` state with no open blocking case: a paid payment stopped for owner
  review — captured money on a failed checkout, multiple captured charges —
  stays in its case workflow, because due work must never bypass a required
  owner choice. Refund and completion claims are mutually exclusive through one
  payment-wide claim: the payment session row's shipped lease (`lease_token`,
  `lease_expires_at`). Refund jobs, the adoption pass, and the effect runner
  each acquire that lease atomically before acting and verify no unfinished
  refund job or effect owns the payment, so two runners can never both read
  "nothing done yet" and act, and a booking can never complete while its
  irreversible refund is in flight. For a reservation whose deposit and balance
  are separate payments, the claim spans them: a runner acquires the lease of
  every payment sharing the booking-level obligation, always in one fixed order,
  before acting — so refund and completion can never split one booking between
  two sessions.
- From this cutover on, completion stops storing payment references in attendee
  PII — the aggregate owns the attendee-to-payment link — so the attendee-PII
  reference source M11 reads is closed at M8 and cannot grow while the copy
  runs.
- When completion cannot be honoured, persist the chosen refund path and record
  the provider refund and local Money completion as separate durable effects
  driven by the M7 engine, with explicit provider, database, and total
  subrequest budgets.
- The M5 complete-a-proven-booking case action lands here.
- Fence listing deletion against pending payment work, establishing the claim
  before any irreversible step: today `performListingDelete` removes the stored
  attachment before the database delete, so the fence must precede storage
  cleanup, not only the row delete. Fence attendee deletion the same way: an
  attendee with unfinished completion work or durable effects cannot be deleted
  until that work settles or is repointed, checked inside the deleting
  transaction. Repoint payment work and open cases during attendee merges. Move
  the maintenance writers off the old tables — and the admin action itself
  always completes: merge, delete, and prune succeed for attendees with uncopied
  historical rows, and only the legacy row's own removal waits. Each writer
  verifies a row is copied before deleting it and otherwise leaves the row for
  M11 to copy and prune; `deleteAllStaleReservations` is gated the same way, so
  no path ever deletes an uncopied legacy row. Before a merge or delete
  completes for an attendee whose payment history is not yet copied, the
  attendee-held migration facts — legacy payment references and the
  payment-identifying facts M11 reads, still encrypted — are preserved in a
  durable migration snapshot that M11 consumes (or that attendee's payments are
  canonicalized on the spot), so completing the deletion loses nothing the copy
  needs.
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
Their merge order is free, but neither is deferrable: both land directly after
Stack B, so rule 7's deadline for `payment_completion_deliveries` holds
whichever merges first. Both are new effect kinds on M8's machinery — bounded
due-work query and scheduled runner included, request paths as first attempt
only.

#### M9: Durable messages and outgoing webhooks (was PR 11)

Src target: 300–600. Store prepared message and webhook bodies plus buyer facts
before delivery; resolve the owner recipient from the current business address
at send time; attempt and schedule each delivery independently, keeping each run
within explicit provider, database, and total subrequest budgets; mark permanent
failures without blocking later work. Every delivery carries a stable identity:
webhooks send it in a header consumers deduplicate, and email uses the
provider's idempotency key where the provider offers one. Where it does not, the
attempt record persists the provider's acceptance evidence before the delivery
is marked complete; if that evidence write itself is lost, the retry may
duplicate an email — an accepted, documented outcome for messages only, never
for webhooks or money.

Standalone value: the M8 completion runner's messages and webhooks use the
current owner address, recover on schedule after an interruption, and one
permanently failing destination no longer blocks the rest of the queue.

#### M10: Durable site assignment and renewal (was PR 12)

Src target: 300–600. Persist site assignment and renewal effects before remote
work; serialize concurrent paid renewals; keep remote calls outside
transactions; repoint queued site work during attendee merges; schedule
unfinished work within explicit provider, database, and total subrequest
budgets. Each persisted renewal effect carries a stable provider idempotency
key, or the runner reads the remote state before re-attempting — an uncertain
success is never blindly replayed, so a site cannot be extended twice.
Assignment claims a site atomically: the claim requires the site to still be
assignable inside the mutating statement itself (today `assignBuiltSite`
overwrites without that check, so two concurrent paid completions can take the
same site), and the loser moves to the next site or builds one. A site build
gets the same no-blind-replay rule as renewals: the persisted effect carries a
stable creation identity, and a retry after a lost response reads the provider
and adopts the site that identity already created instead of provisioning a
second one or failing on the duplicate name.

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
  fence-and-drain: pause `applyAttendeeMerge`, `deleteAttendee`, attendee PII
  edits (`applyAttendeeAtomicEdit` — its `pii_blob` write can change the
  attendee-only legacy payment references the copy resolves), the prune task,
  and `deleteAllStaleReservations` for the duration of the copy. The M7 adapter
  is the only permitted concurrent writer, and the cursor detects and replays
  its versioned writes before marking a row verified. Lease ownership, renewal,
  and timeout details are fixed in the M11 behavior contract (`PR_WORKFLOW.md`)
  before the first cursor page.
- Copy every source by stable cursor in bounded, verified pages. Never split one
  provider payment across pages; never mistake an empty joined page for the end;
  deleted booking rows do not block; ticket-use state is not resurrected;
  attendee-only references are copied, not skipped. A row or reference whose
  provider-qualified payment identity the aggregate already carries — every sale
  completed after M6, and any reference a paid booking wrote into attendee PII
  before M8 closed that path — is verified against its aggregate payment and
  recorded as already canonical, never copied as new legacy input: no duplicate
  payment, no false identity conflict. Before such a row is marked settled, any
  legacy-only local completion facts it still owns (M6's folded facts: the
  attendee it booked, the ticket result, a recorded local failure) are folded
  idempotently onto the canonical completion records — deduplicating the payment
  identity never discards the booking outcome. Preserve unknown or contradictory
  facts without inventing values — create a complete M5 case and continue.
  Ambiguous account assignment gets its own required migration decision: the
  owner assigns the provider account or marks the row unmigratable with a
  reason, recorded in the decision union, and a revision-fenced copy retry
  consumes the decision so verification resumes — no row can block M13 forever.
  Marking a row unmigratable is a terminal, verified disposition: the decision
  preserves a bounded accounting record as durable evidence on the owner-review
  case — an allowlisted set only (provider, provider identities and references,
  amounts, currency, timestamps, state, failure data, and the recorded reason),
  encrypted in the case's evidence and readable only through the owner-only case
  page — never buyer PII, ticket tokens, or credentials. M13 can then drop the
  old tables without deleting the payment's money story, while the row's secrets
  die with the tables, exactly what M12's redaction would have left had the row
  migrated. M12 never redacts this record — it contains nothing to redact, and
  after M13 it is that payment's only copy. A source row is **settled** when it
  is either copied and verified into a canonical payment or terminally preserved
  as unmigratable — the one completion condition the snapshot release, the
  adapter drain, and M13's retirement gate all share, so an unmigratable row
  satisfies every gate it cannot block. Delete each M8 deletion snapshot only
  once every payment and buyer fact it references is settled — a snapshot is
  attendee-scoped and can carry several payments, so the last verified payment
  releases it, under the same gate as any source row and idempotent across
  interrupted or restored runs; no duplicate buyer facts outlive the migration,
  and M13 verifies none remain.
- Each copied payment is immediately served by the current readers, result
  recovery, cases, and refunds; migrated charges join attendee refund targets
  through the M7 engine in this same release. Record verified progress and
  release leases within the call budget; interruption resumes from the same
  cursor.
- Retire the M7 adapter behind an explicit, revision-fenced drain: once every
  row is settled, disable new adapter refunds (every copied target is canonical
  and an unmigratable row's money is owner-case territory, so no refund still
  needs the adapter), wait for in-flight adapter requests and their queued
  repair work to reach a terminal outcome, then run the final reconciliation
  pass, folding in any refund that completed since its row was verified by
  comparing each row's monotonic version and refund identities against the copy.
  With the adapter disabled, no write can land after the pass — retirement
  re-checks the version high-water marks and fails loudly if one moved. In this
  same milestone, switch every legacy read-through caller — panels, exports,
  statistics, refund targets — to the current readers and delete the M6
  read-through adapter, so no production caller outside the restore path reads
  an old table (M13's precondition).

Standalone value: operators can prove a live database or old backup is safe to
migrate, and all history becomes usable by the one current engine without
stopping on malformed rows.

#### M12: Redact terminal payment secrets (was PR 15)

Src target: 400–700. Redact intent, evidence, ticket tokens, completion
payloads, and the stored delivery records from M9 — prepared message and webhook
bodies plus their buyer facts — only after all work that needs them is terminal,
including deliveries that permanently failed. The bounded accounting record M11
preserves on an unmigratable-row case is permanently retained: it carries no
buyer secrets by construction, and once M13 drops the old tables it is that
payment's only copy, kept as documented accounting history. Eligibility is
defined for every terminal outcome — completed, fully refunded, failed,
cancelled, expired, and free — each either redacts once its work is terminal or
documents why its data is retained, with a cleanup test per state; page cleanup
so one bad or ineligible record cannot block later eligible rows.

Standalone value: deployed sites keep accounting history while shedding buyer
secrets and ticket credentials they no longer need.

#### M13: Retire old payment storage (was PR 16)

Src target: 600–1,000, mostly deletions — the atomic-cutover exception where
this exceeds rule 3's cap: the table drop and every reader, codec, and gate it
orphans leave together, because splitting them would hold dead readers alive
across a merge. Release only after every fleet database reports every source row
settled — copied and verified, or terminally preserved as unmigratable — and no
production caller outside migration reads an old table.

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
| F6  | Attendee merge or delete removing records with an open case or unfinished work         | M4, M5, M6, M8  |
| F7  | Restore-deploy workflow allowing incompatible code onto a migrated database            | M6              |
| F8  | Cross-payment duplicate provider charges                                               | M6              |
| F9  | Account lookup failure retaining a claim                                               | M6              |
| F10 | SumUp return IDs interpreted differently by different routes                           | M6              |
| F11 | Square fallback reads scanning too short a list                                        | M6              |
| F12 | Delayed work using live currency rather than stored currency                           | M4, M6          |
| F13 | Charges without a stored provider unrefundable after a provider switch (#2020 gap)     | M4, M6, M7      |
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
| F39 | A post-cutover sale counted or refunded twice through the legacy read-through          | M6              |
| F40 | An attendee PII edit changing legacy payment references mid-copy                       | M11             |
| F41 | Redacting the preserved evidence that is an unmigratable payment's only record         | M11, M12        |
| F42 | A folded legacy row's local booking facts hidden by read-through deduplication         | M6              |
| F43 | An already-canonical payment reference migrated again as new legacy input              | M8, M11         |
| F44 | A legacy deletion stripping folded local facts from a sale the aggregate represents    | M6              |
| F45 | Two concurrent paid completions claiming the same built site                           | M10             |
| F46 | A site build replayed after a lost response, provisioning a second site                | M10             |
| F47 | An adapter refund completing after the final reconciliation pass, lost at retirement   | M11             |
| F48 | A multi-listing payment credited in full to each listing, or its shared order lost     | M6, M7, M8      |
| F49 | Legacy-only booking facts dropped when a dual-store row is marked settled              | M11             |
| F50 | Unmigratable evidence keeping buyer PII or ticket tokens forever                       | M11, M12        |
| F51 | Two classifiers disagreeing about the same settled money between M4 and M5             | M4              |
| F52 | Checkout fees or price modifiers misallocated into a listing's income                  | M6, M8          |
| F53 | A bulk refund run exceeding the request budget, refunding only an initial subset       | M4, M7          |
| F54 | One sold-out line half-booking a multi-listing order after payment                     | M8              |
| F55 | The M8 runner re-completing sales the legacy path already finished                     | M8              |
| F56 | A deposit checkout losing the full modifier fact to the charged fraction               | M6, M8          |
| F57 | The adoption pass racing an in-flight legacy commit and re-running its completion      | M8              |
| F58 | Adoption turning an owner-review payment into due work, bypassing the required choice  | M8              |
| F59 | A queued refund page stranded by an attendee merge or delete in the M7 window          | M7              |
| F60 | A refund-all crash after its first page losing the unrecorded remainder                | M7              |
| F61 | An attendee merge rewriting Money while refund pages are still queued                  | M7              |
| F62 | A reservation refund confusing money charged now with the full obligation              | M7              |
| F63 | A deposit-plus-balance refund reversing the booking obligation twice or not at all     | M7              |
| F64 | Adoption stranding payments whose folded result records a completion failure           | M8              |
| F65 | A cursor advancing past a transiently failed refund, finishing the job around it       | M7              |
| F66 | A booking completing while its payment's irreversible refund is in flight              | M8              |
| F67 | A retried refund minting a fresh provider idempotency key and refunding twice          | M7              |
| F68 | Transient and permanent refund failures collapsing into one boolean                    | M7              |
| F69 | An obligation cancellation without a stable identity re-running or never retrying      | M7              |
| F70 | Two runners both reading "nothing done yet" and acting on one payment                  | M8              |
| F71 | A consumer re-deriving the allocation and disagreeing with the stored record           | M6              |
| F72 | A booking split across two payment leases, refunding one while completing the other    | M8              |
| F73 | Repointing replacing the merge fence and replaying a pre-merge allocation              | M7, M8          |
| F74 | A queued refund acting on stale evidence after the payment's outcome moved on          | M7              |
| F75 | Cancelling a booking obligation that the failed completion never posted                | M8              |
| F76 | A discount folded into line prices losing its signed modifier fact                     | M6              |
| F77 | Deposit and balance allocations minting separate identities for one obligation         | M6              |

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
