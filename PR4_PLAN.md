# M4: one diagnosis for settled money — behavior contract

## Status

PR A's current implementation is on `claude/m4-pr-a` in PR #2065; its production
module map is "As built" below. Once a row appears there, the named code and
tests are authoritative; planned-port prose and historical estimates are not
alternative specifications. Later callback, allocation, and whole-checkout
layers have not started.

All approved owner decisions are recorded below: proceed-and-alert for the
multi-charge observation, the Stripe `amount_refunded` read widening, both new
copy strings, the two-PR slicing (2026-08-09), and owner review for every
multi-charge observation — automatic refunds act on single-charge observations
only (2026-08-10), plus exact allocation or rejection for a shared legacy
charge, separate cash-return and obligation-cancellation effects, required
partial-payment choices, and the two approved implementation stacks
(2026-08-11). The earlier first two decisions have nothing to act on in PR A:
every kind that compares money against what was owed needs a whole reading of
the checkout, which this slice does not build, so those kinds are absent and
pinned absent by test. Milestone source: PLAN.md's M4 section, fault rows F3 and
F51 (with M4 slices of F6, F12, F13, and F53), and the binding decided behaviors
on refunds and multiple captures; this PR carries the matching PLAN.md sync (the
M4 section, the M6 provider note, and those fault rows).

## Part A value

Part A has cut the admin single-refund, bulk-refund, and payment-refresh routes
over to one indexed, claimed refund path. Each route claims the exact payment
rows it loaded, reads each charge from the provider that proved it owns that
reference, judges the charge's captured and returned money, and either parks the
work or arms one exact send set. Pending, uncertain, rejected, unreadable, and
completed provider answers remain different facts instead of collapsing into a
boolean.

The whole admin command is admitted before money moves. A listing-wide command
claims and checks the complete refundable set for existing safety work and
prices that same complete set before any provider call. If its physical provider
retry plan, fixed nominal database path, rollback room, and retry-protected
settlement and caller tails do not fit the remaining Bunny allowance, the whole
command refuses with zero sends. Provider requests may still overlap in groups
of five, but five is only a concurrency window, not a partial money batch or a
total budget. Once money may have moved, returned markers, ledger findings,
owner-review cases, and claim retirement are derived from durable facts on the
exact rows.

## Part A guarantee

> An admin refund sends only after a current provider read validates the exact
> indexed charge and an all-or-none claim still owns every row the command
> loaded. A command whose complete declared envelope cannot fit the remaining
> request budget refuses before its first provider send. After a send is armed,
> the claim remains until durable provider and ledger facts prove what finished;
> a confirmed return whose ledger write fails becomes exact `unrecorded` work
> before settlement can release the claim. A listing-wide command is never
> narrowed to a convenient first batch after its safety decision.

This guarantee covers the admin single, bulk, and refresh paths only. Callback
and redirect refunds still do not take a callback-scope claim. Part A also does
not build a whole-checkout reading, shared-charge allocation, historical-marker
attestation, stable booking obligations, refund jobs, or aggregate-table writes.
Those boundaries remain later work and are named below.

## Historical production evidence (superseded by "As built")

This table was verified against `4879ae0d` (post-#2062 main) before Part A was
built. It records the baseline that motivated the design; it does not describe
the current branch. The production module map under "As built" is authoritative.

| Area                           | Evidence                                                                                                                                                                                                                                                                                                                                                                                                          | Consequence                                                                                                                                                                                                                       |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Callback judge                 | `classifySession` returns `trusted`/`mismatch`/`ignore` from price-proof, currency, and amount equality (`src/features/api/payment-processing/classify.ts:97-113`); no free-checkout predicate exists — a paid charge against a signed total of 0 falls out of amount inequality                                                                                                                                  | This verdict logic is the displaced callback classifier; `outcomeOf` replaces it and names `paid_without_charge` explicitly                                                                                                       |
| Boundary constructor           | `validatedPaymentSession` rejects unvouched money as `malformed_charge` with `refundable`, and a paid session without a resource id as `blank_reference` (`src/shared/payment/validated-session.ts:17-113`)                                                                                                                                                                                                       | Stays. It is M3's observation boundary, not a settled-money judge; its rejections feed the same refund path the judge uses                                                                                                        |
| Mismatch refunds               | `refuseMismatch` (balance path) and `chargeMismatchSpec` (booking path) refund on verdict `mismatch` (`src/features/api/payment-processing/refunds.ts:239-250,308-312`; consumed at `index.ts:238-250`)                                                                                                                                                                                                           | These actions stay; their trigger becomes a judge outcome instead of the inline verdict                                                                                                                                           |
| Refund re-attempt surface (F3) | On `refunded === false` the reservation is released so the next redelivery re-attempts the refund; the comment asserts this "CANNOT double-pay" on the strength of provider-side rejection (`src/features/api/payment-processing/index.ts:350-366`)                                                                                                                                                               | True for Stripe/Square only because of idempotency keys; unguarded for SumUp. The judge fronts every attempt with the overlap refusal                                                                                             |
| Refund state today             | `RefundState` is `none \| completed \| unknown` — no pending state exists on the live path (`src/shared/payment/refund-state.ts:10-23`); derived from `processed_payments.provider_refunded_at` (`src/shared/db/payment-references.ts:130-161`)                                                                                                                                                                   | A pending provider refund reads as `none` everywhere today; nothing compares refunded-so-far against captured money                                                                                                               |
| Single-charge refund judge     | `tryRefund`: blank-id guard, attempt, then `isPaymentRefunded` fallback treating already-refunded as success (`src/features/api/payment-processing/refunds.ts:120-160`)                                                                                                                                                                                                                                           | The ordering is ad-hoc judgment; it becomes: observe → `outcomeOf`/`resolveRefund` → act                                                                                                                                          |
| Bulk refund judge              | `refundReferenceAtProvider`: `completed` short-circuit, attempt, `isPaymentRefunded` fallback (`src/features/admin/refunds/provider.ts:40-68`); waves of 5, wave count unbounded (`:167-211`), caller caps batch at `BULK_REFUND_LIMIT` (`src/features/admin/attendee-refunds/bulk.ts`)                                                                                                                           | Same cutover as `tryRefund`. The unbounded wave shape itself is M7 (F53), not M4                                                                                                                                                  |
| Idempotency                    | Deterministic `refundIdempotencyKey` used by Stripe (`src/shared/stripe.ts:109`) and Square (`src/shared/square.ts:688`); SumUp passes none (`src/shared/sumup.ts:222-229`), and the SumUp refund API supports none                                                                                                                                                                                               | SumUp replay defence must come from the judge plus full-refund semantics; the contract records this as a per-provider fact                                                                                                        |
| Square refund facts            | `retrievePayment` already selects `refundedMoney` — a genuine provider cumulative (`src/shared/square.ts` retrievePayment; `square-provider.ts:44-53` uses `refunded >= charged`); `refundPayment` returns false for PENDING (`CONFIRMED_REFUND_STATUSES = ["COMPLETED"]`, `square.ts:587`) and throws on wrong `payment_id` or partial amounts (`:712,721-728`)                                                  | Square legs get a real `confirmedRefunded`. A PENDING answer is a real in-flight refund the current code treats as failure — the F3 trigger                                                                                       |
| Stripe refund facts            | Current schema picks only `latest_charge.refunded` (boolean) (`src/shared/stripe/schemas.ts:43,51`); the locked Stripe types document `amount_refunded` on the charge                                                                                                                                                                                                                                             | Widening the pick to `amount_refunded` gives Stripe a documented cumulative. Approved as decision 2                                                                                                                               |
| SumUp refund facts             | `isPaymentRefunded` is `getTransactionStatus === "REFUNDED"` (`src/shared/sumup-provider.ts:103-107`) — full-refund only, no partial, no pending                                                                                                                                                                                                                                                                  | Refund authority moves to the same read's `transaction_events[]` (PR3's verified sandbox contract — status stayed `SUCCESSFUL` after a full refund, so the status check can miss even full refunds); pending remains unobservable |
| Multiple captures              | Square: `paymentReference = paidPaymentId ?? order.tenders?.[0]?.paymentId ?? ""` silently takes the first tender (`src/shared/square-provider.ts:124-125`); nothing counts captures per order. SumUp: `paidChildVerdict` already rejects extra children as `unrecorded_child` (`src/shared/sumup-observation.ts:143-151`). Stripe: a session names one `payment_intent`; no list read exists on the current path | Square `tenders[]` is present evidence: two paid tenders become a detectable `multiple_charges` conflict. Stripe multiple-capture detection has no current-path evidence and is out of scope (M6)                                 |
| Wrong parent                   | Square throws on `payment.orderId !== order.id` (`square-provider.ts:145-153`) and on refund `payment_id` mismatch (`square.ts:712`); SumUp reference/id/merchant checks are classifier verdicts (`sumup-observation.ts:208-239`); Stripe has none                                                                                                                                                                | Existing checks keep their behavior but report through the one conflict vocabulary; no new Stripe check is invented                                                                                                               |
| Error and alert classes        | `logError` fans out to ntfy (`src/shared/logger.ts:335`); the mismatch pager is `WEBHOOK_PRICE_SIGNATURE` (`refunds.ts:244,275`); the "money moved but records did not" incident class is `reportRefundNotRecorded` (`src/shared/invariant-errors.ts:37-39`)                                                                                                                                                      | Owner-review conflicts alert through these existing classes; no new alert channel                                                                                                                                                 |
| Money of record                | Ledger `transfers` (capture via `checkout-complete.ts:42-56`; refunds via `refund-ledger.ts:197,228,305`); `processed_payments.provider_refunded_at` marks completed provider refunds (`payment-references.ts:260-273`)                                                                                                                                                                                           | These are the durable "our completed records" input to the judge. M4 writes no new tables                                                                                                                                         |
| Dormant aggregate schema       | `payment_charges` already declares `captured_amount`, `refunded_amount`, `refund_state`, `pending_refund_id`, `pending_refund_idempotency_key` — schema-only, no readers or writers (`src/shared/db/migrations/schema/payments/charges.ts:29-53`)                                                                                                                                                                 | Stays dormant. M4 must not write it (delivery rule 1; M6/M7 activate it)                                                                                                                                                          |

## Reference design (superseded by "As built")

Source: `origin/claude/great-fermi-l2n29f`, `src/shared/payment-state/`. This is
the approved input design, preserved to explain the decisions Part A tested. The
branch's modules were fully pure and had no production callers there. The
current implementation deliberately kept only the pieces a live caller needs;
the "As built" map below supersedes every port instruction and estimate here.

| Branch module                                                                      | Lines | M4 fate                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `diagnose.ts` (`outcomeOf`, `hasSettled`, `SettledReading`)                        | 196   | Port. The judge                                                                                                                                                                                                                                            |
| `conflict.ts` (15-kind `PaymentConflict` variant + `IS_THE_READING_ITSELF`)        | 55    | Port minus the four M4-unreachable kinds (see the conflict table's note). Reconcile `invalid_provider_data`'s reason type against main's `ProviderInvalidReason` (plain union, includes `unrecorded_child`; branch has `mismatched_parent`)                |
| `refund.ts` (`resolveRefund`)                                                      | 72    | Port                                                                                                                                                                                                                                                       |
| `resources.ts` (charge/refund legs, `refundMoneyMatchesCapture`, resource schemas) | 246   | Port slimmed: reuse main's `money.ts` and `resource-id.ts` instead of restating `MoneySchema`/`ResourceIdSchema`. Keep main's stricter resource-id rule (`/^\S+$/u`, no inner whitespace) — the branch's looser rule accepts `"pi_1 2"` and is not adopted |
| `words.ts`                                                                         | 87    | Port only the subsets M4 needs (refund states, resource-kind map); the case/decision/ticket vocabularies are M5+                                                                                                                                           |
| `validation/kind.ts` (`kindObject`)                                                | 11    | Port (the one missing compile dependency)                                                                                                                                                                                                                  |
| `observation.ts` (`PaymentObservation`, ownership proof)                           | 219   | Adapt minimally: M4 needs the observation shape as `outcomeOf` input; ownership proof semantics already live in M3's staging/signature checks. No duplicate vocabulary is kept                                                                             |
| `resolve.ts`, `lifecycle.ts`, `decision.ts`, `operator.ts`, `record/*.ts`          | —     | Not M4. `resolve.ts`/`lifecycle.ts` are M5 (stored-evidence re-validation); `record/*` are aggregate-table row rules (M5/M6). `lifecycle.ts` will call back into the `outcomeOf` M4 lands                                                                  |

The branch's test files (`test/shared/payment-state/diagnose.test.ts`,
`refund.test.ts`, `conflict.test.ts`, `resources/refunds.test.ts`) are the
ported behavioral spec, including the pinned arithmetic cases (80 confirmed + 50
pending out of 100 refused; 100 confirmed + 100 completed not double-counted).

### As built

The rows above record what was proposed; this section says what EXISTS, and is
updated as each slice merges. Once a module appears here, **that file and its
tests are the authority, not the prose above** — check a finding or a proposed
amendment against the real code first, fix the code when the built behavior is
wrong, and change this document only when the document is what is wrong
(AGENTS.md, "Once it is built, the code is the authority").

