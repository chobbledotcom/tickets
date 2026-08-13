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

| Milestone                               | Status                                                                                                                                                                                                                                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1 safety behavior (was PR 1)           | Merged as #2020. Also landed the M2 pure modules: `src/shared/payment/money.ts`, `resource-id.ts`, `refund-state.ts`, and `validated-session.ts`.                                                                                                                                     |
| M2 money/resource vocabulary (was PR 2) | Core modules merged inside #2020. Any provider parsing still off those schemas rides with M3 or M4.                                                                                                                                                                                   |
| M3 provider ownership (was PR 3)        | Complete: #2048 (payment processing core), #2050 (bounded registration delivery), #2060 (observation boundary + SumUp callback wiring; F2 closed).                                                                                                                                    |
| M11 verifier slice (was PR 13)          | Started early in #2056 — the verifier is read-only and parallelizable.                                                                                                                                                                                                                |
| M4 settled-money diagnosis (was PR 4)   | Part A is implemented by #2065 on `claude/m4-pr-a`: the current admin refund path, its provider boundary, row lifecycle, repair UI, budget, and safety cutovers are authoritative. Callback claims, whole-checkout diagnosis, allocation, and aggregate jobs remain later milestones. |
| M5 cases (was PR 5)                     | The current-row review/acknowledgement slice landed in M4 Part A. Remaining aggregate case kinds ship with their M6–M8 producers and actions, not as a dormant layer.                                                                                                                 |
| M6–M10 and M12–M13                      | Not started.                                                                                                                                                                                                                                                                          |

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
  payment requires owner review. If several coherent captures sum exactly to the
  signed total, the booking may proceed with that review and no automatic
  refund. If the multi-capture reading also fails currency, total, parentage, or
  another validation rule, it parks: no booking and no automatic refund. A
  coherent single-charge mismatch keeps the automatic-refund remedy.
- A provider-partially-refunded charge observed before booking parks even when
  its captured and expected totals otherwise agree: no paid booking and no
  automatic refund. The buyer is retained for owner review. On an existing
  booking, Refund and Refresh preserve the exact partial-return work rather than
  treating it as zero or complete.
- Contradictory provider parentage is an action-level no-refund gate regardless
  of which conflict label wins. Conflict ordering may choose one headline, but
  must evaluate refusal-shaped conditions before proceed-shaped review and must
  retain the complete observed charge evidence.
- Money already proved fully returned never creates a paid booking. A new
  booking takes the stable refused-and-refunded result; a balance remains unpaid
  and records the captured-and-returned cash round trip against the existing
  attendee rather than creating a placeholder.
- If a reviewed or conflicted payment later fails ordinary booking work, that
  downstream failure cannot route it into an automatic one-charge refund. The
  buyer record and exact owner-review evidence remain authoritative.
- A legacy provider charge may fund one or more booking obligations. Before an
  automated refund or ledger reversal can use it, the owner either records an
  exact allocation of its captured Money across those obligations or rejects the
  automated action. Every part is positive, uses the charge currency, and the
  parts sum exactly to the captured amount. The system never invents an equal,
  proportional, first-attendee, or current-row split.
- Returning cash and cancelling a booking obligation are separate effects. A
  confirmed provider refund records only the cash that charge returned. An
  obligation cancellation reverses its sale, modifier, and fee facts exactly
  once under the stable obligation identity. Neither effect implies the other.
- When one payment under an obligation returns while another remains captured,
  the owner makes a required, revision-fenced choice with no default: keep the
  booking and make the returned amount due, return all remaining cash and then
  cancel, or cancel now while keeping the retained cash as visible refund work
  owed to the buyer.
- A queued owner email uses the current business address at send time. Its body
  and buyer facts remain the stored payment snapshot.
- An incomplete or contradictory legacy record is copied without invented facts,
  marked for owner review, and does not stop the rest of the migration.
- A buyer whose paid booking needs review sees that payment was received, that
  the booking needs review, and that they must not pay again. The approved copy
  is: “We received your payment. Your booking needs a manual check. Do not pay
  again — we will contact you.” Reloading shows the same stable result.
- Post-terminal provider evidence is merged, never used to replay an
  irreversible effect. Unchanged evidence is a replay; the application's own
  later-visible refund confirms its recorded attempt. An unambiguous external
  full refund of the single known charge remains eligible for Refresh to record
  the returned cash in Money without implying booking cancellation. Partial,
  sibling-capture, or contradictory evidence blocks instead. Provider array
  order and mutable attributes are not resource identity.
- No aggregate checkout path becomes authoritative until the owner can view its
  evidence and perform every supported required action. Until a case kind's own
  page action ships (M7/M8), a supported action may be a link to a still-live
  admin tool that genuinely resolves that case kind.
- Retry and replay rules apply only to duplicate callbacks or interrupted work
  handled by the current version. The system never emulates an older version's
  payment behavior.

## Target architecture

### Pure rules (adapt from great-fermi)

All pure payment rules live in `src/shared/payment/`; do not open a second
directory. The common vocabulary is `money.ts`, `resource-id.ts`,
`refund-state.ts`, and `validated-session.ts`. M4 Part A added the refund-only
vocabulary in `resources.ts`, `conflict.ts`, `diagnose.ts`, `refund.ts`, and
`admit-refund.ts`: `ChargeMoney` is the complete fact one charge can prove,
`refundOutcomeOf` is its sole judge, and the stored conflict union contains only
the three cases that judge can produce. `provider-read.ts`,
`provider-failures.ts`, `refund-attempt.ts`, and `refund-network.ts` make
provider reads, attempts, failures, and bounded reconciliation total and
exhaustive. `row-state.ts`, `claim.ts`, `review.ts`, and `admit-move.ts` declare
the live row lifecycle and derive its operator and writer rules.

