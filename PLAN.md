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

| Milestone                               | Status                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1 safety behavior (was PR 1)           | Merged as #2020. Also landed the M2 pure modules: `src/shared/payment/money.ts`, `resource-id.ts`, `refund-state.ts`, and `validated-session.ts`.                                                                                                                                                                                                                                                     |
| M2 money/resource vocabulary (was PR 2) | Core modules merged inside #2020. Any provider parsing still off those schemas rides with M3 or M4.                                                                                                                                                                                                                                                                                                   |
| M3 provider ownership (was PR 3)        | Complete: #2048 (payment processing core), #2050 (bounded registration delivery), #2060 (observation boundary + SumUp callback wiring; F2 closed).                                                                                                                                                                                                                                                    |
| M4 settled-money diagnosis (was PR 4)   | Part A is implemented by #2065 on `claude/m4-pr-a`: every actual refund send, and every admitted provider-tagged callback target once captured Money is trustworthy, uses one durable `payment_charges` authority, one provider-send permit, and one owner-recovery lifecycle. Whole-checkout diagnosis, stable booking obligations, allocation, and durable Refund All jobs remain later milestones. |
| M5 cases (was PR 5)                     | The current-row review/acknowledgement slice landed in M4 Part A. Remaining aggregate case kinds ship with their M6–M8 producers and actions, not as a dormant layer.                                                                                                                                                                                                                                 |
| M6–M11 atomic aggregate cutover         | Not started as a production cutover. #2056 started its read-only verifier early. Creation, reads, jobs, completion, delivery, site effects, and bounded history migration activate together; no intermediate layer may merge as a live parallel path.                                                                                                                                                 |
| M12–M13                                 | Not started.                                                                                                                                                                                                                                                                                                                                                                                          |

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
   between the branches' names, no dual writes, and no runtime read-through over
   the displaced store. A bounded migration may decode an old record only inside
   its explicit owner-authenticated ceremony. It must finish and verify before
   the canonical runtime is enabled; the same release then deletes every old
   runtime caller. M4 follows this rule by cutting every live refund sender over
   to the canonical authority at once.
3. **Size.** Keep each PR under 800 changed `src/` lines (insertions plus
   deletions, recounted after formatting). One exception: an atomic cutover that
   would otherwise need a throwaway compatibility layer may exceed the cap — a
   bigger honest PR beats building a bridge in one PR and demolishing it in the
   next. Say so in the description. PR_WORKFLOW.md's "repository source-line
   limit" is this rule, exception included. Tests, fixtures, and documentation
   do not count against the cap; never weaken them to shrink a diff. #2065 is
   the approved current-path exception: its `14881` gross changed `src/` code
   lines cut every refund caller, provider adapter, persistence writer, and
   recovery surface over together. Imports, comments, and blank lines are
   excluded from that audited total. Splitting it at a live seam would have
   required the legacy and canonical authorities to run in parallel, which this
   plan forbids.
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
   legacy replay path. The aggregate cutover release first fences old writes,
   completes its bounded owner-authenticated migration, and verifies every
   source disposition. Only then does one epoch switch enable canonical runtime
   reads and writes. No request can see a partly migrated store.
7. **The aggregate tables are already shipped.** M4 Part A activated the
   previously unwritten `payment_charges` table as the sole durable authority
   for provider refunds. Its migration refuses to reinterpret a non-empty table.
   The still-dormant `payment_sessions`, `payment_completion_effects`,
   `payment_completion_deliveries`, `payment_cases`, and
   `payment_case_decisions` tables are defined in
   `src/shared/db/migrations/schema/payments/`; do not add drop-and-recreate
   churn against them. Each must hold a complete production role when the atomic
   M6–M11 cutover activates or be dropped in that same release. Their existence
   is not permission to land unused repositories, codecs, indexes, or exports.
   Their currently dormant buyer-bearing columns accept DB-key `enc:1`
   ciphertext. No production writer may use that shape: before activation,
   rebuild every buyer-bearing or raw-reference field to require owner-key
   `hyb:1` ciphertext, or drop the table if it has no complete production role.
8. **Port the source branch's tests** when adapting one of its modules; adapt
   existing tests rather than authoring from scratch. Never copy great-fermi's
   test-only-export exemptions.
9. **PR descriptions state**: the immediate current-system value and the exact
   production route, worker, page, or write path that receives it; the summed
   `src/` line count; the database and provider call budget whenever the slice
   touches providers or adds queries (Bunny's hard limit is 50 subrequests per
   request); the fault-ledger rows closed; the tests and mutation commands run;
   and the old path deleted. The full field list is in steps 2, 5, and 6 of
   `PR_WORKFLOW.md`. Review pure schemas, transactions, provider parsing, and
   orchestration as distinct commits where that helps.

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
  coherent single-charge mismatch keeps the automatic-refund remedy. The review
  is a durable case. Its best-effort ntfy alert contains only a finite case code
  — no buyer/provider identifiers or amounts — and points the owner to the
  owner-protected record where the evidence and required action live.
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
- An incomplete or contradictory retained payment record is copied without
  invented facts, marked for owner review, and does not stop the rest of the
  aggregate migration. An attendee payment id that survives only inside old PII
  is outside that promise: current in-app refunds deliberately leave it
  unsupported rather than decrypting attendee history to recover it.
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
`refundOutcomeOf` is its sole judge, and the pure `PaymentConflict` union
contains only the three disagreements that judge can produce. Those names are
not a second stored review schema: a durable provider disagreement retains its
exact Money in the canonical authority. Exact zero or full-return evidence can
become `needs_owner_choice/provider_conflict`; partial or inconclusive evidence
becomes `needs_provider_check/provider_conflict` and admits no owner money
answer. `provider-read.ts`, `provider-failures.ts`, `refund-attempt.ts`, and
`refund-network.ts` make provider reads, attempts, failures, and bounded
reconciliation total and exhaustive. `row-state.ts`, `claim.ts`, `review.ts`,
and `admit-move.ts` declare the live row lifecycle and derive its operator and
writer rules.

The whole-checkout observation, ownership proofs, charge legs, expected-money
comparisons, and whole-payment `outcomeOf` are deliberately NOT present. They
arrive only with the M6 reader that can supply their complete evidence. Build
them against that reader, widen stored unions only when a real reading can
produce the new case, and do not recreate a second refund judge.

### Persistence and runtime (keep and harden from payment-aggregate)

M4 Part A supplies the live runtime discipline: provider-aware indexed
references, revision-fenced attendee claims, typed provider reads and attempts,
one durable `payment_charges` authority shared by admin and buyer callbacks, one
admin single/bulk/refresh orchestration path, exact ledger findings, structured
confirmations, and declared lifecycles for provider work, local row work, owner
choice, and terminal outcome. The aggregate still needs payment, allocation,
case, decision, effect, and delivery repositories; persist-before-provider
checkout creation; durable booking and refund jobs; scheduled recovery; bounded
migration; backup, restore, and redaction.

New raw provider references in `processed_payments` and `payment_charges` are
encrypted to the owner's public key. Equality uses a DB-keyed one-way index, and
SQL-only consumers see plain state words, never the reference. With a modern v2
password-wrapped owner key, a holder of the database and `DB_ENCRYPTION_KEY`
alone cannot open those new raw references or attendee PII. A dormant legacy v1
owner wrap is the explicit exception: its KEK is derivable from the stored
password hash plus `DB_ENCRYPTION_KEY`, so that holder can unwrap the data key
and site private key until the next successful login upgrades the wrap to v2.
This is owner-key-protected at-rest storage, not an authorization claim that
only owner requests possess the site private key: manager requests share that
key, while owner-only refund detail and decisions are enforced at the route
boundary. This claim is deliberately about data stored in this database:
provider credentials are DB-key encrypted settings, so somebody holding the
database and environment key may be able to use those credentials to query data
held by the provider.

`processed_payments.failure_data` has a deliberately different boundary: it is
DB-key encrypted, so that same holder can open its lifecycle metadata. Keep it
limited to attendee and command ids, times, finite review/claim/outcome reasons,
and terminal display text (which may include a listing name); raw provider
references and buyer PII must never enter it. Every current writer uses the one
`PaymentRowState` stored schema. Live readers reject historical bare terminal
failure and review shapes instead of normalizing them into a parallel runtime.
Historical plaintext `processed_payments.payment_reference` values are not
readable by live refund code. Saving or merging that attendee cannot turn a PII
payment id into refund authority: neither action can prove its provider, and
neither writes a payment row. Old DB-key-encrypted refund-warning notes remain
display history until the owner deletes them or the retention/redaction ceremony
removes them. They are never refund-reference migration input. No interactive
request performs a population decrypt or rewrite.

Do not copy `payment-runtime/legacy-replay.ts`, `legacy-sumup.ts`,
`operator-legacy-read.ts`, or any equivalent runtime branch selected by record
age or origin. Migration code may decode an old retained payment-row format only
to write a canonical current payment when that row already proves the identity,
or a terminal accounting case when it does not. It may not search attendee PII
or notes for another reference. After that write, only the current engine reads,
reconciles, refunds, completes, or displays it. Provenance and unknown facts may
preserve evidence; they must not dispatch to different runtime behavior. Every
write validates the complete prospective record with the pure rules, writes with
revision or lease fencing, and validates the returned row. There must not be
parallel raw-row and decoded-domain implementations of the same rule.

## Data laws

Eight laws govern how every part of this program behaves around data. Each
milestone contract instantiates them for the data it touches and says which law
admits each new state, consumer, or fact — so a review finding of one of these
shapes is answered by the law, and a design that satisfies them up front rules
the shape out as a class. M4's first production instantiations are
`PaymentRowState` plus the exhaustive `PAYMENT_ROW_LIFECYCLE` declaration,
`RefundAuthorityState` plus its exhaustive refund lifecycle, the exact claim and
revision transactions, and `ATTENDEE_DATA_RULES`; M5's cases, M6's aggregate
rows, M7's refund jobs, M8's completions, and M11's migration copies are all
data these laws bind.

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

Milestones are behavior units, not normally a PR count: one milestone may land
as several standalone PRs (M3 already has), and each PR still satisfies every
delivery rule on its own. The M6–M11 aggregate replacement is the deliberate
exception: its work packages may be developed and reviewed as commits or
unmerged branches, but they activate in one PR and one fleet-wide cutover
because any merged intermediate would require a live compatibility path.
Provider cutovers move Stripe, Square, and SumUp together behind exhaustive
records keyed by provider, so adding or omitting a provider is a compile error.

The approved work has one current-path stack and one atomic aggregate cutover.
The current-path stack now has M4 Part A's exhaustive provider outcomes,
provider-tagged reference admission with explicit refusal for older untagged
references, exact admin claims, one callback/admin provider authority and send
permit, bounded selected-page execution, exact ledger repair, and owner-visible
recovery. The aggregate cutover turns whole-checkout problems into durable cases
without duplicating that lifecycle, makes attendee merge atomic, moves checkout,
reads, completion, delivery, and site effects to stable booking obligations with
exact allocations, migrates retained history under the owner key, then removes
every old runtime reader and writer before activation. Its internal work
packages are individually testable, but are not live release layers.

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
authority for this live slice. It hardens admin single refunds, Refund All,
Payment Refresh, buyer-callback refunds, payment-row merge/delete/retention, and
the provider and checkout boundaries they use. It activates `payment_charges` as
the one provider-refund authority. It does not build a whole-checkout
observation, allocate one charge across stable booking obligations, or write the
other dormant aggregate tables. The former `PR4_PLAN.md` has been retired; this
as-built map and the fault ledger preserve the useful decisions without leaving
a second planning document to drift from the code.