| Landed                                                           | Lives in                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Differs from the reference                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kindObject`                                                     | `src/shared/validation/kind.ts` (`test/shared/validation/kind.test.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Verbatim                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Refund observations and resolutions, `refundMoneyMatchesCapture` | `src/shared/payment/resources.ts` (`test/shared/payment/resources.test.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Money and resource-id schemas come from main's `money.ts` and `resource-id.ts`, which now export them; main's stricter no-whitespace id rule applies. Charge legs, the session/charge/whole-resource schemas and `sameProviderResource` are NOT here — they describe a whole checkout, which nothing reads yet. The refund schemas define the live types and are private; `chargeMoneyRead` is the one door provider numbers come through, and returns a tagged invalid read instead of collapsing malformed money into absence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| The conflict union                                               | `src/shared/payment/conflict.ts` (`test/shared/payment/conflict.test.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 3 kinds — `refund_exceeds_capture`, `partial_refund`, and `multiple_pending_refunds`: the ones a charge's own money can show that a person has to settle. `failed_refund` is NOT one of them, and that is a correction to the failure table below rather than a port: this document already reads Stripe's `failed`/`canceled` as "settled as not-happening; a fresh operator attempt is legitimate", and a kind every route turns into `refused` is the opposite of that — it left a SumUp buyer charged for good, since the FAILED event never leaves the transaction history. A failed attempt that moved no money now reads `ready`; one reported beside money already back parks as `partial_refund`, which is the case the old ordering was really protecting. Two pending attempts cannot be assigned to one run, so they require owner review. The eight that compare money against what was owed need a whole reading and arrive with it; those, the read-level pair and the refund-shape pair are all pinned absent by test, so nothing can store a name no reading can report. `IS_THE_READING_ITSELF` went with them (its only true entries were the read-level kinds, its only callers M5's)                                                         |
| `resolveRefund`                                                  | `src/shared/payment/refund.ts` (`test/shared/payment/refund.test.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Verbatim                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| The two state columns                                            | `src/shared/db/migrations/2026-08-10_payment_state_columns.ts`, `.../schema/tables-attendees.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `payment_reference_index` is a plain index because several rows may represent one charge; `protected_state` is the plaintext live-work mirror. New payment rows write the reference and index together. Old PII-only and unindexed payments stay unavailable until that attendee is re-saved and an indexed anchor lands atomically; refund reads never globally scan or decrypt attendees and never repair unrelated records. `evidence_index` remains planned and is not declared                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Structured refund confirmation                                   | `src/features/admin/refunds/confirmation.ts`; `src/shared/db/refund-confirmations.ts`; named-note storage in `src/shared/db/notes/{queries,types}.ts`; migration `src/shared/db/migrations/2026-08-12_refund_confirmations.ts` (`test/features/admin/refunds/confirmation.test.ts`, `test/shared/db/notes/queries.test.ts`)                                                                                                                                                                                                                                                                            | One HMAC replay identity is derived from the attendee plus sorted, deduplicated provider-aware blind reference indexes. The unique confirmation insert, exact held-row assertion, one encrypted activity entry, exact indexed warning deletion, and optional named confirmation note commit in one transaction. Activity and note prose are display only; confirmation does not load or decrypt either history. New manual-refund warnings carry their blind reference index, while older unnamed notes remain ordinary history                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| The refund-only judgment                                         | `refundOutcomeOf` and `ObservationOutcome` in `src/shared/payment/diagnose.ts` (`test/shared/payment/diagnose.test.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | New, not in the reference: a reference carrying no agreed total is judged on captured-vs-returned alone. The booking-tier kinds are not evaluated rather than being evaluated against a synthesized total. These two are the whole of the module — the whole-reading judge that used to sit beside them is gone (see below). A reading holding two refunds in flight returns the explicit `multiple_pending_refunds` owner conflict; it never passes as settled or throws away the evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| The money facts a refund is judged on                            | `ChargeMoney` + `chargeMoneyRead` in `src/shared/payment/resources.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | New: `ChargeLeg` split into its money and the record it came from, because a bare provider reference has no checkout to hang a charge off. `money()` now also takes the `bigint` amounts Square states                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| The overlap guard and its wiring                                 | `src/shared/payment/admit-refund.ts` (`test/shared/payment/admit-refund.test.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `admitRefund`, `admitProviderRefund`, `sendRefundIfAdmitted`, `admissionReason`. Every refund reads the exact captured money before it sends and hands that same observation to the adapter; the attempt-then-check fallback and the separate Square reread are deleted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| The one record a row carries                                     | `src/shared/payment/row-state.ts` (`test/shared/payment/row-state.test.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | The claim, exact owner-review case, unrecorded-money fact, and terminal outcome share one env-key-encrypted slot, each in its own field. A review case carries its stable `caseId`, reason, and optional `acknowledgedAt`; acknowledgement changes only that optional time. A claim is a strict phase variant: `checking` cannot carry a provider capability, while `ready` and `send_armed` must carry the capability proved for that reference. Every phase also names one command id and a sorted, unique, non-empty initiating-attendee set. The committed-evidence summary field is PR B's and is not declared yet. Rows written before the record existed hold a bare terminal failure and read as an outcome-only record; legacy bare review reasons receive a deterministic legacy case id at the stored-format boundary                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| The claim's rules                                                | `src/shared/payment/claim.ts` (`test/shared/payment/claim.test.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Pure: exact initiating-attendee-set ownership, staleness against `claimLeaseMs(STALE_RESERVATION_MS)`, and evidence-derived release. The lease is the greater of reservation staleness and a five-minute request-lifetime floor. A stale `checking` or `ready` command starts over from `checking`, because no send permit existed. Only stale `send_armed` work inherits possible provider doubt: keyed work may repeat its deterministic request, while keyless work is observed and sent to exact owner review if no returned money is visible                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| The all-or-none claim                                            | scope derivation in `src/shared/db/payment-claim/scope.ts`; transaction in `src/shared/db/payment-claim/take.ts`; release/row mechanics in `src/shared/db/payment-claim.ts` (`test/shared/db/payment-claim/take.test.ts`, `test/shared/db/payment-claim.test.ts`, `test/features/admin/refunds/provider/claim-set-races.test.ts`)                                                                                                                                                                                                                                                                      | `attendee_set` scope only — callback claims remain later work. The physical row owner and command scope are separate facts: each matching reference group carries the same sorted ids of the initiating attendees, including every expanded representation, so a crashed shared command resumes from its initiator rather than `attendees[0]` or a row's current owner. The transaction verifies every attendee PII revision and exact `(attendee, session, reference index)` snapshot, expands the hold to every row with a matching prepared index, and writes all holds or none. It never mints storage from an in-memory fallback. Settlement names the exact command id, lease time, and row phase; a stalled predecessor therefore cannot clear or rewrite its successor                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| The `protected_state` mirror and its prune gate                  | written by `payment-claim.ts`; read by `paymentStatement` in `src/shared/db/prune.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | The claim writes the mirror in the same statement as the record; the prune keeps every arm byte-identical for rows whose mirror is empty and never deletes a row carrying work, however long ago the claim was taken — a retained claim IS the record that money may be going back, and staleness lets the same attendee set resume it but never makes it pruneable                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Each provider's refund capability                                | `refundCapability` on `PaymentProvider` and its three adapters; binding in `src/shared/db/payment-reference-provider.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Stripe and Square declare `keyed`; SumUp declares `keyless`. Readiness binds that proved capability to every exact representation by advancing the exact command from `checking` to `ready`; binding never claims that a provider send happened. A stale run inherits capability only from `send_armed`, so pre-send keyless work can safely restart while a mixed-provider attendee retries only armed keyed references and observes armed keyless references                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| The provider-send boundary                                       | `armRefundDispatch` and `RefundDispatchPermit` in `src/shared/db/payment-refund-dispatch.ts`; consumption in `src/features/admin/refunds/{attempt,provider}.ts` (`test/shared/db/payment-refund-dispatch.test.ts`, `test/features/admin/refunds/provider/readiness-integration.test.ts`)                                                                                                                                                                                                                                                                                                               | Immediately before any provider call, one transaction verifies every requested reference representation still belongs to the exact command and lease and is `ready`, then advances the whole requested set to `send_armed` or none. Only that transition yields typed, per-reference permits accepted by the send path. A repeated armed keyed command receives the same logical permission; armed keyless work receives an exact `uncertain_keyless_refund` owner-review decision. If any requested sibling is uncertain, no fresh sibling is armed and no provider call begins                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Legacy reference materialization                                 | `src/shared/db/payment-anchor/attendee.ts`, `src/shared/db/attendees/pii-write.ts`, and indexed-only reads in `src/shared/db/payment-references.ts` (`test/shared/db/payment-references/readiness.test.ts`)                                                                                                                                                                                                                                                                                                                                                                                            | The historical invariant is one payment id per attendee. Re-saving one attendee atomically and idempotently writes their PII plus a deterministic indexed anchor unless a current indexed payment row already represents it. Old identities remain as rows when PII changes. Until that attendee is re-saved, untouched PII-only payments and old unindexed payment rows are unavailable. Refund reads load only indexed rows for the named attendees; there is no global attendee scan, no decrypt-every-attendee fallback, and no read-time storage repair                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Provider discovery, tagging, and readiness                       | `src/shared/payment/provider-discovery.ts`, `src/shared/db/payment-reference-provider.ts`, `src/features/admin/refunds/readiness.ts` (`test/shared/payment/provider-discovery.test.ts`, `test/shared/db/payment-reference-provider.test.ts`, `test/features/admin/refunds/readiness.test.ts`)                                                                                                                                                                                                                                                                                                          | A tagged reference reads only its named provider. An untagged reference reads every credentialed provider and binds only when exactly one validates and every other provider definitively reports missing. One match beside an unavailable or invalid answer is `provider_search_incomplete`, not a guess. Binding rechecks the exact claim, atomically rewrites every matching old identity and its per-reference capability, and refuses a returned legacy marker as `historical_marker` instead of inventing an attestation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Shared-reference admission                                       | `sharedRepresentations` in `src/shared/db/payment-claim/take.ts`; `runRefundReadiness` in `src/features/admin/refunds/readiness-run.ts` (`test/features/admin/refunds/shared-reference-readiness.test.ts`)                                                                                                                                                                                                                                                                                                                                                                                             | More than one durable row for one reference is parked before provider discovery, sends, or ledger work. Every exact representation receives a durable `shared_reference` review case. Marking it reviewed stamps acknowledgement on that exact case but preserves the case and safety hold; it does not allocate the charge. The case retires only when a later indexed claim proves that representation is unique. An unchanged shared representation therefore remains blocked before provider or ledger I/O                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Durable owner-review work                                        | exact marker writers in `src/features/admin/refunds/{provider-reviews,ledger-findings,readiness-run}.ts`; owner action in `src/features/admin/attendee-payment-review.ts` and `src/shared/db/payment-review.ts` (`test/features/admin/attendee-payment-review.test.ts`, `test/shared/db/payment-review.test.ts`, `test/features/admin/refunds/provider-reviews.test.ts`)                                                                                                                                                                                                                               | Provider conflicts, unsafe partially returned obligations, and shared references are attached to the exact rows that carry them as cases with stable ids. The owner form's HMAC identity binds the sorted complete set of `[sessionId, caseId, reason]` facts without exposing them. In one transaction the command re-reads that set, refuses a stale identity, stamps `acknowledgedAt` only on its unacknowledged cases, preserves every reason, case id, hold, and other row fact, and writes one activity entry. A replay returns already acknowledged; concurrent replay serializes to one acknowledgement and one log. Any claim on the attendee blocks the command, regardless of claim age or phase. Automatic retirement is evidence-owned, never acknowledgement-owned: `shared_reference` retires only when its indexed representation is unique; `multiple_pending_refunds` and `refund_exceeds_capture` retire after a complete clean provider observation of their exact rows; `partial_refund`, `partially_returned_obligation`, and `uncertain_keyless_refund` retire only after every exact reference is returned and every ledger posting records. A fresh different finding wins, and a settlement can retire only the same reason it observed |
| The operator-facing payment safety state                         | `PaymentWorkStatus` and `getPaymentWorkStatus` in `src/shared/db/payment-review.ts`; action visibility in `src/features/admin/attendee-page.ts`; refund GET/POST admission in `src/features/admin/attendee-refunds/single.ts`; claim-time admission in `src/features/admin/refunds/readiness-run.ts`; exhaustive result destinations in `src/features/admin/attendee-refunds/single-result.ts`; real journeys in `specs/payments/{checking-before-a-refund,waiting-for-a-refund,recovering-the-money-record,refunding-from-two-windows,only-owners-refund}.feature`                                    | `clear`, `moving`, `needs_money_record`, and `needs_review` are one exhaustive state shared by links, confirmation pages, and submitted forms. Moving, unrecorded, and review work remove the refund action and render no usable refund form; a copied stale form is checked again on POST. Both single and bulk sends also recheck inside the exact claim and refuse any unresolved review or unrecorded row before provider preparation; refresh enters that same claim with explicit permission to reconcile those facts but never turns acknowledgement into send permission. An uncertain provider answer tells the owner not to resend and points to refresh. Only owners may refund or acknowledge review work: managers see neither link, and manager GET and POST requests receive 403 before provider or Money work. Any claim takes priority over review and blocks both review GET and POST. The Cucumber stories exercise public booking, owner and manager login, rendered forms, two real browser windows, provider delays, and ledger recovery through production routes; only provider responses and the deliberate database fault are controlled at their external boundaries                                                                   |
| The per-provider refund evidence                                 | `ProviderRead`, `readCharge`, and `chargeMoneyRead` in `src/shared/payment/{provider-read,resources}.ts`; Stripe in `stripe-provider.ts`; Square in `square/{api,client,payment-outcomes,transport}.ts` plus `square-provider.ts`; SumUp in `sumup/{money,transaction,transport}.ts` plus `sumup-provider.ts`                                                                                                                                                                                                                                                                                          | Replaces `isPaymentRefunded` outright — that method and its null collapse are gone from the interface. `found`, `missing`, `unavailable`, and `invalid` are exhaustive and survive every adapter. HTTP 400/422 reads are invalid `rejected_request` evidence, 404 is missing, and retryable/auth/rate/server failures remain unavailable. Stripe reads the charge's captured amount/currency/`amount_refunded` and refuses an uncaptured state; Square reads its captured and refunded totals and only accepts `COMPLETED`; SumUp validates the transaction id, merchant, captured state, amount, currency, and refund events. A top-level SumUp `REFUNDED` is itself authoritative full-return evidence and becomes one refund event for the transaction amount even when `transaction_events` is absent; a `SUCCESSFUL` transaction still needs refund-event evidence                                                                                                                                                                                                                                                                                                                                                                                           |
| The per-provider refund attempt                                  | `RefundAttemptResult` / `RefundRequest` in `src/shared/payment/refund-attempt.ts`; shared boundaries in `provider-failures.ts`; provider adapters above; admin orchestration in `src/features/admin/refunds/{attempt,claim,dispatch,provider,waves}.ts`                                                                                                                                                                                                                                                                                                                                                | A send returns exactly `completed`, `accepted`, `rejected`, `not_sent`, or `uncertain`. Named Stripe/Square refunds must match the admitted parent, amount, currency, and documented status. Their keyed adapters make exactly one fresh charge observation after either an uncertain or rejected send. Exact full-return evidence wins; a clean no-refund read preserves a rejection; pending, partial, or conflicting refund evidence turns a rejection into `uncertain`, retaining protection until refresh reconciles it. SumUp's empty success is never called completion: one fresh transaction read must account for the entire capture. Known provider failures remain typed; unknown internal errors throw. Admin completion requires `completed` or independently observed returned money; accepted/in-flight work is pending. Provider work retains fixed concurrency of five, while the separate whole-command admission below bounds the total physical calls. Inherited retry discipline is selected per reference index, not per attendee or run                                                                                                                                                                                                   |
| Whole-command admission and subrequest budget                    | safety admission in `src/features/admin/refunds/readiness-run.ts`; physical-call pricing in `src/features/admin/refunds/{budget,dispatch}.ts`; fixed reserves in `src/shared/subrequest-budget.ts` and `src/shared/db/client.ts` (`test/features/admin/attendee-refunds/bulk/safety-admission.test.ts`, `test/features/admin/refunds/{budget,refresh/budget}.test.ts`, `test/features/admin/refunds/provider/batch/budget.test.ts`, `test/shared/subrequest-budget.test.ts`, `test/shared/db/client/transaction.test.ts`)                                                                              | A listing-wide refund request claims the complete refundable candidate set and checks shared references, review cases, and unrecorded money across that whole set before provider preparation. Refund and refresh both require their exact row set to fit before and inside the claim and immediately before provider reads. Each checkpoint prices the adapter's physical retry worst case, discovery and bounded recovery reads, database work, rollback room, and protected settlement/caller tails against the remaining database, external, and combined allowances. A failed gate refuses whole before fresh provider I/O and never narrows work to a first-five subset. Existing live work remains protected when refresh cannot fit; M7/F53's persisted cursor is the automatic retirement path for histories too large for one request. Five controls provider-call overlap only; it is neither a partial money batch nor the budget                                                                                                                                                                                                                                                                                                                     |
| Live work owns its status, recovery, and writer rules            | `LIVE_WORK`, `paymentWorkFor`, and `moveRefusalOrNull` in `src/shared/payment/admit-move.ts`; checked attendee actions in `src/features/admin/attendees-route-helpers.ts` (`test/shared/payment/admit-move.test.ts`, `test/features/admin/attendee-page.test.ts`)                                                                                                                                                                                                                                                                                                                                      | One exhaustive record is keyed by every non-settled `PaymentRowState` field. Adding a live field is a compile error until it declares how it is found, its plain mirror, its operator status, its recovery action, its priority, its refusal, and whether it stops delete or merge. The same winning entry supplies `PaymentWorkStatus` and `PaymentRecoveryAction`, so status and next step cannot drift in parallel tables. The recovery action is constrained to the complete attendee-action schema, which owns its real route. A terminal outcome is settled and stops neither writer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| The merge/delete admissions and legacy anchor identity           | row admission in `src/shared/db/payment-admit-move.ts`; canonical anchor input in `src/shared/db/payment-anchor/reference.ts`; save/merge writers in `src/shared/db/payment-anchor/attendee.ts` and `src/shared/db/payment-references.ts` (`test/shared/db/payment-admit-move.test.ts`, `test/shared/db/payment-references/storage.test.ts`)                                                                                                                                                                                                                                                           | `assertRowsFreeToMove` reads every affected row through the CALLER's `TxScope` — `deleteAttendee`'s cascade and `applyAttendeeMerge`'s batch both became interactive transactions to give it one — and throws `PaymentRowsBusyError`. The merge admits BOTH ids: the source's rows change hands and the target's set grows by what the source brings. Save and merge now derive the same encrypted reference plus every provider-aware matching blind index. Before moving rows, merge creates a legacy anchor only when no matching current source row will move in that same transaction, so it cannot manufacture a false shared-reference conflict. The orphan purge is the third writer and gates in SQL off the `protected_state` mirror, since a set-based purge cannot decrypt what it removes                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Exact refund-ledger planning and results                         | `src/shared/accounting/{queries,store}.ts`; `src/shared/refund-ledger/{plan,record,result}.ts` (`test/shared/accounting/{queries/balances,store}.test.ts`, `test/shared/refund-ledger/plan/{partial,reference-placement,whole-account}.test.ts`, `test/shared/refund-ledger/record/batch.test.ts`, `test/features/admin/refunds/provider/batch/{ledger-findings,write-order}.test.ts`)                                                                                                                                                                                                                 | `computeAttendeeRefunds` loads every requested attendee account once, then maps each returned reference to provider-funded event groups, separates already-recorded and new reversals, and refuses unsafe groups with operator money or an unsettled obligation. `RefundLedgerResult` names exact `recorded`, `unrecorded`, and `reviewReferenceIndexes`; row settlement carries those findings back to the exact payment rows. After every provider wave finishes, the complete dispatched command shares one returned-marker write and one ledger call. The ledger validates every attendee against one bulk snapshot and applies every clean plan in one batch; a stored conflict parks only that attendee, while a database failure marks every unproved plan unrecorded without an unbounded per-attendee retry loop. Thirty returned attendees post in four database round trips. A returned deposit no longer cancels the sale it only part-paid: it remains unrecorded and receives `partially_returned_obligation` review                                                                                                                                                                                                                                |
| Money the books have not caught up with                          | `unrecorded` on `PaymentRowState`; its entry in `LIVE_WORK` (`test/shared/payment/admit-move.test.ts`, `test/shared/db/payment-claim.test.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                         | New, and the delete/retention blocker the owner named (2026-08-11). A provider refund that the ledger could not record now says so on the row: it stops a delete, which would destroy the repair target, but not a merge, which relocates it. The mirror carries it, so the prune and the orphan purge honour it for free. It retires when a later run's ledger post lands. "Not recorded" is not itself provider doubt: it may move with a merge, but blocks deletion and retention cleanup until repaired. A claim also stays when the returned-marker write fails, because without that durable fact a later run cannot prove what happened. Repeated repair attempts preserve the original `unrecorded.returnedAt` date. The verdict names the rows the posting actually returned, so a sibling charge still with the provider is never stamped as returned money                                                                                                                                                                                                                                                                                                                                                                                             |
| Evidence-preserving preparation and phase-safe settlement        | `underAttendeeClaim` in `src/features/admin/refunds/claim.ts`; typed preparation in `readiness.ts`; classification in `readiness-findings.ts`; provider/ledger work in `provider.ts`; refresh persistence in `refresh.ts`; exact findings in `ledger-findings.ts` (`test/features/admin/refunds/readiness-failure-evidence.test.ts`, `test/features/admin/refunds/claim.test.ts`, `test/features/admin/refunds/provider/{claim,claim-completion}.test.ts`, `test/features/admin/refunds/provider/batch/{ledger-findings,write-order}.test.ts`, `test/features/admin/refunds/refresh/returned.test.ts`) | The claim hands rows back by attendee and settles each independently, so one uncertain attendee does not hold settled neighbours. Every authoritative returned marker seeds exact `unrecorded` findings before work starts; ledger success must actively disprove that conservative starting point. A typed readiness failure carries successful sibling observations instead of discarding them: returned money becomes unrecorded, in-flight money retains doubt, and a provider contradiction becomes review work. An unexpected preparation throw marks every still-unproved candidate in doubt. `finally` guarantees a settlement attempt, but it does not decide what is safe to release: the accumulated facts do. A provider-confirmed return whose ledger call throws is placed in exact `unrecorded` findings before the error propagates; a returned-marker failure retains the claim. Settlement releases only rows whose durable facts prove completion and leaves every other hold visible for refresh. Provider HTTP stays concurrent while local claim and marker writes share one ordered lane                                                                                                                                                   |
| Claimed payment refresh                                          | `refreshClaimedPayment` in `src/features/admin/refunds/refresh.ts`, through `runRefundReadiness` (`test/features/admin/refunds/refresh/{blocking,returned,review}.test.ts`, `test/features/admin/attendees-edit.test.ts`)                                                                                                                                                                                                                                                                                                                                                                              | Refresh takes the same exact attendee-row claim, provider readiness, shared-reference park, per-reference inherited capability, marker writes, and ledger findings as a refund run. It never applies evidence to rows that moved or disappeared. It observes only: an inherited keyless reference with no settled proof remains held rather than being resent. Unlike a send, refresh may reconcile existing work. A complete clean observation retires only `multiple_pending_refunds` and `refund_exceeds_capture` on its exact rows. Only the path where all exact references are returned and the ledger records every one retires `partial_refund`, `partially_returned_obligation`, and `uncertain_keyless_refund`; any current provider or ledger finding remains. Shared-reference retirement happens earlier only when the indexed representation is unique                                                                                                                                                                                                                                                                                                                                                                                              |
| Declared attendee-dependent storage                              | `ATTENDEE_DATA_RULES` in `src/shared/db/attendees/dependent-data.ts`; production statements in `src/shared/db/attendees/delete.ts` (`test/shared/db/attendees/dependent-data.test.ts`, `test/shared/db/attendees/delete.test.ts`)                                                                                                                                                                                                                                                                                                                                                                      | One schema declares whether every attendee-linked table is deleted, repointed, or retained. Production attendee removal is derived from it instead of maintaining a second cascade list. The schema test walks the live database definition: every attendee-id-like column and every payment table must be declared, every named column must exist, dependent children precede parents, and production emits the declared operations. `refund_confirmations` and its reference children can therefore never be added without an explicit deletion decision, while durable payment history and built-site assignment keep their named lifecycle                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Reachable payment-work recovery                                  | indexed fact in `src/features/admin/attendee-page-data.ts`; attendee template in `src/ui/templates/admin/attendees.tsx`; orphan facts in `src/shared/db/orphan-attendees.ts`; owner queue in `src/features/admin/privacy.ts`, `src/ui/templates/admin/privacy.tsx`, and `src/locales/en/privacy.json` (`test/ui/templates/admin/attendee-page.test.ts`, `test/features/admin/attendee-refunds/balance-payments.test.ts`, `test/integration/server/privacy.test.ts`, `specs/payments/recovering-the-money-record.feature`)                                                                              | The authoritative indexed-payment fact, not the legacy PII `payment_id`, decides whether Payment Details and the real Refresh form render. A merge can therefore move protected payment rows onto a target with a blank legacy id without hiding their only recovery action; the visitor journey performs that merge, refreshes the row through the rendered form, records Money without a second Stripe send, then proves deletion is unblocked. A PII-only unindexed legacy id remains visible but does not promise a refresh the backend cannot perform. Orphan cleanup and the recovery queue share one no-bookings fact. Protected orphans are excluded from purge and listed by id under Privacy's "Outstanding payment work", linking to the still-live attendee page without loading or decrypting every orphan                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Reserved cleanup and deferred error reports                      | `withSubrequestReserve` in `src/shared/subrequest-budget.ts`; transaction reserve in `src/shared/db/client.ts`; `withDeferredErrorReports` and persistence scope in `src/shared/logger.ts` (`test/shared/subrequest-budget.test.ts`, `test/shared/db/client/transaction.test.ts`, `test/integration/logger/log-error.test.ts`)                                                                                                                                                                                                                                                                         | A command cannot enter a bounded body unless its mandatory tail still fits. Every transaction attempt keeps one rollback call outside its working allowance, and refund work separately reserves settlement and the route's final activity write. Non-critical ntfy, activity-log, and Sentry fan-out is queued until the money-critical command ends and flushes even when that command throws, so reporting cannot spend the calls needed to preserve money facts. Only recursive logging from one persistence attempt is suppressed; independent overlapping errors each persist                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| One candidate per person                                         | `getRefundCandidates` in `src/features/admin/refunds/candidates.ts` (`test/features/admin/refunds/candidates.test.ts`, `test/features/admin/attendee-refunds/bulk.test.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                            | Quantity-zero lines are dropped, then listing rows are deduplicated by attendee id before references are loaded. A person with several booking rows consumes one bulk slot, produces one tally, and reaches provider/ledger orchestration once                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

Lifecycle reachability has two separate gates. The checked attendee-action
schema proves that the declared route exists and has the right scope; that is
necessary, but a registered route with no rendered control is still unreachable
to an operator. The authoritative indexed payment/work state therefore also
decides whether the attendee template renders the usable recovery form, even
when legacy PII `payment_id` is blank. The merge-to-blank-target scenario in
`specs/payments/recovering-the-money-record.feature` is the composition proof:
the visitor merges the protected row, sees and submits Refresh, records the
already-returned money without a second provider send, and can then delete the
attendee.

The provider-outcome cutover uses delivery rule 3's atomic-cutover exception.
`PaymentProvider`, every provider adapter, every live refund caller, and their
test doubles changed together; splitting that interface migration would require
the compatibility surface delivery rule 2 forbids.

Still planned and explicitly outside Part A: declared-observation sweeps,
callback-scope claims, historical-marker repair, and allocation-driven
shared-reference work.

The sweeps are what build a whole reading of a checkout, and nothing in this
slice does. Everything that only a whole reading could feed — `outcomeOf`,
`hasSettled`, the observation and ownership-proof schemas, charge legs, the
session/charge/whole-resource schemas, and the eight conflict kinds that compare
money against what was owed — has been DELETED rather than left exported with no
caller. It returns in the slice that reads it, from git history, written against
what that slice actually needs. The repo's no-test-only-exports check is what
forced the choice, and it was right to: a mechanism with no caller is a promise
wearing the costume of a built thing.

Four boundaries remain live in the code and belong to later layers:

- **Callback refunds do not claim.** Admin single, bulk, and refresh work now
  take the same exact attendee-set hold. The callback arms (`tryRefund` and
  `refundRejectedCharge` in `payment-processing/refunds.ts`) still send without
  a callback-scope claim, so their keyless lost-answer window remains. A balance
  callback can no longer land a charge under a running admin refund:
  `balanceFinalizeStatements` stands down while a claim holds the attendee, and
  aborts rather than passing as a no-op, so the callback retries.
- **A shared legacy charge has no authoritative allocation.** The current path
  closes the dangerous behavior: it claims every representation, writes
  `shared_reference` review markers, and stops before provider or ledger I/O.
  The owner review action only timestamps the exact case; it preserves the
  marker and does not allocate money. The unchanged representation therefore
  remains parked until it becomes unique or a later revision-fenced owner
  decision allocates the captured Money across stable booking obligations or
  rejects the automated action. No split is inferred.
- **Historical completion markers are not proof.** Before this cutover, an
  accepted empty refund response could write `provider_refunded_at` and reverse
  the full ledger without preserving the provider, captured amount, currency,
  reference identity, or provider observation that justified it. A current SumUp
  transaction whose own top-level status is `REFUNDED` is authoritative
  full-return evidence; the historical local marker is not a stored copy of that
  evidence. Discovery therefore refuses an untagged returned marker as
  `historical_marker`; no schema member or writer pretends it was verified.
  Repair or audited owner attestation remains later work, and no migration may
  stamp those rows silently.
- **Provider identity is not booking identity.** Part A can say exactly which
  provider charge returned and which payment rows carry it, but the ledger still
  groups booking effects too broadly for two separate orders on one attendee. It
  therefore does not claim to solve the overwritten event-group case, the free
  member of a refunded package, or safe retention of an unreturned sibling
  payment. Those need the later stable booking-obligation identity and its
  allocation rules; a provider-row marker must not be used to invent that
  missing ledger relationship.

## Trusted facts and observed facts

This section through "What is deleted (F51)" preserves the approved
milestone-wide design, including later callback and whole-reading layers.
Present-tense design rules here are not evidence that Part A built their
machinery. The "As built" map governs Part A; whole-checkout sweeps,
`SIBLING_READ_CAP`, callback claims, allocation, stable obligations, and
historical attestation remain planned.

Trusted (expected) facts — never substituted for observed facts:

- The signed price proof carries the expected total and metadata (`price_proof`,
  verified per M1/M3). An expected CURRENCY exists only on this booking tier: a
  session was signed under the site currency of its checkout, and M4 keeps
  today's comparison against the live `settings.currency` — the exposure is a
  mid-checkout currency change, refusal-safe (the mismatch refuses and the money
  returns), closed when M6 stores the currency per charge (F12). A STORED
  reference carries no expected currency and never borrows today's (law 4,
  frozen facts): its judgment makes no expected-vs-observed currency comparison
  at all, and the only currency rule on a refund-only input is observed-internal
  — a refund leg in a different currency from its captured leg refuses as
  `refund_exceeds_capture`.
- Our durable completed-refund records: a ledger `refund_cash` leg and
  `processed_payments.provider_refunded_at`. New writes on the landed path are
  made only from completed provider evidence. Historical SumUp rows are an
  exception: before this cutover, an accepted empty refund response could write
  the marker and full ledger reversal without storing the provider observation,
  exact identity, amount, or currency that proved the return. Those old
  marker/ledger pairs must remain unverified until provider tagging/discovery
  and the owner-approved cutover repair verify or correct them. This does not
  weaken a fresh SumUp read: top-level `REFUNDED` is current provider evidence
  for the transaction's full amount even when its event history is absent.
- The staged/signed ownership facts from M3 (SumUp sealed staging, Stripe
  signatures, Square order metadata proof).
- A stored refund reference's PROVIDER IDENTITY. A reference must carry every
  fact its future judgment needs, and the provider that captured it is chief
  among them — the currently selected provider is ambient state, never evidence
  about an old charge. New writes tag the reference with its provider inside the
  same owner-key-encrypted value (a callback knows its provider from its own
  route and signatures; an anchor row minted by an admin claim is tagged by the
  terminal write that records a provider-VALIDATED outcome, so a stored tag
  always records proof, never a resolution guess). A reference from before the
  tag has its provider DISCOVERED, never assumed: the deployed existing-payments
  rule (`existingPaymentProviderState`,
  `src/shared/existing-payment-provider.ts`) prefers the currently configured
  provider without ever inspecting the reference, so it can only ORDER the
  search, never decide it (law 4 — ambient state may order a search, never
  decide a fact). Discovery runs the reference's evidence read against each
  credentialed provider in turn — the deployed rule's answer first, so a
  single-provider site pays exactly today's one read and no reference resolves
  worse than today — and exactly one read that finds the payment and passes that
  provider's M3 validation is the proof, recorded as the row's tag by the
  terminal write so discovery runs once per reference ever. A reference NO
  credentialed provider validates is an honest UNRESOLVED failure naming what
  was tried and the fix ("No configured payment provider recognizes this
  payment. Add the provider it was taken with, or refund it from that provider's
  dashboard.") — it never names a guessed provider as the reference's own, and
  no refund is ever dispatched to an adapter that did not validate the payment.

Observed facts — from the provider at judgment time:

- The session/checkout resource and status (existing M3 reads).
- Captured money per charge: SumUp vouched `amountMinor` + `transactionId`;
  Square `payment.amountMoney` per tender with `payment.orderId` parentage;
  Stripe session totals and `payment_intent`.
- The provider's cumulative refunded total: Square `refundedMoney`; Stripe
  `latest_charge.amount_refunded` (after the schema widening, decision 2); SumUp
  the sum of successful `REFUND` events in a `SUCCESSFUL` transaction read. A
  transaction whose current top-level status is `REFUNDED` is authoritative
  evidence that its documented full amount returned, even when
  `transaction_events[]` is absent. A top-level `SUCCESSFUL` alone proves no
  return; PR3's sandbox evidence showed that status can remain after a full
  refund, so its event history still matters.
- A provider's direct answer to a refund attempt (succeeded / PENDING /
  rejected).

An unavailable read is never treated as "no refund exists". A missing documented
field is a malformed read (M3 boundary), never a zero.

## Valid states

The judge's output is the ported four-kind union — no nulls, no defaults:

```typescript
type ObservationOutcome =
  | { kind: "ready" }
  | { kind: "fully_refunded" }
  | { kind: "refund_pending" }
  | { issue: PaymentConflict; kind: "conflict" };
```

Every conflict kind is mapped exhaustively (a `Record<kind, Remedy>` in code, so
a new kind is a compile error) onto exactly one of two remedies:

| Conflict kind             | Meaning                                                                                                                                                                                                           | Remedy in M4                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `currency_mismatch`       | Any observed currency differs from the signed expected currency (booking tier only — a stored reference carries no expected currency and never borrows today's; law 4)                                            | Refuse-and-record: today's mismatch refund path                                                                                                                                                                                                                                                                                                                                                 |
| `provider_total_mismatch` | Provider session total ≠ signed expected total                                                                                                                                                                    | Refuse-and-record: mismatch refund path                                                                                                                                                                                                                                                                                                                                                         |
| `partial_charge`          | Captured sum < expected                                                                                                                                                                                           | Refuse-and-record: mismatch refund path                                                                                                                                                                                                                                                                                                                                                         |
| `capture_total_mismatch`  | Captured sum ≠ expected (over-capture)                                                                                                                                                                            | Owner review: detect, record, alert                                                                                                                                                                                                                                                                                                                                                             |
| `paid_without_charge`     | Money on a free checkout: expected total is 0 and a charge is present                                                                                                                                             | Refuse-and-record: mismatch refund path (the charge has a resource to refund)                                                                                                                                                                                                                                                                                                                   |
| `resource_mismatch`       | Charge/refund parent or provider disagrees with its session/charge                                                                                                                                                | Refuse-and-record: refuse retryably (callback) / refuse attempt (refund path); keeps Square's current throw-behavior, named                                                                                                                                                                                                                                                                     |
| `duplicate_charge`        | Two charge legs share one resource id                                                                                                                                                                             | Refuse-and-record                                                                                                                                                                                                                                                                                                                                                                               |
| `multiple_charges`        | More than one captured charge on one payment (Square: >1 paid tender)                                                                                                                                             | Owner review: detect, record, alert; automatic work proceeds on the signed total as today                                                                                                                                                                                                                                                                                                       |
| `refund_exceeds_capture`  | Returned + returning money would exceed captured (`Math.max(providerCumulative, ourCompleted) + pending > captured`, or any single refund > captured, or a refund leg's currency differs from its captured leg's) | Refuse-and-record: the refund attempt is refused                                                                                                                                                                                                                                                                                                                                                |
| `failed_refund`           | Provider answered a refund attempt with failure                                                                                                                                                                   | **Not built, deliberately — see the as-built row for the conflict union.** A failure that moved no money settles as not-happening and a fresh attempt is legitimate, which is what "release/retry" meant; a failure reported beside money already returned parks as `partial_refund`. Neither needs a kind of its own, and giving it one made every later attempt refuse                        |
| `partial_refund`          | Cumulative shows part of the money returned                                                                                                                                                                       | Owner review. On the BOOKING path it PARKS — no ticket, buyer retained, alert — because the provider retaining less than the signed total is an operator choice (a dashboard discount? a cancellation underway?), never an automatic booking. On a refund attempt or the refresh route it is detect-record-alert (no current-path action can safely finish it; the balance-refund engine is M7) |

Five of the branch's fifteen kinds are NOT ported in M4. `failed_refund` is
dropped on purpose rather than for want of evidence — see the as-built row for
the conflict union above, and the retryable-failure entry below. The other four
are absent because no M4 observation can produce them and unreachable union arms
are dead code. The two read-level kinds (`invalid_provider_data`,
`missing_resource`) belong to M5's `resolve.ts`, which is what emits them — M4
read failures remain M3's `ProviderRead` boundary outcomes. And two refund-shape
kinds (`duplicate_refund` — two refund resources sharing one id — and
`multiple_pending_refunds` — more than one refund in flight) need evidence M4
never holds: no provider read on this path returns a per-refund resource list,
and the only pending refund an observation can carry is the direct answer to its
own single attempt — durable pending-refund records are M7's
`pending_refund_id`. Both kinds return with M7's engine, from the reference
branch.

A paid session with no charge reference never reaches the judge either: the
retained `validatedPaymentSession` boundary already rejects it as
`blank_reference` (retryable, unrefundable by construction — there is no
resource to refund). `paid_without_charge` is reserved for the refundable
free-checkout case.

`fully_refunded` is path-dependent by design. On a refund attempt it means
"already done, count it as success" — exactly `tryRefund`'s current fallback,
now a named verdict. On the booking path (a delayed callback arriving after the
charge was fully refunded externally) it must NOT issue a paid booking: the
session takes the stored-refused arm with the refund step short-circuited to
already-complete — in the session's own path shape (new booking: quantity-0
placeholder, payment + `refund_cash` ledger, system note; balance payment: no
placeholder, the existing attendee's balance stays unpaid, and the same
idempotent payment + `refund_cash` pair posts against the existing attendee —
the commands table row states both) — and the buyer sees the existing refunded
answer. This outcome is reachable only where the observation in hand carries
refund evidence: Square's payment read carries it at booking judgment, and the
Stripe/SumUp rejection arms gain it from the read each buys before a refund
attempt. On the Stripe and SumUp booking tiers it cannot fire — those reads
carry no refund facts, and M4 does not buy a refund-facts read for every trusted
booking, so an externally refunded charge that still reads as a clean paid
session books today and keeps booking in M4. That exposure is stated, unchanged
from today, bounded to externally-refunded-then-completed checkouts, and closes
with M6's aggregate. `refund_pending` refuses a new attempt without treating the
charge as refunded.

### One conflict per observation — the evaluation order is binding

An observation can match several conflict kinds at once (two captured tenders in
a wrong currency match both `multiple_charges` and `currency_mismatch`).
`outcomeOf` reports exactly one, chosen by its fixed evaluation order, which is
part of this contract: expected-vs-observed currency, provider total vs
expected, resource parentage, per-leg currency, over-refund, duplicate charge,
partial charge, money on a free checkout, failed refund — every
refuse-and-record kind — and only then the owner-review kinds, in this order:
partial refund FIRST, then capture total, then multiple charges. Within the
owner-review group the ordering principle is the global one applied again:
park-shaped kinds evaluate before proceed-shaped kinds, so condition ordering
can never quietly upgrade an observation into a booking. `partial_refund` leads
because it is the only owner-review kind that parks the booking path: a split
payment whose two legs sum to the signed total but whose first leg was already
part-refunded must park as `partial_refund` — the provider retains less than the
signed total — never book as `multiple_charges`. Then `capture_total_mismatch`
before `multiple_charges`: a multi-leg sum exceeding the signed total names the
money discrepancy, not merely the leg count. `multiple_charges` therefore fires
only when the captured sum equals the signed total AND no refund evidence
reduces what the provider retains (regressions: two £60 tenders on a £100 signed
order emit `capture_total_mismatch`, never `multiple_charges`; two £50 tenders
on a £100 order with £20 already refunded emit `partial_refund` and park). The
port makes two adaptations explicit. First: a zero-expected observation with
captured money is judged by the free-checkout arm FIRST — before every
expected-vs-observed amount check, `provider_total_mismatch` included, which the
enumerated order would otherwise reach first (a free checkout with a positive
provider session total matches it) — so `paid_without_charge` (refund path) is
the one diagnosis for money on a free checkout (equivalently:
`provider_total_mismatch`, `partial_charge`, and `capture_total_mismatch` all
exclude expected 0). Second: the ported order placed `multiple_charges`
mid-list, ahead of `partial_charge` — kept, two under-paying tenders would emit
`multiple_charges` and proceed-and-alert an underpaid booking; the adaptation
moves every owner-review kind after every refuse-and-record validation kind, so
that observation emits `partial_charge` and (being multi-charge) parks with no
booking per decision 5. The principle the adapted order encodes: every
refuse-and-record validation kind is evaluated before the owner-review kinds, so
an observation matching both always takes the safer refuse path — condition
ordering can never quietly upgrade a refusable observation into a
proceed-with-alert one. Decision 5 does not weaken this: a multi-charge
observation matching a refuse kind still refuses the booking — the rule below
only changes whether the refusal's refund is automatic.

Picking one kind never discards the rest of the evidence. The emitted conflict
carries the observation's full captured-charge list (resource ids, amounts,
currencies), so the durable record and the operator always see every charge no
matter which kind won the order.

How a refuse-and-record remedy then acts depends on how many captured charges
the observation carries (decision 5), and the rule below is the CALLBACK side's
— what to do about invalid money that arrived. A refuse-and-record kind emitted
on the refund-attempt side is the opposite action: it refuses the attempt itself
(`refund_exceeds_capture`, an attempt's `resource_mismatch`, a provider-answered
`failed_refund`) and makes zero provider calls beyond its evidence read, per the
commands and failure tables — a verdict that exists to prevent a payout can
never route back into one. On the callback side, with exactly one captured
charge — structurally every Stripe observation (a session names one
`payment_intent`), and virtually every Square and SumUp one — the remedy is
today's refund path, unchanged: one charge, one refund call. One check gates
that arm at the ACTION level, not by kind: before any callback automatic refund,
every observed charge must cohere with the signed session — the parentage facts
the observation carries must agree. A contradiction forces the retryable
no-refund refusal with zero provider calls REGARDLESS of which conflict kind won
the evaluation order: a payment with a wrong parent AND a wrong currency is
labelled `currency_mismatch` by the binding order, but the refund is still
withheld, because refunding a payment whose parent disagrees could return money
for a DIFFERENT order — most plausibly provider consistency lag. A kind-keyed
carve-out would be bypassed by exactly that observation; the gate is on the
action, so another winning label can never hide contradictory parentage.
Provider redelivery with coherent evidence, or the operator, resolves it; no
automatic money moves on evidence that contradicts itself. Regression: one
captured payment with both a wrong parent order and a wrong currency refuses
retryably, zero provider calls, never a refund. With more than one, no automatic
refund runs at all: the session parks to owner review — no booking, no provider
refund calls, a terminal outcome, the activity record naming the winning
conflict kind and every charge, the code-only alert, and the decision-3
manual-check copy for the buyer. Every park RETAINS the buyer: a new-booking
session persists the same quantity-0 placeholder attendee `storeRefundedBooking`
creates today — name and contact details kept, no ticket, no refund run —
atomically with the terminal outcome, plus a system note naming the conflict; a
balance session notes the existing attendee, who already carries contact
details. Without that record the promised "we will contact you" would be a
promise the owner cannot keep — the activity log holds only resource ids and
amounts. The owner returns the money from the provider dashboard. This is the
boundary decision 1 already draws: the in-app path cannot safely move money on
charges it has no record slot for — per-charge refund evidence, ledger legs, and
retry state are exactly M7's durable engine, and imitating it inside one
callback would mean invented facts (an unread tender's refund state) and an
unbounded provider fan-out. Regression cases: two captured tenders in a wrong
currency yield `currency_mismatch` whose remedy makes zero refund calls, books
nothing, records both resource ids under the winning kind, and answers the
manual-check copy; two captured tenders whose sum is below the signed total
yield `partial_charge` (never `multiple_charges` — the adapted order above) and,
being multi-charge, park the same way with no booking; one captured charge in a
wrong currency refunds exactly as today; a free checkout with captured money
yields `paid_without_charge` and reaches the refund path.

### Owner-review conflicts survive downstream booking failures

A `multiple_charges` / `capture_total_mismatch` observation that proceeds and
then fails to book (sold out, capacity, price drift) must NOT fall into today's
automatic single-reference refund — that would move one tender's money on a
conflicted payment and strand the rest in a different state. When the judge
flagged owner review, every downstream automatic refund is suppressed: the
session records a terminal owner-review outcome, the activity-log record names
both the conflict and the failed booking (the alert is the code-only pointer
described under Owner choices), and replays return the same stable answer. The
buyer is retained here exactly as in the park above — the quantity-0 placeholder
(new booking) or the system note on the existing attendee (balance), written
atomically with the terminal outcome — so the owner holds the contact details
the buyer copy promises to use. The buyer sees new plain-language copy: "We
received your payment. Your booking needs a manual check. Do not pay again — we
will contact you." The owner resolves it with the provider dashboard (every leg
named in the activity record — the alert stays the code-only pointer), matching
the decided behavior "a failed checkout that shows captured money stops
automatic work". Regression case: a sold-out booking on an order with two
captured tenders makes zero provider refund calls and records the owner-review
outcome.

### Evidence tiers — no invented facts

The judge's refund gate uses the richest evidence the provider exposes for that
reference, and never more:

- **Square** (session and legacy references alike): `retrievePayment` states
  captured `amountMoney` and cumulative `refundedMoney` — the full arithmetic
  applies. The DECLARED Square observation for any money decision is that
  payment read PLUS its order's captured-tender sweep (law 6, total evidence):
  the callback path already holds the order read; the admin single and bulk
  preflights and the refresh route buy the one order read their path lacks — the
  order id rides the payment read — so no path judges Square money on
  payment-only evidence, and a sibling tender captured before booking is seen at
  the first attempt to move money even when no redelivery ever revealed it. A
  sibling tender the sweep reveals carries its amount and capture state but not
  its refund totals, and the binding evaluation order needs those to park a
  part-refunded split rather than book it — so a multi-tender observation buys
  one payment read per additional captured tender before judging, under the same
  bounded sibling fan-out as SumUp's children below (regression: a two-tender
  order whose sibling was part-refunded before the callback parks as
  `partial_refund`, never books as `multiple_charges`). What no read can see is
  a tender Square has not yet propagated into the order at that instant — that
  lag residual is the same provider-data-fault class as the stale cumulative
  (closed by M7's per-attempt records), a bounded propagation window where the
  pre-sweep blind spot was unbounded. `refunded_money` is a DOCUMENTED-OPTIONAL
  field: Square omits it on a never-refunded payment, so its absence means a
  cumulative refund of zero in the captured money's currency — the
  genuinely-expected-absence case the house rules name, already modelled
  optional at the boundary (`square.ts:463-476`) and pinned by the existing
  missing-means-not-refunded test. The malformed-field refusal is for money that
  is present but incoherent (an amount without a currency), never for this
  documented absence — an ordinary never-refunded payment judges `ready`, it
  does not retry forever. Order tenders are captured money only when they SAY
  so: today's tender pick carries only ids (`square.ts:55-59`), and Square
  documents that an order's tender list can lag and can hold non-captured
  states, so the widened pick reads each tender's `amount_money` AND its capture
  state by the tender's documented TYPE. A card tender counts per
  `card_details.status` — captured only when the status says so;
  authorized/voided/failed card tenders are named in the evidence but never
  counted as money; a CARD tender carrying money with a missing or unrecognized
  `card_details.status` is a malformed read — it refuses at M3's provider-read
  boundary (retryable callback / failed admin row), the same rule as any missing
  documented field, because no ported conflict kind represents an unreadable
  reading and `outcomeOf` must not invent one. A non-card tender (Square
  documents cash, wallet, gift-card, and other types, none of which carry
  `card_details`) that states `amount_money` counts as observed captured money
  in the sweep, its type named in the evidence — these types document no
  order-level pending state, and counting them errs toward detection (an
  owner-review record), never toward validity: the webhook-named payment keeps
  its independent COMPLETED check from the payments read, which alone gates
  booking — the tender sweep only detects EXTRA captured money. The per-leg
  refund reads of the complete-evidence rule apply to sibling tenders that NAME
  a payment id; Square documents a tender's `paymentId` as optional, and a
  captured non-payment tender (cash and kin) has no payment to read, so its
  cumulative refunded total is UNKNOWABLE on this path — never defaulted to zero
  (law 2: a fact nothing carries is not invented). An observation carrying such
  a leg is refund-evidence-INCOMPLETE: the booking path parks it as the split
  owner-review outcome on the sweep evidence, naming the unreadable leg — a
  TERMINAL recorded park, which is exactly why the cash rule below holds — and
  the admin and refresh paths refuse the attendee whole as any multi-leg
  observation, the unreadable leg named in the detection (regression: an order
  with the named card payment plus a captured cash tender parks on booking with
  zero refund calls, refuses admin refunds whole, and never attempts a payment
  read for the cash leg). A valid order carrying a cash tender must never wedge
  as an eternally retrying malformed read. Before any duplicate or
  multiple-charge check, the observation coalesces the named payment with its
  own tender: the tender whose payment id IS the webhook-named payment is
  excluded from the sweep (its facts come from the richer payments read), so a
  caught-up tender list on an ordinary one-payment order can never read as
  `duplicate_charge` against the payment itself; `duplicate_charge` remains for
  two genuinely distinct legs sharing one resource id. The observation also
  carries `order.totalMoney` as the provider SESSION total, a separate observed
  fact from the per-tender charges — today `retrieveSession` stands the named
  payment's own amount in as `amountTotal` when the payment is COMPLETED
  (`square-provider.ts:154-166`), which would make a valid split payment (a £100
  signed order paid by two captured £50 tenders) fire `provider_total_mismatch`
  (50 ≠ 100) and refuse before `multiple_charges` could park it for owner review
  as decision 1 decided. With the order total carried separately, that
  observation reads: session total 100 = expected, captured sum 100 = expected,
  two captured tenders → `multiple_charges`, proceed-and-alert. The existing
  code comment's guard stays honored — a short or unreadable charge still cannot
  book by matching the order total, because booking validity remains the named
  payment's COMPLETED check and the captured-sum comparison, never the session
  total alone. Regressions: an ordinary Square callback whose caught-up order
  lists exactly the named payment's own tender judges `ready` — never
  `duplicate_charge`, never `multiple_charges`; a £100 signed order paid by two
  captured £50 tenders emits `multiple_charges` (proceed-and-alert), never
  `provider_total_mismatch`.
- **Stripe**: two tiers by path. A webhook-parsed session carries only
  session-level facts (`amount_total`, currency) — the callback BOOKING judgment
  uses exactly those, the same facts today's verdicts use, with zero new reads.
  Refund attempts judge on charge-tier evidence. Today's
  `StripeExpandedPaymentIntentSchema` picks only the intent id and
  `latest_charge.refunded` (`stripe/schemas.ts:42-52`) — no captured amount, no
  currency — so the decision-2 widening is stated completely: the pick gains the
  charge's documented `amount`, `currency`, and `amount_refunded` together.
  Without the first two the refund gate could not compute returned-vs-captured
  for a Stripe reference — legacy/admin references included, which carry no
  signed proof — without copying an expected or ledger amount into the observed
  slot, which the refund-only input above forbids. All three are documented
  charge money fields: the same read, more money figures, nothing personal —
  decision 2's scope, stated explicitly. The admin/refresh paths already make
  that payment-intent read; a Stripe CALLBACK refund attempt (the rejection arm)
  does not, so it buys the same read before its refund call — one added provider
  call on that rare arm, budgeted in PR A; the full arithmetic then applies
  everywhere charge-tier evidence exists.
- **SumUp** (including every legacy reference): a current top-level `REFUNDED`
  transaction is authoritative full-return evidence for its documented `amount`,
  even when `transaction_events[]` is absent. For a `SUCCESSFUL` transaction,
  cumulative returned money is the sum of that response's successful `REFUND`
  events. This keeps both provider shapes: PR3's sandbox proof showed a full
  refund whose top-level status remained `SUCCESSFUL`, while the live provider
  may also answer `REFUNDED` without event history. Full arithmetic applies over
  the event sum on `SUCCESSFUL` — a dashboard partial refund becomes
  `partial_refund` (owner review), not a silently skipped remainder. A
  transaction response missing the documented `amount` is a malformed read at
  M3's provider-read boundary (retryable callback / failed admin row); an absent
  or empty event list on `SUCCESSFUL` is zero refunded — the genuinely expected
  shape of a never-refunded transaction, not a malformed read. The transaction
  read is not the whole declared shape, though: a paid checkout can carry more
  than one SUCCESSFUL child (below), the replay contract treats a later-visible
  child as possible, and a stored row names only ITS child — so for any money
  decision on a row that names its checkout, the declared SumUp observation is
  the transaction read PLUS the checkout's vouched-children sweep (law 6, the
  same children pick the callback path validates), exactly as Square's order
  sweep: the admin single and bulk preflights and the refresh route buy the one
  checkout read, and a sibling SUCCESSFUL child is a multi-charge observation —
  the whole attendee refuses with zero refund calls and the detection records.
  On any MULTI-child observation — callback booking and admin preflight alike —
  the sweep alone is not the whole shape either: the checkout names a sibling's
  identity, amount, and status but not its refund events, and the binding
  evaluation order needs those events to park a part-refunded split as
  `partial_refund` instead of booking it as `multiple_charges` — so the
  multi-child arm buys one transaction read per SUCCESSFUL child — the NAMED
  child included, because the checkout tier names refund events for none of its
  children (the single-child common case still pays nothing extra; the rare
  multi-child cost is one read per child, counted in admission; regressions: a
  two-child checkout whose sibling was part-refunded before the callback parks
  as `partial_refund`, never books; so does one whose NAMED child was
  part-refunded while the sibling stayed whole). The sibling fan-out — Square
  tenders and SumUp children alike — is BOUNDED on the callback path by
  `SIBLING_READ_CAP`, a named constant derived from the callback ceiling in the
  budget section, because the provider controls the leg list and an unbounded
  list must never chase the request budget: an observation with more additional
  legs than the cap buys nothing and PARKS as the split owner-review outcome on
  the sweep evidence alone — a TERMINAL write naming the unbought evidence, so
  the session retains its buyer, books nothing, refunds nothing, and every
  redelivery replays the park instead of repeating the fan-out (regressions: a
  checkout whose SUCCESSFUL-child count exceeds the cap parks terminally after
  one sweep and zero sibling reads; its redelivery replays the park without
  re-reading). The cap is GLOBAL — admin and refresh runs share it, because
  admission cannot count siblings it has not yet swept: admission prices each
  multi-leg-capable reference (Square, checkout-linked SumUp) at its worst case
  — the declared shape plus up to `SIBLING_READ_CAP` sibling reads — statically
  before any call, and a sweep that then reveals more additional legs than the
  cap stops reading and refuses or parks that attendee whole on the sweep
  evidence alone, inside the budget admission already reserved (regression: an
  admin refund whose sweep reveals more legs than the cap refuses whole after
  the one sweep read, within its admitted budget, with the detection recorded).
  A checkout read that fails is M3's no-verdict boundary — money never moves on
  the narrower read. A legacy reference that names no checkout has the
  transaction read as its whole declared shape — stated, the same M6/M7 residual
  as its other unknowns (regressions: an admin refund of a SumUp booking whose
  checkout carries a second SUCCESSFUL child — booked before the child was
  visible, no redelivery since — is refused whole with zero refund calls and the
  detection recorded; the refresh twin refuses its ledger completion the same
  way). Our own refund calls remain full-amount (no amount body), and legacy
  references keep working — the same reads answer them. A SumUp CALLBACK refund
  attempt (the rejection arm) starts from the checkout observation, which
  carries `amountMinor` and `transactionId` but no refund events — so, exactly
  like Stripe's rejection arm, it buys the one transaction read before its
  refund call; the arithmetic never runs on an invented zero. SumUp is NOT
  structurally single-charge: a paid checkout can carry more than one SUCCESSFUL
  child transaction, and today `paidChildVerdict` refuses ANY extra child as
  `unrecorded_child` (`sumup-observation.ts:143-150`), which the provider turns
  into a retryable refusal (`sumup-provider.ts:133-139`) — an eternal 503 with
  captured money, never a judged observation, no buyer record, no owner alert.
  PR A must not disturb that refusal while it merges alone: its admin and
  refresh readers take the child sweep through their own declared-observation
  reader, and the callback parser's extra-child rejection stays byte-for-byte
  (`paidChildVerdict` keeps refusing until PR B ships the child-aware remedy),
  so the still-legacy callback can never consume a normalized multi-child
  observation and silently book an over-capture in the window between the merges
  (regression: with PR A merged alone, a multi-child SumUp callback still
  answers the retryable refusal, never books). PR B's cutover carries the
  vouched SUCCESSFUL children into the observation's captured-charge list
  instead (each child's documented amount and transaction id), and the COMMON
  remedy map applies — no SumUp-specific arm: children summing to the signed
  total emit `multiple_charges` and proceed-and-alert per decision 1 (the buyer
  books, the owner-review marker and alert land), exactly as Square's two £50
  tenders do; the park is decision 5's, reserved for a multi-charge observation
  that also wins a refuse-shaped validation kind. A SumUp buyer who paid
  correctly in two captures gets a ticket, not a quantity-0 manual-review
  placeholder. `unrecorded_child` remains for a child that fails validation (a
  bad id, a wrong merchant code), not for extra settled money. Regressions: a
  paid SumUp checkout bearing two SUCCESSFUL children summing to the signed
  total BOOKS with the owner-review record and alert — never a 503, never a
  park; one whose children also fail validation (wrong currency, short sum)
  parks with both charges named.

Legacy admin references (`legacyReference`, no session id) are judged the same
way: by whatever their provider's read genuinely answers for the stored payment
reference. "Their provider" is the reference's own, per the trusted-facts rule:
the stored provider tag when the row carries one, else the discovery that rule
defines — the validated read is the proof, tagged onto the row by the terminal
write. Dispatch is per REFERENCE, never per attendee — a merged attendee whose
references were captured under different providers has each reference judged and
refunded at its own provider (`refundCandidateAtProvider` resolves the provider
per reference; provider clients are already cached factories, so two providers
in one run cost no extra reads) — and a TAGGED reference whose provider has no
stored credentials, or whose read fails that provider's validation, is an honest
failed row naming the provider and the fix (restore that provider's credentials,
or refund from its dashboard), never a call to the wrong adapter. Regressions:
after a site switches from Stripe to SumUp with the Stripe credentials retained,
one bulk run refunds an old untagged Stripe reference at Stripe — discovery's
SumUp read does not validate it, its Stripe read does, and the terminal write
tags the row — beside a new SumUp reference refunded at SumUp; with the Stripe
credentials removed, a tagged Stripe row fails naming Stripe with zero provider
calls, and an untagged one fails UNRESOLVED after discovery finds no validating
provider — naming what was tried, dispatching no refund anywhere. A legacy
reference carries no signed price proof, so its judgment is a refund-only input
by definition: observed captured money, the observed cumulative (or summed
refund events), and our completed records. The overlap arithmetic compares
returned money against CAPTURED money, so it needs no expected total — and none
is synthesized: the observed capture is never copied into the expected slot, and
the booking-tier expected-vs-observed kinds (`currency_mismatch`,
`provider_total_mismatch`, `partial_charge`, `capture_total_mismatch`) are
simply not evaluable for these references — stated, not defaulted. No expected
currency is borrowed from today's `settings.currency` (law 4 — the site may have
sold in a different currency when the charge was captured, and F12's
live-currency fault names exactly this class); the only currency rule here is
the observed-internal one — a refund leg in a different currency from its
captured leg refuses as `refund_exceeds_capture`. Regression: a legacy reference
captured while the site sold in one currency refunds cleanly after the site
switches to another — the judgment never reads the live currency setting.

## Commands and events

| Starting state                                                                                                                                                                                                                                  | Command or event                                         | Required result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Paid session observed, judge says `ready`                                                                                                                                                                                                       | Callback/redirect processing                             | Booking proceeds exactly as today (trusted path)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Paid session observed, refuse-and-record conflict                                                                                                                                                                                               | Callback/redirect processing                             | Single captured charge WITH COHERENT PARENTAGE: today's mismatch/rejection refund path runs unchanged — at most one refund call (the judged attempt runs only when it fits; the refusal rows below make zero), buyer answer unchanged, outcome recorded with the existing `REFUND_REASONS` vocabulary. Coherent parentage is a PREREQUISITE of this row, never overridden by whichever kind won the evaluation order: a single charge whose parent facts disagree with the signed session takes the action-level gate's retryable zero-call refusal even when `currency_mismatch` or another kind won. More than one captured charge: zero refund calls — the session parks to owner review with the manual-check copy (decision 5)                                                                                                                                                                 |
| Paid session observed, PROCEED-shaped owner-review conflict (`multiple_charges`, `capture_total_mismatch` — `partial_refund` is park-shaped and takes its conflict-table park: no ticket, buyer retained, manual-check copy, never this row)    | Callback/redirect processing                             | Booking proceeds on the signed total as today; the durable activity-log record carries the conflict kind, every resource id, and the amounts; the best-effort alert is the existing code-only ntfy ping (`sendNtfyError` sends an error code and nothing else) pointing the owner at the log; no payload echo                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Owner-review conflict flagged, booking then fails (sold out, capacity, price)                                                                                                                                                                   | Callback/redirect processing                             | No automatic refund on the conflicted payment; terminal owner-review outcome recorded; buyer sees the manual-check copy; replays return the same answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Owner acknowledges the exact current review cases ("mark reviewed")                                                                                                                                                                             | Admin attendee payment action (owner level, PR A)        | The form carries an HMAC over the sorted `[sessionId, caseId, reason]` set the owner saw. One transaction re-reads that exact set, fails closed if it changed, stamps only `acknowledgedAt`, preserves every review case and safety hold, and writes one activity entry. A replay is already acknowledged, and concurrent replay logs once. Any claim blocks acknowledgement, not only a fresh or capability-bound claim. Managers cannot GET or POST the action. Acknowledgement never makes refunding admissible, allocates shared money, decides a partially returned obligation, or restores deletion/retention; only reason-specific evidence retirement can remove the review                                                                                                                                                                                                                 |
| Charge with no completed/pending refund facts, judge says attempt fits                                                                                                                                                                          | Refund attempt (`tryRefund` / admin single / admin bulk) | Provider refund attempted with the provider's idempotency key (Stripe/Square); success re-reads the complete declared observation, then records completion — a capture beyond the judged set parks with the sent refund recorded instead                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Charge where returned + returning would exceed captured (> captured)                                                                                                                                                                            | Refund attempt                                           | Attempt refused before any provider call; recorded/answered through the caller's existing failure shape (callback: retryable; admin: failed row with reason). One boundary everywhere: accounted-for ≤ captured passes; exact equality means nothing is left and routes to the `fully_refunded`/`refund_pending` rows, never to refusal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Charge already fully refunded (provider cumulative or our records)                                                                                                                                                                              | Refund attempt                                           | `fully_refunded`: success without a provider refund call, as `tryRefund`'s fallback does today                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Provider answers in-flight to a refund attempt (Square PENDING; Stripe refund `status` `"pending"` or `"requires_action"` — in flight, not settled, not a rejection; today Stripe collapses both to a false failure at `stripe-provider.ts:81`) | Refund attempt                                           | No completion write, exactly as today. Within the request that observed it, the judge answers `refund_pending` and no further attempt starts. A later redelivery has no durable pending record (that is M7's `pending_refund_id`); its re-attempt reuses the same deterministic idempotency key, so within the provider's key-retention window (~24 hours for Stripe) it lands on the SAME provider refund — one payout. Past the window the overlap guard's fresh pre-attempt read protects, with the stale-cumulative residual named under Retry and replay                                                                                                                                                                                                                                                                                                                                       |
| Free checkout (expected 0), provider shows money                                                                                                                                                                                                | Callback processing                                      | `paid_without_charge` → refuse-and-record refund path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Paid session observed, judge says `fully_refunded` (money already returned)                                                                                                                                                                     | Callback/redirect processing                             | No paid booking, and the refusal takes the session's own path shape. A new-booking session runs the stored-refused arm with the refund short-circuited to already-complete: quantity-0 placeholder, payment + `refund_cash` ledger, system note. A balance session (`balanceAttendeeId` names an existing attendee) creates NO placeholder and no new attendee: the balance stays unpaid, the terminal refused outcome and a system note on the existing attendee name the externally refunded charge, and the money round trip still reaches the ledger — the same idempotent payment + `refund_cash` pair, keyed by the session, posts against the existing attendee (net zero), so the captured-and-returned cash shows on the attendee statement and in ledger reporting instead of vanishing. Both: the buyer sees the existing refunded answer; terminal, and replays return the same outcome |

Every command keeps one authoritative implementation; the judge is consulted,
never duplicated.

## Failure table

| Work completed                 | Failure                                                                                                                                                                                                                                    | Required result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Retry owner                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Nothing                        | Provider read unavailable before judgment                                                                                                                                                                                                  | No verdict; caller's existing unavailable handling (callback 503 retryable; admin row fails with reason)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Provider redelivery / operator                                             |
| Judge refused refund           | — (refusal is the outcome)                                                                                                                                                                                                                 | No provider call, no local mutation beyond the recorded answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Provider redelivery / operator re-runs later; cumulative catch-up unblocks |
| Provider refund succeeded      | Local completion write fails                                                                                                                                                                                                               | A next attempt's fresh read sees the provider cumulative (Square/Stripe) or the amount evidence (SumUp) → `fully_refunded`, success without a second payout. On the callback placeholder-refund path the outcome stays TERMINAL even when `recordPlaceholderRefund` reports `posted: false`: the attendee insert precedes the ledger write, and today it carries no replay identity, so a retryable answer would re-enter booking and insert a second placeholder — the current docstring's "a retry must NOT re-create it" is kept. PR B gives the insert that identity and closes the re-creation window structurally, on EVERY path that persists a buyer record and then refunds — the boundary rejection arm (`refundRejectedCharge`) and the stored-refused booking failures alike (`storeRefundedBooking` inserts its placeholder before refunding, `store-refund.ts:167-185`, called from `payment-processing/index.ts:208-249,291-298` — the same crash window): the arm claims the reservation, then ONE batch persists the buyer record and writes its id plus a staged refund-in-flight marker onto the reservation row (`failure_data` with a distinct staged kind, naming the deterministic idempotency key, the batch's written-at time, and its `callback` owner scope per Concurrency) plus the staged charge's one-way IDENTITY CODE and its amount and currency numbers — never the owner-key reference, which the staged row's only in-scope consumer (the keyless callback resume) could not read back, and never a raw id in env-key data: the resume codes the charges its own fresh observation names and refunds exactly the one matching the stored code, so even a checkout that later shows a second child pins the staged charge unambiguously, and an observation naming NO matching charge is an honest no-verdict that leaves the row staged (regression: a staged resume on a two-child checkout refunds only the code-matched child) — and only then calls the provider (the staged batch also sets the `protected_state` mirror, so no retention arm can reach the row mid-flight). The buyer record follows the session's shape: a new-booking session inserts the quantity-0 placeholder; a balance session inserts NOTHING — it binds the existing attendee whose balance was being paid, and the payment/refund pair posts against that attendee per the commands table, because a placeholder would attach the money to a spurious record. `blank_reference` never enters this lifecycle: it is retryable and unrefundable by construction — no resource to refund — so its reservation releases and the callback answers retryably until a delivery carries a usable reference; it is never stored as a terminal rejection. A worker death between that batch and the terminal batch leaves the staged row — neither an unresolved reservation (the reaper never deletes it: `attendee_id` is set) nor a finalized answer — so a redelivery reads it and re-creates nothing (the buyer-record identity is on the row). Whether it RESUMES is decided by the staged row's age against the edge request lifetime bound: a FRESH row means the original worker may still be awaiting the provider, so the duplicate answers retryably without touching the provider — Stripe/Square would dedupe a concurrent resume under the stored idempotency key, but SumUp has no key, and the age gate is what keeps two live workers from racing full refunds — while a STALE row is a crashed worker, and the redelivery resumes at the refund step: Stripe/Square under the stored idempotency key, SumUp behind its fresh pre-attempt evidence read (a cumulative covering the charge answers `fully_refunded` with no second call). Every stale staged resume rebuilds and judges the COMPLETE declared observation FIRST (law 6): single-charge as staged resumes the refund exactly as stated, while a checkout that meanwhile gained a captured sibling is a multi-charge observation and PARKS whole — zero refund calls, the staged state resolving into the park outcome with the detection recorded — the possibly-already-sent keyless refund being the same named lost-answer residual (regression: a staged SumUp resume whose checkout now shows a second SUCCESSFUL child parks, never refunds the staged child alone). Redelivery is FINITE — every provider stops retrying, and the redirect-path arm has no redeliveries at all — so the staged state's lifecycle does not end with the webhook queue (law 4, total lifecycle): the admin REFRESH route on that attendee is the operator's cure, resuming a STALE callback-scope staged row exactly as a redelivery would — it holds fresh evidence, matches the staged identity code, refunds under the stored idempotency facts, and finalizes — so "finish or re-run the refund" is an action the operator can actually take, and a merge or delete blocked by the staged row has a satisfiable path (regression: a staged row whose redeliveries are exhausted is finished by the refresh route — refund, terminal write, then the delete admission passes). Scope preservation still bars the admin SINGLE-REFUND route from touching a FRESH callback claim; the refresh resume applies to STALE rows only. The staged state is routed BEFORE the finalized-success branch: today's conflict handler answers success for any row with `attendee_id` set before it ever reads `failure_data` (`payment-processing/index.ts:69-74`), which would replay a staged row as a completed booking while the buyer's money sat captured — PR B's handler checks `failure_data` for the CALLBACK-scope staged kind FIRST, so a staged rejection-arm row resumes at the refund step and only a genuinely finalized row replays success — an `attendee_set` claim is invisible to this routing, per Concurrency (regression: a redelivery against a staged callback-scope row answers the refund resume, never `alreadyProcessedResult`). PR B fixes the silent half too: `posted: false` stops being ignored — the unposted-money fact rides the terminal write itself, stored in the terminal record's outcome data (`failure_data`, the same env-key-encrypted slot `markSessionFailed` writes, naming the session and amount) in the SAME batch as the finalize, so the durable marker and the replay identity land atomically: even if every other write fails, the terminal row itself names the money the ledger is missing. The activity-log entry and the attendee system note are layered on top as operator surfacing, non-throwing best-effort — their failure logs a classified error and never prevents the finalize, so redelivery cannot re-book the placeholder. Repair stays with existing tools (the refresh-payment route re-posts what provider state supports; the manual ledger correction `reportRefundNotRecorded` covers the rest); durable automated re-posting is M7's persistence half | Next redelivery / operator                                                 |
| Refund call sent               | No validated provider verdict (transport error, timeout, or a response body that fails its schema — `StripeRefundSchema` / the Square refund response shape; a 2xx with an unreadable body moves money just as invisibly as a lost packet) | Not recorded as failed blindly: the malformed body is surfaced loudly (a classified error naming the provider and reference — never parsed leniently), and one post-call evidence re-read re-judges. A cumulative that now covers the charge records completion — the money moved, and the idempotency key or the provider's second-refund rejection keeps it one payout. Anything else records the honest failure — including when the re-read itself is stale (cumulative totals lag): that recorded failure is the row above wearing a different cause, repaired the same way — a later judged read (the refresh-payment route or an operator re-run) observes the caught-up cumulative, answers `fully_refunded`, and records completion, while the idempotency key (Stripe/Square) or full-refund rejection (SumUp) keeps any interim re-attempt at one payout. A definitive rejection that names its reason (Stripe's explicit failure statuses, Square's typed errors) skips the re-read: the verdict is the answer. SumUp's generic 409 state-conflict is NOT definitive — it does not say which state conflicted, so it is never assumed to mean already-refunded: it takes the same one bounded re-read, and the evidence answers (a cumulative covering the charge records `fully_refunded`; anything else records the honest failure). On the landed admin path that lost answer is not yet a durable recorded outcome, so EVERY capability retains its claim; law 3's keyed-release rule applies only after a later layer durably records the outcome. A re-run against the FRESH claim repeats the settling answer with zero provider calls. Once the claim is STALE, a scope-preserving re-claim reads fresh evidence first. A claim inherited from a KEYED call may repeat the deterministic request when that evidence still says ready; a claim inherited from a KEYLESS call is reference-wide observation-only and never sends again until evidence proves settlement. At any time, a cumulative covering the charge resolves the claim to `fully_refunded` with no call. The residual — an accepted refund still invisible to evidence past the staleness bound — is the same named provider-data-fault class as the stale cumulative under Retry and replay, closed by M7's per-attempt records                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Same caller; operator re-runs                                              |
| Provider refund PENDING        | Request ends                                                                                                                                                                                                                               | No completion write; Stripe/Square replay lands on the same idempotency key; SumUp: a re-attempt's fresh amount read answers `fully_refunded` before any call when the cumulative covers the charge, and a provider 409 on the call itself is classified by the bounded re-read, never assumed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Provider redelivery                                                        |
| Owner-review conflict detected | Alert delivery fails                                                                                                                                                                                                                       | The durable record survives: the conflict is written to the activity log in the same transaction as the processing outcome, so it is admin-visible regardless of alert delivery. The ntfy/log alert itself is best-effort, stated as such — terminal replays do not re-observe, so a lost alert is not retried on this path. Retryable owner alerting is M5's unsent-revision machinery                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Operator (activity log today; M5 cases)                                    |

## Retry and replay

- Stable identity: the provider payment reference (unchanged), plus the
  deterministic `refundIdempotencyKey(provider, reference)` for Stripe and
  Square provider calls. Stripe prunes idempotency keys after ~24 hours, so a
  re-attempt beyond that window is a genuinely new provider operation; its
  protection is the overlap guard's fresh pre-attempt read — after 24 hours the
  cumulative reflects any committed refund (provider lag is seconds to minutes,
  not days), so the guard refuses. The residual — a cumulative still stale a day
  after a committed refund — is a provider data fault, not lag; the durable
  per-attempt records that close it completely are M7's, and M4 states the
  boundary instead of writing new tables for it. SumUp has no provider
  idempotency parameter — its replay safety is: our refunds are full-amount
  only, a second refund of a refunded transaction is provider-rejected (its
  generic 409 state conflict, classified by the bounded evidence re-read, never
  assumed), and the judge short-circuits from a fresh read of the documented
  transaction evidence (`amount` against the summed refund events).
- Exact replay of a callback returns the same terminal outcome (existing
  `processed_payments` replay), and a replay that reaches the refund path gets
  the judge's verdict from fresh evidence — an already-completed refund answers
  success, never a second payout. Exact means every captured resource the fresh
  observation carries matches the payment resource the terminal record stored —
  the comparison sweeps the whole observation (Square: the named payment plus
  every captured order tender; SumUp: every vouched SUCCESSFUL child the
  checkout carries — the same sweep the initial judgment makes, so a
  later-visible second child is never mistaken for a replay; Stripe: the single
  named resource), so a redelivery naming the original resource but carrying a
  caught-up tender list or a newly visible SumUp child with a second capture is
  new evidence, not a replay. All post-terminal deliveries take one total rule,
  whether they carry new money (that caught-up second capture) or changed
  settled facts on the same resources (a Square redelivery of the same payment
  now showing a higher cumulative `refundedMoney` after an external partial
  refund): the fresh observation — already validated and in hand, zero extra
  provider calls — runs through the pure judge for detection only. What gets
  recorded is total, not a whitelist: EVERY conflict kind the fresh judge emits
  — owner-review kinds and refuse-and-record kinds alike, because after
  settlement no automatic remedy is safe, so a new tender in a wrong currency
  (`currency_mismatch`) or with a wrong parent (`resource_mismatch`) maps to the
  same durable owner-review record rather than to a refund or a refusal — and
  equally a `fully_refunded` verdict on a session whose terminal answer booked
  the money as kept: an external refund reaching 100% must not be quieter than
  one reaching 60%. EXTERNAL is the boundary of that rule: a delivery whose only
  change from the committed evidence is refund progress the app's OWN durable
  facts already record — the named reference's completed in-app refund
  (`provider_refunded_at` with its ledger reversal), or a terminal record whose
  outcome names the refund the rejection arm itself issued — is a CONFIRMATION,
  not a detection: the fingerprint advances in the same batch so the next
  identical redelivery replays silently, and nothing else is written — no
  owner-review record, no alert — because alerting the owner that the provider
  now shows the refund the app performed would bury the real alerts under one
  false alarm per refunded booking. Any fact beyond the app's recorded refund —
  progress past the refunded amount, a resource the committed evidence lacks, a
  changed currency or parent — records and alerts per the total rule
  (regressions: an admin-refunded booking's caught-up Square redelivery advances
  the fingerprint with no record and no alert, and its replay writes nothing; an
  overpay rejection's redelivery now showing the arm's own refund is equally
  silent; a redelivery showing refund progress beyond the app's recorded refund
  still records and alerts). Every record names the stored reference plus every
  observed charge and goes through the same recorder, and the recorded terminal
  outcome is returned unchanged. A redelivery whose observation matches the
  stored facts detects nothing and simply replays the stored answer. The
  terminal outcome stands because no automatic remedy — booking or refund — can
  safely re-run after settlement: re-judging stored terminal evidence is M5's
  `resolve.ts`, and moving the new money is the owner's dashboard call per
  decisions 1 and 5. No provider re-read is needed: the observation was
  validated before the reservation check. Both the replay comparison and
  once-ness hang off one mechanism, because neither existing surface is
  comparable from a webhook: the activity log's `message` is owner-key-encrypted
  ciphertext (`activity-log.ts` — a webhook can write it, never search it), and
  `processed_payments.payment_reference` is `OwnerKeyEncrypted` — randomized
  ciphertext the webhook writes but cannot read back or compare. The
  `evidence_index` column (in PR A's migration, per law 5; PR B is its first
  callback-side writer) carries the answer: a deterministic one-way code (the
  existing `hmacHash` pattern behind `ticket_token_index` and friends) over ONE
  canonical representation used everywhere — the CODED canonical summary defined
  below. There are not two serializations: a fresh delivery derives the coded
  summary from its judged observation (a total derivation, so every fact that
  can change the verdict or the recorded evidence — a future observation field
  included — lands in a leg's identity code, its settled-facts code, or its
  numbers by construction) and hashes THAT; the stored fingerprint is the hash
  of the stored coded summary; equal input, equal hash, so an unchanged delivery
  always compares equal. Each leg's IDENTITY code is its STABLE identity —
  provider plus resource id, nothing else — while parent linkage, currency, and
  capture state live in the leg's separate settled-facts code: a provider
  correcting a leg's parent linkage is a settled-facts change on the SAME leg
  (recorded, newest reading kept), never a phantom second leg that would hold
  the sibling-capture gates closed forever. The summary also carries the outcome
  kind and the session-total number. Canonical includes ORDER: legs sort by
  identity code, ties broken by the full coded representation — because provider
  array order is not evidence: Square and SumUp may return the same tenders or
  children permuted, and an order-sensitive hash would record and alert an
  identical observation as new money. The tiebreak matters precisely where ids
  repeat — a reachable `duplicate_charge` observation carries two legs with one
  id, and an id-only sort would leave their relative order the provider's
  (regressions: a redelivery whose only difference is tender order hashes equal
  and writes nothing; so does one permuting two same-id legs). Comparable in
  plaintext, revealing nothing (a one-way code over provider resource ids and
  money figures, no PII). This is what keeps the changed-settled-facts guarantee
  above real in every direction: a grown cumulative refund (still
  `partial_refund`, same resources), a currency that changed while staying
  wrong, or a parent that changed while staying mismatched each change the
  fingerprint and record, rather than masquerading as an exact replay. Columns
  on an existing table, not a new table; `payment_charges` stays dormant. Every
  terminal write stores it — success finalization and `markSessionFailed` alike
  (`markSessionFailed` also gains the owner-readable `payment_reference` write
  it lacks today: `processed-payments.ts:190-203` writes it on success,
  `:213-226` never on failure). A redelivery hashes its fresh observation and
  compares: an equal fingerprint is an exact replay — nothing written, the
  stored answer returned; a different fingerprint is new evidence — the total
  detection rule above records it (a third tender on a payment whose first two
  were already recorded changes the fingerprint, so later money is never
  suppressed by an earlier record) and the committed evidence advances by MERGE,
  never replacement (the monotone law below). Identical redeliveries therefore
  write nothing more even after a lost acknowledgement — and truly concurrent
  duplicates are serialized too: the detection write is a COMPARE-AND-SET in one
  interactive transaction, the `evidence_index` update conditioned on the index
  still holding the value this delivery compared against, and the owner-review
  record committing only when that condition held. Two deliveries in flight with
  the same new evidence yield exactly one record and one alert — the loser's
  condition fails, it writes nothing and alerts nothing. A losing delivery is
  not discarded blind: it reloads the committed index, and only an index EQUAL
  to its own fingerprint is a true duplicate (answer the stored outcome). A
  differing index means the contenders carried DIFFERENT evidence — a clean
  observation seeding a legacy row's index while a simultaneous delivery carries
  the caught-up second tender — so the loser retries the compare-and-detect
  cycle against the committed index instead of suppressing real money that may
  never be redelivered; the retry is bounded by the transaction retry budget and
  convergent because each round compares against a strictly newer index — and a
  loser that EXHAUSTS the budget answers RETRYABLY, never the stored terminal
  answer: the delivery stays unacknowledged for the provider to redeliver while
  redeliveries last, and past the last one the facts are still not lost — they
  live AT THE PROVIDER, so the next complete declared read commits them: the
  admin refresh route (the staged state's same operator cure) or any later money
  action's pre-attempt sweep (law 6). Unmerged evidence is deferred, never
  acknowledged away (regressions: CAS exhaustion under racing distinct
  observations returns retryable, and the evidence lands on a later round; the
  refresh route's fresh read commits facts whose delivery was exhausted). The
  retry writes only what the loser's own observation justifies, and "beyond the
  committed evidence" is DECIDABLE FROM THE ROW ALONE: every write that sets or
  advances `evidence_index` — a detection, a legacy seed, a confirmation —
  stores the judged observation's CODED canonical summary as its own field of
  the row's `failure_data` record, in the same batch as the index, so a losing
  retry compares CONTENT, never a one-way hash it cannot decompose — on terminal
  failure rows exactly as on booked ones. CODED, because the env-key slot must
  not weaken the owner-key boundary: stored payment references are deliberately
  owner-key encrypted (`src/shared/db/payment-references.ts` — checkout and
  webhook code writes them, only an authenticated admin request reads them
  back), so a summary holding raw provider resource ids would re-expose under
  the weaker env key exactly what that boundary protects. The summary therefore
  stores, per leg: a one-way identity code over the leg's STABLE identity —
  provider plus resource id, nothing mutable (the existing `hmacHash`
  blind-index pattern behind `ticket_token_index`) — and the leg's
  JUDGE-READABLE facts: captured amount and currency, capture state, cumulative
  refunded, observed count, and the leg's observation-time VALIDITY VERDICTS
  (parent coherence, per-leg currency agreement, duplicate status — the judge's
  own check results, booleans and small enums that reverse to no id), plus a
  one-way settled-facts code kept for CHANGE DETECTION only — plus the SIGNED
  EXPECTED total, the PINNED observed provider session total with their
  agreement verdict (a contradicted later reading keeps its settled-facts code
  beside the pinned one, set-monotone; the pinned value stays the judge input
  while the recorded contradiction gates money), and the outcome kind (one
  representation, the fingerprint's own input above; capture-sum conflicts need
  the expected total and `provider_total_mismatch` needs the observed one, so
  the merged re-judgment holds every input the live judgment had). This shape IS
  the judge's input type: a live observation converts to it before judging, a
  stored summary already is it, so the merge-time re-judgment below and every
  live judgment run the same pure judge over the same shape — never a second
  coded-data diagnosis, and never an outcome carried forward that the stored
  facts cannot reproduce. No raw provider resource or parent id ever enters
  env-key data; the human-readable evidence — the real ids and amounts the owner
  acts on — is the owner-key activity-log record the same detection batch
  already writes. Every comparison the summary serves works on codes: a losing
  retry codes its own fresh observation's legs the same way and set-compares;
  the refresh and refund gates code the named reference (decrypted in their
  authenticated context) and check the summary for captured legs beyond it; a
  webhook can compute every code from the fresh observation it holds, and none
  can be reversed from a database dump. Advances are MONOTONE (concurrency law
  2): an advancing write stores the MERGE of the committed summary with the
  judged observation, whose outcome kind is RE-JUDGED from the merged evidence
  by the same pure judge before hashing — never carried forward from either
  input — so one merged evidence set has exactly one kind and one hash
  (regression: committed two-tender `multiple_charges` evidence merging a
  lagging one-tender observation with newer refund progress stores the kind the
  judge assigns the MERGED facts, and a later caught-up delivery of those same
  facts hashes equal) — legs united by their STABLE identity code (provider plus
  resource id), so a committed leg never leaves the summary (identical legs keep
  the larger observed count, preserving `duplicate_charge` multiplicity), and
  each mutable fact merges by ITS OWN ordering law, because arrival order is not
  provider-state order under propagation lag: cumulative refunded keeps its
  maximum; capture state advances only forward through its lifecycle (a
  COMPLETED capture never regresses to PENDING via a lagged read — the stale
  reading merges to no change); and the facts with no intrinsic order — parent
  linkage, its validity verdict, and the OBSERVED PROVIDER SESSION TOTAL (a
  session-level fact stored once beside the legs, pinned by the first validated
  observation) — record a CONTRADICTION (on the leg, or on the summary for the
  session total) when a reading disagrees with the committed one: both readings'
  settled-facts codes are kept (set-monotone, so replaying either reading adds
  nothing and the fingerprint never flaps), the contradiction is itself a
  recorded fact, and a leg whose identity-adjacent facts — or a summary whose
  session total — are contradicted judges as an owner-review conflict wherever
  it gates money — the same principle as the action-level parentage gate: no
  automatic money moves on evidence that contradicts itself — with WHICH reading
  is the provider's current truth the named residual M7's provider-timestamped
  per-attempt records resolve (regressions: a stale wrong-parent reading
  delivered after a corrected one records the contradiction once and cannot
  overwrite the correction — a third delivery of either reading writes nothing
  and hashes equal; a named payment whose parent readings contradict refuses its
  refresh completion and admin refund as owner-review, never completes on
  last-arrival) — a leg never minting a phantom sibling either way — and the
  stored fingerprint is the hash of that MERGED coded summary. Committed
  evidence can therefore only grow, even when the advancing observation is a
  lagging SUBSET carrying one genuinely new fact: a committed two-tender summary
  receiving a one-tender observation with newer refund progress advances to a
  summary still naming BOTH tenders plus the progress, so the gates below never
  un-learn a capture, and the caught-up two-tender redelivery after it hashes
  equal to the merged summary and replays silently. An observation whose merge
  ADDS NOTHING — every leg already present with the same settled facts, no
  refund progress past the summary's — is a STALE snapshot (Square serving one
  delivery a lagging tender list) and writes NOTHING, never regressing the index
  to an older observation that would make already-recorded money look new and
  alert again; only a merge that adds a fact — a leg the summary lacks, a
  changed settled fact, refund progress past it — records and advances the
  index, the added delta classified as detection or confirmation by the total
  rule above (regressions: after a clean loser retries against a committed
  second-capture index, a redelivery of that second capture writes nothing more;
  a stale two-tender loser that lost to a committed three-tender record finds
  both its tenders in the summary, writes nothing, and the next three-tender
  redelivery fingerprints equal and replays silently — one record, one alert; a
  lagging one-tender delivery bearing newer refund progress on a two-tender
  record advances a summary still naming both tenders, and the refresh gate
  still refuses ledger completion on the sibling capture). The equal-fingerprint
  replay path never reads the summary; that decrypt is paid only on the rare
  differing-index retry. An interruption between the two writes can neither make
  the next identical delivery record twice (fingerprint advanced with the
  record) nor suppress a record that never landed (neither write happened).
  Regressions: two simultaneous identical post-terminal deliveries produce one
  record, one alert; a legacy row's clean seed racing a second-capture delivery
  ends with the conflict recorded exactly once. When the fresh judge's outcome
  on a BOOKED session is an owner-review CONFLICT — a first callback finalized
  `ready` before Square's tender list caught up, a later delivery revealing the
  second capture — that same batch also writes the owner-review marker into the
  session row's `failure_data`: the conflict KIND, beside the same batch's
  committed observation summary — the captured-resource evidence lives ONCE, in
  the summary, serving the loser retries and the gates alike, so the marker's
  charges can never drift from the fingerprint's, and picking one kind never
  discards the rest of the evidence (nor can the summary later forget a capture:
  advances merge per law 2, so a committed leg never leaves the summary) — and
  the gates read CONTENT, not just kind: every marker hides the Refund action
  (its handler could only refuse — the dead-link rule), while the refresh
  route's ledger-completion writes are refused whenever the committed summary
  names any captured charge beyond the named reference — REGARDLESS of which
  kind won the evaluation order, because an extra capture can hide behind a
  higher-priority diagnosis: a replay revealing a second tender AND a partial
  refund on the named tender emits `partial_refund`, yet completing the ledger
  when that tender later fully refunds would reverse the whole booking order
  while the sibling stays captured (regression: such a marker refuses completion
  even though its kind is `partial_refund`). Refund-progress evidence is
  deliberately NOT gate-closing beyond that: a dashboard FULL refund of the
  named single charge judges `fully_refunded` — recorded and alerted precisely
  because NO local fact explains it (the app performed no refund; that is the
  external-change test above), fingerprint advanced, NO marker — so the refresh
  route's unambiguous `fully_refunded → completed` ledger write stays open and
  the provider refund reaches the ledger; a dashboard PARTIAL refund judges
  `partial_refund`, whose marker (the committed summary: the named charge alone)
  hides the Refund action but leaves the refresh route free to observe later
  settlement and complete what provider state supports. Without the marker, the
  attendee would keep a live Refund action whose use reverses the full ledger
  order while the newly detected sibling stays captured (regressions: a session
  booked clean whose redelivery reveals a second tender loses its Refund action
  and refuses legacy refunds immediately; one whose charge was
  dashboard-refunded in full completes its ledger through the refresh route with
  no marker written). Legacy rows from before PR B carry no fingerprint, and a
  RETENTION-PRUNED row is the same shape wearing a different cause: today's
  ledger preflight (`replaySessionFromLedger`,
  `payment-processing/index.ts:183-194`) answers a pruned session from the
  ledger BEFORE any validation runs, which under law 1 is a consumer skipping
  the state machine — so PR B's cutover judges the in-hand observation FIRST on
  both: any conflict records per the total rule, detection against a row-less
  session MINTS the anchor row (the same claiming-write mint) carrying the seed
  evidence and marker, and only then is the ledger replay answered (regression:
  a redelivery after the payment row was retention-pruned whose order now
  carries a second captured tender records the detection on a freshly minted
  anchor row before replaying the ledger answer; a clean post-prune redelivery
  replays writing nothing). A first post-upgrade redelivery of a
  fingerprint-less row takes the same detection path, not a blind replay: the
  fresh observation — validated and in hand — is judged, any conflict records
  per the total rule (a legacy multi-tender session whose sibling tenders
  today's code never saw is a REAL first detection), and `evidence_index` is
  seeded from that observation in the same batch either way; a clean observation
  seeds silently — the fingerprint and its committed summary, nothing else. From
  then on the row compares like any other — only unchanged legacy evidence
  replays silently, so the total post-terminal rule holds for existing
  production rows too.
- Retries stay owned by provider redelivery and the operator, as today. M4 adds
  no scheduler.
- Permanent failures: a provider's explicit refund rejection records the failed
  outcome as today; `partial_refund` and `capture_total_mismatch` park as
  owner-review alerts (no automatic retry can fix them).
- One failed item cannot block later work: bulk refund rows already record
  per-reference results; a refused row records its reason and the wave
  continues.

## Concurrency

### The reference row is one state machine

This section records the full approved M4 target. Part A currently implements
the resolution, the `attendee_set` claim, and the owner-review marker described
below; callback claims, committed evidence, fingerprints, complete checkout
reads, and `evidence_index` remain later-layer design. The "As built" map is
authoritative wherever this target uses present tense.

In the completed target a row holds four durable facts: its RESOLUTION (open
reservation → booked success or terminal failure — `attendee_id` plus the
terminal outcome data), its CLAIM (none, or one live claim: owner scope
`callback`/`attendee_set`, command id, written-at time, initiating owner ids,
phase, and the proved provider capability where that phase requires one), its
OWNER-REVIEW MARKER (none, or the conflict kind), and its COMMITTED EVIDENCE
(the fingerprint plus the coded canonical summary). All but the resolution live
as distinct fields of the ONE env-key-encrypted `failure_data` record described
above, and the row's LIVE WORK STATE — claim, staged refund, or owner-review
marker, else empty — is mirrored in the plaintext `protected_state` column,
written by the same statement that writes the record it mirrors, so a consumer
that cannot decrypt still routes on the real state machine. Six laws — PLAN.md's
data laws instantiated for this row — bind every consumer, current and future;
the rules in this section and the failure table are instances of them, and a new
consumer or state must say which law admits it:

1. **Total routing — readers and writers alike.** Every reader routes on the
   same precedence — a claim in the reader's OWN scope first, then the
   resolution, then open — and leaves untouched any state it does not own (a
   callback never consumes an `attendee_set` claim; an admin run never resumes a
   `callback` staged row). A writer that would GROW a claimed world is routed
   the same way: while any of an attendee's rows carries a live fresh
   `attendee_set` claim, an other-scope write that would grow the attendee's
   reference set (the balance-settlement finalize — the transaction that inserts
   a new reference row and posts its ledger group) or advance a claimed row's
   committed evidence (a callback delivery carrying new observation facts for
   it) reads the claim inside its own transaction and answers RETRYABLY without
   writing, so a claimed set can never gain a charge and a judged verdict can
   never go stale mid-run; the provider redelivers after the claim resolves, and
   a stale claim (a crashed worker) blocks neither (regressions: a balance
   callback finalizing while an admin refund's fresh attendee claim is live
   answers retryably and writes nothing, and its redelivery after release lands
   the reference and its ledger group; a callback delivery carrying a new
   sibling capture for a row under a fresh admin claim answers retryably and
   writes nothing, and its redelivery after release records the detection).
   Every consumer routes on a DISCRIMINANT, never a proxy: a reader that can
   decrypt the record routes on the record's own discriminant, and the one
   reader that cannot — the prune's SQL — routes on the plaintext
   `protected_state` mirror above. Non-emptiness of the encrypted slot is NOT a
   state: committed evidence and terminal outcome data ride the same slot
   without protecting the row, so refund evidence alone never exempts a row from
   its normal retention (the prune design under Owner choices). Routing is total
   over WRITERS too: an operation that relocates or removes rows — the attendee
   merge's reference move, the attendee delete's cascade — is a consumer of
   every state on them, so its admission reads each affected row's record inside
   the same interactive transaction that would move or remove it and FAILS
   CLOSED against any live claim or staged marker, fresh or stale (the answer
   names the fix: finish or re-run the refund, then retry). The two writers
   differ on OWNER-REVIEW markers, by what each destroys: a MERGE relocates —
   the marker and terminal outcomes ride the moved row unchanged, and the
   per-attendee marker check then gates the merged person whole — while a DELETE
   destroys, and a park's marker guards a RETAINED BUYER (the quantity-0
   placeholder or balance note whose contact details are the "we will contact
   you" promise), so the attendee delete also fails closed on a live
   owner-review marker: the owner resolves the review first (regressions: a
   delete against an attendee whose reference carries an owner-review marker is
   refused naming the review; a merge of the same attendee succeeds and gates
   the target whole). The write lock makes the check race-free — a claim lands
   before the admission and blocks it, or after the transaction commits and sees
   the moved world.
2. **Monotone evidence.** Committed evidence only grows: every advance stores
   the merge of committed and observed, never the raw observation (the merge is
   defined under Retry and replay). No consumer can ever read a summary that
   lost a leg or regressed a refund cumulative.
3. **Phase-and-capability-derived claim release.** The durable phase says what
   could have happened; provider capability says which recovery is safe. A new
   claim starts `checking` with no capability. A validated discovery binds the
   exact provider capability and advances every representation to `ready`, which
   means no send is armed and therefore no provider call can have escaped. One
   final transaction, immediately before the provider boundary, compare-and-sets
   the exact command, lease, and complete reference representations from `ready`
   to `send_armed`; only that write returns a permit the send path accepts. A
   stale `checking` or `ready` command restarts from `checking`, including
   keyless work, because binding alone never implies a send. A stale
   `send_armed` KEYED command may repeat its deterministic request. A stale
   `send_armed` KEYLESS command is observation-only: returned or in-flight
   evidence settles it normally, while fresh evidence showing no return parks
   `uncertain_keyless_refund` on the exact rows for the owner and releases the
   command instead of retaining an endless moving state. If one requested
   sibling has that uncertainty, the arm transaction advances no fresh sibling
   and the run sends nothing. A future provider adapter declares its capability
   and inherits the same phase machine.
4. **Frozen facts.** Every fact a judgment consumes is signed, stored, or proven
   — never ambient. A stored reference carries every fact its future judgment
   needs — its provider identity above all (trusted facts; the legacy-references
   rule). A fact the reference lacks is either DISCOVERED from
   provider-validated evidence (the provider discovery: a read that finds and
   validates the payment is proof, recorded as the tag) or NOT EVALUABLE (a
   stored reference's expected currency, and with it every booking-tier
   expected-vs-observed kind) — stated, never borrowed from live settings.
   Ambient state — the currently selected provider, today's site currency — may
   order a search; it never decides a fact.
5. **States never straddle slices.** The PR that first WRITES a state ships
   every consumer that must recognize it — prune arms, routing, resume rules,
   the merge and delete admissions — in the same slice. PR A writes the first
   claims AND the first owner-review marker (its refresh cutover detects
   `partial_refund`, and a persisted marker is that outcome's required shape),
   and therefore ships their complete current consumers: `protected_state`,
   `payment_reference_index`, marker vocabulary and retirement, the prune gate,
   and merge/delete admission. The judged-evidence fence, `evidence_index`,
   committed summaries, callback scope, and staged rejection lifecycle remain
   later-layer work and must ship with all of their own consumers.
6. **Total evidence — later-layer target.** Each provider declares ONE
   observation shape for money decisions — Square: the payment plus its order's
   captured-tender sweep; Stripe: the charge tier; SumUp: the transaction's
   documented amount plus its refund events, plus the checkout's
   vouched-children sweep where the row names its checkout — and every path that
   moves or reverses money (a callback remedy, an admin single or bulk refund,
   the refresh route's ledger completion) supplies the complete shape before
   acting. No path judges money on a narrower read than the declared
   observation; a path that cannot afford the reads does not move the money.

| Operation A                                 | Operation B                                                                     | Required result                                                                                                         | Protection                                                                                                                                                                                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Callback refund attempt                     | Redelivered callback refund attempt                                             | One payout                                                                                                              | **Later callback layer:** callback-scope claim plus provider idempotency for Stripe/Square; keyless SumUp recovery stays closed until that claim exists                                                                                        |
| Admin refund                                | Callback refund of the same charge                                              | One payout                                                                                                              | **Later callback layer:** both paths share the claim and evidence lifecycle. Part A serializes admin work only and does not claim callback refunds                                                                                             |
| Two admin bulk waves touching one reference | —                                                                               | One payout per reference                                                                                                | The all-or-none claim (laws 1 and 3) serializes the waves; `refundState === "completed"` short-circuit, judge verdict, and idempotency key back it up                                                                                          |
| Refund run holding a live claim             | Attendee merge or delete of a claimed attendee                                  | Rows never move or vanish under live refund work; the merge/delete answers the settling reason                          | Law 1's writer admission: the merge/delete transaction reads every affected row's record and fails closed on any live claim or staged marker                                                                                                   |
| Judgment read                               | Provider state changes after read, before attempt                               | Provider-side rejection or idempotent landing; never a silent double payout                                             | Provider guarantees (documented full-refund rejection) + next read converges                                                                                                                                                                   |
| Refund call succeeds                        | Sibling capture lands at the provider after the judged sweep, before completion | A sibling the re-read can see parks before completion; one narrower residual is RETAINED and named, never promised away | **Later whole-checkout layer:** the terminal batch is preceded by a complete-observation re-read and the post-terminal evidence path merges a late sibling into committed evidence. Part A neither promises this sweep nor stores that summary |

M4 Part A's row-state slice adds exactly TWO new columns on
`processed_payments`, with one schema migration: `protected_state`, the
plaintext live-work mirror law 1 requires for the consumer that cannot decrypt;
and `payment_reference_index`, a blind one-way index of the reference's stable
identity (the `ticket_token_index` pattern) that lets the claim transaction see,
in SQL, a live claim on the SAME provider reference held by ANOTHER row — two
attendees carrying one SumUp reference can no longer each claim only their own
row. New payment writes populate the index at write time. Saving one old
attendee materializes that attendee's PII-only payment as a deterministic
indexed anchor in the same transaction as the PII write. Untouched PII-only
payments and old unindexed rows remain unavailable, which is deliberate: refund
reads never scan or decrypt unrelated attendees and never mutate old storage.
The historical system created one payment id per attendee, so Part A does not
build cross-attendee discovery for impossible legacy sharing. `evidence_index`
remains a later-layer promise and is not declared by Part A. The durable refund
serialization needs nothing further — the staged refund-in-flight marker rides
in `failure_data`, and the provider tag rides inside the owner-key-encrypted
reference value, not another column. That slot is ONE env-key-encrypted record.
Part A uses distinct fields for the claim, owner-review marker,
unrecorded-ledger fact, and terminal outcome; the committed observation summary
remains later work. Every current writer rewrites the whole record with the
other fields preserved, conditioned on the exact value it read, so a claim lands
beside a terminal record (an operator retrying a reference whose recorded refund
failed) without clobbering it.

The hardened confirmation slice adds one `refund_confirmations` table and one
nullable structured-name column on `system_notes`. It carries an opaque purpose
and replay key, not provider references or buyer details. Existing unnamed notes
remain valid; new refund warnings and confirmations are selected by indexed
facts rather than decrypted prose.

The rest of this subsection preserves the approved later-layer design. Its
callback scope, committed summaries, fingerprints, `evidence_index`, complete
checkout sweeps, and post-terminal evidence merge are NOT Part A behavior.
Present-tense descriptions of the already-built attendee-set claim, anchors,
refresh path, and merge/delete admission remain subordinate to the exact modules
in "As built" above.

An evidence-advancing write against a row under a live FRESH claim does not land
at all — it answers retryably per law 1's writer exclusivity — because a
condition checked in the database cannot govern the HTTP call that follows it:
only exclusion keeps a judged verdict valid through the provider call.
Throughout this contract, PLAN.md's atomicity law is the standing default: facts
that must agree — a marker and its mirror, a summary and its fingerprint, a
buyer record and its staged state, a retirement and its completion — change in
ONE statement, batch, or interactive transaction, and the only fences that exist
(the claim's staleness rule, the judged- fingerprint condition on money writes)
each span a gap atomicity cannot close: a provider call or a concurrent request
in the middle. Before ANY provider refund call, the admin single route and each
bulk wave first claim the complete loaded row set, validate and bind provider
facts while that claim is `checking`, and then atomically advance the exact
command and requested reference representations from `ready` to `send_armed`.
The send path accepts only the permit produced by that last compare-and-set. The
future callback arm must enter this same state machine under `callback` scope;
Part A does not yet claim callback refunds. The attendee command scope is the
sorted initiating-id set for each matching reference group, distinct from every
representation's physical `attendee_id`, and all representations carry the same
command scope. The claim is per ATTENDEE REQUEST and all-or-none: a route
refunding an attendee claims the attendee's complete reference set in one
interactive transaction — every row claimed or the transaction rolls back whole
— so two concurrent requests can never split a merged attendee's references
between them, each winning some rows and moving only part of the money;
admission (the subrequest pre-flight) runs BEFORE the claim, since it is pure
arithmetic with no writes, so a refused request never leaves claims behind, and
a request that dies after claiming recovers via the stale rule. The claim
transaction RE-RUNS that arithmetic against the exact rows it reads (pure, zero
calls, inside the transaction — law 8): if the set differs from the pre-flight's
snapshot (a balance settlement landed between count and claim, before writer
exclusivity could apply), the in-transaction decision is the binding one —
refuse whole if the current set exceeds the budget, else claim the current set —
so the claimed set and the admitted set are the same set by construction
(regression: a reference landing between pre-flight and claim is either claimed
within the re-checked budget or the whole run refuses; never a partial-attendee
refund, never an over-budget run). The run's ORDER is fixed and total:
admission, then the claim transaction over the stored reference set (known from
our rows alone — no provider call decides membership), then every provider read
— discovery and the order/checkout sweeps run UNDER the claim, so the identity
and evidence a run acts on cannot be re-resolved by a concurrent run mid-flight
— then the whole-set judgment, and only then any refund call; a park-shaped
verdict releases the claim with the recorded answer and zero refund calls. A
capture a sweep reveals beyond the stored references is DETECTION-ONLY: it has
no row, no route ever refunds it (multi-charge is owner review), and its
detection and marker land under the claim on rows the run holds — nothing a
sweep discovers is claimable or dispatchable by a concurrent run. The verdict a
run acts on is FENCED to the evidence it judged: the claim records the
fingerprint the judgment ran against, and both the provider call and the
finalize are conditioned — the same compare-and-set shape — on the row's
`evidence_index` still equal to it. Under law 1's writer exclusivity no fresh
claim can lose that condition mid-flight, so the fence is the BACKSTOP for the
stale-claim world — a worker that stalled past the staleness bound while a
resume re-claimed and advanced the row: the zombie's finalize fails its
condition and re-judges from the merged summary before any completion, and where
the zombie's refund call escaped before it stalled, the re-judge PARKS — the
whole-attendee completion is refused, the returned leg's refund evidence and any
sibling capture are recorded together, and the owner review names the partial
state (one leg returned, one still captured) instead of a reversal the evidence
no longer supports (regressions: a finalize whose fingerprint moved re-judges
and never posts the stale completion; a stale-claim resume whose fresh read
reveals a sibling parks its completion with the escaped refund recorded). The
lost-answer recovery read obeys law 6 like every money-authorizing read: it
re-fetches the provider's COMPLETE declared observation — Square's payment plus
order sweep, SumUp's transaction plus checkout sweep where named — never the
named payment alone, so a sibling that became visible during the lost-answer
window parks the completion instead of letting the named cumulative answer
`fully_refunded` (regression: a lost-answer recovery whose re-read reveals a new
captured sibling refuses the ledger completion and records the detection). The
loser answers "a refund for this payment is already in progress" without
touching the provider; a stale claim (older than the edge request lifetime
bound) is a crashed worker and may be re-claimed — but only SCOPE-PRESERVING: a
stale `callback` claim resumes on the callback path per the staged lifecycle,
while a stale `attendee_set` claim is re-claimable only by an admin run that
claims the attendee's complete current reference set again, all-or-none,
re-judging the whole set before any money moves. A callback never consumes a
claim it did not write: the staged-first routing in the callback handler keys on
`callback` scope alone, so a session carrying a fresh or stale `attendee_set`
claim replays its finalized answer and runs replay detection without touching
the claim or the provider — the callback holds one session's context and can
neither decrypt nor judge a merged attendee's other references (payment
references are owner-key-encrypted; a webhook writes them, never reads them
back), so letting it resume an attendee-set claim would refund one reference
outside the whole-set judgment the claim exists to enforce (regression: an admin
claim of a merged attendee's two references dies before the provider call; a
redelivered callback for one reference replays the booked answer and moves no
money; a later admin retry re-claims the complete set and finishes the refund).
Regression: two concurrent single-attendee refunds of one merged attendee — one
claims every reference and refunds, the other claims nothing and answers
in-progress. A PII-only legacy reference has no refund capability until its
attendee is re-saved. That save writes one deterministic anchor per
`(attendee, reference index)`; the claim transaction checks the attendee PII
revision and exact indexed-row snapshot before holding it, but never mints
storage from an in-memory fallback. Current indexed rows retain the
shared-reference expansion and readiness park before provider I/O. Refresh uses
the same indexed claim path, so a materialized legacy partial-refund finding is
durable too. This claim is what makes the SumUp cells real: with no idempotency
parameter, two truly simultaneous refund calls are serialized only by the
provider, and SumUp documents 409 as a state conflict, not a concurrency
guarantee — so the local claim is the serialization, for every provider one
mechanism (regression: two concurrent admin refunds of one SumUp reference make
exactly one provider call; the loser answers in-progress). The claim also binds
the operator writes that move rows between attendees (law 1's writer half):
today `applyAttendeeMerge` moves every source reference row and its ledger legs
unconditionally (`src/shared/merge/attendee-merge.ts` —
`UPDATE processed_payments SET attendee_id …`) and the attendee delete removes
the rows outright (`src/shared/db/attendees/delete.ts`), so either could
relocate or destroy a claimed row mid-refund — provider money moving while the
finalize's account is merged away or deleted, or a moved `refund_cash` leg
making a target's unrefunded charge read as returned. Per law 1 both admissions
read every affected reference row's record inside the same interactive
transaction that would move or remove it and fail closed on any live claim or
staged marker, fresh or stale, with the plain answer ("A refund is still
settling for this person. Finish or re-run it, then try again."); a stale
claim's cure is re-running the refund — the scope-preserving re-claim finishes
and releases it — never merging around it. The delete admission additionally
refuses on a live owner-review marker per law 1's writer rule — the marker
guards a retained buyer the owner promised to contact, so the review resolves
first — while a merge carries markers across, gating the target whole.
Regressions: a merge submitted while a bulk refund's claim is live on one source
reference moves nothing and answers the settling reason, and the refund's
finalize lands intact; an attendee delete against a staged callback row is
refused the same way; a merge after the claim releases succeeds and carries the
rows' markers and terminal outcomes unchanged. Release follows law 3 and names
the exact command id, lease, and phase, so an old worker cannot settle a resumed
command. Pre-arm `checking` and `ready` work can restart safely after staleness.
An unanswered live call retains its `send_armed` command. After staleness, armed
keyed work may repeat its deterministic request; armed keyless work may only
observe, then either settles from returned/in-flight evidence or becomes exact
owner-review work when fresh evidence shows no return. The table's "one payout"
answers rest on that claim for EVERY available indexed reference. PII-only
legacy payments are unavailable until attendee re-save materializes their
indexed anchor; claims never synthesize a row. SumUp's cells hold on the claim
itself, with the provider's second-refund rejection and the fresh pre-attempt
evidence read as the backstop a stale-reclaim resume still gets; Stripe/Square's
hold on the idempotency key within its retention window and on the fresh-read
guard past it, whose stale-cumulative residual is the M7 boundary named under
Retry and replay.

## Owner choices

Genuine conflicts the system must not decide:

- **`multiple_charges`** (a second captured charge on one payment): the record
  (activity log) names the payment reference, every provider resource id, and
  the per-tender amounts; the alert is the existing best-effort ntfy ping, which
  by its privacy contract carries only an error code (`sendNtfyError(code)` — no
  ids, no amounts), so a conflict-specific code points the owner at the activity
  log rather than carrying the evidence itself. The record PRESENTS the observed
  tenders; it never prescribes a refund. By the binding evaluation order this
  kind fires only when the captured sum EQUALS the signed total (a larger sum
  wins `capture_total_mismatch`, a smaller one `partial_charge`), so the usual
  reading is a valid split payment where NO money is owed back — instructing the
  owner to "refund the extra charge" would return £50 of a correctly-paid £100
  booking and leave it underpaid while the ledger still says paid in full.
  Whether anything needs returning is the owner's judgment from the presented
  tenders, made in the provider dashboard (the in-app path cannot act on sibling
  charges it has no record slot for until M6). Several in-app doors are closed
  to keep that true. The proceed-and-alert finalize stores the owner-review
  conflict in the session row's `failure_data` slot (a discriminated
  owner-review kind beside the existing failure kinds — the row stays a booked
  success, `attendee_id` set), and every legacy money action on such a session
  fails closed until M6's per-charge reconciliation: the single and bulk admin
  refund actions check per ATTENDEE, before any provider call — if ANY of the
  attendee's references carries the marker the whole attendee is rejected up
  front, because `refundCandidateAtProvider` runs a merged attendee's references
  concurrently and a per-reference refusal would land only after a sibling
  reference's money had already moved, leaving `recordAttendeeRefund` skipped
  and the states inconsistent. The same attendee-whole rule governs FRESH
  verdicts, not just markers an earlier request recorded: the run reads and
  judges the COMPLETE reference set first — evidence reads only, no provider
  refunds — and only when every reference judges refundable does it issue any
  refund call; a park-shaped fresh verdict (`partial_refund`, `refund_pending`,
  an owner-review kind) on ANY reference refuses the whole attendee with zero
  refund calls (regression: a merged attendee with one clean reference and one
  part-refunded reference is refused whole — the clean sibling's money does not
  move); the refresh-payment route likewise refuses the `fully_refunded` →
  completed ledger write for a marked session — the named tender's dashboard
  refund does not mean the BOOKING's money came back, and
  `recordConfirmedRefund` would reverse the whole ledger order while a sibling
  tender stays captured — recording the observed provider fact in the activity
  log instead; and the Refund action is not RENDERED for a gated attendee
  (`canRefundAttendee` in `attendee-page-data.ts:74-80` and the bulk-action
  candidate set gain THE CONDITION THE HANDLER ENFORCES — the committed
  summary's own re-judgment, the same one judge the refund preflight fronts — so
  ANY park-shaped summary judgment keeps the action unrendered, marker or no
  marker: more than one captured charge (until M6), an unresolved
  `partial_refund`, a recorded contradiction. Summary content survives marker
  retirement, so review never re-renders an action the preflight would refuse
  with zero calls — the house rule that a link the target refuses must not be
  shown), the attendee page showing the owner-review indicator with the
  dashboard pointer in its place while the marker lives, and a plain
  blocked-refund note naming the reason (second charge, partial refund at the
  provider) with the same dashboard pointer after review retires it. A payment
  with NO committed summary — a pre-M4 row never yet swept, or one whose summary
  left with normal retention after review — has nothing to gate on and renders
  the action exactly as today: the handler's preflight is the guard, its
  refusing run WRITES the summary and marker (re-protecting the row), so the
  gate self-heals from the first attempt and the dead click is bounded to one,
  on rows that behave identically today (regressions: a reviewed single-charge
  payment whose provider still reports a partial refund renders the note and no
  action; a pre-M4 multi-tender row's first refund attempt refuses, writes the
  summary and marker, and the next page load renders the note; a reviewed
  two-capture attendee renders the note, never the Refund action). Without these
  guards the admin route could refund the webhook-named tender while
  `recordAttendeeRefund` reverses the booking's FULL ledger amount — a £50
  provider payout the ledger books as a £100 return, with £50 still captured at
  Square. The guard reads in PR A's refund cutover and is written by PR B's
  callback finalize (vacuously true between them); and because the admin
  preflight and the refresh route judge the DECLARED Square observation (law 6 —
  the payment plus its order's captured-tender sweep), a multi-tender booking
  that predates the judge, or one booked clean before Square's tender list
  caught up with no redelivery since, is caught by the fresh sweep at the first
  attempt to move its money — marker or no marker (regression: an admin refund
  against a Square booking whose order carries a second captured tender, booked
  clean with no redelivery and no marker, is refused whole with zero refund
  calls and the detection recorded). M6's backfill remains for surfacing
  (aggregates, display), not for the money gate. The marker also outlives
  payment pruning: today's prune deletes ANY aged row with non-empty
  `failure_data` (`prune.ts:50-77`, retention configurable as low as days),
  which would silently drop the guard while the attendee and refundable
  reference live on. A pruned indexed row no longer falls back to PII, but the
  protection must still survive for every row that remains. Non-empty
  `failure_data` cannot be the protection predicate either, in the other
  direction: committed evidence and terminal outcome data ride the same slot, so
  once every terminal write stores its summary, "non-empty means protected"
  would exempt every ordinary row from the configured retention forever —
  provider references and money evidence retained indefinitely with no live work
  on the row. Law 1's plaintext mirror is the answer for both directions: PR A
  adds the `protected_state` column (law 5: PR A writes the FIRST claims, and a
  claim landing on a row already older than the payment retention — an old
  booking or legacy anchor being refunded — would otherwise make that row
  deletable the moment the claim lands, letting a concurrent request mint a
  fresh row, claim it, and reach a second keyless provider call while the first
  still runs), every writer sets it in the same statement as the record it
  mirrors (claim/staged/marker, cleared again by the release that removes the
  state), and the prune's payment statement becomes: a row with an empty
  `protected_state` takes today's arms byte-identical — aged failure rows,
  reference-empty, attendee-gone, and refund-history prune exactly as they do
  now, whether or not the slot holds evidence — while a row with a live
  protected state prunes ONLY via the attendee-gone arm, living exactly as long
  as its attendee (a marked booked row whose attendee carries an earlier refund
  transfer survives pruning; a claim written onto a row older than the retention
  survives a concurrent prune run; an evidence-only booked row past the
  retention with refund history prunes exactly as today; a released claim's row
  resumes its normal schedule; a SumUp in-doubt claim's failed row survives
  retention while the claim stands). "Attendee-gone" itself is routed the same
  way (law 1 — routing is total over writers, scheduled cleanup included): the
  ORPHAN-ATTENDEE purge is a deleting writer, and its selection EXCLUDES any
  attendee one of whose payment rows carries a non-empty `protected_state` — the
  mirror is SQL-visible for exactly this consumer class — so a parked quantity-0
  placeholder whose listing was later deleted does not become purge-fodder that
  silently destroys the marker, the staged state, and the retained buyer an
  explicit admin delete would have been refused over. BOTH orphan selectors take
  the exclusion, the scheduled one and the manual owner privacy purge alike
  (`purgeOrphanedAttendees`'s own candidate query in
  `src/shared/db/orphan-attendees.ts:31-37`, reached from
  `POST /admin/privacy/orphans`, deletes attendees and their payment rows
  without passing the admin delete's admission — the same
  `protected_state IS NULL OR ''` predicate lands in that query) (regressions:
  deleting a parked placeholder's listing leaves the placeholder standing
  through the next orphan purge while its marker stands; retiring the marker
  lets the following purge remove it normally; a marked orphan never appears in
  the manual privacy purge's candidate set either). Regressions: an admin single
  refund against a proceed-and-alert multi-tender booking is refused with the
  owner-review reason and makes zero provider calls; a merged attendee holding
  one marked and one normal reference is rejected whole, before either
  reference's provider call; a refresh-payment run against a marked session
  whose named tender was dashboard-refunded records the observation and leaves
  the ledger untouched; the attendee page for a gated attendee renders the
  owner-review indicator and no Refund action. Automatic work is not stopped:
  the booking stands on the signed total. This is PLAN.md's approved M4 text
  applied ("one handler maps these outcomes onto today's behavior: detect,
  record, and alert … no automatic work is stopped or stranded before an owner
  can act") — failing the callback closed instead would 503 until provider
  redelivery exhausts, leaving taken money with no booking, no buyer answer, and
  no case tooling until M5, which is precisely the stranding the plan forbids.
  No money moves automatically either way; the tenders sit untouched for the
  owner. Decision 1 records the owner's explicit choice of this remedy.
- **`capture_total_mismatch`**: same detect-record-alert handling — the buyer
  over-paid, so their claim to the booking is valid and the surplus is named for
  the owner; the evidence names expected vs observed amounts. Resolution today
  is the provider dashboard plus existing admin tools; case pages arrive in M5.
- **`partial_refund` on the booking path**: PARKS, exactly as decision 5's park
  (buyer retained via placeholder or balance note, no ticket, no refund call,
  terminal outcome, alert). The provider retains LESS than the signed total, and
  an alert cannot choose among the intents that could explain it — a dashboard
  discount, a cancellation underway, a correction — so booking automatically
  would hide a real decision behind a guess; the operator's required choice
  decides. On the refund and refresh paths it stays detect-record-alert (the
  booking already exists there). Regression: a callback whose charge was
  externally part-refunded before delivery parks — no ticket, both amounts
  recorded.
- **A multi-charge observation that also fails validation** (decision 5): parks
  to owner review instead of any automatic refund — no booking, no provider
  calls, the record names the winning conflict kind and every charge, and the
  buyer sees the manual-check copy. Single-charge observations keep the
  automatic refund remedy unchanged.

No money-moving automation is added for any owner-review kind.

## Security and privacy

- One new owner action, exposed through its confirmation GET and verified POST,
  adds no role. Managers see no link and both manager requests receive 403. The
  form carries only an HMAC identity for the sorted exact
  `[sessionId, caseId, reason]` set, not the review facts themselves. The POST
  re-reads that set in its transaction and fails closed when a case was
  replaced, added, or removed; any claim makes the aggregate state `moving` and
  blocks both GET and POST. A successful command stamps `acknowledgedAt` on the
  exact unacknowledged cases and logs once without removing a case, changing its
  reason, clearing its mirror, allocating shared money, deciding an obligation,
  or enabling a refund. Replays are no-ops and two concurrent copies produce one
  acknowledgement and one activity entry. Evidence-specific refresh and
  indexed-uniqueness rules alone retire review work. The encrypted activity log
  carries conflict kinds, resource ids, and amounts; the ntfy alert carries the
  fixed error code only, per the commands table's alert boundary. Neither
  carries buyer PII or raw provider payloads (M3's fixed-refusal discipline is
  unchanged).
- The judge runs on evidence already fetched by the current path; the only new
  provider data crossing a boundary is Stripe's documented `amount_refunded` and
  refund `status` fields (decision 2) Square's documented tender `amount_money`
  and capture-status fields, and SumUp's documented transaction `amount` and
  `transaction_events[]` refund events — money figures and money states, none
  personal.
- The owner-key boundary on stored payment references is preserved: the
  env-key-encrypted `failure_data` record never holds a raw provider resource or
  parent id — the committed summary stores one-way leg codes and money numbers
  (Retry and replay), and the raw ids live only where they always have, in the
  owner-key-encrypted `payment_reference` and activity log. The plaintext
  `protected_state` mirror carries a state word alone — never an id, an amount,
  or a key.
- Untrusted inputs cannot reach the judge without passing M3's ownership
  boundary first. Forged SumUp callbacks with unknown, oversized, empty, or
  missing ids still cost zero provider calls; a forger replaying a REAL staged
  checkout id costs exactly one bounded read — that read IS the authenticity
  check, by M3's design — answered with the fixed refusal on any mismatch. The
  bound is per request — an amplification factor of at most one — with exactly
  one stated exception: the deliveries that genuinely process the session. Once
  a terminal record exists, every later replay of that checkout id, forged or
  not, costs the one authenticity read — plus the capped sibling reads whenever
  the sweep shows evidence beyond the committed summary OR the committed
  observation is itself MULTI-LEG: a sweep proves a NEW resource, but only the
  per-leg reads can prove a changed settled fact on an existing sibling (an
  external partial refund advances no sweep field), and the post-terminal rule
  requires recording exactly those changes. Neither trigger is
  forger-manufacturable — the sweep is the provider's own answer and the
  committed leg count is our own record. A single-leg unchanged delivery still
  costs exactly the one read, a multi-leg replay costs the one read plus its
  capped leg reads, and the reservation lock serializes the work while the
  terminal record plus acknowledgement end it (regressions: replaying an
  unchanged single-leg terminal delivery costs one read; a terminal replay whose
  checkout genuinely gained a child buys at most the capped sibling reads once,
  records the detection, and later replays cost one read again; a terminal
  replay of a multi-leg payment whose sibling was externally part-refunded
  records the advanced refund, never answers unchanged). The honest bound BEFORE
  the terminal record differs in one case: while a refund answer stays
  provider-PENDING there is deliberately no terminal record (F3's core rule —
  pending is neither failed nor complete). Each redelivery in that window costs
  the authenticity read, then the staged AGE GATE decides — the same fresh/stale
  rule as the staged lifecycle, one mechanism: against a FRESH staged claim the
  delivery answers retryably with ZERO further provider calls (the original
  worker or the provider is still settling); only against a STALE claim does the
  resume re-do the evidence read and one refund re-attempt under the SAME stored
  idempotency key (one payout regardless). That window is real, provider-ended
  (it closes when the refund settles, typically one redelivery cycle), and its
  per-delivery cost is a fixed ceiling — stated and budgeted rather than claimed
  away; a forger replaying a real staged checkout id during it buys bounded
  idempotent work, never a second payout. Regressions (PR B): a replayed
  callback for a terminally processed session costs exactly one provider read
  and zero refund calls; a replay against a FRESH staged row makes zero provider
  calls beyond authenticity; a replay against a STALE staged row re-attempts
  under the same idempotency key and never moves a second payout. Bounding
  request volume itself is the platform's rate limiting, unchanged — M4 adds no
  new unauthenticated read surface.

## What is deleted (F51)

In the same merges that wire `outcomeOf` in:

- `classifySession` / `classifySessionIntent`'s verdict arithmetic and the
  `SessionClass` type (`classify.ts:97-132`) — the callback-side judge.
- `tryRefund`'s ad-hoc attempt/fallback ordering and
  `refundReferenceAtProvider`'s duplicate of it — both become observe → judge →
  act. The fallback's one real protection — confirming a refund whose response
  was lost in transit — survives as the failure table's narrow
  indeterminate-answer re-read, run only when no provider verdict arrived
  instead of after every false.
- The refresh-payment route's `refunded ? "completed" : "none"` boolean mapping
  (`attendees-edit.ts:98-102`) — a third judge. Its provider poll becomes the
  provider's DECLARED money-decision observation (law 6 — for Square the payment
  plus its order's captured-tender sweep; the charge tier for Stripe; for SumUp
  the transaction read plus its checkout's child sweep where the row names its
  checkout), judged by `outcomeOf`: `fully_refunded` → completed as today —
  EXCEPT on a session carrying an extra-captured-money marker kind, or whose
  fresh sweep itself reveals a captured sibling, where the ledger write is
  refused and the observation recorded instead (the named tender's refund is not
  the booking's; see the `multiple_charges` owner choice; regression: a refresh
  whose named tender is fully refunded but whose order sweep shows a captured
  sibling refuses the completion write with the detection recorded, even when no
  marker existed before the run); `refund_pending` → stays unrefunded with the
  pending answer surfaced; `partial_refund` → a PERSISTED owner-review record
  (the marker with its kind), never a silent "none" or a bare activity entry:
  the marker durably hides the attendee's Refund action from that moment — a
  rendered action whose handler could only re-read the same partial state and
  refuse would be a dead link — while the refresh action itself remains
  available to observe later settlement. A refund send and a refresh
  deliberately have different admission under the same exact claim: single and
  bulk refunding refuse any unresolved review or unrecorded row before provider
  preparation, while refresh may enter those states only to reconcile them.

  Each of Part A's six review reasons has one evidence-owned retirement rule.
  `shared_reference` retires only when the indexed representation becomes
  unique. `multiple_pending_refunds` and `refund_exceeds_capture` retire on the
  exact observed rows only after a complete provider read no longer reports an
  issue. Clean provider evidence cannot retire `partial_refund`,
  `partially_returned_obligation`, or `uncertain_keyless_refund`; those retire
  only when every exact reference is returned and the ledger records every one.
  The retirement travels in the same claim settlement as the evidence, and the
  plaintext mirror follows whatever work remains. A different current provider
  or ledger issue wins over retirement, and the compare-and-set settlement
  removes a case only if its current reason is the reason the run disproved.

  Part A's owner command is acknowledgement, not retirement. Its HMAC identity
  binds the sorted exact `[sessionId, caseId, reason]` set the owner saw. The
  transaction stamps only `acknowledgedAt`, preserves every case and safety
  hold, and logs once; stale forms fail closed and concurrent replay produces
  one acknowledgement plus one activity entry. Any claim blocks the action,
  regardless of age, phase, or capability, and managers cannot GET or POST it.
  Acknowledgement therefore restores no refund, delete, or retention permission
  and creates no allocation or obligation decision.

  Validation and extra-capture marker kinds belong to the later whole-reading
  slices and remain governed by their planned evidence-rejudgment and M6
  reconciliation rules; Part A does not declare or store them.
- No alias, wrapper, or re-export bridges the old names.

`validatedPaymentSession` (M3 boundary), `refund-state.ts` (a record-derived
display fact, not a judge), and the ledger stay.

## Original vertical PR design (superseded where "As built" differs)

This section preserves the approved sequencing and later-layer rationale. Its PR
names, size estimates, module lists, provider call arithmetic, and proposed
whole-checkout sweeps predate the implementation and are not a second source of
truth for Part A. In particular, Part A did not build the Square tender or SumUp
child sweeps, `SIBLING_READ_CAP`, callback claims, or callback transition
repository described below. The "As built" map records what landed; the later
boundaries remain useful plans until their code exists.

The approved current-path stack has six standalone layers: exhaustive provider
outcomes; legacy-reference readiness; canonical planning and whole-run budgets;
exact claims and provider permits across admin, callback, and refresh; one
transition repository finishing the callback lifecycle; and owner-visible
payment cases. The aggregate stack then makes attendee merge atomic, cuts over
stable obligations and exact allocations, and replaces refunds with the durable
allocation-driven engine. PLAN.md's 400–700 src figure is the milestone target;
the hard rule is delivery rule 3's 800 changed src lines PER PR. The review
rounds added real closures (owner-review carry-through, the ledger-swallow fix,
the SumUp amount widening, the terminal-replay sweep, the six-law state machine
with provider discovery, the admin-side tender sweep, and the merge/delete
admissions), and decision 5 removed the multi-charge refund machinery a middle
revision had grown. The estimates are PR A ≈ 400–550 and PR B ≈ 250–350 — a
650–900 total that can run past the milestone target's top while each PR stays
well under its own cap; the overage buys review-found correctness, not scope
creep.

**PR A — "No refund attempt can exceed the captured money" (≈ 400–550 src)**

- Ports the pure closure: `outcomeOf`, conflict kinds, refund legs and
  arithmetic, `resolveRefund`, `kindObject`, the words subsets.
- Builds the per-provider refund-evidence adapters (Square: cumulative + PENDING
  answer, plus the widened order-tender pick — each tender's documented
  `amount_money` and capture state — so the admin and refresh evidence read
  judges the payment PLUS its order's captured-tender sweep per law 6, the same
  pick PR B's callback detection reuses; Stripe widened to the charge's
  documented `amount`, `currency`, AND `amount_refunded` — the full decision-2
  pick, because an admin or legacy Stripe reference carries no signed expected
  total, so without the first two the overlap guard has no captured-money
  denominator and no currency check (the evidence-tiers section states this; the
  slice must not narrow it) — plus refund `status`, mapped totally — `succeeded`
  → completed; `pending` and `requires_action` → `refund_pending` (in flight:
  re-attempts land on the same idempotency key, and the operator's answer names
  the status); `failed` and `canceled` → `failed_refund` (settled as
  not-happening; a fresh operator attempt is legitimate — noting, unchanged from
  today's use of the same deterministic key, that a re-attempt inside Stripe's
  ~24-hour idempotency window replays the original failed answer, and a
  genuinely new attempt exists once the window lapses; per-attempt identity is
  M7's `pending_refund_idempotency_key`); and a `null` status — a shape the
  production schema accepts (`StripeRefundSchema`, `schemas.ts:64-72`) — is no
  verdict at all, so it takes the failure table's lost-answer arm: the one
  bounded evidence re-read decides, nothing is recorded from the null itself —
  instead of today's collapse of everything non-succeeded to failure; SumUp
  widened to the documented `amount` plus `transaction_events[]`, and — where
  the row names its checkout — the checkout's vouched-children sweep per law 6,
  reusing the children pick the callback path already validates) and fronts
  `tryRefund`, `refundReferenceAtProvider`, and the admin refresh-payment
  route's provider poll with the judge.
- Lands the shared owner-review recorder — the activity-log write and the
  code-only alert helper — because PR A's own judge already makes an
  owner-review outcome reachable (`partial_refund` on the refresh-payment route)
  and each slice must carry the remedies for the outcomes it makes reachable. PR
  B reuses this recorder for the callback-side owner-review arms.
- Refactors Square's refund call to act on the already-observed payment: today
  `squareApi.refundPayment` re-reads the payment internally for its amounts
  (`square.ts:664`), so without the refactor a judged attempt would cost three
  provider calls. The judge's read becomes THE read; the refund call takes the
  observed amounts, which also removes the read-then-refund gap inside the
  provider call.
- Deletes the displaced attempt/fallback ordering in both.
- Resolves each reference's provider per law 4: `refundCandidateAtProvider`
  dispatches per REFERENCE — the stored provider tag when the row carries one,
  else the discovery the trusted-facts rule defines (the evidence read runs
  against each credentialed provider, ordered by the deployed existing-payments
  resolution first; exactly one validating read is the proof, recorded as the
  row's tag by the terminal write; no validating provider ⇒ the honest
  unresolved failure, no refund dispatched anywhere). The provider tag rides
  inside the owner-key-encrypted reference value (no new column), new callback
  writes tag at write time, and an admin-minted anchor row is tagged by the
  terminal write that records a provider-validated outcome.
- Adds the `protected_state` mirror and its prune gate (the Owner-choices
  analysis; laws 1 and 5): every writer of a claim, staged refund, or marker
  sets the plaintext column in the same statement, releases clear it, and the
  payment prune keeps today's arms byte-identical for rows whose mirror is empty
  — evidence and terminal outcome data never exempt a row from its retention —
  while a row with a live protected state prunes only through the attendee-gone
  arm.
- Guards the row-moving writers (laws 1 and 5, shipped with the first claims):
  the attendee merge and attendee delete admissions read every affected
  reference row's `failure_data` inside their own interactive transaction and
  fail closed on any live claim or staged marker with the settling answer, fresh
  or stale — and the delete admission's owner-review-marker refusal ships HERE
  too, not with PR B, because PR A's refresh path is the first marker writer
  (law 4: a state and all its consumers ship in one slice; regression: after PR
  A alone, deleting an attendee whose refresh detected `partial_refund` is
  refused naming the review).
- Completes: F3 (classification half). Regression tests: the pinned arithmetic
  rows; a Square PENDING answer followed by a redelivery produces exactly one
  provider refund (the re-attempt reuses the same idempotency key and lands on
  the same refund — asserted by key equality, one payout); pending + completed
  exceeding captured is refused; completed counts immediately while cumulative
  lags; two concurrent SumUp refund attempts make exactly ONE provider call —
  the loser of the all-or-none CAS claim answers in-progress without touching
  the provider (the claim transaction ships in THIS slice, before any provider
  call on every refund route, per the concurrency section); a lost-answer SumUp
  refund leaves its claim standing — an immediate second run answers the
  settling copy with zero provider calls, a stale claim re-claims behind the
  fresh evidence read, and a covering read resolves it with no call (law 3); a
  claim written onto a row older than the payment retention survives a
  concurrent prune run, while an evidence-only booked row past the retention
  with refund history prunes exactly as today (the `protected_state` gate ships
  in this slice, law 5); a merged attendee carrying references from two
  providers judges and refunds each at its own provider — an untagged pre-switch
  reference discovered by the validated read and tagged on its terminal write —
  while a tagged reference whose provider has no stored credentials fails its
  row naming that provider with zero provider calls, and an untagged reference
  no credentialed provider validates fails unresolved, dispatching no refund
  (law 4); a legacy reference captured under a previous site currency refunds
  cleanly after the currency switch — its judgment never reads
  `settings.currency` (law 4); an admin refund against a Square booking whose
  order carries a second captured tender — no marker, no redelivery — is refused
  whole with zero refund calls (law 6); a merge submitted while a refund claim
  is live on a source reference moves nothing and answers the settling reason,
  an attendee delete against a staged row is refused the same way, and a merge
  after release carries markers and terminal outcomes unchanged (law 1); a
  Stripe refund answering a `null` status records nothing until the bounded
  evidence re-read answers; a SumUp transaction whose successful refund events
  sum above zero and below `amount` reads as `partial_refund`, never
  `fully_refunded` — an empty or absent event list stays `ready`, and events
  summing to `amount` read `fully_refunded` even while top-level status still
  says `SUCCESSFUL` (the sandbox-observed shape); a Stripe refund answering
  `pending` writes no completion, reports the pending answer (not failure), and
  a re-run lands on the same idempotency key; a refund whose transport answer is
  lost but which committed at the provider records completion after the
  reconcile read — one payout; a partially-refunded reference on the
  refresh-payment route records owner review instead of silently reading as
  unrefunded.
- Superseded budget sketch (not built): the arithmetic below records the
  original proposal only. It is not the implementation contract; the
  whole-command admission row in "As built" is authoritative. On the normal
  arms, the proposal counted 2 provider calls per admin Stripe reference and per
  checkout-less legacy SumUp reference (1 evidence read — its result IS the
  judgment input, never a separate call — plus at most 1 refund call) and 3 per
  Square or checkout-linked SumUp reference (the declared observation is two
  reads — the payment then its order's tender sweep, or the transaction then its
  checkout's child sweep, per law 6 — plus the refund call); when a sent
  refund's answer is lost, the recovery re-read is the COMPLETE declared
  observation again (law 6 — it authorizes a completion write), so the
  lost-answer arm adds 1 read for Stripe and checkout-less SumUp and 2 for
  Square and checkout-linked SumUp, and a multi-leg observation — Square sibling
  tenders, SumUp sibling children — adds one read per additional leg wherever it
  is judged, capped EVERYWHERE by `SIBLING_READ_CAP` (admission reserves the cap
  as each multi-leg-capable reference's worst case; beyond it the observation
  refuses or parks on the sweep alone). Discovery adds reads only for an
  UNTAGGED reference whose earlier candidate fails to validate: worst case one
  evidence read per credentialed provider (at most three exist), the validating
  read doubling as the judgment input. Per outcome: refusal and `fully_refunded`
  cost the evidence reads alone (1; 2 for Square and checkout-linked SumUp; 0
  when our own records already refuse); a normal attempt adds the refund call
  plus, on success, the post-success complete re-read — the same
  complete-observation price as the lost-answer arm (1 more read for Stripe and
  checkout-less SumUp, 2 for Square and checkout-linked SumUp), reserved in
  admission. A callback refund costs its refund call plus evidence: 0 extra
  reads for a Square rejection carrying valid money (the carried payment
  evidence judges; one whose money fields were the malformed part buys the one
  re-read, like the other arms), 1 read on the Stripe and SumUp rejection arms
  (the payment-intent / transaction read each buys). Today the same reference
  costs 1–2 (the refund, plus the fallback read on failure), so M4 moves the
  read up front, the lost-answer arm spends its extra read exactly where today's
  blind fallback also spent one, and Square's second normal-arm read buys the
  sibling-capture check no path makes today. This sketch proposed
  `BULK_REFUND_LIMIT` (5) **attendees**; that attendee cap was deleted before
  landing. The built listing-wide action admits and executes its complete
  refundable set or refuses it whole, while five limits provider-call
  concurrency only. In the old estimate, one attendee could carry several
  references (deposit plus balance; merges): R total references cost 2R (Stripe;
  checkout-less SumUp) to 3R (Square; checkout-linked SumUp) provider calls on
  the normal arms, plus 1 per reference whose sent refund's answer is lost (the
  reconciling re-read above) and the discovery reads of any untagged reference,
  typically R ≤ 10 for a full batch. Because the worst case must fit Bunny's
  50-subrequest allowance even if every answer is lost, PR A adds a batch
  pre-flight: before ANY provider call, the run counts its still-unrefunded
  references, and a batch whose recovery worst case cannot fit the request's
  REMAINING subrequest budget is refused whole — zero provider calls, every row
  failed with the plain reason "This run has too many payments to refund at
  once. Refund fewer attendees at a time." The admission counts provider calls
  at each adapter's PHYSICAL fetch worst case, not its logical call count:
  Stripe's transport makes up to three fetches per logical call
  (`STRIPE_MAX_NETWORK_RETRIES = 2` in `stripe/request.ts`, each attempt counted
  by the guard via `countExternalSubrequest`), so a Stripe batch's three logical
  calls per tagged reference admit as 9R; the Square and SumUp adapters make
  exactly one fetch per call today, so their factor is 1 (a tagged Square or
  checkout-linked SumUp reference admits as 5 plus 2 × `SIBLING_READ_CAP` — two
  evidence reads, the refund, the two-read post-success/lost-answer recovery,
  and the sibling worst case counted for BOTH complete observations, since the
  initial judgment and the post-success re-read each price up to the cap (a run
  admitted near Bunny's limit must never exhaust its allowance after the refund
  is sent but before its completion work); a checkout-less SumUp as 3) — each
  factor read from the adapter's own retry constant, so a future retry change
  moves the admission with it. An untagged reference admits with its discovery
  worst case on top: one evidence read per credentialed provider, each priced at
  that provider's own factor. The admission compares that physical provider
  worst case plus the batch's own database calls at the client's retry worst
  case — every post-provider write costed at the bounded maximum of four
  attempts (`TRANSIENT_ERROR_BACKOFF_MS` in `db/client.ts` allows three retries,
  and the round-trip guard counts each attempt separately), so a `SQLITE_BUSY`
  streak after money has moved cannot push the request over the limit — plus a
  failure reserve PROPORTIONAL to R, not a constant: the worst case is every
  admitted reference failing, and each failed reference spends its own error
  fan-out (`logError`'s ntfy and Sentry subrequests plus the per-row activity
  record, database writes at the retry multiplier), on top of one batch-level
  error report — R × the per-failure fan-out cost plus the batch constant, every
  term still static at admission — against the allowance MINUS the subrequests
  the request has already spent before the pre-flight (the db client's call
  counter is the source — the route's auth and attendee loads are not free). A
  batch can no longer abort mid-flight with some refunds committed and
  unrecorded; every term is known at pre-flight time, so the refusal is exact,
  not a guess. Regression: an oversized batch makes zero provider calls and
  fails every row with that reason. The same admission fronts EVERY route that
  attempts provider refunds in one request — not just the bulk route: the
  single-attendee refund (`POST /admin/attendees/:attendeeId/refund` calls
  `processRefundBatch` with an array of one in `attendee-refunds/single.ts`)
  runs the identical pre-flight over the one attendee's reference count, because
  a merged attendee can carry many references — six Stripe references admit as
  54 physical fetches on the lost-answer path, over the allowance on their own.
  Its refusal is the single-attendee shape of the same plain reason ("This
  attendee has too many payments to refund in one go. Refund them from the
  provider dashboard.") — refused whole before any provider call, never a
  partial pass through the references (regression: a merged attendee whose
  reference count cannot fit the remaining budget gets that error and zero
  provider calls). The paged engine that processes arbitrarily large batches is
  still F53 / M7 — this slice only refuses what one request cannot safely hold.
  Database calls: one NEW cost beside today's — the all-or-none claim
  transaction per refund run (claim before any provider call over rows already
  indexed for each attendee; finalize/release after), counted in the admission's
  own arithmetic; everything else unchanged.
- Standalone value: the live system stops repeat and over-refunds on the admin
  and attempt side. The callback rejection arm keeps today's behavior until PR B
  cuts it over with its reservation — PR A claims nothing about that arm.

**PR B — "One judge for callback money, and alerts for what it finds" (≈ 250–350
src)**

- Builds the callback-side observation (expected facts from the signed proof,
  charges from the session evidence per provider) and replaces
  `classifySession`'s verdicts with the judge's outcomes mapped by the
  exhaustive remedy `Record`; deletes `SessionClass` and the inline arithmetic.
- Cuts the callback rejection arm (`refundRejectedCharge`) over to the judge,
  behind the same reservation the booking path holds. Today the arm runs before
  `processPaymentSession` ever reaches `reserveSession` (`webhooks.ts:423-435`),
  so two concurrent deliveries of one rejected session are serialized by nothing
  — with no SumUp idempotency key, both can issue the refund. PR B widens
  `SessionRejection` to carry the session identity the webhook already resolved,
  and the rejection arm claims the `processed_payments` reservation under that
  SAME session id the valid booking path reserves — one key, so a redelivery
  whose provider read has since become valid collides with the rejection's
  terminal record and replays the stored rejected answer instead of booking a
  charge that was already refunded. The reservation is claimed BEFORE any
  provider call; the terminal rejected outcome is written once the refund
  settles; a concurrent duplicate answers the in-flight retry (503) or the
  stored terminal answer — never a second payout. This is what makes the
  security section's amplification exception and the concurrency table's first
  row true for rejections, not just bookings. The rejection handed to
  `refundRejectedCharge` keeps the observation's charge facts (per its tier): a
  Square rejection whose observation carries valid captured money is judged with
  zero extra reads; a refundable Square rejection whose money fields were the
  malformed part (a `COMPLETED` payment missing `amountMoney` or its currency)
  buys the same one payment re-read the other arms buy, and if the re-read still
  lacks the documented fields the refusal stays retryable with NO refund call —
  an unreadable amount is never invented, not even to return it. Stripe's
  session tier and SumUp's checkout tier carry no refund facts, so those arms
  each buy one read before the refund call (payment-intent for Stripe,
  transaction for SumUp) — one added provider call on those rare arms; the
  trusted booking path stays zero-read. Regressions: two concurrent deliveries
  of one rejected SumUp session make at most one provider refund call; a
  delivery after the terminal write makes zero; a rejected-then-valid redelivery
  lands on the rejection's reservation and books nothing; a Square rejection
  with unreadable money makes zero refund calls and stays retryable after the
  re-read.
- Wires the callback outcomes through the shared owner-review recorder landed in
  PR A (the activity-log write joins the processing transaction) and adds the
  callback-side Square multiple-tender detection using the widened order-tender
  pick PR A built (law 6): a tender counts as captured money only when its
  status says so (authorized/voided/failed tenders are named in evidence, never
  counted; money with an unreadable status refuses at the read boundary as a
  malformed read) — all from the order read the path already makes, no extra
  provider calls.
- Carries owner review through downstream booking failures (no automatic refund
  on a conflicted payment; terminal owner-review outcome; the new buyer copy
  above), and implements the staged placeholder lifecycle the failure table
  requires: the rejection arm claims the reservation, then ONE batch inserts the
  buyer record — new booking: the quantity-0 placeholder; balance: a binding to
  the existing attendee whose balance was being paid, never a placeholder — and
  writes its id plus the staged refund-in-flight marker, the batch's written-at
  time, and the session's payment reference onto the reservation row BEFORE the
  provider call, on every persist-then-refund path (`refundRejectedCharge` and
  `storeRefundedBooking`'s stored-refused failures alike). That gives the
  persist its replay identity: a redelivery against a FRESH staged row answers
  retryably — the original worker may still be in flight, and SumUp has no
  idempotency key to dedupe a race — while a STALE row resumes the refund;
  `blank_reference` stays retryable outside this lifecycle entirely (no resource
  to refund, never a stored rejection). The staged state is routed before the
  finalized-success branch — keyed on `callback` scope, so an admin
  `attendee_set` claim never routes here (per Concurrency) — and the terminal
  batch lands the outcome, fingerprint, and — on `posted: false` — the
  unposted-money fact in `failure_data`, atomic with the finalize, with the
  activity-log entry and attendee note layered on top as best-effort surfacing;
  durable automated re-posting is M7's. Regression tests: the
  sold-out-with-two-tenders case makes zero refund calls; a worker death between
  the staged batch and the provider call resumes at the refund step on
  redelivery with exactly one placeholder; a duplicate delivery racing a live
  staged worker makes zero provider calls; a balance-session rejection posts
  against the existing attendee and inserts no placeholder; a failed placeholder
  ledger write books exactly one placeholder across redeliveries, names the
  money durably in the terminal row, and leaves the miss visible in the activity
  log and the attendee's notes.
- Separates exact terminal replays from new money, and settles the remaining
  callback arms: the terminal-replay comparison sweeps every captured resource
  in the fresh observation against the stored reference, and any extra captured
  resource writes the owner-review record with the code-only alert before
  returning the recorded outcome (the acked answer stops redelivery, and
  `markSessionFailed` now stores the observed reference so failure rows compare
  too); a callback judged `fully_refunded` books nothing and takes the
  stored-refused arm with no refund call; a single-charge refuse remedy refunds
  as today; and a multi-charge refuse remedy parks to owner review (decision 5).
  Regression tests: a post-terminal callback carrying a second captured tender —
  under the original resource name or a new one — records the conflict, never
  re-books or refunds, and an identical redelivery writes nothing more (the
  `evidence_index` fingerprint comparison, exercised by redelivering after a
  lost acknowledgement), while a THIRD tender arriving after the two-tender
  record changes the fingerprint and records again; a lagging one-tender
  redelivery bearing newer refund progress on a two-tender record advances a
  merged summary still naming both tenders, and the caught-up two-tender
  redelivery after it replays silently (law 2); a second capture arriving after
  a terminal failure is detected the same way (the failure row now carries the
  fingerprint and reference); a delayed callback for an externally
  fully-refunded charge issues no paid booking and no refund call; a
  wrong-currency two-tender observation makes zero refund calls, books nothing,
  records both resource ids, and answers the manual-check copy.
- Budgets: zero additional provider or database calls beyond today's callback
  path on the trusted arm, plus the one activity-log statement inside the
  existing processing transaction; the refuse arm makes at most one provider
  refund call (single-charge observations; a multi-charge observation makes zero
  and parks to owner review), and the sibling fan-out is bounded by
  `SIBLING_READ_CAP` (beyond it the observation parks on the sweep alone), so
  the callback's provider-call ceiling is fixed — sweep + cap + at most one
  refund + that refund's post-success complete re-read — and can never be chased
  upward by a provider-controlled tender or child list; the new-evidence replay
  arm adds one durable write, no provider calls.
- Completes: F51. Regression tests: every conflict kind maps to exactly one
  remedy (exhaustiveness compile test + table-driven behavior tests); money on a
  free checkout refunds; two paid tenders alert without stopping the booking;
  verdict parity cases proving byte-identical buyer answers for today's
  trusted/mismatch flows.

Both PRs run targeted mutation on every changed payment module
(`deno task mutation --harness`) and the branch gate (`precommit:mutation`)
before merge, per delivery rule 4.

## Adversarial review

- _External refund succeeds, local write fails?_ The next judgment's fresh read
  sees the provider cumulative (Square/Stripe) or the summed refund events
  (SumUp) → `fully_refunded` → success without a second payout. Unchanged from
  today, now named.
- _Callback replayed?_ Terminal outcomes replay from `processed_payments`;
  pre-terminal replays re-judge fresh evidence; refunds land on idempotency keys
  (Stripe/Square) or provider full-refund rejection (SumUp).
- _Follow-up read fails after a signed success?_ No verdict is invented; the
  caller's existing unavailable handling answers (retryable/failed row).
- _Wrong amount, currency, parent, id?_ Each is a named conflict with one
  remedy; parents/ids keep M3's per-provider evidence checks.
- _Two requests race?_ See the concurrency table: the judge narrows what the
  existing lock + idempotency protections must carry; no new interleaving is
  introduced because the judge is pure and takes no locks.
- _Stale evidence between read and attempt?_ Provider-side idempotency or
  rejection converts the race to an idempotent landing; the next read converges.
  Fresh-evidence-per-attempt is the rule (no cached verdicts).
- _Same resource on another record?_ `duplicate_charge` within one payment's
  evidence refuses; duplicated refund resources need the per-refund identities
  only M7's records hold (see the conflict table's note); cross-payment
  duplicates are F8 (M6, needs the aggregate unique index) and out of scope —
  stated, not silently dropped.
- _One queued item fails permanently?_ Bulk rows record per-reference results; a
  refused reference cannot block the wave.
- _What does the buyer see?_ Byte-identical answers for the trusted flow and
  every existing mismatch/rejection flow — the judge changes which internal
  verdict fires, not those responses. The decided exceptions are new: the
  manual-check copy where a payment parks to owner review — an owner-review
  conflict whose booking later fails (decision 3), or a multi-charge observation
  failing validation (decision 5) — and the stored-refused answer (existing
  copy) where a callback judged `fully_refunded` would today have booked. Owner
  alerts are the only other new user-visible artifact, and PR B's parity tests
  cover exactly the unchanged flows.
- _SumUp double-refund without idempotency?_ A second full refund of a refunded
  transaction is provider-rejected (the generic 409, classified by the bounded
  evidence re-read rather than assumed), and the judge's fresh amount read
  answers `fully_refunded` first when the cumulative equals captured — a
  dashboard partial refund instead reads as `partial_refund` and parks for the
  owner. The unguarded window is a crash after a SumUp refund succeeded and
  before any later read — the next read converges, and law 3 keeps every re-run
  out of that window: the keyless claim stays standing and remains
  observation-only after staleness until evidence resolves it; our own refund
  calls are full-amount only.

## Owner decisions (answered 2026-08-09 through 2026-08-11)

1. **Owner-review remedy for `multiple_charges` — DECIDED: proceed-and-alert.**
   Booking proceeds on the signed total, with a durable activity-log record
   naming every charge and a best-effort code-only alert pointing at it (the
   ntfy ping carries an error code and nothing else); no automatic refund of the
   extra charge. This is PLAN.md's approved M4 text applied. The fail-closed
   alternative was offered and declined: 503s until provider redelivery exhausts
   would mean money taken, no booking, no buyer answer, and no case tooling
   until M5.
2. **Stripe `amount_refunded` widening — DECIDED: approved.** The read schema
   widens from `latest_charge.refunded` alone to also pick the documented
   `latest_charge.amount_refunded`, giving Stripe a real cumulative for the
   refund arithmetic.
3. **Copy approvals — DECIDED: both strings approved verbatim.** Blocked refund
   (admin failed-row reason): "A refund for this payment is still settling. Try
   again after it completes." Conflicted payment whose booking failed (buyer
   page): "We received your payment. Your booking needs a manual check. Do not
   pay again — we will contact you."
4. **M4 slicing — DECIDED: two original PRs.** PR A (refund-overlap guard)
   first, then PR B (callback cutover); each stands alone, hardest first. The
   later approved layers refine PR B's remaining work without changing PR A.
5. **Multi-charge refunds — DECIDED: owner review, never automatic
   (2026-08-10).** An observation carrying more than one captured charge never
   receives automatic refunds. When it also fails validation (wrong currency,
   wrong total — any refuse-shaped conflict), the session parks to owner review:
   no booking, no provider refund calls, a terminal outcome, the activity record
   naming every charge, the code-only alert, and the decision-3 manual-check
   copy for the buyer. Single-charge observations — structurally all of Stripe,
   and virtually all of Square and SumUp — keep today's automatic refund remedy
   unchanged. Reason: per-charge refund evidence, ledger legs, and retry state
   are M7's durable engine; inside one M4 callback they would mean invented
   facts (an unread tender's refund state), an unbounded provider fan-out
   against the edge subrequest budget, and a ledger shape with no slot for a
   partly-returned batch.
6. **Legacy shared-charge identity — DECIDED: exact allocation or reject.** A
   charge may fund one or more stable booking obligations. The owner records
   positive Money parts whose currency matches the charge and whose amounts sum
   exactly to the captured amount, fenced on the reviewed evidence revision, or
   rejects the automated action. No allocation is inferred.
7. **Cash return and obligation cancellation — DECIDED: separate effects.** A
   provider refund records only returned cash. Cancelling a booking reverses its
   sale, modifier, and fee facts once under the stable obligation identity.
   Neither operation implies the other.
8. **Partially returned obligation — DECIDED: required owner choice.** The owner
   keeps the booking with the returned amount due, returns all remaining cash
   then cancels, or cancels now while retained cash stays visible as refund work
   owed to the buyer. There is no default, and the choice is revision-fenced.
9. **Delivery — DECIDED: two stacks.** The six-layer current-path stack adds
   exhaustive outcomes, reference readiness, planning and budgets, exact claims
   and permits, one transition repository, and payment cases. The three-layer
   aggregate stack makes merge atomic, cuts over obligations and allocations,
   and replaces refunds with the durable allocation-driven engine. Each layer is
   independently green and merges bottom-up.