The whole-checkout observation, ownership proofs, charge legs, expected-money
comparisons, and whole-payment `outcomeOf` are deliberately NOT present. They
arrive only with the M6 reader that can supply their complete evidence. Build
them against that reader, widen stored unions only when a real reading can
produce the new case, and do not recreate a second refund judge.

### Persistence and runtime (keep and harden from payment-aggregate)

M4 Part A supplies the current-store version of the runtime discipline:
provider-aware indexed references, revision-fenced all-or-none claims, typed
provider reads and attempts, one admin single/bulk/refresh orchestration path,
exact ledger findings, structured confirmations, and one declared lifecycle for
claim, review, unrecorded money, and terminal outcome. The aggregate still needs
payment, charge, case, decision, effect, and delivery repositories;
persist-before-provider checkout creation; durable booking and refund jobs;
scheduled recovery; bounded migration; backup, restore, and redaction.

New raw provider references in `processed_payments` are encrypted to the owner's
public key. Equality uses a DB-keyed one-way index, and SQL-only consumers see a
plain state word, never the reference. A holder of only the database and
`DB_ENCRYPTION_KEY` therefore cannot open new raw references or attendee PII.
Historical plaintext `processed_payments.payment_reference` values remain
readable compatibility evidence until a later migration or redaction: saving
that attendee adds the new owner-encrypted indexed anchor, but deliberately does
not rewrite or delete the historical row. Old DB-key-encrypted refund-warning
notes remain until the owner's explicit confirmation. There is no global
decrypt-and-rewrite pass: the compatibility limit is recorded rather than paid
for by an unbounded request.

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
the shape out as a class. M4's first production instantiation is
`PaymentRowState` plus the exhaustive `LIVE_WORK` declaration, the exact claim
transactions, and `ATTENDEE_DATA_RULES`; M5's cases, M6's aggregate rows, M7's
refund jobs, M8's completions, and M11's migration copies are all data these
laws bind.

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
   never on a proxy. A blocking state also names a real operator route and a
   rendered control that can reach it, with a visitor journey proving the state
   can end. A state representing unresolved money requires an explicit choice;
   acknowledgement alone never clears it. A state and all its consumers ship in
   one slice.
5. **Decisions bind to complete, versioned evidence.** A path that acts reads
   the full declared evidence shape for its source — no path decides on less
   than the source's declared observation — and every consequential write is
   fenced on the exact evidence it judged: changed evidence forces a re-judge,
   and recorded evidence only grows, by merge, never replacement.
6. **Data never moves to weaker protection.** A fact under a stronger key or
   boundary is never copied under a weaker one. Cross-boundary comparison uses
   one-way codes; a plaintext mirror carries a state word, never contents. A
   migration that cannot preserve this rule leaves the old record with reduced
   functionality rather than decrypting a population or copying its contents
   under the database key.
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

The approved work lands in two stacks. The current-path stack now has M4 Part
A's exhaustive provider outcomes, indexed legacy-reference readiness, exact
admin claims and provider permits, bounded selected-page execution, exact ledger
repair, and owner-visible row review. Its remaining layer turns whole-checkout
problems into durable cases without duplicating that lifecycle. The aggregate
stack makes attendee merge atomic, cuts checkout and reads over to stable
booking obligations with exact allocations, then moves callback and admin
refunds onto a durable allocation-driven job with exact cancellation effects.
Each layer removes the live path it replaces and stands alone green.

### Stack A — finish the current path (M3–M4; M5 behavior follows its producers)

#### M3: Check provider ownership on the current path (was PR 3, complete)

Src target: remainder of ~800.

- Adapt the strict provider observation boundary. Allow an unrecorded child only
  when it is a charge under the same pending checkout.
- Wire SumUp's current callback path first; block unknown unsigned callbacks
  from causing unbounded provider reads.

Standalone value: current SumUp callbacks cannot attach unrelated resources or
be used to amplify outbound requests.

#### M4: One diagnosis for settled money — fail-closed cutovers only (was PR 4)

Status: Part A is built. The code named here and its mirrored tests are the
authority for this current-store slice. It hardens admin single refunds, Refund
All, Payment Refresh, payment-row merge/delete/retention, and the provider and
checkout boundaries they use. It does not claim buyer-callback refunds, build a
whole-checkout observation, allocate one charge across booking obligations, or
write the dormant aggregate tables.

As-built module map:

- **Refund-only rules.** `src/shared/validation/kind.ts` and
  `src/shared/payment/{resources,conflict,diagnose,refund,admit-refund}.ts`
  define one charge's captured/refunded facts and one `refundOutcomeOf`
  judgment. The exhaustive conflict union is `refund_exceeds_capture`,
  `partial_refund`, and `multiple_pending_refunds`. `failed_refund` is
  deliberately absent: an attempt that certainly moved no money may be retried,
  while a failure reported beside returned money is diagnosed from the returned
  facts. The judge never invents the signed checkout total or booking allocation
  that this slice cannot read.
- **Reference identity and storage.** Migration
  `2026-08-10_payment_state_columns.ts`, `tables-attendees.ts`,
  `db/payment-reference-store.ts`, `db/payment-references.ts`,
  `db/payment-anchor/{reference,session,attendee}.ts`, and
  `db/attendees/pii-write.ts` keep a new raw reference under the owner key and a
  DB-keyed blind equality index beside it. `protected_state` is only a plaintext
  state word. Old PII-only or unindexed references gain an anchor only when that
  attendee is saved; refund reads never scan or decrypt the attendee table and
  never repair unrelated people as a side effect. Until then, those older
  payments have less refund functionality by design.