As-built module map:

| Contract                         | Exported entry points                                                                                                                                                                                                                                                                                                                                                                        | Focused authority tests                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Charge evidence and judgment     | `chargeMoneyRead`; `refundMoneyReturned`; `refundMoneyAccountedFor`; `refundMoneyMatchesCapture`; `refundOutcomeOf`; `resolveRefund`; `admitRefund`; `admitObservedRefund`; `admissionReason`                                                                                                                                                                                                | `test/shared/payment/{resources,diagnose,refund,admit-refund}.test.ts`                                                                                                                                                                                                                                                                                                                                                                          |
| Provider reads and attempts      | `ProviderRead`; `providerFailure`; `RefundAttemptResult`; `RefundRequest`; `refundOutcomeAfterReread`; `refundWithOneReread`; `SquarePaymentStatus`; `isSquarePaymentStatus`                                                                                                                                                                                                                 | `test/shared/payment/{provider-failures,refund-attempt}.test.ts`; `test/shared/stripe-provider/{outcomes,refund-outcomes}.test.ts`; `test/shared/square/refund-outcomes.test.ts`; `test/shared/sumup/{transaction,provider-money}.test.ts`; `test/shared/square-provider/{metadata,webhook-fields}.test.ts`                                                                                                                                     |
| Durable provider state           | `RefundAuthorityState`; `RefundAuthorityStateName`; `readRefundAuthorityState`; `writeRefundAuthorityState`; `validateRefundAuthorityState`; `refundStateMirror`; `refundLocalMirror`; `refundNextActionAt`; `readyRefund`; `armRefundSend`; `markRefundObservationDue`; `rearmKeyedRefund`; `returnRefundToReady`; `markRefundCompleted`; `markRefundLocalRecorded`                         | `test/shared/payment/refund-authority-state.test.ts`; `test/shared/payment/refund-authority/state.test.ts`; `test/shared/provider-refunds/state/contracts.test.ts`; `test/integration/refund-authority-architecture.test.ts`                                                                                                                                                                                                                    |
| Conflict, choice, and lifecycle  | `RefundConflictDecisionSchema`; `refundConflictDecision`; `refundConflictNeedsProviderCheck`; `markRefundOwnerChoiceNeeded`; `mayReplaceRefundWithFreshEvidence`; `markRefundProviderConflict`; `refundOwnerChoices`; `resolveRefundOwnerChoice`; `refundEvidenceActionAllowed`; `refundLifecycleFor`; `refundAuthorityWorkSql`; `refundAuthorityPrunableSql`; `refundMoveRefusalOrNull`     | `test/shared/payment/refund-authority-choice.test.ts`; `test/shared/payment/refund-authority-lifecycle.test.ts`; `test/shared/payment/refund-authority/state.test.ts`; `test/shared/provider-refunds/{state,target-conflict}.test.ts`; `test/integration/refund-authority-architecture.test.ts`                                                                                                                                                 |
| Provider permit and one engine   | `ProviderRefundEvidence`; `ProviderRefundTarget`; `ProviderRefundResult`; `RefundAuthorityReceipt`; `ProviderRefundDependencies`; `RefundEngineProvider`; `loadRefundProvider`; `AuthorizedRefundRequest`; `authorizeDurableRefundSend`; `requireProviderRefundAuthorization`; `requestProviderRefunds`; `requestProviderRefund`; `recordProviderRefunds`                                    | `test/shared/provider-refunds/{target,state,work,send,budget}.test.ts`; `test/shared/provider-refunds/send/outcomes.test.ts`; `test/shared/provider-refunds.test.ts`; `test/integration/refund-authority-architecture.test.ts`                                                                                                                                                                                                                  |
| Atomic authority storage         | `prepareRefundAuthority`; `createOrLoadRefundAuthority`; `bindRefundCallbackIfChargeExists`; `transitionRefundAuthority`; `resolveRefundAuthorityMoney`; `completeRefundAuthority`; `markRefundAuthorityRecorded`                                                                                                                                                                            | `test/shared/db/provider-refund-authority.test.ts`; `test/shared/provider-refunds/{target,state,work,send}.test.ts`                                                                                                                                                                                                                                                                                                                             |
| Callback and placeholder cutover | `requestSessionRefund`; `refundRejectedCharge`; `storeRefundedBooking`; `attendeePaymentProvenance`; `finishPlaceholderRefund`; `resumePlaceholderSession`; `completePlaceholderMoney`; `advanceSessionFailure`; `loadAnchorRowWork`                                                                                                                                                         | `test/features/api/payment-processing/refunds/{provider-result,rejected-charge}.test.ts`; `test/features/api/payment-processing/{index/refunds,store-refund,store-refund-authority,placeholder-resume}.test.ts`; `test/shared/db/processed-payments/outcome-advance.test.ts`; `test/shared/db/payment-anchor/held-work.test.ts`; `specs/payments/unreadable-payment-kept.feature`; callback integration suites under `test/integration/server/` |
| Admin claims and dispatch        | `claimLeaseMs`; `checkingClaimFor`; `claimAttendeeRows`; `underAttendeeClaim`; `runRefundReadiness`; `rememberReadinessFailureFindings`; `requestReadyRefund`; `dispatchRefundBatch`; `refreshClaimedPayment`; `AuthorityBearingReference`; `recordedRefundAuthorities`                                                                                                                      | `test/shared/payment/claim.test.ts`; `test/shared/db/payment-claim/{admission,take,unrecorded-date}.test.ts`; `test/shared/db/payment-claim/take/shared-references.test.ts`; `test/features/admin/refunds/{claim,readiness-failure-evidence}.test.ts`; `test/features/admin/refunds/readiness-findings/authority-failure.test.ts`; `test/features/admin/refunds/dispatch/{budget-lifecycle,write-order}.test.ts`                                |
| Owner recovery                   | `ProviderRefundCase`; `listProviderRefundCases`; `loadProviderRefundCase`; `resolveProviderRefundCase`                                                                                                                                                                                                                                                                                       | `test/shared/db/provider-refund-cases{,-validation}.test.ts`; `test/shared/provider-refunds/state-owner-revision.test.ts`; `test/integration/server/privacy-refund-recovery{,-active-revision,-race}.test.ts`; `test/ui/templates/admin/provider-refund-cases.test.tsx`; `specs/payments/resolving-uncertain-refunds.feature`                                                                                                                   |
| Local work and destructive moves | `PaymentWorkStatus`; `PaymentRecoveryAction`; `PAYMENT_ROW_LIFECYCLE`; `paymentWorkFor`; `paymentWorkForMirrors`; `mirroredMoveRefusalOrNull`; `mirrorFor`; `PaymentMoveSnapshot`; `loadPaymentMoveSnapshot`; `assertRowsFreeToMove`; `PaymentRowsBusyError`; `ATTENDEE_DATA_RULES`                                                                                                          | `test/shared/payment/admit-move.test.ts`; `test/shared/db/payment-admit-move.test.ts`; `test/features/admin/attendee-page/actions.test.ts`; `test/integration/server/attendees/delete.test.ts`; `test/shared/db/attendees/{dependent-data,delete}.test.ts`; `test/shared/db/prune/payments.test.ts`; `specs/payments/recovering-the-money-record.feature`                                                                                       |
| Confirmation and local review    | `confirmRefund`; `insertRefundConfirmation`; `PAYMENT_REVIEW_RETIREMENT`; `getPaymentReviewState`; `acknowledgeCurrentPaymentReview`                                                                                                                                                                                                                                                         | `test/features/admin/refunds/confirmation.test.ts`; `test/shared/db/{refund-confirmations,payment-review}.test.ts`; `test/features/admin/attendee-payment-review.test.ts`                                                                                                                                                                                                                                                                       |
| Exact Money repair               | `refundMoneyReturned`; `refundMoneyAccountedFor`; `computeAttendeeRefunds`; `RefundLedgerResult`; `REFUND_LEDGER_BATCH_DATABASE_CALLS`                                                                                                                                                                                                                                                       | `test/shared/payment/resources.test.ts`; `test/shared/refund-ledger/plan/{partial,reference-placement,whole-account}.test.ts`; `test/shared/refund-ledger/record/batch.test.ts`; `test/features/admin/refunds/provider/batch/{ledger-findings,ledger}.test.ts`                                                                                                                                                                                  |
| Bounded command support          | `refundReadinessSubrequestCost`; `refundPreparedSubrequestCost`; `REFUND_SETTLEMENT_SUBREQUEST_RESERVE`; `REFUND_LEDGER_SUBREQUEST_RESERVE`; `REFUND_OBSERVED_AUTHORITY_DATABASE_CALLS`; `REFUND_ACTIVE_AUTHORITY_DATABASE_CALLS`; `REFUND_RESULT_DATABASE_RESERVE`; `withSubrequestReserve`; `withDeferredErrorReports`; `getRefundCandidates`; `getRefundAllSummary`; `loadRefundAllBatch` | `test/features/admin/refunds/{budget,claim-settlement,candidates}.test.ts`; `test/features/admin/refunds/provider/batch/budget.test.ts`; `test/features/admin/refunds/dispatch/budget-lifecycle.test.ts`; `test/features/admin/refunds/readiness-run/refresh-budget.test.ts`; `test/shared/provider-refunds/{budget,send}.test.ts`; `test/shared/subrequest-budget.test.ts`; `test/integration/logger/log-error.test.ts`                        |
| Private indexed references       | `storePaymentReference`; `loadPaymentReference`; `prepareClaimedAttendeePaymentAnchor`; `attendeePaymentProvenance`; `getRefundPaymentReferences`; `MAX_REFUND_REFERENCES_PER_ATTENDEE`                                                                                                                                                                                                      | `test/shared/db/payment-anchor/{attendee,reference}.test.ts`; `test/shared/db/payment-references{,/readiness,/storage}.test.ts`; `test/shared/db/{refund-all-candidates,attendees/create,attendees/pii}.test.ts`; `test/features/api/payment-processing/{store-refund,store-refund-authority}.test.ts`; `test/integration/refund-authority-architecture.test.ts`                                                                                |
| Attendee refund controls         | `refundWorkRemains`; `loadAttendeeForEdit`; `attendeePage`                                                                                                                                                                                                                                                                                                                                   | `test/features/admin/attendee-page-data/{refund-actions,refunds-ui}.test.ts`; `test/features/admin/attendee-page/actions.test.ts`; `test/integration/server/attendees/payment.test.ts`; `specs/payments/checking-before-a-refund.feature`                                                                                                                                                                                                       |

- **Authority module ownership.** `payment/refund-authority-state.ts` owns the
  one stored union, its parser, serializer, validation, and SQL mirrors.
  `payment/refund-authority.ts` owns pure automatic transitions;
  `payment/refund-authority-choice.ts` owns the explicit owner/conflict
  transitions, legal-choice derivation, and the exhaustive
  `mayReplaceRefundWithFreshEvidence` rule;
  `payment/refund-conflict-decision.ts` turns fresh Money evidence into the
  exact `not_sent | returned | wait` decision; and
  `payment/refund-authority-lifecycle.ts` is the one exhaustive declaration of
  each state's admitted evidence actions (`check_provider`, `observe_pending`,
  and `replace_with_fresh_evidence`), blocker, clearer, choice requirement,
  operator route, and pruning rule. Both the destructive-work SQL and its exact
  pruning inverse derive from that declaration. The database identity and state
  writers remain `db/provider-refund-authority.ts` and
  `db/provider-refund-authority-change.ts`; owner decisions plus their activity
  audit remain one transaction in `db/provider-refund-case-resolution.ts`. These
  are parts of one authority, not interchangeable implementations.
- **Refund-only rules.** `src/shared/validation/kind.ts` and
  `src/shared/payment/{resources,conflict,diagnose,refund,admit-refund}.ts`
  define one charge's captured/refunded facts and one `refundOutcomeOf`
  judgment. Its pure `PaymentConflict` result can name `refund_exceeds_capture`,
  `partial_refund`, or `multiple_pending_refunds`; those are charge-judgment
  values, not variants stored in the local `PaymentReviewReason` schema. Durable
  disagreements use the canonical provider authority's `provider_conflict`
  evidence. Only exact zero or full return admits a real owner decision in
  `needs_owner_choice`; partial or inconclusive evidence lives in
  `needs_provider_check` and can only be observed again. Both retire through the
  one canonical Refund recovery route. `failed_refund` is deliberately absent:
  an attempt that certainly moved no money may be retried, while a failure
  reported beside returned money is diagnosed from the returned facts. The judge
  never invents the signed checkout total or booking allocation that this slice
  cannot read.
- **Reference identity and storage.** Migrations
  `2026-08-10_refund_authority_records.ts`, `tables-attendees.ts`,
  `db/payment-reference-store.ts`, `db/payment-reference-rows.ts`,
  `db/payment-references.ts`,
  `db/payment-anchor/{reference,session,attendee}.ts`, and
  `db/attendees/payment-provenance.ts` keep a new raw reference under the owner
  key and a DB-keyed blind equality index beside it. That index is deliberately
  NOT unique: several attendee/payment rows may legitimately represent one
  provider charge, and the claim must expand to all of them. `protected_state`
  is only a plaintext state word. `getRefundPaymentReferences` accepts an
  explicitly named, decrypted `currentPaymentId` and returns the exhaustive
  `complete | legacy_unindexed | provider_unknown | too_many_references`
  `RefundPaymentReferenceSet`; it never exposes only an unsafe subset. Its SQL
  names only the selected attendee ids and retrieves at most the declared ten
  references plus one proof of overflow per attendee. A non-empty historical
  `processed_payments.payment_reference` with a blank `payment_reference_index`,
  or a current PII payment id absent from that attendee's indexed identities,
  makes the attendee `legacy_unindexed` before provider I/O. An eleventh
  reference makes it `too_many_references` before decryption or provider I/O. An
  indexed reference without an authenticated provider tag makes it
  `provider_unknown`. Once any refusal is proved, the attendee cannot reach
  provider I/O; unindexed and oversized sets are also refused before their
  reference bodies are decrypted.

  `loadPaymentReference` requires owner-key `hyb:1` ciphertext and throws at the
  storage boundary for a raw or DB-key value. There is no live plaintext
  decoder. Historical rows with no usable owner-encrypted index remain
  permanently unavailable to current in-app refunds. The owner refunds those
  payments directly in Stripe, Square, SumUp, or the relevant provider. Neither
  attendee save nor merge backfills them. There is no population decrypt,
  request-time recovery, dual read, compatibility writer, or promised M11
  qualification path.

  `attendees.pii_payment_session_id` makes that boundary queryable without
  opening PII. `NULL` means historical or otherwise unqualified; `''` proves the
  encrypted PII had no payment id; a non-empty value names the exact
  `processed_payments.payment_session_id` whose owner-encrypted, blind-indexed
  reference proves the PII id. A normal paid booking writes the pointer in its
  existing all-or-nothing booking transaction. A callback placeholder writes it
  through `attendeePaymentProvenance` in the placeholder transaction. A later
  balance payment never changes the pointer, so it cannot make an older PII-only
  deposit look complete. Merge propagates a source `NULL` to the target in the
  same merge transaction, so deleting the source cannot erase evidence of hidden
  old history; a source `''` or non-empty qualified pointer leaves the target's
  provenance unchanged. Pruning retains the exact processed row named by a
  non-empty pointer. The PII-free Refund All summary treats `NULL` as
  `legacy_unindexed`, even beside a newer indexed balance, and refuses before
  selecting, decrypting, or calling a provider.

  `prepareClaimedAttendeePaymentAnchor` accepts only a provider-tagged identity
  and is called only by the validated callback placeholder transaction. It
  prepares the owner-encrypted anchor and its canonical `PaymentRowState`
  `checking` claim as one insert; the attendee, booking rows, indexed reference,
  destructive-write fence, and conservative original-session outcome therefore
  commit atomically. It cannot be called by attendee save or merge; the
  architecture test pins that sole production caller. Distinct old deposit,
  balance, merge, session, and PII-only references remain unsupported by the
  current in-app refund path. `legacy_unindexed` and `provider_unknown` are
  derived historical-data refusals, not runtime compatibility paths or persisted
  work, and neither acknowledgement nor a generic clear retires them. Historical
  application behavior never assigned one payment ID to separate attendees, so
  this path does not scan or decrypt unrelated attendee PII for a hypothetical
  old sharing case; indexed representations and merges still expand by blind
  identity.
- **Provider ownership.** New checkout, callback, and placeholder writes carry
  the provider inside the owner-encrypted reference. Admin admission accepts
  only that provider-tagged identity. An untagged indexed reference returns
  `provider_unknown` before loading any provider; it is never searched for,
  inferred from current configuration, or bound by a runtime repair. The old
  provider-discovery and binding modules were deleted with their callers and
  tests, and the architecture gate rejects their return. Historical returned
  markers do not attest a provider or amount. A tagged provider is
  authoritative, not a search hint: if it is unconfigured or its read is
  missing, unavailable, or invalid, the row stops there and no other adapter is
  tried. Every refund-facing adapter load receives the complete
  `TaggedPaymentReference` and goes through `loadRefundProvider`, which loads
  only `reference.provider` and verifies that the returned adapter matches the
  tag. Refund code cannot accept a bare provider type, consult current/last
  configuration, enumerate stored credentials, call raw `loadPaymentProvider`,
  or import provider adapters directly. Readiness, capability, and dispatch
  remain per reference, so one merged attendee may safely carry payments from
  different providers. `provider_unknown` is a bounded typed limitation, not
  recoverable work. The attendee page explains that the old row did not record
  its provider and does not render a Refresh form whose route can only refuse;
  Single Refund, Refund All admission, and a direct Refresh request all remain
  fail-closed with zero provider calls. The old ambient provider-to-dashboard
  guess was deleted too: an untagged payment id is inert display text, with no
  provider dashboard link or external-link target even when one provider is
  currently configured. The owner handles that historical payment in the
  provider dashboard; current refund code never qualifies it.
- **Provider boundary.**
  `payment/{provider-read,provider-failures,refund-attempt,refund-network}.ts`
  and the Stripe, Square, and SumUp adapters replace nullable reads and booleans
  with `found | missing | unavailable | invalid` and
  `completed | accepted | rejected | not_sent | uncertain`. Stripe and Square
  send the exact captured minor units and currency admitted from the read. SumUp
  exposes only a full-refund-by-transaction operation, so the exact admitted
  transaction is its send boundary rather than an amount argument. Stripe checks
  `captured`, `paid`, and `status`, then derives Money from the documented
  `amount_captured`, `currency`, and `amount_refunded` fields; the provider's
  boolean `refunded` flag is never enough. Square validates payments, refunds,
  and orders at the wire boundary and treats only an explicit 404 as missing.
  Its payment webhook admits exactly `APPROVED`, `PENDING`, `COMPLETED`,
  `CANCELED`, and `FAILED`: a missing, non-text, empty, or unknown status throws
  at the boundary; a known non-completed status is the only status acknowledged
  without processing; and `COMPLETED` must also carry its Order id. The shared
  `isSquarePaymentStatus` declaration and
  `test/shared/square-provider/webhook-fields.test.ts` pin that set, so a new
  provider word cannot silently become a safe skip. SumUp never turns a missing
  proof into a full return: a top-level `REFUNDED` transaction without at least
  one refund event is invalid `missing_documented_resource`. A `SUCCESSFUL`
  transaction with an absent or empty event list means zero returned. Every
  present event must name a known type, a chargeback invalidates the read, and
  every refund event must have a supported status plus a valid amount in the
  transaction currency.

  `providerFailure` gives every adapter the same read-side transport table: 404
  is `missing`; 400/422 is invalid `rejected_request`; 408/504 is unavailable
  `timeout`; 429 is unavailable `rate_limited`; every other HTTP failure is
  unavailable `provider_error`; a malformed answer is invalid; and a connection
  failure is unavailable. An ambiguous send gets one bounded reread, never an
  adapter loop. SumUp also treats a rejected response as local evidence about
  that request, not proof that no refund happened beside it. Every SumUp result
  except `not_sent` takes exactly one fresh charge read. Its rejection goes
  through the same `refundOutcomeAfterReread` judgment Stripe and Square use: a
  fully returned charge completes from that fresh observation, and only a fresh
  `found` charge that is still `ready` preserves rejection. Pending or
  conflicting money becomes `uncertain: observed_refund`; mismatched captured
  money becomes `uncertain: mismatched_money`; a missing read becomes
  `uncertain: missing_documented_resource`; and an unavailable or invalid read
  becomes uncertain with that read's exact reason. None invent completion, and
  none lets a request-local rejection release the claim as conclusive when the
  fresh charge itself is unreadable.
  `test/shared/sumup/{transaction,provider-money}.test.ts` and
  `test/shared/payment/refund-attempt.test.ts` pin the wire meaning, one-read
  count, and this evidence table.
- **Canonical authority storage.**
  `db/migrations/2026-08-10_refund_authority_records.ts` rebuilds the previously
  unwritten `payment_charges` table only after proving it empty; a populated
  table makes deployment fail rather than reinterpreting unknown data. Its
  schema stores provider, owner-key-encrypted reference, blind reference and
  callback replay identities, exact captured/refunded Money, provider
  capability, one validated state document, its SQL mirrors, next due time, and
  revision. Reference and callback identities are each globally unique. The
  JSON/mirror checks make a state disagreeing with its indexed work columns
  unstoreable. Exactly two modules form its one writer boundary:
  `db/provider-refund-authority.ts` creates identities and binds callback
  evidence, while `db/provider-refund-authority-change.ts` owns every Money and
  state transition as one revision-conditional statement. The architecture test
  rejects any third writer. `db/provider-refund-cases.ts` owns bounded case
  reads and decrypts the reference only for the owner-only detail page;
  `db/provider-refund-case-resolution.ts` applies the exact decision and writes
  its activity audit in one transaction.