- **Provider ownership.** `payment/provider-discovery.ts`,
  `db/payment-reference-provider.ts`, and
  `features/admin/refunds/{readiness,readiness-findings,readiness-problem,ready-admission,readiness-run}.ts`
  bind an untagged indexed reference only when exactly one credentialed provider
  returns `found` and every other provider returns `missing`. `found` beside an
  unavailable or invalid read is incomplete evidence, not permission to guess;
  configuration may order discovery but never decide ownership. Historical
  returned markers do not attest a provider or amount. A tagged provider is
  authoritative, not a search hint: if it is unconfigured or its read is
  missing, unavailable, or invalid, the row stops there and no other adapter is
  tried. Readiness, capability, and dispatch remain per reference, so one merged
  attendee may safely carry payments from different providers.
- **Provider boundary.**
  `payment/{provider-read,provider-failures,refund-attempt,refund-network}.ts`
  and the Stripe, Square, and SumUp adapters replace nullable reads and booleans
  with `found | missing | unavailable | invalid` and
  `completed | accepted | rejected | not_sent | uncertain`. Stripe and Square
  send the exact captured minor units and currency admitted from the read. SumUp
  exposes only a full-refund-by-transaction operation, so the exact admitted
  transaction is its send boundary rather than an amount argument. Stripe checks
  capture/refund totals; Square validates payments, refunds, and orders at the
  wire boundary and treats only an explicit 404 as missing; SumUp treats a
  top-level `REFUNDED` transaction as authoritative even when event history is
  absent, but a `SUCCESSFUL` transaction needs the documented refund events. An
  ambiguous send gets one bounded reread, never an adapter loop.
- **Exact claims and retry capability.**
  `payment/{row-state,claim,review,admit-move}.ts`,
  `db/payment-claim{,/scope,/take}.ts`, `db/payment-refund-dispatch.ts`, and
  `features/admin/refunds/{claim,dispatch,provider-reviews}.ts` claim all and
  only the indexed rows for the command. The transaction fences each attendee's
  exact `pii_blob` revision and exact `(attendee, session, reference index)`
  set, expands matching indexed representations, and preserves the initiating
  attendee scope after a merge. The claim phases
  `checking -> ready ->
  send_armed` make the final all-row transaction the
  only source of typed send permits. Stripe and Square declare `keyed`; SumUp
  declares `keyless`. A stale keyed armed call can repeat the exact idempotent
  request. A stale keyless armed call may only be observed and, while settlement
  is unproved, becomes explicit `uncertain_keyless_refund` work rather than
  risking a second payout. Paid-balance completion uses
  `db/payment-finalize.ts:balanceFinalizeStatements`, whose transaction guard
  aborts while an admin refund claim holds that attendee; the callback retries
  instead of racing a booking-finalization write against money leaving.
- **Bounded orchestration.**
  `features/admin/refunds/{attempt,budget,candidates,claim,dispatch,provider,provider-requests,readiness-run,waves}.ts`,
  `subrequest-budget.ts`, and `db/client.ts` price physical provider retries,
  database retries, rollback, settlement, and caller tails at several
  checkpoints before fresh provider I/O. A selected command that cannot fit
  refuses without narrowing or sending. Provider calls overlap by at most five.
  One attendee may still carry many references, so even a small selected page
  can refuse safely. `logger.ts:withDeferredErrorReports` queues non-critical
  activity, notification, and Sentry fan-out until the money-critical command
  finishes, and flushes the queue even on a throw, so diagnostics cannot consume
  the subrequests reserved for settlement or rollback.
- **Refund All admission.** `db/refund-all-candidates.ts` first computes a
  PII-free whole-listing count and detects any visible `review` or `unrecorded`
  blocker from indexed state. It then loads and decrypts at most five candidate
  PII blobs, with existing claims first, and passes exactly that page through
  the same claim and budget admission as a single refund.
  `features/admin/refunds/candidates.ts:getRefundCandidates` drops quantity-zero
  rows and deduplicates by attendee before loading references, so several
  booking rows for one person consume one place, one tally, and one
  orchestration run. One submission retires at most five people and reports the
  remaining count; another submission takes the next page. Five is therefore
  both the interactive page size and provider overlap ceiling. M7 still owns a
  durable cursor/job that remembers and resumes the operator's whole-listing
  intention after a crash.
- **Money settlement.** `shared/accounting/{queries,store}.ts`,
  `shared/refund-ledger/{plan,result,record,log}.ts`, and
  `features/admin/refunds/{ledger-findings,result-findings,provider,claim,refresh}.ts`
  carry exact `recorded`, `unrecorded`, and `review` findings back to each held
  reference. A provider-confirmed return is conservatively `unrecorded` until
  the ledger disproves it. A ledger throw records that exact durable fact before
  propagating; an unexpected preparation throw keeps every unproved row in
  doubt; a marker or settlement failure retains the claim. `finally` guarantees
  a settlement attempt, but accumulated evidence — never control-flow optimism —
  decides what may release. Ledger reads and writes use a bounded snapshot and
  fixed number of database calls rather than one loop per attendee.