- **Exact claims and retry capability.**
  `payment/{row-state,claim,review,admit-move}.ts`,
  `db/payment-claim{,/scope,/take}.ts`, and
  `features/admin/refunds/{claim,dispatch,authority}.ts` admit only a complete
  indexed attendee set. Inside the claim transaction, the command rereads every
  non-empty reference row owned by the selected attendees, including blank-index
  rows, plus indexed sharing rows. That expansion is hard-bounded:
  `MAX_SHARED_PAYMENT_ROWS_PER_CLAIM` admits at most 100 rows outside the
  selected attendee set, and the SQL reads at most 101 so the last row is only
  an overflow sentinel. Seeing it returns the typed `too_many_reference_holders`
  refusal before any sharing row's encrypted `failure_data` is decrypted, before
  a claim write, and before provider or ledger I/O. The refund and Refresh
  surfaces map that finite result to exact operator copy; they never truncate
  the sharing set. A blank-index row present at initial load yields
  `legacy_unindexed`; an indexed but untagged reference yields
  `provider_unknown`; and a row that appears between load and claim makes the
  exact row-set comparison return `changed`. None can reach the provider
  authority. A blank index is a separator, never an equality value: it is
  omitted from the sharing lookup, two blank indexes never make rows holders of
  one charge, and a selected set with no non-empty indexes skips the sharing
  query entirely. The transaction also fences each attendee's exact `pii_blob`
  revision and exact `(attendee, session, reference index)` set. Any PII
  revision change or payment-row addition, deletion, or reassignment between
  load and claim returns `changed` for the whole command; no row receives a
  partial claim. The claim expands matching indexed representations and
  preserves the initiating attendee scope after a merge. `processed_payments`
  holds only this short-lived `checking` fence; it stores no provider send
  phase, capability, or completion projection. `checkingClaimFor` is the one
  constructor for that fence, used by both ordinary claim acquisition and the
  automatic placeholder anchor. There is no second hand-built claim shape for
  callback recovery.

  `test/shared/db/payment-claim/take/shared-references.test.ts` proves the
  blank-index separator and zero-index-query rules, proves the 100-row edge is
  accepted, and proves 101 is refused without decrypting even deliberately
  corrupt shared state. `test/shared/db/payment-claim/{admission,take}.test.ts`
  prove the exact row-set and attendee-revision fence. The readiness admission
  regression proves the typed refusal remains finite at the feature boundary.

  `payment/refund-{authority,authority-state,authority-choice,authority-lifecycle,conflict-decision,provider-authorization,replay-window,request-identity}.ts`,
  `db/provider-refund-authority.ts`, and `shared/provider-refunds.ts` and
  `shared/provider-refunds/{target,send,state,work,budget}.ts` own the
  irreversible lifecycle. One globally unique blind reference index identifies
  the charge, one unique callback index deduplicates callback delivery, and
  every transition compares an exact revision. `ready` means evidence permits
  one attempt; `send_armed` means that exact generation may have crossed the
  network boundary; `observing` waits for fresh evidence; `completed` separately
  tracks provider return and local Money recording; `needs_owner_choice` means
  the stored evidence schema admits at least one specific owner answer; and
  `needs_provider_check` means it admits none and only another observation may
  advance it. Both attention states block sends and destructive deletion. An
  observe-only check may retire an ordinary ambiguity when fresh provider
  evidence proves the money fully returned. Fresh partial, invalid, backward,
  wrong-currency, excessive, or pending evidence instead replaces that ordinary
  ambiguity with `needs_provider_check`, advances the authority revision, and
  preserves or raises the proved returned-Money floor. It therefore invalidates
  a stale “not sent” form rather than letting an old guess erase newer evidence.
  Identical provider-check evidence is the only recheck that preserves the
  current revision. Any changed returned amount or changed conclusion advances
  it, including evidence that moves backwards and therefore becomes `wait`. A
  conclusive `provider_conflict` owner-choice revision is immutable under later
  reads. Stripe and Square declare `keyed`; SumUp declares `keyless`. Keyed
  replay uses the same identity only inside its finite provider window. Keyless
  work never automatically resends an armed generation. A fresh `accepted`
  result stays `observing` until provider evidence proves the return; an
  idempotency key is not settlement proof.

  `ProviderRefundTarget` makes send versus observation explicit. A clean
  observe-only read with no existing authority returns `unchanged`; it does not
  invent durable work. Once an authority exists, callback and admin entry points
  both reconcile that same row through the exhaustive `changed`,
  `needs_owner_choice`, `needs_provider_check`, `pending`, `ready`, `returned`,
  `unchanged`, or `withheld` result. `unchanged` is possible only for a clean
  observe-only probe with no authority to create; `changed` is the explicit lost
  revision result.

  A `ready` authority cannot remain a dead Send control when its provider read
  is unreadable. `missing` or `invalid` evidence moves it immediately to
  `needs_owner_choice/provider_unreadable`; `unavailable` gets one finite
  five-minute grace from `readyAt`, then the same transition if it still cannot
  be read. Every such attempt makes zero provider refund sends. The owner page
  explains that no refund was sent and requires the ordinary explicit
  provider-returned/provider-not-sent choice; it never offers a generic clear or
  a second send path.

  Only `shared/provider-refunds/send.ts` can mint `AuthorizedRefundRequest`, and
  every provider adapter requires that permit. The architecture test rejects any
  second mint import, adapter/API caller, `payment_charges` writer, legacy
  refund path, or live read/write of `provider_refunded_at`. It also rejects
  current/last provider selectors, `existingPaymentProviderState`, the deleted
  `orderedCredentialedPaymentProviderTypes`, raw `loadPaymentProvider`, and
  direct adapter imports in refund-facing code. `loadRefundProvider` has an
  exact production allowlist: admin refund readiness and the provider-refund
  authority. Attendee-claim settlement still matches the exact command id, lease
  time, and `checking` phase, so a stalled predecessor cannot release a
  successor's fence.

  `paymentRowStateStatement` writes the encrypted `failure_data` record and its
  derived plaintext mirror in ONE conditional statement, matching the exact
  prior `failure_data`. `PaymentRowSettlement` requires an explicit claim
  keep/release decision and changes only the optional books/review facts the run
  proved; an absent decision never clears an older repair target, review, or
  terminal outcome. A CAS loser changes nothing and cannot overwrite a
  successor. Paid-balance completion uses
  `db/payment-finalize.ts:balanceFinalizeStatements`, whose transaction guard
  aborts while an admin refund claim holds that attendee; the callback retries
  instead of racing a booking-finalization write against money leaving.
- **Bounded orchestration.**
  `features/admin/refunds/{attempt,budget,candidates,claim,dispatch,provider,provider-requests,readiness-run,waves}.ts`,
  `subrequest-budget.ts`, and `db/client.ts` price physical provider retries,
  database retries, rollback, settlement, and caller tails at several
  checkpoints before fresh provider I/O. The readiness budget prices every
  active tagged reference from its stored provider identity. It has no
  configured-provider argument and never assigns zero cost because credentials
  appear absent; ambient settings cannot change refund admission. A selected
  command that cannot fit refuses without narrowing or sending. Dispatch
  reserves the exact post-arm send, bounded reread, and returned-money recording
  allowance around the arm transaction itself. Claim acquisition runs inside the
  settlement reserve; it is not counted a second time in the plan. An arm retry
  therefore cannot consume the permission it is about to persist: exhaustion
  before commit is proved `not_sent`, while a durable keyless `send_armed` phase
  is reserved for a genuinely uncertain dispatch. The engine's declared
  worst-case database envelopes are four calls for an already-known terminal
  authority, sixteen for an observation that creates durable work, twenty for an
  active send, eight reserved while the provider call is in flight, and twelve
  to retire returned local work. That final retirement is not pre-reserved: a
  completed return whose local books are due is canonical recoverable work, not
  an unsafe partial send. The envelopes derive from `DATABASE_MAX_ATTEMPTS`, not
  hand-counted happy-path SQL. One unresolved reference fits; two independently
  retryable sends or observations refuse before either provider read. Provider
  calls overlap by at most five. One attendee may still carry up to ten
  references, so even the one-attendee Refund All batch can refuse safely before
  its first provider call. `logger.ts:withDeferredErrorReports` queues
  non-critical activity, notification, and Sentry fan-out until the
  money-critical command finishes, and flushes the queue even on a throw, so
  diagnostics cannot consume the subrequests reserved for settlement or
  rollback. Nested scopes share one outer flush boundary, and independent or
  overlapping errors each persist; only recursive reporting caused by that
  persistence attempt is suppressed
  (`test/integration/logger/log-error.test.ts`).
- **Refund All admission.** `db/refund-all-candidates.ts` first computes a
  PII-free whole-listing count and detects any visible `review`, `unrecorded`,
  or incomplete historical-payment blocker among that same complete refundable
  set. Its booking CTE requires the event-group-scoped ledger sale and payment
  facts, so a paid booking with no reference-bearing processed-payment row
  contributes a `legacy_unindexed` blocker without reading its PII; a free
  booking or an abandoned checkout with only a sale contributes nothing.
  Together those facts prove only that the booking took money, not its raw
  provider reference or provider ownership. Settled non-candidates keep their
  own protection and repair state but cannot strand an unrelated refund. The
  summary runs before selection, so any SQL-visible blocker on a refundable
  candidate refuses the whole command. The GET/summary route decrypts zero
  attendee PII blobs. The POST batch loads at most one encrypted blob, with
  existing claims first, and decrypts zero when the summary is blocked or empty
  and exactly one otherwise. It never decrypts an attendee array and then slices
  it. Typed candidate admission catches a current PII payment id with no indexed
  identity and a row that appears after the summary; an incomplete attendee
  rejects the request before provider I/O. That historical reference remains a
  manual provider-dashboard refund; no later milestone is expected to qualify it
  for this command. The selected attendee passes through the same claim and
  budget admission as a single refund.
  `features/admin/refunds/candidates.ts:getRefundCandidates` drops quantity-zero
  rows and deduplicates by attendee before loading references, so several
  booking rows for one person consume one place, one tally, and one
  orchestration run. One submission retires at most one person and reports the
  remaining count; another submission takes the next person. This conservative
  batch size follows the proved Bunny envelope for one attendee's complete
  reference set; the provider overlap ceiling remains five within that attendee.
  M7 still owns a durable cursor/job that remembers and resumes the operator's
  whole-listing intention after a crash.
- **Money settlement.** `shared/accounting/{queries,store}.ts`,
  `shared/refund-ledger/{plan,result,record,log}.ts`, and
  `features/admin/refunds/{ledger-findings,result-findings,provider,claim,refresh}.ts`
  carry exact `recorded`, `unrecorded`, and `review` findings back to each held
  reference and settle each attendee independently, so doubt for one person
  cannot hold proved-finished neighbours. A provider-confirmed return is
  conservatively `unrecorded` until the ledger disproves it. Every returned
  observation enters the settlement findings before the fallible canonical
  authority write. If that write fails for the same charge or a sibling, all
  returns already proved in the wave remain exact `unrecorded` work; the
  authority error still propagates. If another provider read fails, successful
  sibling observations are likewise not discarded: returned money remains exact
  `unrecorded` work, in-flight money retains doubt, a contradiction becomes
  review, and ambiguous provider identity beside money movement stays
  `in_doubt`. An unexpected preparation throw likewise keeps every
  still-unproved row in doubt. `underAttendeeClaim` attempts settlement on both
  the returned and thrown paths; it never promises that settlement itself cannot
  fail. A failed settlement may retain the claim and is propagated when work
  otherwise succeeded.

  A ledger throw first turns every provider-confirmed return into exact
  `unrecorded` work and keeps every still-unproved row in doubt, then attempts
  settlement before propagating the original error. A secondary settlement
  failure is reported without replacing that root failure, and a successful
  return is not exposed to the caller until settlement lands. Accumulated
  evidence — never control-flow optimism — decides what may release. Repeated
  repair preserves the first `unrecorded.returnedAt` date
  (`test/shared/db/payment-claim/unrecorded-date.test.ts`). The batch ledger
  uses one bounded snapshot: a stored conflict parks only its attendee, while a
  database failure marks every unproved plan unrecorded. The bound is
  executable, not aspirational: `REFUND_LEDGER_BATCH_DATABASE_CALLS` is four,
  and `test/shared/refund-ledger/record/batch.test.ts` proves thirty returned
  attendees still take exactly those four database round trips.
  `test/features/admin/refunds/readiness-findings/authority-failure.test.ts`
  pins the before-authority ordering for one returned charge and returned
  siblings.