- **Confirmation and review.** `features/admin/refunds/confirmation.ts`,
  `db/refund-confirmations.ts`, `db/payment-review.ts`,
  `db/notes/{queries,types,legacy-refund-warnings}.ts`, and migration
  `2026-08-12_refund_confirmations.ts` store one replay-safe confirmation keyed
  by the attendee and sorted provider-aware blind indexes. The confirmation,
  held-row assertion, generic activity, exact warning deletes, and optional
  named note commit together. Modern confirmation never scans note history. An
  explicit old anchor confirmation examines only that attendee's unnamed notes
  in twenty-row decryption waves; an exceptionally long history may still run
  out of request budget and leave that old payment unavailable, but it never
  widens to other attendees. Owner review acknowledgement stamps only the exact
  case revision; it does not clear the marker, authorize a refund, or decide an
  allocation. `PaymentWorkStatus` is exactly
  `clear | moving |
  needs_money_record | needs_review`, with claim, unrecorded
  money, then review as the fixed priority. The form HMAC binds the complete
  sorted `[sessionId, caseId, reason]` set; its transaction rereads that set,
  stamps only unacknowledged cases, and writes one activity entry. Any claim
  blocks acknowledgement, regardless of age or phase. Managers can neither
  acknowledge review nor send refunds, in the rendered UI or at GET/POST
  authorization boundaries. Refresh intentionally remains available to an
  authenticated manager because it observes and repairs existing work but has no
  provider-send permit. The current pending copy — “Refresh payment status after
  it completes” — deliberately supersedes the early “Try again” wording, which
  could be read as permission to resend.
- **Review retirement and reachable repair.** `payment/admit-move.ts` has one
  exhaustive `LIVE_WORK` entry for every non-settled `PaymentRowState` field;
  the winning entry supplies its mirror, status, recovery action, refusal, and
  delete/merge behavior. The recovery action is constrained to the real
  attendee-action schema.
  `features/admin/{attendee-page,attendee-page-data,attendee-payment-review,attendees-route-helpers}.ts`
  and `ui/templates/admin/attendees.tsx` render from authoritative indexed
  payment work, not legacy PII `payment_id`, so a merge cannot hide the only
  Refresh form. Clean evidence retires only the exact review it proves gone. In
  particular, a returned-and-recorded reference retires its own `partial_refund`
  review even when a sibling reference remains captured; acknowledgement alone
  never retires it.
- **Every destructive consumer.** `db/payment-admit-move.ts`,
  `db/attendees/dependent-data.ts`, `db/attendees/delete.ts`, `db/prune.ts`,
  `merge/attendee-merge.ts`, and `db/orphan-attendees.ts` make claims block
  merge and delete, while review and unrecorded money block delete and travel
  with a merge. The same plaintext mirror gates prune and orphan purge; an empty
  mirror deliberately preserves ordinary retention, so evidence-only settled
  rows are not retained forever. Merge admits both source and target inside the
  transaction, because the source rows move and the target set grows. It mints a
  legacy anchor only when no matching current source row is moving in that same
  transaction, preventing a false `shared_reference` case. `ATTENDEE_DATA_RULES`
  exhaustively declares delete, repoint, or retention for every attendee-linked
  table; schema tests reject an undeclared attendee-id-like column or payment
  table. The privacy recovery queue starts at a partial state index, selects
  only distinct attendee ids, and keyset-pages twenty plus one lookahead without
  loading or decrypting attendee PII.
- **Migration and restore parity.** Migration
  `2026-08-13_payment_work_queue_index.ts` installs the partial
  `processed_payments(attendee_id) WHERE protected_state != ''` recovery-queue
  index. `schema-sync.ts` emits partial predicates and treats columns used only
  by a predicate as dependencies; historical restore support finds the same
  dependencies from `sqlite_master.sql`. Fresh installs, upgrades, and
  old-schema restores therefore converge on the same bounded index.
- **Fail-closed booking/provider errors.** `payment/checkout-failure.ts` exposes
  only provider, a finite reason, and an optional numeric status; Stripe maps it
  in `stripe/runtime.ts`, SumUp in `sumup.ts`, and Square in
  `square/checkout.ts`. Recognized provider/network/timeout/invalid-response
  failures carry no raw body, message, cause, request id, session id, or buyer
  contact into retained diagnostics. Unknown application errors keep their
  identity and propagate. `classifySessionIntent` distinguishes `ready`,
  foreign/unverifiable input, and unreadable trusted input: a valid price proof
  with a malformed booking intent, a provider network/API failure, or a
  malformed non-null checkout response fails before reservation, booking, or
  refund and returns a retryable 503 where appropriate. Only expected
  `PaymentUserError` input becomes a visitor-facing refusal; Square's
  buyer-correctable email/phone validation remains in that class.
- **Privacy-safe diagnostics.** `shared/payment-review.ts`,
  `features/admin/refunds/report.ts`, `shared/refund-ledger/log.ts`, and
  `shared/invariant-errors.ts` accept closed reasons and row/count context, not
  arbitrary provider references, attendee names, or payment-session ids. The
  safe description and caught exception travel separately, preserving the
  original stack for Sentry without copying money identifiers into console,
  notification, or retained activity text. Adding a raw identifier is therefore
  a visible type-boundary change rather than an easy string interpolation.
- **Visitor-level proof.** The Cucumber stories
  `specs/payments/{checking-before-a-refund,waiting-for-a-refund,recovering-the-money-record,refunding-from-two-windows,only-owners-refund,refunding-everyone-at-once}.feature`
  cover the pre-send check, a delayed provider result, repair of returned money
  missing from the books, two-window races, owner-only controls, bounded Refund
  All pages, whole-listing blocker admission, and per-page failure isolation.
  They submit the rendered forms and cross the real provider and ledger
  boundaries; the recovery story also merges onto a target with blank legacy
  PII, refreshes without a second provider send, and proves deletion becomes
  reachable.

Known limits are deliberate and remain visible. Part A protects and operates
only indexed current-store references; it does not globally decrypt or backfill
old attendees. It does not erase historical plaintext references or old
DB-key-encrypted warning notes. It does not solve the callback claim, stable
booking-obligation, exact allocation, ledger order-identity, or durable Refund
All job described below. Those are new authorities at different layers, not
piecemeal extensions to the admin row lifecycle.

Standalone value: the live admin path cannot guess a provider, default malformed
evidence into success, send without an exact claimed permit, silently lose a
known returned refund after a local failure, decrypt a whole attendee
population, or make a manager decide or move money.