- **Confirmation and review.** `features/admin/refunds/confirmation.ts`,
  `db/refund-confirmations.ts`, `db/payment-review.ts`,
  `db/notes/{queries,types}.ts`, and migration
  `2026-08-10_refund_authority_records.ts` store one replay-safe confirmation
  keyed by the attendee and sorted provider-aware blind indexes. The
  confirmation, held-row assertion, generic activity, and optional named
  confirmation note commit together. Confirmation never scans, decrypts, or
  deletes historical note history, including for an old anchor. Old
  manual-refund warnings are compatibility display history only: a successful
  indexed confirmation leaves them visible beside the authoritative
  confirmation, and the owner may delete each note through the ordinary note
  action. This deliberately trades automatic cleanup of old display history for
  constant request work; do not restore a history scan to tidy it.

  Local `PaymentReviewReason` stores only `shared_reference` and
  `partially_returned_obligation`. Acknowledgement stamps the exact case
  revision to record that the owner saw it; it does not clear the marker,
  authorize a refund, or decide an allocation. The evidence-owned clearer is
  exhaustive: `shared_reference` retires only after one unique indexed
  representation is proved, and `partially_returned_obligation` only after every
  exact reference is returned and recorded.

  Provider uncertainty and charge conflicts never enter that local review
  schema. `provider-refund-cases.ts` exposes the canonical authority's own
  revision. `payment/refund-authority-choice.ts` derives the only legal action
  from the exact stored evidence: ordinary uncertainty offers returned or not
  sent; an exact zero-return conflict offers only not sent; an exact full-return
  conflict offers only returned; and a partial return or invalid, backward,
  wrong-currency, excessive, or pending evidence offers no money answer and can
  only be checked again. The stored union makes those last cases
  `needs_provider_check`, while `needs_owner_choice` is constructible only with
  a non-empty legal choice set. A fresh partial or inconclusive reading replaces
  an ordinary ambiguous choice instead of leaving a stale not-sent answer
  available. `money_recorded` is the separate proof that the local ledger caught
  up. There is no generic clear. `PaymentWorkStatus` is exactly
  `clear | moving | needs_money_record |
  needs_provider_recovery | needs_review`.
  A live claim comes first, then an explicit owner review, then mechanical
  ledger repair, then canonical provider recovery. In particular, a generic
  repair action cannot hide the decision it is waiting for. The local-review
  form HMAC binds the complete sorted `[sessionId, caseId, reason]` set; its
  transaction rereads that set, stamps only unacknowledged cases, and writes one
  activity entry. Any claim blocks acknowledgement, regardless of age or phase.
  Managers can neither acknowledge review nor send refunds, in the rendered UI
  or at GET/POST authorization boundaries. Refresh intentionally remains
  available to an authenticated manager because it observes and repairs existing
  work but has no provider-send permit. The current pending copy says both “Do
  not send the refund again” and “Refresh payment status after it completes”; it
  never labels a resend as the recovery action.
- **Canonical Refund recovery.** `db/provider-refund-cases.ts`,
  `features/admin/privacy.ts`, and
  `ui/templates/admin/provider-refund-cases.tsx` derive the owner queue directly
  from `payment_charges`; there is no copied review or warning-note index. The
  queue keyset-pages twenty summaries without decrypting references. Only its
  owner-only detail opens the reference. `ready` renders one clearly marked Send
  action; `send_armed` and `observing` render observation only; `completed/due`
  requires the separate Money-recorded confirmation; `needs_owner_choice`
  renders only the answer justified by the exact conflict table above; and
  `needs_provider_check` renders only Check again, never a returned/not-sent
  choice. Stored Money is displayed with its own currency divisor, symbol, and
  code, never the site's current currency. A not-sent answer increments the
  generation and leaves `ready` work; saving the choice itself sends nothing.
  Every form binds the exact id and revision. The server reloads the current
  evidence, rederives its legal choices, and rejects a crafted submitted answer
  that the evidence does not admit; the authority stays unchanged. A ready Send
  carries the bound pair into authority admission and loses before provider I/O
  if the inspected revision changed. The same fence covers an active transition:
  a form rendered for revision 1 cannot check or send after revision 2 has
  become `send_armed`. An owner money decision compares its pair inside the
  transaction that changes the authority and writes its finite activity audit.
  Check again is observe-only: its POST first refuses a stale submitted
  revision, and any concurrent change after the read loses the transition CAS
  and is reread instead of overwriting newer evidence. An audit failure rolls an
  owner decision back. The HTTP and state-level races are pinned by
  `test/integration/server/privacy-refund-recovery{,-active-revision,-race}.test.ts`,
  `test/shared/db/provider-refund-cases-validation.test.ts`, and
  `test/shared/provider-refunds/state-owner-revision.test.ts`.
  `refund-authority-lifecycle.ts` exhaustively declares admitted evidence
  actions, the clearer, whether a choice is required, the real route, pruning,
  and merge/delete policy for every state. The architecture test proves every
  declared clearer is exported and every route is registered; the Cucumber story
  proves each rendered control reaches the real exit.
- **Review retirement and reachable repair.** `payment/admit-move.ts` has one
  exhaustive `PAYMENT_ROW_LIFECYCLE` entry for every non-settled
  `PaymentRowState` field; the winning entry supplies its mirror, status,
  recovery action, refusal, and delete/merge behavior. The recovery action is
  constrained to the real attendee-action schema. `db/payment-admit-move.ts`
  turns those row mirrors plus canonical charge work into one
  `PaymentMoveSnapshot`: a `delete | merge` admission record and the
  operator-facing `PaymentWork`. Both page rendering and transactional writers
  consume that same decision. The attendee Actions page therefore does not offer
  Delete to either an owner or a manager while payment work blocks it. A direct
  GET of the delete URL returns 400 and renders the reason without a
  confirmation form. Claims block both delete and merge; review, unrecorded
  Money, and canonical provider work block deletion but remain mergeable because
  their indexed row moves and the global charge authority does not.
  `features/admin/{attendee-page,attendee-page-data,attendee-payment-review,attendees-route-helpers}.ts`
  `ui/templates/admin/attendees.tsx`, and
  `ui/templates/admin/attendees/delete-confirm.tsx` render from authoritative
  indexed payment work, not legacy PII `payment_id`, so a merge cannot hide the
  only Refresh form. The per-attendee Refund action is admitted from that same
  complete reference set, `refundWorkRemains`, and an active booking line. It is
  absent when no tagged automatic payment exists, no active booking remains, or
  the exact authority says the cash work is finished; a legacy PII id or paid
  display value cannot make the action appear. These rules are pinned by
  `test/features/admin/attendee-page-data/refund-actions.test.ts`,
  `test/features/admin/attendee-page-data/refunds-ui.test.ts`,
  `test/features/admin/attendee-page/actions.test.ts`,
  `test/integration/server/attendees/{delete,payment}.test.ts`, and the real
  visitor journey in `specs/payments/recovering-the-money-record.feature`. Clean
  evidence retires only the exact local review it proves gone.
  `PAYMENT_REVIEW_RETIREMENT` is exhaustive over its two stored reasons:
  `shared_reference` needs one unique indexed representation, while
  `partially_returned_obligation` needs every exact reference returned and
  recorded. `partial_refund`, `refund_exceeds_capture`,
  `multiple_pending_refunds`, and uncertain keyless sends live only in the
  canonical provider authority and retire through Refund recovery. They are
  never copied into a parallel local-review lifecycle. Acknowledgement retires
  neither local reason.
- **Every destructive consumer.** `db/payment-admit-move.ts`,
  `db/attendees/dependent-data.ts`, `db/attendees/delete.ts`, `db/prune.ts`,
  `merge/attendee-merge.ts`, and `db/orphan-attendees.ts` make claims block
  merge and delete, while review and unrecorded money block delete and travel
  with a merge. The same admission joins matching `payment_charges`: every
  unfinished generation, owner choice, or completed return whose Money is due
  blocks deletion. Merge is relocation rather than destruction, so it may move
  the indexed processed reference while the globally unique charge authority
  stays in place; merge never copies or reparents that authority. The surviving
  attendee therefore reaches the same unresolved row and its real recovery
  route. The preflight is guidance only: merge and delete repeat the same
  admission on their own write transaction, so a claim that arrives after the
  page rendered still wins and rolls the destructive write back.

  The two lifecycle-derived plaintext mirrors gate prune and orphan purge. Empty
  local-row work permits a referenced payment row to age out only when that
  row's exact blind reference index matches a prunable canonical charge
  authority. An attendee-wide `refund_cash` leg and a returned sibling charge
  are never deletion authority; an ambiguous legacy reference with no exact
  canonical match stays retained. This preserves ordinary retention for the
  exact settled row without deleting another charge that is still paid.
  Conversely, any non-empty `protected_state` or non-prunable refund-authority
  state prevents pruning however old or stale it is: staleness can make recovery
  possible, but never makes a safety record disposable
  (`test/shared/db/prune/payments.test.ts`).

  Merge admits both source and target inside the transaction, because the source
  rows move and the target set grows. It relocates only reference-bearing rows
  already admitted by that transaction; it never mints a row from either
  attendee's PII payment id. This prevents both a false `shared_reference` case
  and a provider-less identity from becoming live authority.
  `ATTENDEE_DATA_RULES` exhaustively declares delete, repoint, or retention for
  every attendee-linked table, and production delete statements derive from it.
  Its schema tests walk the live database, reject undeclared attendee-id-like
  columns and payment tables, require every named column to exist, require
  children before parents, and prove production emits the declared operations
  (`test/shared/db/attendees/{dependent-data,delete}.test.ts`).

  Protected orphans are excluded from both scheduled and manual purge. The
  owner-only “Outstanding payment work” queue at `/admin/privacy` starts at the
  partial state index, selects distinct attendee ids, and keyset-pages twenty
  plus one lookahead without loading or decrypting attendee PII. It links by
  attendee id to the still-live attendee page. Review and Refresh are
  attendee-scoped, so their route and rendered control remain usable after the
  final listing is deleted (`test/integration/server/privacy.test.ts`,
  `test/features/admin/attendee-page/actions.test.ts`, and
  `test/features/admin/attendee-payment-review.test.ts`). Canonical provider
  work has its own “Refund recovery” list on the same owner page and links by
  authority id, so it remains reachable even when the listing no longer exists.
- **Migration and restore parity.** Migration
  `2026-08-10_refund_authority_records.ts` installs the partial
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
  buyer-correctable email/phone validation remains in that class. A completed
  Square callback whose ticket-shaped metadata omits or corrupts `price_proof`
  is unreadable trusted input and remains retryable; it is never acknowledged as
  foreign. For that early Square malformed-versus-foreign distinction, any
  non-empty `_origin` remains an application marker across a hostname change; it
  is not compared with today's domain. It is not ownership proof — only the
  signed `price_proof` supplies that — but it prevents an older app checkout
  with damaged signed metadata from being terminally acknowledged as an
  unrelated order. `processed-payments.ts:parseSessionFailure` likewise lets
  decryption or schema corruption throw at the stored-data boundary instead of
  inventing a generic handled failure. The booking integration tests pin thrown
  database and application errors, malformed signed intents, the hostname-change
  marker, and the real Square webhook cases so none can become a silent success
  response.
- **Recoverable automatic placeholders.**
  `db/payment-anchor/{reference,attendee,session}.ts`,
  `db/attendees/{create,create-batch,payment-provenance}.ts`,
  `db/provider-refund-authority.ts`, and
  `features/api/payment-processing/{refunds,store-refund}.ts` prepare the paid
  session's provider-tagged reference, ready refund authority, and conservative
  terminal result before any provider refund I/O.
  `prepareClaimedAttendeePaymentAnchor` derives the same canonical `checking`
  claim as admin work through `checkingClaimFor`; `prepareRefundAuthority`
  prepares the same `payment_charges` insert used by ordinary refund admission.
  One `createAttendeeAtomic` transaction then writes the quantity-zero attendee,
  every booking row, the owner-public-key-encrypted reference and blind index
  under a synthetic `legacy:` anchor, the exact `PaymentRowState` claim, the
  attendee's non-empty provenance pointer, the `ready` charge authority, and the
  terminal result on the original payment session. The prepared statements run
  as one batch, and every expected write is checked. Failure to write any member
  rolls the attendee, bookings, terminal result, provenance, anchor, and
  authority back together. There is no committed state in which the callback is
  terminal but the refund has no durable recovery authority. The synthetic
  anchor attests only that this attendee owns that tagged reference: it is not a
  sent attempt or provider completion.

  After commit, `requestSessionRefund` passes the already-validated callback's
  captured Money to `requestProviderRefund`, which loads and advances that same
  ready authority before a fresh provider read; it does not create a second
  authority or refund path. The read still gates every send. An unavailable read
  therefore leaves reachable canonical work instead of a note that deletion can
  erase; a read whose captured Money disagrees becomes a durable
  `provider_conflict` owner choice. The quantity-zero attendee cannot be deleted
  or pruned while that authority is active. It can be merged once its
  short-lived claim settles because the authority and indexed reference travel
  safely. The explanatory system note contains only the finite placeholder
  reason and is never a safety authority, named work item, or clearing
  mechanism. No warning-note refund path remains.

  `storeRefundedBooking` releases the anchor claim only after the provider
  result, placeholder ledger post, any canonical-authority Money recording,
  refund activity, and explanatory note have all finished. A throw before that
  point leaves the atomically minted claim protecting the attendee; it cannot
  expose an unclaimed deletion window between attendee creation and recovery
  work. Settlement uses the prepared exact command, timestamp, session, and
  `checking` phase, so it cannot release a successor's claim. Only after that
  settlement does `sessionFailure.replace` compare-and-set the conservative
  terminal outcome to the exact final result; it cannot overwrite a racing or
  unrelated outcome.

  The terminal outcome and ready recovery authority already exist when
  placeholder creation commits. If the caller loses that committed reply, a
  redelivery replays the same attendee, indexed anchor, and authority without a
  second create or provider send. The indexed anchor makes the attendee's real
  Payment Details render immediately; canonical recovery lives in the owner-only
  Refund recovery queue, and no attendee save or population decrypt is needed.
  This does not make the provider result or placeholder ledger post part of the
  creation transaction. M7 still owns the original checkout's durable
  handled/effect marker after `processed_payments` retention and the
  placeholder-ledger replay-marker gap; it must attach that work to this
  authority, never resurrect a legacy replay path or reinterpret the synthetic
  anchor as the marker.
  `test/features/api/payment-processing/{store-refund,store-refund-authority}.test.ts`
  exercises all-row rollback, atomic terminal/anchor/provenance/authority
  creation, tagged identity, recovery after a failure immediately after commit,
  and deletion refusal while work remains.
  `test/features/api/payment-processing/index/refunds.test.ts` exercises the
  lost committed-reply replay.
- **Privacy-safe diagnostics.** `shared/payment-review.ts`,
  `features/admin/refunds/report.ts`, `shared/refund-ledger/log.ts`, and
  `shared/invariant-errors.ts` accept closed reasons and row/count context, not
  arbitrary provider references, attendee names, or payment-session ids. The
  safe description and caught exception travel separately, preserving the
  original stack for Sentry without copying money identifiers into console,
  notification, or retained activity text. Adding a raw identifier is therefore
  a visible type-boundary change rather than an easy string interpolation.
  `payment_charges` deliberately exposes provider, Money, state, revision, and
  due timestamps to SQL, because the database must schedule and police the
  lifecycle. Its raw provider reference is owner-key ciphertext; its reference,
  callback, and request identities are DB-keyed one-way indexes. It stores no
  buyer name, email, phone, address, attendee PII blob, raw callback session id,
  provider response, or credentials. A database holder with `DB_ENCRYPTION_KEY`
  can read the finite explanatory placeholder note and lifecycle metadata. With
  a v2 password-wrapped owner key they cannot open new raw payment identifiers
  or buyer PII. A dormant v1 owner wrap can expose the data key and site private
  key from the same database and environment key, and provider credentials
  encrypted with the DB key may allow provider-side queries; both remain the
  explicit system-wide caveats above.
- **Visitor-level proof.** The Cucumber stories
  `specs/payments/{checking-before-a-refund,waiting-for-a-refund,recovering-the-money-record,refunding-a-booking,refunding-from-two-windows,only-owners-refund,refunding-everyone-at-once,resolving-uncertain-refunds}.feature`
  cover the pre-send check, a delayed provider result, repair of returned money
  missing from the books, two-window races, owner-only controls, bounded Refund
  All requests, whole-listing blocker admission, and per-request failure
  isolation. `resolving-uncertain-refunds.feature` drives the real Privacy queue
  through ready send, provider observation, required owner choice, and separate
  Money recording. The stories submit the rendered forms and cross the real
  provider and ledger boundaries. Refund-safety purchases use the public booking
  page: Stripe follows the production completion route, while SumUp follows the
  real checkout staging write and unsigned webhook handler. No story rewrites a
  stored payment's provider to manufacture the state it tests. The focused
  regressions exercise Delete disappearing while work remains and returning
  after recovery, one old blank-index row stopping every Refund All send, and a
  PII-only deposit remaining a blocker even beside a later indexed balance. The
  final branch gate, rather than this plan, is the authority for pass counts.

Known limits are deliberate and remain visible. Part A protects old history by
refusing an incomplete or untagged selected attendee; it does not make that
history refundable and never decrypts or backfills an attendee population.
Attendee save, merge, and M11 do not mint payment rows from old PII. A
historical or unqualified attendee provenance remains a permanent fail-closed
boundary for current in-app refunds; the owner handles it directly in the
provider dashboard. A later indexed balance cannot erase that boundary. This is
a product choice, not deferred compatibility work: do not add a whole-table
scan, a re-save backfill, a migration-only PII refund reader, or a parallel
legacy refund engine. Refund All's PII-free summary can use booking ledger facts
and the provenance marker to detect and block the incomplete history, but it
cannot recover or provider-qualify the raw PII reference. Part A does not erase
historical plaintext references or old DB-key-encrypted warning notes. It does
not cut the buyer callback classifier over: `payment-processing/classify.ts`
still judges a paid session from its signed total and currency and does not read
`refundOutcomeOf` or charge-level refund evidence. A provider session that still
reads paid after its charge was externally returned can therefore still enter
the current booking completion path. The atomic cutover combines M6's
whole-checkout reader with M8's durable completion and deletes that displaced
writer before activation.

Before a provider-tagged refund target exists, the current checkout entry still
uses `shared/existing-payment-provider.ts` to choose the ambient current or last
provider. A provider switch can therefore strand or misroute an in-flight
checkout. A paid callback with a blank provider reference can still be
terminally acknowledged, and an authenticated malformed Stripe completion can
still be terminally dropped. These are whole-checkout admission and completion
defects for the atomic M6/M8 cutover; they are not alternate paths the M4 refund
authority should learn to tolerate. M6–M11 must replace and delete
`getPaymentProviderForExistingPayments` and every runtime payment-ownership
caller in the same activation. After that cutover, credential enumeration may
exist only inside settings/activation recovery. It is never payment ownership
and must not enter refund admission, budgeting, provider loading, observation,
sending, or dashboard links.

Part A also does not solve stable booking obligations, exact allocation, ledger
order identity, a durable Refund All intention, or the original checkout's
durable handled marker described below. Those are authorities at different
layers, not piecemeal extensions to the provider-refund lifecycle. In
particular, the automatic placeholder's atomic attendee/reference/terminal-
outcome creation and `checking` fence plus its pre-read provider authority close
the missing recovery-control, duplicate-create, and destructive-cleanup faults.
They do not supply the original checkout's durable effect marker after
`processed_payments` retention or close the placeholder-ledger replay-marker
gap. M7 owns those exits on the same authority.

Standalone value: no live admin refund path or admitted provider-tagged callback
refund target can guess a provider, default malformed evidence into success,
send without the one durable permit, silently lose a known returned refund after
a local failure, decrypt a whole attendee population, or make a manager decide
or move money. Whole-checkout callback admission remains the explicit M6/M8
cutover debt above; this statement does not turn its ambient provider selection
or legacy terminal acknowledgement into M4 guarantees.

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
  alert. The durable case commits before best-effort notification; the ntfy copy
  carries only a finite case code, never buyer/provider identifiers or amounts,
  and directs the owner to the protected detail. Every rendered link is gated by
  the same permission and existence fact as its target.
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

### Atomic aggregate cutover — work packages M6–M11

M6–M11 ship as one cutover PR and one release. The package boundaries below are
for implementation, review, and focused tests; none may become an independently
merged live layer. Before activation, the release pauses payment creation,
callbacks, refund commands, completion, attendee mutation, and pruning behind
one durable cutover fence. Its explicit owner-authenticated migration reads the
old tables in bounded resumable pages, writes canonical rows, adopts every
in-flight checkout, and gives every source row either a verified canonical
identity or a complete owner decision. After verification, one transaction
raises the cutover epoch. Only then may canonical readers and writers serve
requests. The displaced readers, writers, interfaces, and maintenance paths are
deleted in this same release; there is no read-through, dual write, runtime
fallback, or mixed-store answer. Frozen old tables remain only as migration
audit input for M12/M13 redaction and removal.

This is also the rule for every later change to M4's live refund authority, not
just this named aggregate cutover. Extend the canonical state and every consumer
in place, or fence requests, migrate and verify every retained row, switch one
epoch, and delete the displaced schema, readers, writers, routes, and jobs in
the same release. Record age, missing optional fields, provider kind, and
deployment version may preserve evidence or cause a typed refusal; none may
select a legacy runtime, fallback authority, dual write, or alternate refund
engine. If a future change cannot make that atomic replacement safely, it does
not activate.