#### M5: Payment cases — remaining aggregate case work (was PR 5)

M4 Part A already ships the current-row case needed by live admin refunds:
revisioned review evidence, an owner-only view and acknowledgement, automatic
evidence-owned retirement, a reachable Refresh action, manager refusals, and
merge/delete/retention rules. Acknowledgement records that the owner saw one
exact revision; it deliberately neither clears unresolved money nor grants a
send permit.

There is no remaining honest standalone M5 foundation. Whole-checkout and
booking-level cases cannot exist until M6 can read and persist their complete
evidence, and their money-moving or completion choices cannot exist before the
M7/M8 engines that execute them. Land each remaining case kind with that real
producer and every action that resolves it, reusing the M4 lifecycle
declarations instead of opening a parallel review system:

- M6 adds revisioned cases produced by the whole-payment judge, the owner list
  and detail evidence, stable buyer result, and retryable current-revision
  alert. Every rendered link is gated by the same permission and existence fact
  as its target.
- M7 adds refund/allocation decisions and closes both the provider result and
  Money before retiring their case. M8 adds complete-booking decisions and
  durable completion effects.
- A genuine ambiguity stores immutable reviewed evidence and a required choice
  with no default. A generic acknowledgement is never a substitute. A case
  re-judges on evidence change and closes only when the exact condition is gone
  or its required decision completed atomically.
- Aggregate cases are repointed or settled inside attendee merge/delete
  transactions and are covered by the same declared storage lifecycle as every
  other attendee-linked table.

Milestone value: every aggregate problem becomes visible and resolvable in the
same slice that first makes it possible, with no dormant case vocabulary and no
second source of truth beside M4's live-work rules.

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
  `allocateReservationDeposit` does not survive the move. Store provider and
  currency on every aggregate charge. M4 already tags new current-store
  references and discovers one older INDEXED reference only from conclusive
  provider reads; M6 makes those facts intrinsic to every aggregate charge and
  M11 migrates historical evidence in bounded pages. Neither milestone may turn
  this into a request-time attendee scan. An old PII-only reference stays less
  functional until it is explicitly materialized or migrated, and an ambiguous
  provider becomes an owner decision rather than a configuration guess.
- Reads: keep M4's tagged `ProviderRead`/`RefundAttemptResult` contract for one
  charge, then add the whole-checkout observation only here, beside the reader
  that supplies its complete signed intent, session, charges, account, currency,
  amount, parent, and provider-specific child evidence. Square payment IDs are
  named by validated orders, not short-list scans. Missing, invalid,
  unavailable, pending, paid, free, and failed stay distinct. Only this complete
  reading may introduce the expected-money conflict kinds and whole-payment
  judge that M4 deliberately did not ship. The provider-specific traps remain
  binding:
  - Square coalesces the webhook-named payment with its own order tender so one
    charge cannot look duplicated, uses the order total as session total rather
    than one tender's amount, and reads refund evidence for every payment-backed
    captured sibling. An absent documented `refunded_money` means zero; a
    present but incoherent Money value is invalid. A card tender counts only
    when its status proves capture. A captured non-payment tender without a
    payment id is real captured money with unknown refund evidence: it parks for
    owner review, is never defaulted to zero, and is not subjected to an
    impossible payment read.
  - A checkout-linked SumUp observation is the named transaction plus the
    checkout's vouched successful children and, for a multi-child reading, each
    child's transaction refund evidence. A checkout-less historical reference
    can honestly carry only its transaction evidence.
  - Square tender and SumUp child lists are provider-controlled and therefore
    have one declared cap shared by callbacks, admin, and refresh. Exceeding the
    cap records bounded owner work without chasing the remaining list or moving
    money.
- One claimed reconciliation function serves signed callbacks, buyer returns,
  manual refresh, case refresh, and scheduled retries: it reads, resolves via
  `outcomeOf`, and persists once — evidence, charges, state, due time, revision,
  and case changes in a single transaction. Store every charge identity once and
  reject cross-payment reuse. Multiple captures open an M5 case. Reconciliation
  fingerprints a stable, order-independent resource set: unchanged terminal
  evidence replays; later visibility of the application's own refund confirms
  it; genuinely new external evidence is merged and surfaced without re-running
  booking or refund. Evidence merges by stable provider-plus-resource identity.
  A lagging subset never removes a known charge; cumulative refunds keep their
  maximum and capture state moves only forward. Conflicting facts with no safe
  ordering, including parentage, currency, or session total, are retained as
  contradictions that block money movement. The whole merged reading is
  re-judged; an earlier outcome is never carried forward. A compare-and-set
  loser carrying distinct evidence retries boundedly or answers retryably, never
  acknowledges that evidence away.
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

M4 Part A is the baseline, not work to repeat: admin single, one selected Refund
All page, and Refresh already share tagged reads, exact claims, provider
capabilities, one-send permits, conservative settlement, and `unrecorded`
repair. M7 moves those mechanisms onto aggregate charge/obligation identities,
adds the callback and durable-job lifecycles, and deletes the current-store
engine it replaces.

- **Durable Refund All.** Before the first provider call, persist the operator's
  whole-listing intention, every immutable payment identity it covers, and a
  cursor. Each request claims, budgets, and processes one bounded page, records
  every result, and advances only past terminal items. A permanent refusal opens
  required owner work; a transient failure remains due for bounded retry and
  cannot be skipped by the cursor. A crash after page one therefore leaves a
  visible resumable job naming the remainder. M4's PII-free whole-listing safety
  summary and five-person interactive page remain the safe input shape, but
  repeated manual submission is no longer the only continuation.