Every dormant aggregate table must hold its complete production role at that
epoch or be dropped. The cutover cannot activate without the owner's private
key: owner-encrypted retained payment evidence and buyer snapshots cannot be
opened under `DB_ENCRYPTION_KEY`. That ceremony must not scan attendee PII to
recover old payment ids. Until the owner performs it, the current M4 runtime
stays wholly in charge; after it, old unindexed payments still require a manual
provider refund rather than a legacy engine.

#### Work package M6: Aggregate checkout creation and reads

Src target: 1,200–1,800 within the sanctioned atomic-cutover exception. Creation
and reads move together precisely so no `sumup_checkouts` projection,
checkout-metadata preservation bridge, or projection-repair machinery exists.
The dormant `payment_sessions` buyer-bearing fields currently accept DB-key
`enc:1` ciphertext. Before the first M6 writer exists, rebuild those fields to
require owner-key `hyb:1` ciphertext or drop the dormant table and replace it
with the one canonical owner-key-protected session store. The current shape may
never become a live compatibility store.

The M6 release itself carries the restore-deploy guard (as its own commit is
fine): once the cutover release has shipped,
`.github/workflows/restore-deploy.yml` refuses to deploy any commit that
predates the aggregate cutover — regardless of what the restored database
contains, because a pre-cutover backup carries no aggregate marker and its
recorded commit would restart the old writers. Restoring an old backup means
loading it into the current application and completing this same migration
ceremony before activation. Document this in the operator restore guide beside
the backup's recorded commit; the guard is live before the first aggregate write
can happen in production.

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
  references and refuses every older indexed-but-untagged reference before
  provider I/O. The aggregate copy preserves old incomplete evidence as
  unsupported accounting history; it does not qualify that evidence for an
  automatic refund. Provider and currency are intrinsic to every charge the new
  runtime may act on. No migration or request-time attendee scan, runtime
  provider-discovery fallback, or configuration guess exists. Old PII-only and
  untagged references remain manual provider work.
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
- At activation, the aggregate never references a deleted attendee:
  `applyAttendeeMerge` repoints aggregate payment sessions, charges, cases,
  effects, deliveries, and queued work to the surviving attendee inside its
  transaction, while `deleteAttendee` settles or repoints them before the
  attendee row goes. The migration fence pauses merge, delete, PII edits,
  pruning, and stale-reservation deletion before it takes its source snapshot,
  so no historical booking or payment-identifying fact can disappear between
  verification and copy. Pre-fence privacy deletion remains intentional; like a
  backup, the migration copies what still exists when the fence rises and never
  recreates data already removed under the current retention rules.
- The aggregate readers replace `resolveWebhookSession` and `retrieveSession`
  for every caller — signed webhook callbacks, buyer return and cancel pages,
  and paid-session validation — and the displaced methods leave the
  `PaymentProvider` interface and all three provider implementations in this
  same cutover. They feed the durable completion and effect machinery described
  in M8–M10; no old completion, finalize, delivery, or maintenance writer
  remains active beside them. Every admin and callback refund already writes
  M4's canonical `payment_charges` authority. M6 links that same row to the
  complete payment and charge observation; it never copies its state into a
  second refund record. The claimed whole-payment reconciliation folds both
  provider evidence and that authority's current revision. Pull-only SumUp work
  is already due through `next_refund_action_at`, so no writer-through marker or
  provider-specific side queue is needed. This is an atomic replacement, not a
  selector between generations: after the epoch changes there is no runtime
  fallback to either displaced checkout reader, no read-through to old payment
  storage, no dual write, and no second completion or refund authority.
  Migration-only decoders remain unreachable from request handlers and are
  removed with their frozen sources.
- During the fenced migration, adopt or expire every in-flight pre-cutover
  checkout (all three providers) atomically and idempotently: same claim,
  identity, and validation rules; concurrent callbacks and migration runs bind
  to one claim; defined outcomes for paid, pending, expired, and unavailable
  sessions. No paid checkout is stranded without an aggregate row.
- Panels, exports, statistics, refund targets, callbacks, and maintenance switch
  to the canonical repositories only after every retained source row verifies.
  The old runtime readers and writers are absent from the activated build. The
  migration itself folds a source row's local completion facts — attendee,
  ticket result, and recorded failure — onto its canonical identity before
  declaring that source settled, so identity deduplication never drops the
  booking outcome.

Cutover contribution: no live checkout can lose its intent or create a second
provider checkout after an interrupted request, and every route, worker, page,
and export gets the same authoritative answer for the same payment.

#### Work package M7: Refund jobs and stable booking obligations

M4 Part A is the authority, not work to repeat: admin single, one-attendee
Refund All, Refresh, and buyer callbacks already share tagged reads, the
revisioned `payment_charges` state machine, one provider-send permit,
conservative settlement, required owner choices, and local Money repair. M7 adds
a durable whole-listing intention and stable booking-obligation effects around
that same provider authority. It does not build a second aggregate refund
engine. The cutover links the current authority to stable aggregate identities
and removes the processed-payment claim and reference paths whose callers have
all moved before activation.

- **Durable Refund All.** Before the first provider call, persist the operator's
  whole-listing intention, every immutable payment identity it covers, and a
  cursor. Each request claims, budgets, and processes one bounded page, records
  every result, and advances only past terminal items. A permanent refusal opens
  required owner work; a transient failure remains due for bounded retry and
  cannot be skipped by the cursor. A crash after page one therefore leaves a
  visible resumable job naming the remainder. M4's PII-free whole-listing safety
  summary and one-attendee interactive request remain the safe input shape, but
  repeated manual submission is no longer the only continuation.
- **Extend one callback/admin lifecycle.** M4 already persists the exact charge,
  capability, captured Money, callback replay identity, generation identity, due
  time, and revision before a validated callback can send. A duplicate makes no
  second call. Stripe and Square may replay only the exact keyed generation
  inside its finite window; SumUp never automatically replays an armed keyless
  generation. `accepted`, lost responses, and contradictory reads all have
  durable, reachable exits in Refund recovery. M7 attaches scheduled retries,
  the missed-SumUp-checkout task, and the original checkout's handled marker to
  this same lifecycle. It must not reinterpret a placeholder's `legacy:` anchor
  as the original checkout, a sent attempt, provider completion, or durable
  replay marker.
- **Durable job inputs around the existing engine.** Individual, selected bulk,
  balance, automatic, callback, and case-decision refunds continue through
  `requestProviderRefunds`, now fed by M6's stable aggregate charge and
  allocation identities. Job items are self-contained and never rebuild their
  target from live attendee PII or current settings. Provider success followed
  by a local failure remains due on the authority and repairs Money
  idempotently. Refunds stay available while new sales are disabled.
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
- **Migration boundary and removal.** The cutover's M11 work package migrates
  and verifies every retained `processed_payments` record before enabling the
  aggregate runtime. It copies only payment references already present in
  retained payment storage; it never searches attendee PII for another one.
  Unsupported history receives a terminal accounting disposition and remains a
  manual provider refund, not an actionable canonical charge. This work package
  removes the processed-payment claim and reference paths as their final callers
  move, and the architecture gate continues to prove that only one send permit
  mint, provider API path, and `payment_charges` writer exist.

Cutover contribution: a whole-listing intention survives request death, the one
durable retry/evidence machine gains stable allocation and scheduled work, and
cash or booking obligations can never move twice or be silently inferred from
each other.

#### Work package M8: Durable paid completion, including its failure path

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
  completed. Before the effect runner claims its first payment, the fenced
  migration classifies every retained completion: a completed source result is
  marked done and is never re-booked or re-posted to Money; a paid payment with
  no completion result becomes due work; and a recorded completion failure
  becomes the matching durable failure effect — its chosen refund path or an
  owner case — never marked done and never re-run as a fresh booking. The
  migration begins only after in-flight old commits drain or fail and it
  revision-checks every source before settlement. Adoption also gates on a
  completion-safe `outcomeOf` state with no open blocking case: a paid payment
  stopped for owner review — captured money on a failed checkout, multiple
  captured charges — stays in its case workflow, because due work must never
  bypass a required owner choice. Refund and completion claims are mutually
  exclusive through one payment-wide claim: the payment session row's shipped
  lease (`lease_token`, `lease_expires_at`). Refund jobs, the adoption pass, and
  the effect runner each acquire that lease atomically before acting and verify
  no unfinished refund job or effect owns the payment, so two runners can never
  both read "nothing done yet" and act, and a booking can never complete while
  its irreversible refund is in flight. For a reservation whose deposit and
  balance are separate payments, the claim spans them: a runner acquires the
  lease of every payment sharing the booking-level obligation, always in one
  fixed order, before acting — so refund and completion can never split one
  booking between two sessions.
- At activation, completion stops storing payment references in attendee PII —
  the aggregate owns the attendee-to-payment link. M4 already keeps every new
  `processed_payments` reference under the owner key and refuses to scan
  PII-only history. The cutover carries forward only links already proved by
  retained payment storage; it does not consume old attendee PII before deleting
  the writer.
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
  open cases during attendee merges. The cutover fence blocks merge, delete,
  prune, PII edits, and `deleteAllStaleReservations` while historical rows are
  being copied, so activated maintenance code can be canonical-only; it never
  needs a copied/not-copied branch or migration snapshot.
- Install the old-write fence before the first migration page and verify it in
  every old committing transaction until all in-flight requests drain. Provider
  refunds need no exemption: M4 already writes their state only to canonical
  `payment_charges`. The cutover epoch rises only after the last source row is
  settled, and every old writer is deleted before requests resume.

Cutover contribution: interrupted paid bookings resume without charging,
booking, or recording Money twice; a provider refund that outruns a local
failure repairs itself; and no admin action can orphan payment work.

#### Work package M9: Durable messages and outgoing webhooks

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

The dormant `payment_completion_deliveries.data` schema currently accepts DB-key
`enc:1` ciphertext even though the payload can contain the buyer's name, email,
phone, and address. Before the first M9 writer exists, change that column to
require owner-key `hyb:1` ciphertext or drop the dormant table and replace it
with the one canonical owner-key-protected delivery store. It may never become a
live DB-key-readable queue or a compatibility mirror beside a new queue.

Cutover contribution: the M8 completion runner's messages and webhooks use the
current owner address, recover on schedule after an interruption, and one
permanently failing destination no longer blocks the rest of the queue.

#### Work package M10: Durable site assignment and renewal

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

Cutover contribution: paid site delivery and renewal recover safely after an
interruption, a concurrent payment, or an attendee merge.

#### Work package M11: Verify and copy retained payment records

Src target: verifier 400–600; copy 800–1,200 (cutover exception). The verifier
is read-only and parallelizable — #2056 already started it. The copy is the
activation gate for the complete M6–M11 runtime, not a later bridge.

- The verifier reads the retained payment stores — `processed_payments`,
  `checkout_stages`, `sumup_checkouts`, their explicit merge links, and M4's
  canonical authority — into one lossless model without writing cases. It does
  not scan attendee PII or old free-text notes for payment references. Group one
  provider payment before pagination, convert old timestamps, and report
  contradictions through operator diagnostics and backup verification. An
  owner-encrypted reference already present in payment storage is opened only
  through the request-scoped private-key path; key material and raw references
  never enter progress records, logs, audits, or backups. If required retained
  evidence cannot be opened, block the copy and preserve the source row. Back up
  databases before migrating.