- **One callback/admin lifecycle.** Buyer callbacks currently call
  `tryRefund`/`refundRejectedCharge` without the admin attendee-set claim.
  Before any callback refund, persist one exact charge, capability, amount,
  currency, replay identity, request identity where supported, due time, and
  evidence revision. A duplicate makes no second call. Stripe/Square resume the
  same keyed request while the provider's retention window still makes that
  replay safe; the same key alone is not sufficient once that finite window may
  have expired, so fresh complete evidence and the durable attempt identity must
  gate any resend. SumUp never resends an uncertain keyless attempt without
  fresh settlement proof. A process death before or after a keyless call must
  have a finite, explicit resolution rather than an immortal observe-only hold.
  Square `accepted`, lost callback responses, the missed-SumUp-checkout
  maintenance task, and placeholder replay all feed this ONE claimed
  reconciliation path, not provider-specific side machines.
- **Aggregate refund engine.** Individual, selected bulk, balance, automatic,
  callback, and case-decision refunds run through one one-or-many engine over
  M6's stored provider-qualified charge identity, exact captured Money, evidence
  revision, and allocation. Queue items are self-contained and never rebuild
  their target from live attendee PII or current settings. Persist provider
  refund identity before local completion; provider success followed by a local
  failure remains due and repairs Money idempotently. Refunds stay available
  while new sales are disabled.
- **Stable booking obligations.** Cash return and booking cancellation are
  separate durable effects. A payment page returns and posts only the cash that
  charge moved. The stable obligation identity owns the sale, modifier, and fee
  facts; its cancellation is claimed with its decision and applied exactly once.
  If one payment returns while another remains captured, require the decided
  revision-fenced owner choice — keep the booking and make the return due,
  return the rest then cancel, or cancel while retained cash remains visible
  refund work. Recovery can retry either effect but cannot infer one from the
  other or cancel twice.
- **Shared and ambiguous legacy evidence.** An indexed current-store reference
  with multiple representations remains M4 `shared_reference` review; its
  acknowledgement is not an allocation. The aggregate action either records
  positive Money parts, all in the captured currency and summing exactly to the
  capture, across stable obligations, or records an explicit owner rejection.
  Likewise, an ambiguous provider choice is limited to providers a fresh read
  revalidates as `found`. Every choice is fenced on the exact held rows and
  evidence revision. No equal, proportional, first-attendee, configuration, or
  current-row default is permitted.
- **Changed evidence and destructive writers.** Re-run the outcome and blocking
  case checks in the claiming transaction before each provider call. New
  captured money, an external refund, a changed allocation, or a new case parks
  the item for the owner rather than acting on a stale snapshot. A queued refund
  built from pre-merge Money facts blocks merge/delete until it settles or is
  explicitly cancelled; repointing cannot make a frozen allocation safe after a
  merge has posted its own adjustments.
- **Migration bridge and removal.** Uncopied `processed_payments` rows route
  through the aggregate engine only through the one named M7 adapter. Its
  provider completion marker/version and aggregate refund identity change
  atomically so a returned charge cannot reappear as refundable, and M11 can
  detect completions that land after copy. PII-only records lacking
  deterministic evidence remain unavailable or become required owner cases; they
  never trigger a global decrypt scan. M11 removes the adapter after verified
  copy. M7 deletes every displaced refund path and proves no production caller
  remains.

Standalone value: a refund intention survives request death, every entry point
shares one durable retry/evidence machine, and cash or booking obligations can
never move twice or be silently inferred from each other.

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
  PII — the aggregate owns the attendee-to-payment link — so the historical PII
  source M11 reads is closed and cannot grow while the copy runs. M4 already
  keeps every new `processed_payments` reference under the owner key and refuses
  to scan PII-only history; M8 removes the need to write the compatibility PII
  copy at all.
- When completion cannot be honoured, persist the chosen refund path and record
  the provider refund and local Money completion as separate durable effects
  driven by the M7 engine, with explicit provider, database, and total
  subrequest budgets.