- The cutover fence stops every old payment writer and drains in-flight commits
  before copying. It pauses payment creation and callbacks, admin refund
  commands, completion, attendee merge/delete, pruning, and stale-reservation
  deletion while relationships are established. It need not pause PII edits to
  recover hidden payment ids because hidden ids are not migration input.
  Existing provider work already lives in M4's `payment_charges` authority and
  is linked, never copied into a second state machine. Lease ownership, renewal,
  timeout, and safe abort details are fixed in the cutover behavior contract
  before the first cursor page.
- Copy every retained payment row by stable cursor in bounded, verified pages.
  Never split one provider payment across pages, mistake an empty joined page
  for the end, let deleted booking rows block, or resurrect ticket-use state. A
  tagged, owner-encrypted reference already present in retained payment storage
  may become a canonical charge. A blank-index, untagged, PII-only, or otherwise
  unproved reference does not: preserve its SQL-visible accounting facts as a
  terminal unsupported record and direct any cash action to the provider
  dashboard. Current provider, last-active provider, credential order,
  identifier spelling, owner guess, a note, or a dashboard URL can never qualify
  it. Do not read attendee PII, decrypt a population, or make an interactive
  request perform the copy.
- A reference already owned by M4's authority is linked to the aggregate
  payment, never copied as a new charge. Before a source is settled, fold its
  local completion facts — attendee link, ticket result, and recorded failure —
  idempotently onto canonical completion records. Preserve unknown or
  contradictory facts without inventing them. A terminal unsupported or
  unmigratable disposition keeps only a bounded accounting record: an allowlist
  of non-buyer facts already present in retained payment storage, encrypted for
  the owner-only case page, with no buyer PII, ticket tokens, credentials, raw
  note text, or newly recovered reference. That lets M13 retire the old table
  without pretending the current engine can refund it.
- A source is settled when it is either copied and verified into a canonical
  payment or terminally preserved as unsupported/unmigratable. Record progress
  and release leases within the call budget; interruption resumes from the same
  cursor. A final verifier proves counts, identities, Money, local outcomes, and
  provider-work links before the cutover transaction raises the epoch.
- The activated application has only canonical panels, exports, statistics,
  refund targets, callbacks, completion, effects, and maintenance. Every old
  runtime reader and writer is deleted in this release. Migration-only decoders
  for retained payment rows cannot be imported by request handlers; the
  architecture gate rejects a second refund writer, completion projection,
  read-through, or dual write.

Cutover contribution: every retained payment row receives a verified canonical
or terminal accounting disposition. Only proved current evidence becomes
actionable; unsupported historical refunds stay manual.

### Follow-on history retirement (M12–M13)

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
request, worker, page, export, or maintenance command reads an old table.

- Drop the old tables and delete the migration reader, progress gates, old
  codecs, stale TODO entries, temporary exemptions, and dead exports together —
  except an explicit restore-time conversion step, documented in the operator
  restore guide, so a pre-aggregate backup can complete the same fenced ceremony
  before the application starts. It is not importable by runtime request code.
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

| #   | Finding                                                                                | Owner                                    |
| --- | -------------------------------------------------------------------------------------- | ---------------------------------------- |
| F1  | Disabling new payments also disabled existing-payment refunds                          | Closed by #2020                          |
| F2  | Unknown unsigned SumUp callbacks triggering outbound reads                             | Closed by #2060                          |
| F3  | Pending and completed refunds together exceeding captured money                        | Closed by M4                             |
| F4  | One failed decision blocking all reconciliation                                        | M5, M6                                   |
| F5  | Permanent provider or delivery errors retrying forever or blocking a queue             | M5, M6, M9                               |
| F6  | Attendee merge or delete removing records with an open case or unfinished work         | M4 current rows closed; M6–M8 aggregate  |
| F7  | Restore-deploy workflow allowing incompatible code onto a migrated database            | M6                                       |
| F8  | Cross-payment duplicate provider charges                                               | M6                                       |
| F9  | Account lookup failure retaining a claim                                               | M6                                       |
| F10 | SumUp return IDs interpreted differently by different routes                           | M6                                       |
| F11 | Square fallback reads scanning too short a list                                        | M6                                       |
| F12 | Delayed work using live currency rather than stored currency                           | M4 admin closed; M6 aggregate            |
| F13 | Charges without a stored provider guessed after a provider switch (#2020 gap)          | Closed by M4 permanent refusal           |
| F14 | In-flight pre-cutover checkouts paid after the cutover, stranded without a row         | M6                                       |
| F15 | Old rows changing during aggregate migration                                           | M11 fence                                |
| F16 | Old payment-reference readers surviving after migration                                | M11, M13                                 |
| F17 | Owner refund decisions closing a case without closing Money                            | M7                                       |
| F18 | Completed provider refunds missing from Money                                          | Closed by M4                             |
| F19 | Provider success followed by a local failure having no repair path                     | Closed by M4                             |
| F20 | Refund-all conflicting forever with unfinished completion                              | M7, M8                                   |
| F21 | The same indexed provider reference refunded twice through admin bulk refunds          | Closed by M4                             |
| F22 | A completed refund resurfacing as refundable on an uncopied row                        | Closed by M4 canonical authority         |
| F23 | Attendee-only payment references skipped, or refunded without verified facts           | Closed by M4 permanent refusal           |
| F24 | Delayed completion rebuilding facts from edited live data                              | M8                                       |
| F25 | Listing attachments deleted before a payment fence succeeds                            | M8                                       |
| F26 | `deleteAllStaleReservations` deleting uncopied legacy rows under the fence or mid-copy | M8, M11                                  |
| F27 | Concurrent renewals racing                                                             | M10                                      |
| F28 | Queued site work retaining a deleted attendee ID after merge                           | M10                                      |
| F29 | SumUp identities split across migration pages                                          | M11                                      |
| F30 | A merged migration page mistaken for end-of-input                                      | M11                                      |
| F31 | Deleted booking rows blocking migration forever                                        | M11                                      |
| F32 | Ticket-use state resurrected during migration                                          | M11                                      |
| F33 | Migrated charges omitted from refund targets                                           | M11                                      |
| F34 | Late refund-completion writes landing after a row was copied and verified              | Closed by M4 canonical authority         |
| F35 | Migration silently skipping retained evidence whose owner key or source is unavailable | M11                                      |
| F36 | Terminal buyer details, completion data, or ticket tokens never redacting              | M12                                      |
| F37 | An unconditional table drop destroying a restored old backup before it migrates        | M13                                      |
| F38 | Attendee merge or delete destroying attendee-held payment facts before the copy        | M11 fence                                |
| F39 | A migrated source payment appearing twice after activation                             | M6, M11                                  |
| F40 | An attendee PII edit changing legacy payment references mid-copy                       | Closed: PII is not migration input       |
| F41 | Redacting the preserved evidence that is an unmigratable payment's only record         | M11, M12                                 |
| F42 | A historical identity deduplication dropping its local booking facts                   | M11                                      |
| F43 | An already-canonical payment reference migrated again as new input                     | M4, M11                                  |
| F44 | A legacy deletion stripping folded local facts from a sale the aggregate represents    | M6                                       |
| F45 | Two concurrent paid completions claiming the same built site                           | M10                                      |
| F46 | A site build replayed after a lost response, provisioning a second site                | M10                                      |
| F47 | A parallel refund adapter completing after its retirement pass                         | Closed by M4; no adapter exists          |
| F48 | A multi-listing payment credited in full to each listing, or its shared order lost     | M6, M7, M8                               |
| F49 | Source booking facts dropped when its refund authority is already canonical            | M11                                      |
| F50 | Unmigratable evidence keeping buyer PII or ticket tokens forever                       | M11, M12                                 |
| F51 | Two classifiers disagreeing about the same refund evidence                             | Refund side closed by M4; checkout M6/M8 |
| F52 | Checkout fees or price modifiers misallocated into a listing's income                  | M6, M8                                   |
| F53 | A selected refund command overrunning budget after sending only an initial subset      | Closed by M4                             |
| F54 | One sold-out line half-booking a multi-listing order after payment                     | M8                                       |
| F55 | The completion runner re-completing a sale already finished before migration           | M8, M11                                  |
| F56 | A deposit checkout losing the full modifier fact to the charged fraction               | M6, M8                                   |
| F57 | Migration racing an in-flight old commit and re-running its completion                 | M8, M11                                  |
| F58 | Adoption turning an owner-review payment into due work, bypassing the required choice  | M8                                       |
| F59 | A queued refund page stranded by an attendee merge or delete in the M7 window          | M7                                       |
| F60 | A refund-all crash after its first page losing the unrecorded remainder                | M7                                       |
| F61 | An attendee merge rewriting Money while refund pages are still queued                  | M7                                       |
| F62 | A reservation refund confusing money charged now with the full obligation              | M7                                       |
| F63 | A deposit-plus-balance refund reversing the booking obligation twice or not at all     | M7                                       |
| F64 | Adoption stranding payments whose folded result records a completion failure           | M8                                       |
| F65 | A cursor advancing past a transiently failed refund, finishing the job around it       | M7                                       |
| F66 | A booking completing while its payment's irreversible refund is in flight              | M8                                       |
| F67 | A retried refund minting a fresh provider idempotency key and refunding twice          | Closed by M4                             |
| F68 | Transient and permanent refund failures collapsing into one boolean                    | Closed by M4                             |
| F69 | An obligation cancellation without a stable identity re-running or never retrying      | M7                                       |
| F70 | Two runners both reading "nothing done yet" and acting on one payment                  | M8                                       |
| F71 | A consumer re-deriving the allocation and disagreeing with the stored record           | M6                                       |
| F72 | A booking split across two payment leases, refunding one while completing the other    | M8                                       |
| F73 | Repointing replacing the merge fence and replaying a pre-merge allocation              | M7, M8                                   |
| F74 | A queued refund acting on stale evidence after the payment's outcome moved on          | M7                                       |
| F75 | Cancelling a booking obligation that the failed completion never posted                | M8                                       |
| F76 | A discount folded into line prices losing its signed modifier fact                     | M6                                       |
| F77 | Deposit and balance allocations minting separate identities for one obligation         | M6                                       |
| F78 | An indexed refund omitting a PII-only or blank-index sibling charge                    | Closed by M4 provenance refusal          |
| F79 | A rejected SumUp request hiding a refund completed beside it                           | Closed by M4                             |
| F80 | An automatic quantity-zero placeholder hiding its only payment recovery control        | Closed by M4                             |
| F81 | A rejected send plus an unreadable reread releasing its claim as conclusive            | Closed by M4                             |
| F82 | An anchor-only returned charge hiding a manual-money booking obligation                | M7 stable obligations                    |

## Done means

- Every ordinary milestone is merged in dependency order and stands alone. The
  M6–M11 work packages activate only as their one atomic cutover PR; none is a
  separately merged compatibility layer.
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
  With a v2 owner wrap, a database plus `DB_ENCRYPTION_KEY` cannot recover that
  private key; a dormant v1 wrap remains explicitly weaker until login upgrades
  it. Historical plaintext or DB-key-encrypted evidence is migrated under the
  stronger boundary, preserved only in a finite owner case or frozen source
  awaiting redaction, or redacted. It is never readable by the activated runtime
  and never silently copied under `DB_ENCRYPTION_KEY`.
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