- The M5 complete-a-proven-booking case action lands here.
- Extend M4's current-row merge/delete/prune/orphan protections to aggregate
  cases and effects. Fence listing deletion against pending payment work,
  establishing the claim before any irreversible step: today
  `performListingDelete` removes the stored attachment before the database
  delete, so the fence must precede storage cleanup, not only the row delete.
  Fence attendee deletion the same way: an attendee with unfinished completion
  work or durable effects cannot be deleted until that work settles or is
  repointed, checked inside the deleting transaction. Repoint payment work and
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
  attendee PII, historical raw-reference warning notes, merge references, and
  the M8 deletion snapshots into one lossless model without writing cases. Group
  one provider payment before pagination; convert old timestamps; report
  contradictions through operator diagnostics and backup verification. Attendee
  PII is owner-key-encrypted: the run sits behind an owner-authenticated step
  and reaches the key only through the existing request-scoped private-key path
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
  attendee-only references are copied, not skipped. Historical plaintext
  `processed_payments.payment_reference` values and raw references found in old
  DB-key-encrypted warning notes cross directly into owner-key-encrypted
  canonical evidence plus blind indexes; they are never persisted in migration
  progress, logs, diagnostics, or a new DB-key-readable field. Retire the old
  compatibility copy only after its canonical write verifies. A row or reference
  whose provider-qualified payment identity the aggregate already carries —
  every sale completed after M6, and any reference a paid booking wrote into
  attendee PII before M8 closed that path — is verified against its aggregate
  payment and recorded as already canonical, never copied as new legacy input:
  no duplicate payment, no false identity conflict. Before such a row is marked
  settled, any legacy-only local completion facts it still owns (M6's folded
  facts: the attendee it booked, the ticket result, a recorded local failure)
  are folded idempotently onto the canonical completion records — deduplicating
  the payment identity never discards the booking outcome. Preserve unknown or
  contradictory facts without inventing values — create a complete M5 case and
  continue. Ambiguous account assignment gets its own required migration
  decision: the owner assigns the provider account or marks the row unmigratable
  with a reason, recorded in the decision union, and a revision-fenced copy
  retry consumes the decision so verification resumes — no row can block M13
  forever. Marking a row unmigratable is a terminal, verified disposition: the
  decision preserves a bounded accounting record as durable evidence on the
  owner-review case — an allowlisted set only (provider, provider identities and
  references, amounts, currency, timestamps, state, failure data, and the
  recorded reason), encrypted in the case's evidence and readable only through
  the owner-only case page — never buyer PII, ticket tokens, or credentials. M13
  can then drop the old tables without deleting the payment's money story, while
  the row's secrets die with the tables, exactly what M12's redaction would have
  left had the row migrated. M12 never redacts this record — it contains nothing
  to redact, and after M13 it is that payment's only copy. A source row is
  **settled** when it is either copied and verified into a canonical payment or
  terminally preserved as unmigratable — the one completion condition the
  snapshot release, the adapter drain, and M13's retirement gate all share, so
  an unmigratable row satisfies every gate it cannot block. Delete each M8
  deletion snapshot only once every payment and buyer fact it references is
  settled — a snapshot is attendee-scoped and can carry several payments, so the
  last verified payment releases it, under the same gate as any source row and
  idempotent across interrupted or restored runs; no duplicate buyer facts
  outlive the migration, and M13 verifies none remain.
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
payloads, historical DB-key-encrypted refund-warning notes containing raw
provider references, and the stored delivery records from M9 — prepared message
and webhook bodies plus their buyer facts — only after all work that needs them
is terminal, including deliveries that permanently failed. The bounded
accounting record M11 preserves on an unmigratable-row case is permanently
retained: it carries no buyer secrets by construction, and once M13 drops the
old tables it is that payment's only copy, kept as documented accounting
history. Eligibility is defined for every terminal outcome — completed, fully
refunded, failed, cancelled, expired, and free — each either redacts once its
work is terminal or documents why its data is retained, with a cleanup test per
state; page cleanup so one bad or ineligible record cannot block later eligible
rows.

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

| #   | Finding                                                                                | Owner                                   |
| --- | -------------------------------------------------------------------------------------- | --------------------------------------- |
| F1  | Disabling new payments also disabled existing-payment refunds                          | Closed by #2020                         |
| F2  | Unknown unsigned SumUp callbacks triggering outbound reads                             | Closed by #2060                         |
| F3  | Pending and completed refunds together exceeding captured money                        | M4 admin closed; M7 aggregate/callback  |
| F4  | One failed decision blocking all reconciliation                                        | M5, M6                                  |
| F5  | Permanent provider or delivery errors retrying forever or blocking a queue             | M5, M6, M9                              |
| F6  | Attendee merge or delete removing records with an open case or unfinished work         | M4 current rows closed; M6–M8 aggregate |
| F7  | Restore-deploy workflow allowing incompatible code onto a migrated database            | M6                                      |
| F8  | Cross-payment duplicate provider charges                                               | M6                                      |
| F9  | Account lookup failure retaining a claim                                               | M6                                      |
| F10 | SumUp return IDs interpreted differently by different routes                           | M6                                      |
| F11 | Square fallback reads scanning too short a list                                        | M6                                      |
| F12 | Delayed work using live currency rather than stored currency                           | M4 admin closed; M6 aggregate           |
| F13 | Charges without a stored provider unrefundable after a provider switch (#2020 gap)     | M4 indexed path closed; M6/M11 history  |
| F14 | In-flight pre-cutover checkouts paid after the cutover, stranded without a row         | M6                                      |
| F15 | Old rows changing after the aggregate write cutover                                    | M6, M8, M11                             |
| F16 | Old payment-reference readers surviving after migration                                | M6, M13                                 |
| F17 | Owner refund decisions closing a case without closing Money                            | M7                                      |
| F18 | Completed provider refunds missing from Money                                          | M7, M8                                  |
| F19 | Bulk provider success followed by local failure having no repair path                  | M4 admin closed; M7 aggregate/callback  |
| F20 | Refund-all conflicting forever with unfinished completion                              | M7, M8                                  |
| F21 | The same indexed provider reference refunded twice through admin bulk refunds          | Closed by M4                            |
| F22 | An adapter-completed refund resurfacing as refundable on an uncopied row               | M7                                      |
| F23 | Attendee-only payment references skipped, or refunded without verified facts           | M4 fails closed; M11 migration          |
| F24 | Delayed completion rebuilding facts from edited live data                              | M8                                      |
| F25 | Listing attachments deleted before a payment fence succeeds                            | M8                                      |
| F26 | `deleteAllStaleReservations` deleting uncopied legacy rows under the fence or mid-copy | M8, M11                                 |
| F27 | Concurrent renewals racing                                                             | M10                                     |
| F28 | Queued site work retaining a deleted attendee ID after merge                           | M10                                     |
| F29 | SumUp identities split across migration pages                                          | M11                                     |
| F30 | A merged migration page mistaken for end-of-input                                      | M11                                     |
| F31 | Deleted booking rows blocking migration forever                                        | M11                                     |
| F32 | Ticket-use state resurrected during migration                                          | M11                                     |
| F33 | Migrated charges omitted from refund targets                                           | M11                                     |
| F34 | Late refund-completion writes landing after a row was copied and verified              | M11                                     |
| F35 | Migration silently skipping charges whose PII key or source is unavailable             | M11                                     |
| F36 | Terminal buyer details, completion data, or ticket tokens never redacting              | M12                                     |
| F37 | An unconditional table drop destroying a restored old backup before it migrates        | M13                                     |
| F38 | Attendee merge or delete destroying attendee-held payment facts before the copy        | M8, M11                                 |
| F39 | A post-cutover sale counted or refunded twice through the legacy read-through          | M6                                      |
| F40 | An attendee PII edit changing legacy payment references mid-copy                       | M11                                     |
| F41 | Redacting the preserved evidence that is an unmigratable payment's only record         | M11, M12                                |
| F42 | A folded legacy row's local booking facts hidden by read-through deduplication         | M6                                      |
| F43 | An already-canonical payment reference migrated again as new legacy input              | M8, M11                                 |
| F44 | A legacy deletion stripping folded local facts from a sale the aggregate represents    | M6                                      |
| F45 | Two concurrent paid completions claiming the same built site                           | M10                                     |
| F46 | A site build replayed after a lost response, provisioning a second site                | M10                                     |
| F47 | An adapter refund completing after the final reconciliation pass, lost at retirement   | M11                                     |
| F48 | A multi-listing payment credited in full to each listing, or its shared order lost     | M6, M7, M8                              |
| F49 | Legacy-only booking facts dropped when a dual-store row is marked settled              | M11                                     |
| F50 | Unmigratable evidence keeping buyer PII or ticket tokens forever                       | M11, M12                                |
| F51 | Two classifiers disagreeing about the same refund evidence                             | Closed by M4                            |
| F52 | Checkout fees or price modifiers misallocated into a listing's income                  | M6, M8                                  |
| F53 | A selected refund command overrunning budget after sending only an initial subset      | Closed by M4                            |
| F54 | One sold-out line half-booking a multi-listing order after payment                     | M8                                      |
| F55 | The M8 runner re-completing sales the legacy path already finished                     | M8                                      |
| F56 | A deposit checkout losing the full modifier fact to the charged fraction               | M6, M8                                  |
| F57 | The adoption pass racing an in-flight legacy commit and re-running its completion      | M8                                      |
| F58 | Adoption turning an owner-review payment into due work, bypassing the required choice  | M8                                      |
| F59 | A queued refund page stranded by an attendee merge or delete in the M7 window          | M7                                      |
| F60 | A refund-all crash after its first page losing the unrecorded remainder                | M7                                      |
| F61 | An attendee merge rewriting Money while refund pages are still queued                  | M7                                      |
| F62 | A reservation refund confusing money charged now with the full obligation              | M7                                      |
| F63 | A deposit-plus-balance refund reversing the booking obligation twice or not at all     | M7                                      |
| F64 | Adoption stranding payments whose folded result records a completion failure           | M8                                      |
| F65 | A cursor advancing past a transiently failed refund, finishing the job around it       | M7                                      |
| F66 | A booking completing while its payment's irreversible refund is in flight              | M8                                      |
| F67 | A retried refund minting a fresh provider idempotency key and refunding twice          | M7                                      |
| F68 | Transient and permanent refund failures collapsing into one boolean                    | M4 admin closed; M7 callback/aggregate  |
| F69 | An obligation cancellation without a stable identity re-running or never retrying      | M7                                      |
| F70 | Two runners both reading "nothing done yet" and acting on one payment                  | M8                                      |
| F71 | A consumer re-deriving the allocation and disagreeing with the stored record           | M6                                      |
| F72 | A booking split across two payment leases, refunding one while completing the other    | M8                                      |
| F73 | Repointing replacing the merge fence and replaying a pre-merge allocation              | M7, M8                                  |
| F74 | A queued refund acting on stale evidence after the payment's outcome moved on          | M7                                      |
| F75 | Cancelling a booking obligation that the failed completion never posted                | M8                                      |
| F76 | A discount folded into line prices losing its signed modifier fact                     | M6                                      |
| F77 | Deposit and balance allocations minting separate identities for one obligation         | M6                                      |

## Done means

- Every milestone is merged in dependency order — through stacks of three to
  seven PRs where the work is stacked, or as the independent single PRs Group C
  names — each merge standing alone under the delivery rules.
- One production payment path remains; all three providers share one canonical
  create/read/refund contract; every provider action and local Money action is
  independently durable and resumable; genuine ambiguity requires an explicit
  owner choice.
- Every provider boundary validates documented data before it reaches booking or
  money code. Expected visitor errors are values; unavailable or malformed
  external evidence fails closed; unexpected application and database errors
  propagate with their identity. No booking/refund path converts an unexpected
  throw into a successful acknowledgement, empty reading, or default result.
- No request discovers payment work by loading or decrypting an attendee
  population. Whole-population questions use indexed, PII-free summaries;
  decryption is limited to one bounded page; work larger than a request has a
  durable cursor and visible continuation. Every physical provider and database
  retry is priced before the selected irreversible work begins.
- New raw provider references and buyer PII require the owner's private key;
  database-keyed indexes and mirrors reveal only blind equality and state words.
  Historical plaintext or DB-key-encrypted compatibility evidence is either
  migrated under the stronger boundary, explicitly retained as limited legacy
  history, or redacted — never silently copied under `DB_ENCRYPTION_KEY`.
- Every blocking state is declared exhaustively with its writers, consumers,
  delete/merge/retention behavior, reachable operator action, exact retirement
  evidence, and a visitor journey that proves it ends. Unresolved money can end
  only through provider/ledger proof or a required revision-fenced owner choice,
  never a generic clear.
- Old backups migrate forward into the current version; the restore-deploy guard
  refuses pre-aggregate code on a forward-migrated database; old code is never
  redeployed and mixed application versions are never supported.
- Payment secrets and buyer details redact once all required work is terminal.
- `nix develop -c deno task precommit` passes; coverage is 100% and
  deterministic; changed-source mutation score is 100%; Cucumber payment stories
  pass; every fault-ledger row and open question is closed.
