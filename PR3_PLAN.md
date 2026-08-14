# PR 3: payment-provider evidence and the atomic checkout target

## Status

**Historical evidence appendix; not an implementation plan.** This document
preserves the provider research, threat model, and acceptance inventory that led
to the shipped payment work. `PLAN.md` is the only plan for work that still
remains. In particular, the whole-checkout boundary described below belongs to
its M6-M11 atomic cutover and must not be revived as a sequence of live
provider-specific slices.

Activation is all-or-nothing: migrate every caller, schema, durable identity,
and owner exit before the new checkout engine becomes live, then delete the old
runtime in the same cutover. There must be no compatibility wrapper, dual write,
runtime read-through, fallback, or legacy parallel observer/refund path.
Read-only preparation and tests may land before activation, but no intermediate
commit may select between two live engines.

That rule survives this historical plan. Any future replacement of M4's
canonical refund schema or engine must either extend it in place or fence
requests, migrate and verify every retained row, switch one epoch, and delete
the displaced path in the same release. Record age or old shape may cause a
typed refusal or migration-only decode; it may never select a live legacy
fallback.

### Implementation progress

The evidence has produced four shipped foundations:

- PR #2048 built the fixed-call paid-order snapshot and bounded processing core.
  A successful paid order uses four database calls without answers and five when
  answers must be replaced: one conditional claim, one snapshot, one atomic
  booking/finalization batch, the optional answer batch, and one combined
  activity batch. Email and webhook rendering add no database reads.
- PR #2050 made registration delivery direct-only and bounded: one POST per at
  most 16 distinct URLs, no redirect following, and one value-free failure
  record.
- PR #2060 added strict current SumUp callback observation and staging,
  including the evidence-backed checkout shapes below.
- M4 Part A added typed all-provider `ChargeMoney` reads and refund attempts,
  plus one canonical `payment_charges` authority for every real provider send.
  Its stored union distinguishes `needs_owner_choice`, whose evidence admits at
  least one required answer, from `needs_provider_check`, whose partial or
  inconclusive evidence admits only another observation. Fresh partial evidence
  replaces ordinary ambiguity and advances the revision rather than leaving a
  stale not-sent choice available. Owner sends and decisions are
  revision-fenced; observation-only checks cannot overwrite a concurrent
  revision. Its automatic placeholder atomically mints the indexed anchor and
  canonical `checking` row state with the attendee/bookings, then releases that
  fence only after provider, ledger, authority, activity, and note work
  finishes. Refund All's summary decrypts zero attendee PII and its command
  decrypts zero or one; a shared claim admits at most 100 outside rows, using
  row 101 only to refuse before decrypting shared state. Square webhook payment
  statuses are a closed five-value set, so missing or new provider words fail
  instead of becoming a skipped callback.

The checkout observer, provider-qualified completion identity, callback/body
boundary, and remaining scope/price/replay work are not partially implemented by
this document. They move together through `PLAN.md` M6-M11. M4's refund
authority is reused by that cutover; a second refund authority is forbidden.

The #2048 processing slice changed the source tree by 6,487 added lines and
7,053 deleted lines, a net reduction of 566 lines. The gross additions exceed
the 1,170-1,870 estimate because every touched source and test file was brought
under the 400-line limit. That required splitting several existing admin,
payment, email, listing, modifier, and code-quality monoliths and moving their
existing tests into focused suites. Those moved lines are modularization, not
new payment behavior. The behavioral part is the paid-order snapshot, atomic
claim/answer/activity writes, and removal of their superseded parallel readers.

## Goal and honest guarantee

The remaining atomic checkout cutover must put Stripe, Square, and SumUp browser
returns and completion callbacks through one current-observation boundary before
booking or automatic refund. The strongest guarantee available without a
persisted historical provider-account identity is narrower than historical
provider ownership:

> A provider response may enter payment processing only when its current
> provider scope, top-level resource, and every child used by processing agree
> with independent request, signature, staging, and provider facts available on
> that path. Site proof, charge shape, price, and processing remain separate
> checks. Facts the provider does not expose are not invented.

This guarantee is named **current provider-scope/resource consistency**, not
historical provider ownership. It does **not** prove the Stripe account or
Square merchant that created an old checkout or preserve every checkout-time
provider fact. The M6-M11 cutover will add a provider-qualified durable session
record for completed replay and private owner recovery; that record cannot turn
a current observation into historical account proof.

## Evidence snapshot and current corrections

The table below is the source audit that shaped the original plan; its file
locations and "current" wording describe that audit, not today's branch. Apply
these corrections before using it:

- **Whole-checkout callers:** `validatePaidSession` and the cancel/callback
  routes still call `retrieveSession` or `resolveWebhookSession`, and provider
  adapters still convert independently through `validatedPaymentSession`. The
  atomic M6 cutover must replace all of them together.
- **Stripe checkout:** the checkout schema still omits `livemode` and expanded
  PaymentIntent handling. M4's strict Stripe charge reader is refund evidence,
  not a whole-checkout replacement.
- **Square checkout:** the browser checkout path still selects `tenders[0]` and
  does not yet enforce the complete location, parent, and all-tender
  relationship. The old `src/shared/square.ts` monolith is already gone; strict
  charge/refund reads live under `src/shared/square/`. A non-empty `_origin`
  remains an app-family marker when the hostname changes, not proof of current
  site ownership; the signed `price_proof` remains that proof. The current
  payment webhook boundary separately accepts only `APPROVED`, `PENDING`,
  `COMPLETED`, `CANCELED`, and `FAILED`. Missing, non-text, empty, and unknown
  statuses throw; only a known non-completed value is skipped, and `COMPLETED`
  also requires its Order id.
- **SumUp:** PR #2060 built strict current checkout observation and a
  known-callback path with one indexed staging read through
  `getSealedSumupCheckout`, then one checkout read. M4's transaction reader
  strictly parses `transaction_events` for refund evidence.
- **Provider reads:** refund charge reads use the typed `ProviderRead` states
  `found`, `missing`, `unavailable`, and `invalid`. Whole-checkout
  `retrieveSession` remains the older nullable/throwing contract and must not be
  mistaken for that authority. A canonical `ready` refund whose read is missing
  or invalid moves immediately to `needs_owner_choice/provider_unreadable`; an
  unavailable read gets one five-minute grace before that same zero-send exit.
  Provider conflicts are stricter: exact zero or full return can admit the one
  justified owner answer; partial, invalid, backward, wrong-currency, excessive,
  or pending evidence is `needs_provider_check` and can only be observed again.
- **Configuration:** whole-checkout provider choice, browser/callback
  observation, and verification still use ambient configuration at separate
  points.
- **Refund safety:** `tryRefund` is gone. Real sends use tagged references
  through `requestProviderRefund`/`requestProviderRefunds` and never re-resolve
  a provider after admission. The remaining gap is earlier whole-checkout
  provider selection before the target is tagged.
- **Persistence and review:** `payment_charges` is the canonical durable
  authority for refund sends, provider checks, and owner choices. Stored-shape
  parsing/mirrors live in `payment/refund-authority-state.ts`; automatic
  transitions in `payment/refund-authority.ts`; conflict and choice transitions
  in `payment/refund-authority-choice.ts`; exits in
  `payment/refund-authority-lifecycle.ts`; and the two provider-authority
  database modules remain its sole writer boundary.
  `processed_payments.payment_session_id` remains a flat checkout identity until
  M6-M11; local `payment_state.review` is not a second provider authority.
  `checkingClaimFor` is the sole constructor for ordinary and placeholder
  attendee fences. `provider_unknown` remains a bounded typed old-data refusal,
  and the attendee page explains it without rendering a dead Refresh form.
- **Admin bounds:** Refund All's GET reads indexed summaries and decrypts zero
  attendee PII. Its POST decrypts zero when blocked/empty and one selected
  attendee otherwise. A claim's blind-index expansion accepts at most 100
  outside sharing rows; SQL row 101 proves overflow and returns
  `too_many_reference_holders` before decrypting shared `failure_data`, writing
  a claim, or calling a provider.
- **Remaining faults:** blank paid references are still terminally acknowledged,
  site proof and strict webhook-envelope work remain incomplete, and
  whole-callback diagnostics still expose more detail than the target permits.

| Area                 | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Consequence                                                                                                                                                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live callers         | `validatePaidSession` calls `retrieveSession` in `src/features/api/payment-processing/classify.ts:134-160`; cancel does the same in `src/features/api/webhooks.ts:247-267`; callbacks call `resolveWebhookSession` in `src/features/api/webhooks.ts:389-473`                                                                                                                                                                                                                                         | All three callers and every provider implementation must migrate together; no compatibility alias remains                                                                                                                             |
| Current conversion   | Stripe, Square, and SumUp call `validatedPaymentSession` independently in `src/shared/stripe-provider.ts:40-60`, `src/shared/square-provider.ts:163-180`, and `src/shared/sumup-provider.ts:52-69`                                                                                                                                                                                                                                                                                                   | Replace these three conversions with one post-observation gate                                                                                                                                                                        |
| Stripe               | Locked Stripe 22.1.0 types expose Session `id`, `livemode`, and `payment_intent`; `payment_intent` may be a string, expanded object, or null. Current `StripeCheckoutSessionSchema` drops `livemode` and accepts only string/null (`src/shared/stripe/schemas.ts:14-38`)                                                                                                                                                                                                                             | Runtime parsing must retain `livemode` and extract an ID from either documented payment-intent shape                                                                                                                                  |
| Square               | Custom REST API version `2025-01-23`; raw Order/Payment casts and mappers omit `location_id` (`src/shared/square.ts:152-235,320-380`). Orders expose `tenders[]`; current browser code chooses `tenders[0]` (`src/shared/square-provider.ts:129-136`)                                                                                                                                                                                                                                                | Add runtime schemas and retain returned IDs, locations, all relevant tender IDs, and returned Payment parent. Environment is request context, not an independently returned field                                                     |
| SumUp                | Locked `@sumup/sdk` 0.1.6 types expose checkout `merchant_code`, `transaction_id`, `transactions[]`, and transaction `id`, `status`, amount/currency, and `merchant_code`. Sanitized 2026-08-05 fixtures under `test/fixtures/sumup/sandbox/` record real pending, paid, failed, and refunded sandbox observations. One authenticated `GET /v1/merchants/{merchant_code}` returned the configured merchant code and `sandbox: true`; the restricted key had no mode prefix recognized by `keyModeOf` | Sandbox identity for restricted keys comes from the matching Merchant response, never a key-prefix assumption. Exact status-specific field presence and the one-response ownership design are now evidence-backed                     |
| SumUp staging        | The DB stores only reference HMAC, encrypted metadata, and `sumup_id`; plaintext reference never rests in the DB (`src/shared/db/sumup-checkouts.ts:1-29,59-128`)                                                                                                                                                                                                                                                                                                                                    | A callback cannot obtain an independent expected reference from its checkout ID. It must fetch the checkout, use its returned reference to open staging, then compare the independently stored `sumupId` with the callback/fetched ID |
| Provider reads       | `createWithClient` catches broad client/transport/parser failures and returns `null` (`src/shared/payment-helpers.ts:85-105,176-193`); Stripe, Square, and SumUp use it                                                                                                                                                                                                                                                                                                                              | Current adapters cannot honestly distinguish authoritative missing, unavailable, and malformed results                                                                                                                                |
| Configuration        | Provider resolution, signature verification, client creation, scope comparison, currency classification, and automatic refunds read mutable settings at different times (`src/shared/payments.ts:357-391`, provider runtime modules, `classify.ts:99-112`, `refunds.ts:120-159`)                                                                                                                                                                                                                     | A local expected-facts object inside a read method cannot create the promised immutable observation                                                                                                                                   |
| Refund safety        | `tryRefund` re-resolves the current/last provider and its refund-status check (`src/features/api/payment-processing/refunds.ts:120-159`)                                                                                                                                                                                                                                                                                                                                                             | An observation under configuration A can currently refund through configuration B                                                                                                                                                     |
| Blank paid reference | `refundRejectedCharge` treats `blank_reference` as settled (`src/features/api/payment-processing/refunds.ts:60-91`)                                                                                                                                                                                                                                                                                                                                                                                  | A provider-paid session with no usable charge ID can be acknowledged while the buyer remains charged                                                                                                                                  |
| Site proof           | `price_proof` is the only current site proof (`src/features/api/payment-processing/classify.ts:57-113`), but cancel rendering parses metadata and queries listings without checking it (`src/features/api/payment-processing/cancel.ts:57-76`)                                                                                                                                                                                                                                                       | Provider scope alone must not authorize listing-specific cancel content or retry links                                                                                                                                                |
| Webhook parsing      | Generic JSON is cast to `WebhookEvent` and logs parser detail (`src/shared/payment-helpers.ts:724-734`); the route reads `listing.type` before an exact envelope parse                                                                                                                                                                                                                                                                                                                               | A validly signed primitive or malformed envelope can escape as an unsanitized route error                                                                                                                                             |
| Diagnostics          | Callback code logs raw payloads and value-bearing states (`src/features/api/webhooks.ts:293-313,341-377,430-463`). `logError` can write activity, ntfy, and Sentry (`src/shared/logger.ts:292-339`)                                                                                                                                                                                                                                                                                                  | Privacy correction cannot be limited to `validatedPaymentSession`; expected forged traffic must not trigger notification amplification                                                                                                |
| Persistence          | `processed_payments` and ledger replay use a flat session ID, not provider + resource kind + ID                                                                                                                                                                                                                                                                                                                                                                                                      | Migrate both to a database-enforced provider-qualified identity; a flat ID must never authorize another provider or resource kind                                                                                                     |

## Evidence-only provider modeling rule

PR 3 must not implement fictional provider response shapes or speculative
recovery branches. A wire field, union member, and normal domain state exists
only when supported by the lock-resolved provider type/contract and official
documentation for the exact endpoint, plus a sanitized real fixture when the
contract leaves runtime presence or status-specific shape uncertain.

- Documented unions are real variants. Stripe `payment_intent` as a string,
  expanded object, or null must be parsed as documented rather than narrowed to
  whichever variant current fixtures happen to contain.
- Authoritative HTTP not-found and temporary network, timeout, rate-limit, or
  5xx failure are real read outcomes. Typed transports preserve them without
  turning either into a fabricated provider body.
- A successful response that violates its documented and observed wire contract
  is parsed once to the fail-closed `malformed` boundary outcome. No partial
  wire object enters provider-scope, status, charge, site, price, booking,
  refund, or owner-recovery decisions.
- Do not add defaults, fallback fields, alternate normalizers, per-field
  business branches, or integration fixtures that portray impossible provider
  data as a normal state. Do not add recovery for a failure unless the pinned
  contract, endpoint documentation, or sanitized exact-endpoint/status fixture
  proves that failure can occur in normal operation.
- Malformed-data tests mutate input only at the direct wire-parser boundary and
  assert one strict `malformed` result. Route tests may inject that typed result
  to prove HTTP mapping, but must not carry a fictional provider response
  through an adapter or integration fixture. Domain tests use only documented
  variants and sanitized real shapes.

## Required boundary layers

The provider contract and bounded request design are evidence-backed. These are
acceptance layers for the single M6-M11 runtime, not independently activatable
features. They must replace the live whole-checkout callers atomically and reuse
M4's canonical refund authority; they must never coexist with a legacy observer
or refund engine.

1. **Request and authentication:** apply a webhook byte limit; parse one strict
   common envelope or the strict SumUp envelope; verify Stripe/Square signature
   with the same bound configuration used later. Unknown event types remain
   non-processing acknowledgements.
2. **Bound provider attempt:** capture provider choice, credentials/client,
   webhook secret, Stripe key mode, Square environment/location, SumUp merchant,
   and site currency once before authentication or provider IO. Browser reads,
   callback reads, comparisons, and automatic refund/status checks use this same
   request-local attempt. Secrets never enter ownership values or diagnostics.
3. **Typed read outcome:** transports preserve `found`, authoritative `missing`,
   temporary `unavailable`, and successful-but-`malformed` from structured
   status/error data; the scope decision adds typed `contradictory` when parsed
   facts disagree. Do not infer any state from the current undifferentiated
   `null`.
4. **Pure provider-scope decision:** compare path-aware independent expected
   facts with narrow parsed observations. Use one exhaustive provider rule
   table. Represent children as arrays: Stripe contributes zero or one; Square
   and SumUp retain provider collections. Do not create a singular algorithm
   beside a collection algorithm.
5. **Status and charge gate:** after top-level/scope acceptance, map status and
   validate the charge selected from accepted children. A paid state without a
   usable accepted child is unresolved paid money, not “nothing to refund.” It
   returns retryably and creates one durable private owner case. A malformed
   wire amount/currency never reaches this gate. Safe refund authority applies
   only to a well-formed, contract-backed captured charge after provider
   relationship and site proof are established.
6. **Site and price classification:** verify `price_proof` independently of
   provider scope. Distinguish foreign/unverifiable proof, valid proof with
   unreadable booking intent, wrong price/currency, and trusted intent. Cancel
   rendering must consume verified intent rather than reparse unsigned metadata.
   Invalid or foreign proof is acknowledged without booking or refund. Valid
   proof with unreadable paid intent returns retryably and creates an owner
   case.
7. **Durable identity and processing claim:** one provider-qualified session
   record stores either completed replay authority or a fixed private
   `owner_action_required` reason. Only a fully accepted paid session reaches
   the existing `processed_payments`/ledger flow. The bound provider attempt
   follows the session into automatic refund and refund-status confirmation.
   Admin refresh/refund otherwise remains separate.

### Path-aware independent facts

| Path            | Independent expected facts                                                            | Observed facts and exact relationship                                                                                                                                                                                                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stripe browser  | Browser Session ID; bound key mode                                                    | Retrieved Session ID must equal the browser ID; `livemode` must match mode; any used PaymentIntent ID must be the Session-named string or expanded object ID                                                                                                                                                                                          |
| Stripe callback | Bound webhook secret and key mode; event type                                         | Signature authenticates the embedded Session snapshot; Session ID is observed, not an independent requested ID; `livemode` must match. The Session naming its PaymentIntent is the only available child relationship and does not prove child existence or raw account identity                                                                       |
| Square browser  | Browser Order ID; bound environment/location                                          | Returned Order ID/location must match. Inspect at most eight distinct tender Payment IDs. Each returned Payment ID, parent Order, and location must match. Continue only when exactly one completed, money-bearing candidate is valid; refuse zero completed candidates as pending and refuse multiple candidates or more than eight IDs as ambiguous |
| Square callback | Signed Payment ID and parent Order ID; bound signature key/environment/location       | Returned Order must equal the signed parent and location; returned Payment ID must equal the signed ID, parent the returned Order, and location the bound location. Signed `merchant_id` is retained only if useful diagnostically in memory; there is no configured merchant fact to compare                                                         |
| SumUp browser   | Browser reference; staging row opened independently by that reference; bound merchant | Returned checkout ID must equal staging `sumupId`; returned reference must equal browser reference; checkout merchant must match. A paid checkout must name exactly one matching successful transaction whose ID, money, currency, and merchant are present and agree                                                                                 |
| SumUp callback  | Unsigned checkout ID; one indexed existence prefilter; bound merchant                 | Fetch only after the ID is staged. Returned checkout ID must equal callback ID. Use returned reference to open staging, then require that row's independently stored `sumupId` to equal callback/fetched ID. A paid checkout must name exactly one matching successful transaction whose ID, money, currency, and merchant are present and agree      |

### SumUp sandbox evidence result

Evidence was collected on 2026-08-05 with `@sumup/sdk` 0.1.6 and reviewed as
sanitized deterministic fixtures under `test/fixtures/sumup/sandbox/`. The fresh
fixture-only review found no credential, original provider value, URL,
instrument/auth data, metadata, or PII leak and confirmed linked identities and
endpoint labels.

| State             | `GET /v0.1/checkouts/{checkout_id}` observed fields                                                                                                                                                            |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pending           | `id`, `checkout_reference`, `amount`, `currency`, `merchant_code`, `status: "PENDING"`, and `transactions: []`; `transaction_id` omitted                                                                       |
| Paid              | The same top-level identity/money/merchant fields with `status: "PAID"`; `transaction_id` present; exactly one `transactions[]` entry with the same ID, amount, currency, `status: "SUCCESSFUL"`, and merchant |
| Failed            | The same top-level identity/money/merchant fields with `status: "FAILED"`; exactly one failed transaction with ID, amount, currency, `status: "FAILED"`, and merchant; `transaction_id` omitted                |
| After full refund | Checkout remains `status: "PAID"`; its named transaction remains `status: "SUCCESSFUL"`. Checkout retrieval does not expose refund completion                                                                  |

The full refund was proved by the documented authoritative
`GET /v2.1/merchants/{merchant_code}/transactions?id={transaction_id}` response:
`transaction_events[]` contained a `REFUND` event with `status: "REFUNDED"` and
amount equal to the original transaction amount. The transaction's top-level
`status` and `simple_status` both remained `"SUCCESSFUL"`; neither is refund
authority for this observed sandbox response. Transaction history independently
corroborated the same full amount through the payment item's `refunded_amount`
and a linked refund item, but production needs no history read because the exact
transaction response already proves the full refund.

**As-built verdict:** PR #2060 uses staging plus one checkout read for
pending/paid/failed ownership and payment observation; the known callback first
uses one indexed staging read. M4's refund charge reader uses one transaction
read, parses `transaction_events[]`, and compares successful refund-event totals
with the transaction amount instead of trusting the unchanged top-level
transaction status. Missing expected event evidence is `invalid`, never an empty
history. M6 must reuse these readers instead of building a second SumUp path.

All narrow schemas that promise rejection of unknown properties use
`v.strictObject`; ordinary `v.object` strips extras and must not be described as
rejecting them. Provider wire schemas and request-local ownership schemas are
different boundaries and must not be conflated.

## State and HTTP matrix

This is the acceptance matrix for atomic checkout activation. Rows already
implemented by #2060 or M4 are named as such; the remaining rows are not a live
parallel path.

| Path/state                                              | Provider/DB work                                                                   | Processing                                                                                               | HTTP behavior                                                                                                                     |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Stripe callback, malformed/contradictory embedded facts | Zero Stripe reads                                                                  | No booking/refund while relationship or scope is unproven                                                | Exact retry response below                                                                                                        |
| Stripe callback, pending                                | Zero Stripe reads                                                                  | No booking/refund                                                                                        | Authenticated non-processing `200` pending acknowledgement while card-only creation remains enforced                              |
| Square callback, non-completed signed notice            | Zero provider reads                                                                | No booking/refund                                                                                        | `200` non-processing acknowledgement; ownership is not claimed because no resource read occurred                                  |
| Square completed callback                               | One Order + one signed Payment read                                                | Continue only after exact ID/parent/location, charge, site, and price checks                             | Existing handled success/pending response; rejection uses exact retry response when retryable                                     |
| Known SumUp callback                                    | One indexed staging DB read + one checkout read                                    | Continue only after returned-reference binding and the evidence-backed checkout/transaction relationship | Existing handled success/pending response; retryable refusal uses exact retry response                                            |
| Non-empty unstaged SumUp callback                       | Exactly one indexed DB read; zero SumUp reads; no per-attempt activity/Sentry/ntfy | No booking/refund/persistence                                                                            | Exact retry response. A later retry can pass after `setSumupCheckoutId`; forged traffic remains locally bounded                   |
| Browser missing/contradictory/malformed                 | One normal provider observation plus staging where applicable                      | No booking/refund                                                                                        | Localized permanent verification page, status `400`: “Payment could not be verified. Check the payment link or contact support.”  |
| Browser unavailable                                     | Same attempted read; no authoritative facts                                        | No booking/refund                                                                                        | Localized temporary page, status `503`: “Payment could not be checked. Try again in a few minutes.”                               |
| Paid with missing/unusable child                        | No refund can be safely named                                                      | No booking; never classify as settled; upsert one private owner case                                     | Callback uses exact retry response; browser uses the temporary `503` page                                                         |
| Invalid or foreign site proof                           | Provider resource may be real but is not proven to this site                       | Never book, auto-refund, or create an owner case                                                         | `200` callback acknowledgement; browser uses the permanent `400` page                                                             |
| Valid site proof, unreadable paid intent                | This site's paid resource is established but booking cannot be reconstructed       | Upsert one private owner case; never silently settle                                                     | Callback uses exact retry response; browser uses the temporary `503` page                                                         |
| Processed replay                                        | Look up provider + top-level resource kind + resource ID before fresh provider IO  | Existing claim/ledger prevents duplicate booking/refund                                                  | Callback acknowledges safely. Browser/cancel verifies route-specific site proof before rendering stored result or listing content |

The shared retry response must use existing `plainResponse`: status `503`,
header `content-type: text/plain; charset=utf-8`, and exact UTF-8 body
`Payment verification failed`. It must not expose provider, state, IDs, parser
messages, or mismatch details. SumUp documents only four retries, after 1
minute, 5 minutes, 20 minutes, and 2 hours; no section may claim indefinite
redelivery.

`setSumupCheckoutId` already requires exactly one affected row before the hosted
URL is exposed. The `503` closes the normal pre-ID race only while that write
succeeds within SumUp's finite retry window; it is not durable reconciliation.

## Concurrency, idempotency, and persistence

The following is the M6-M11 target. Every identity, claim, writer, reader, and
retirement path activates together; no old/new read-through or dual authority is
permitted.

- Each request creates one bound provider attempt before signature verification
  or provider IO. A settings write affects only later attempts. Currency and
  automatic settlement use that same attempt.
- Square's Order and Payment reads are sequential, not atomic. Exact IDs,
  parent, location, selected child, status, and used money must form one
  coherent pair. A reread moves rather than removes the race window.
- SumUp checkout and transaction-array evidence comes from one response when the
  chosen field policy permits it. A later retry may observe a later state.
- Duplicate observations may both spend reads. Only the existing processing
  claim/ledger may authorize booking or refund; the provider-qualified record is
  written in the same successful/owner-case transaction and is never a second
  authority for unprocessed work.
- Automatic refund must use M4's canonical `readCharge` evidence and durable
  provider-refund authority bound to the accepted resource. The deleted
  `isPaymentRefunded` API stays deleted; no future cutover may revive it or
  re-resolve global provider settings.
- Define one canonical identity per provider before any durable claim: Stripe is
  `(stripe, checkout_session, Session.id)`, Square is
  `(square, order, Order.id)`, and SumUp is `(sumup, checkout, Checkout.id)`.
  Square Payment/tender IDs must resolve to their parent Order ID. SumUp
  transaction IDs must resolve to their parent checkout through staging or the
  verified provider relation. Browser, callback, refund, and ledger-replay paths
  all use these mappings; an alternate provider identifier is never a second
  durable identity.
- Add one provider-qualified durable session mechanism with a database `UNIQUE`
  constraint on `(provider, canonical resource kind, canonical resource ID)`.
  Its exhaustive outcome is `completed` with the existing handled-result
  reference, or `owner_action_required` with a fixed reason
  (`paid_child_unusable` or `paid_intent_unreadable`), created/updated
  timestamps, and resolution state. It stores no raw response, metadata,
  payload, credential, mismatch value, or copied PII. Use an atomic upsert on
  that conflict target. Repeated failures update the same case rather than
  create duplicates. Migrate `processed_payments`, its processing claim,
  refunds, and ledger replay to this canonical tuple; remove flat
  `payment_session_id` authority in the same slice.
- Completed replay checks that provider-qualified record before staging or
  provider IO. Callback replay returns the existing acknowledgement. Browser
  success and cancel replay must verify this site's `price_proof` before showing
  any stored result, ticket, retry link, or listing content; absent or foreign
  proof returns the permanent `400` page. An owner case remains retryable and
  visible only on an authenticated owner page with explicit repair actions; it
  never authorizes booking or refund by itself.
- SumUp staging may be pruned after the checkout/retry period without breaking a
  completed replay because completion has provider-qualified durable authority.
  An unresolved callback still needs staging or its owner case.

## Privacy, request limits, and diagnostics

- The atomic cutover must read payment webhook bodies incrementally from
  `request.body.getReader()` before provider work. Preserve the collected raw
  bytes unchanged for signature verification. Accept exactly 64 KiB and
  cancel/reject as soon as accumulated bytes exceed that bound, regardless of
  `Content-Length` or chunking. Generic callback buffering through
  `arrayBuffer()` remains unbounded. PR #2060 already rejects a SumUp callback
  ID over 255 UTF-8 bytes before DB/provider use; M6 must apply the same
  boundary wherever another provider-controlled resource ID can enter first.
- Parse external JSON with strict boundary schemas. Expected malformed payloads
  become value-free typed outcomes. Unexpected system errors may propagate only
  after external SDK/body/parser detail has been replaced with a fixed safe
  error; do not attach raw provider exceptions to Sentry.
- Remove raw payload logging, signature prefixes, provider IDs/statuses/money,
  metadata, malformed values, parser text, and mismatch detail from console,
  encrypted activity logs, ntfy, and Sentry on every touched payment-webhook
  path.
- Do not use `logError` for success, ordinary pending, unknown event types, or
  unstaged forged SumUp IDs. It can add an activity DB write, ntfy request, and
  Sentry request. Every expected outcome or refusal uses a fixed console-only
  class with provider and outcome, never values. The one exception is the
  dedicated value-free registration-delivery activity below. Only unexpected
  programming or system failures use activity, ntfy, and Sentry, after external
  error detail is replaced by a fixed safe class and without attaching the raw
  exception. If writing the dedicated failure activity itself fails, emit the
  fixed database class to console and rethrow; do not spend three more
  subrequests trying to report a reporting failure.
- No raw callback/provider response, ownership decision, forged ID, mode,
  location, merchant observation, credential, or signing secret is newly
  persisted. The only new persistence is the narrow provider-qualified completed
  or private owner-recovery record described above.

## API and caller migration

This inventory belongs to the atomic M6 activation. Replace the former stateless
methods with one request-local bound provider attempt created before
authentication. It owns signature verification, browser and callback
observation, current expected scope, automatic refund, and refund-status
confirmation using one captured configuration/client. Secrets stay private to
the attempt. Deleting an old method and migrating every caller are one change;
there is no alias, compatibility wrapper, fallback, read-through, or period with
two live implementations.

Required migration inventory:

- Delete `PaymentProvider.retrieveSession` and `resolveWebhookSession` in the
  same activation that migrates all source callers and provider implementations.
- Migrate direct test stubs in
  `test/features/api/payment-processing/classify.test.ts`,
  `test/features/api/webhooks/provider.test.ts`, cancel/session-resolution/item-
  validation/unrecognized-session integration suites, all three provider suites,
  and `test/test-utils/payment-session.ts`.
- Keep checkout creation and admin refund/refresh outside the new observation
  API; automatic refunds caused by the observed session must use the bound
  attempt. Do not leave an alias or compatibility wrapper.
- Keep new provider/read contracts focused and lazy. The old 966-line
  `src/shared/square.ts` has already been deleted and split under
  `src/shared/square/`; extend those modules and do not recreate the monolith.
  Split any touched source or test file that crosses the repository's roughly
  400-line target, and keep response/diagnostic mapping out of the webhook route
  and strict parsing out of `payment-helpers.ts`.
- Consolidate Stripe key-mode parsing onto existing `keyModeOf` in
  `src/shared/db/settings/constants.ts`; remove `detectStripeKeyMode` rather
  than adding a third implementation.
- Keep provider-specific collection gathering behind lazy provider loaders.
  `ownership.ts` imports no SDK, no top-level IO is added, and SumUp/Stripe SDKs
  must not enter the shared route's eager module graph.

## Subrequest and source budgets

The figures in this section are the approved design ledger that justified #2048
and #2050. They are not the live M4 refund budget and must not be copied into M6
as current request authority. The M6 cutover must measure its exact physical
provider retries and database calls against today's code before activation. Its
tests, not this historical 48-call table, are the executable bound.

The older “no call increase” and 545-755-line claims were withdrawn.

- Bunny's limit is 50 combined DB and external subrequests. Count every physical
  attempt. One Stripe logical call allows three attempts; Square and the pinned
  SumUp SDK allow one. SumUp calls must enter the shared counter.
- Every payment request gets one shared allowance of at most two additional DB
  attempts, including cold-ready initialization, settings, reads, writes, and
  batches. The allowance is request-wide, not two retries per operation. A retry
  consumes one credit before sleeping; after both credits are spent, a transient
  read rethrows and lock contention becomes `DatabaseBusyError`. Payment paths
  use no retryable interactive transaction.
- Every write that can be retried after an unknown commit result has a stable
  operation key and database uniqueness constraint. Activity, booking, answer,
  ledger, claim, owner-case, and finalization writes use atomic conflict-safe
  insert/upsert behavior. Replaying a committed batch must change no row twice
  and create no duplicate.
- Reject more than 16 final expanded booking lines before provider creation and
  again when parsing signed intent. Reject more than 16 distinct non-empty
  registration webhook URLs; never truncate. Deduplicate non-empty URLs before
  counting, and deliver only from that same bounded set. This bounds payload,
  rendering, attachment, and webhook fan-out work even when several lines share
  one URL.
- The tables include the cold ready-schema maximum: one schema probe, one
  script- version read, and one changed-version write. Pending migrations are a
  startup/ unavailable path, not a payment attempt. Cold payment settings add
  two reads; provider-qualified replay adds one. SumUp browser, known callback,
  and unstaged callback paths add one, two, and one staging reads respectively.

### Historical provider maxima

| Path                             | Observation | Failed refund plus status confirmation | Combined provider maximum |
| -------------------------------- | ----------: | -------------------------------------: | ------------------------: |
| Stripe browser                   |           3 |                                      6 |                         9 |
| Stripe signed callback           |           0 |                                      6 |                         6 |
| Square browser, eight tender IDs |           9 |                                      3 |                        12 |
| Square completed callback        |           2 |                                      3 |                         5 |
| Square non-completed callback    |           0 |                                      0 |                         0 |
| SumUp staged browser or callback |           1 |                                      2 |                         3 |
| SumUp unstaged callback          |           0 |                                      0 |                         0 |

### As-built bounded processing mechanism

PR #2048 deleted the old parallel readers and built one paid-order snapshot with
one `queryBatch` after the processing claim. Its rows load ledger disposition,
current listings, package display/membership/prices, hidden membership, both
directions of listing relationships, referenced modifiers and their scopes, both
contact visit counts, public status, and question/answer facts. The same
snapshot supplies booking creation, email package display, webhook package
prices, cancel rendering, and refunded-result storage. M6 extends this one
mechanism; it does not create a checkout-specific reader beside it.

The maximum successful core is five DB calls regardless of line, modifier,
package, promo, or answer count within the 16-line bound:

1. One atomic conditional claim batch acquires a fresh or stale
   `processed_payments` row and returns an existing completed row on conflict.
2. One paid-order snapshot batch includes ledger preflight and every current
   read.
3. One existing atomic booking batch writes attendee, bookings, modifier use,
   ledger, and contact activity with stable operation keys. The durable session
   remains `processing`.
4. One optional answer-replacement batch uses `INSERT ... SELECT` for validated
   choice and stored-text IDs; no begin/statement/commit transaction remains.
5. One final batch writes every promo and registration activity together and
   marks the canonical provider-qualified session `completed`. A stale claim
   resumes the idempotent missing batches; replay cannot return `completed`
   while answers or activities remain unfinished.

Email and webhook rendering add zero DB reads. At most two registration emails
add two external calls. A prebuilt-site link joins the buyer confirmation
instead of creating a third email. Refunded-result
attendee/ledger/activity/note/terminal state is likewise one batch using the
snapshot rather than parallel rereads.

### Historical exact request totals

“First attempt” means each DB operation runs once while provider columns already
include their physical retry maxima. “Retry maximum” adds the approved two DB
attempts. Every row includes cold-ready initialization and cold settings.

| Early/owner path                               | First attempt | Retry maximum | Headroom |
| ---------------------------------------------- | ------------: | ------------: | -------: |
| Body over 64 KiB, rejected before buffering/DB |             0 |             0 |       50 |
| Malformed envelope or ID over 255 bytes        |             0 |             0 |       50 |
| Completed provider-qualified replay            |             6 |             8 |       42 |
| Square non-completed callback                  |             5 |             7 |       43 |
| Unstaged SumUp callback                        |             7 |             9 |       41 |
| Stripe browser owner case                      |            10 |            12 |       38 |
| Stripe callback owner case                     |             7 |             9 |       41 |
| Square browser owner case, eight tender IDs    |            16 |            18 |       32 |
| Square completed callback owner case           |             9 |            11 |       39 |
| SumUp browser owner case                       |             9 |            11 |       39 |
| Known SumUp callback owner case                |            10 |            12 |       38 |

Missing, malformed, contradictory, unavailable, and foreign-proof paths omit the
owner upsert and therefore remain below the matching owner row. Expected
outcomes use no activity, ntfy, or Sentry subrequests.

| Successful path: 16 direct webhooks + two emails | First attempt | Retry maximum | Headroom |
| ------------------------------------------------ | ------------: | ------------: | -------: |
| Stripe browser                                   |            32 |            34 |       16 |
| Stripe signed callback                           |            29 |            31 |       19 |
| Square browser, eight tender IDs                 |            38 |            40 |       10 |
| Square completed callback                        |            31 |            33 |       17 |
| SumUp browser                                    |            31 |            33 |       17 |
| Known SumUp callback                             |            32 |            34 |       16 |

One renewal adds two DB calls and one provider call. One paid prebuilt-site
assignment adds two DB calls (atomic claim and successful provisioning finalize)
plus at most two Bunny secret calls; Deno needs one provider call. Quantity
above one is rejected before checkout and again from signed intent. Payment
completion never calls `buildAssignableSite`; lost inventory takes the
established charged- but-unfulfillable recovery/refund path. Assignment claim,
provisioning, and finalization finish before the two registration emails, so the
buyer confirmation can carry the site link without a third email. The existing
schema permits renewal and assignment together, so the global table
conservatively includes both:

| Square browser special success                               | First attempt | Retry maximum | Headroom |
| ------------------------------------------------------------ | ------------: | ------------: | -------: |
| Renewal only                                                 |            41 |            43 |        7 |
| One Bunny prebuilt-site assignment                           |            42 |            44 |        6 |
| Renewal plus one Bunny assignment                            |            45 |            47 |        3 |
| Above plus one consolidated follow-up-failure activity batch |            46 |        **48** |    **2** |

The failure activity is exactly one value-free entry in one batch when any email
or webhook delivery fails, regardless of endpoint count, and zero entries when
all succeed. It is never one `logError` fan-out per endpoint. Expected delivery
refusal does not call ntfy or Sentry. The 47-call path before this batch leaves
room for all three safe unexpected-error sinks instead. Collect every settled
email and webhook outcome before reporting: preserve expected refusals and every
unexpected reason in memory, emit one fixed `E_REGISTRATION_DELIVERY` console
class, write the same single failure activity, and send one ntfy plus one Sentry
message with no raw exception attached. Then rethrow the first original reason
locally. An attempted failure-activity write is call 48 and reports its own
failure to console only. No diagnostic path exceeds 50.

The maximum automatic refund/storage branch includes claim, snapshot, attempted
create, one recovery read, one refunded-result batch, provider refund/status
confirmation, and the shared retry allowance:

| Refund/storage path              | First attempt | Retry maximum | Headroom |
| -------------------------------- | ------------: | ------------: | -------: |
| Stripe browser                   |            20 |            22 |       28 |
| Stripe signed callback           |            17 |            19 |       31 |
| Square browser, eight tender IDs |            23 |            25 |       25 |
| Square completed callback        |            16 |            18 |       32 |
| SumUp browser                    |            15 |            17 |       33 |
| Known SumUp callback             |            16 |            18 |       32 |

| Replay/cancel path                    | First attempt | Retry maximum | Headroom |
| ------------------------------------- | ------------: | ------------: | -------: |
| Stripe browser processed replay       |            10 |            12 |       38 |
| Stripe callback processed replay      |             7 |             9 |       41 |
| Square browser processed replay       |            16 |            18 |       32 |
| Square callback processed replay      |             9 |            11 |       39 |
| SumUp browser processed replay        |             9 |            11 |       39 |
| Known SumUp callback processed replay |            10 |            12 |       38 |
| Stripe browser ledger replay          |            12 |            14 |       36 |
| Stripe callback ledger replay         |             9 |            11 |       39 |
| Square browser ledger replay          |            18 |            20 |       30 |
| Square callback ledger replay         |            11 |            13 |       37 |
| SumUp browser ledger replay           |            11 |            13 |       37 |
| Known SumUp callback ledger replay    |            12 |            14 |       36 |
| Stripe cancel with bounded snapshot   |            10 |            12 |       38 |
| Square cancel with bounded snapshot   |            16 |            18 |       32 |
| SumUp cancel with bounded snapshot    |             9 |            11 |       39 |

Organic maintenance already stops at 42 combined calls and skips when foreground
usage leaves no allowance. It can raise smaller requests to 42 but cannot raise
the 48-call maximum. Thus the complete maximum remains 48.

### As-built direct-only webhook policy

Before PR #2050, registration webhooks followed five redirects and repeated the
POST body, so 16 URLs could consume 96 fetches. The ordinary Square browser
maximum would have become 120 and the assignment-plus-renewal maximum 127 (128
with the consolidated failure activity). No batching could make that fit.

Registration webhooks are now **direct-only**: deduplicate non-empty configured
URLs, validate and count that set, then make exactly one POST per distinct
validated URL. Force `redirect: "manual"`. Every 3xx is a typed failed delivery
and is never followed. Attendee data is never sent to the redirected location.
Each request has a 10-second timeout covering connection and response-body work;
a timeout is a typed failed delivery so pending work always settles. Read at
most 64 KiB of response body, cancel the stream on the next byte, and return a
typed failed delivery on overflow. No outbox is required for the approved
synchronous bound.

| Required source area                                                     | Honest changed/added estimate |
| ------------------------------------------------------------------------ | ----------------------------: |
| Shared schemas, collection decision, status/charge gate                  |                       140-200 |
| Bound provider attempt, configuration, and settlement capability         |                       120-190 |
| Typed transports, strict wire/envelope parsers, body/ID bounds           |                       160-260 |
| Three provider adapters and raw mappers                                  |                       170-250 |
| Paid-order snapshot and removal of parallel readers                      |                       180-300 |
| Atomic claim, answer, refund-result, and activity batches                |                       130-220 |
| Browser/callback/cancel/diagnostic and direct-webhook changes            |                       170-270 |
| Bounds, shared retry allowance, site rules, instrumentation, file splits |                       100-180 |
| **Total before deletions**                                               |               **1,170-1,870** |

This estimate is retained only to explain the historical review. Remaining
provider-safety work ships through the atomic `PLAN.md` M6-M11 cutover. That
cutover deletes the old checkout runtime as it activates the new one; a source
budget cannot justify leaving a parallel reader behind.

## Regression and mutation plan

This is the acceptance inventory for the atomic M6-M11 cutover, plus the tests
that already pin #2048, #2050, #2060, and M4. Reconcile paths with the current
tree when implementing it; no test may keep an old runtime callable merely to
compare it with the new one.

M4's as-built authority is deliberately split by responsibility without becoming
parallel. `payment/refund-authority-state.ts` owns the stored union, codec,
validation, and mirrors; `payment/refund-authority.ts` owns pure automatic
transitions; `payment/refund-authority-choice.ts` owns conflict/owner
transitions, derives the non-empty allowed-choice set, and exports the
exhaustive `mayReplaceRefundWithFreshEvidence` rule;
`payment/refund-conflict-decision.ts` derives the exact safe answer; and
`payment/refund-authority-lifecycle.ts` declares every block and exit.
`db/provider-refund-authority.ts` owns identity creation/binding and
`db/provider-refund-authority-change.ts` owns every Money/state write;
`db/provider-refund-case-resolution.ts` uses that writer inside the transaction
that also commits the owner activity audit. The architecture test permits
exactly those two database writer modules as one logical boundary. Production
and tests both call the same refund readiness implementation; a test-side copy
is forbidden.

The state schema itself separates `needs_owner_choice` from
`needs_provider_check`: the first cannot be stored without a real answer, while
the second cannot be resolved by an owner money guess. Exact zero return admits
only not sent, exact full return only returned, and partial/inconclusive
evidence only Check again. A fresh partial or invalid observation replaces
ordinary ambiguity and increments the revision; conclusive conflict choices do
not get rewritten by later reads. Rendered owner sends and choices carry the
authority id and revision, with the send losing before provider I/O and every
write losing its CAS rather than overwriting newer evidence. These boundaries
are pinned by `test/shared/payment/refund-authority-choice.test.ts`,
`test/shared/provider-refunds/{state,state-owner-revision}.test.ts`, and
`test/integration/server/privacy-refund-recovery-race.test.ts`.

The other current hard bounds are executable too:
`test/shared/square-provider/webhook-fields.test.ts` rejects missing and unknown
Square payment statuses;
`test/shared/db/payment-claim/take/shared-references.test.ts` accepts 100
outside sharing rows and uses row 101 only to refuse before decrypting shared
state; and `test/shared/db/refund-all-candidates.test.ts` pins a PII-free
summary plus selection before the one-row encrypted attendee join.

At verified source checkpoint `31492eb2936dea7d7ac51d225d8af3f8fc18d95a`, M4's
focused `resolving-uncertain-refunds.feature` has four scenarios and 43 executed
Cucumber steps, including the unreadable-ready zero-send exit. The completed
full run passes 261 scenarios and 1,863 executed steps. Older suite-wide counts
are not authority.

Direct deterministic coverage for the remaining cutover must include:

- strict Stripe Session parsing (`livemode`, string/expanded/null
  `payment_intent`) in `test/shared/stripe/schemas.test.ts`;
- Square snake-case Order/Payment ID/location/tender mapping under
  `test/shared/square/`, not only provider mocks;
- SumUp checkout/transaction ID/status/money/merchant normalization under
  `test/shared/sumup/`, backed by all four reviewed sandbox fixtures: one
  checkout response for ownership and one transaction response for refund
  confirmation, with no invented status/field combination;
- direct wire-parser tables covering every documented union and sanitized real
  shape, plus malformed mutations that assert only strict parser rejection;
- path-aware pure ownership tables with zero/one/many children using valid
  parsed observations, including real missing/read outcomes and contradictory
  facts but no malformed wire objects or copied expected/observed fact;
- bound configuration with a barrier between capture, provider response,
  settings change, classification, and refund; configuration B must never
  receive A's refund reference;
- browser success and cancel exact `400` permanent and `503` temporary pages,
  including site proof before listing reads;
- reachable callback states only: Stripe contradictory documented embedded
  facts; Square missing/unavailable/contradictory reads; known SumUp
  evidence-backed equivalents; and unstaged SumUp local refusal. Every
  provider's malformed HTTP mapping is tested by injecting the parser's typed
  outcome, never a fictional integration payload;
- direct shared mapping of every typed retry reason to exact `503`,
  `text/plain; charset=utf-8`, and `Payment verification failed`;
- well-formed owned charges preserving safe-refund behavior after downstream
  rejection, documented paid-without-child variants never becoming settled,
  invalid proof never refunding foreign money, and valid proof with unreadable
  intent upserting one private owner case;
- finite SumUp pre-ID retry, zero-row staging update, forged-ID no-provider-read
  and no-notification behavior, staging expiry, duplicate callbacks, browser/
  callback races, and refund recovery;
- webhook bodies delivered as one and several chunks at exactly 64 KiB and one
  byte over, including absent or false `Content-Length`; preserve accepted raw
  bytes exactly. Test provider IDs at exactly 255 UTF-8 bytes and one byte over,
  proving rejection happens before DB/provider use;
- privacy sentinels through raw parsing, SDK/transport failures, converter,
  route errors, console, activity, ntfy, and Sentry; exact expected console-only
  behavior; and only the approved narrow durable fields;
- provider-qualified completion replay before provider/staging IO, owner-case
  idempotent upsert and authenticated visibility, and browser/cancel completed
  replay with valid, absent, and foreign site proof. Process the same Square and
  SumUp payment through their alternate Payment/transaction identifiers and
  prove both resolve to the original canonical Order/checkout row;
- 16 expanded lines and 16 distinct webhook URLs accepted. Refuse 17 before
  provider creation and after signed-intent parse with zero provider creation
  and zero webhook POSTs, while the confirmation email still succeeds.
  Site-assignment quantity one is accepted and two rejected, with no site-build
  call reachable from payment completion;
- direct registration webhook delivery for every 3xx and a stalled endpoint: one
  POST per distinct validated configured URL with `redirect: "manual"`, no
  redirected-target request or attendee-data disclosure, exactly one
  consolidated value-free failure activity for one, two, and 16 failures, zero
  for all-success, and no ntfy/Sentry fan-out. Accept a 64 KiB response body;
  cancel and return the typed failure for one byte over;
- mixed registration delivery outcomes preserve a refused sibling beside every
  unexpected reason, wait for both channels, create one failure activity, make
  exactly one ntfy/Sentry fan-out, attach no raw exception, and only then
  rethrow the first original reason locally;
- one paid-order snapshot DB round trip whose rows drive validation, modifier
  resolution, email, webhook, cancel, and refund rendering; direct query-count
  tests must fail if any removed parallel reader returns;
- fresh/conflicting/stale claims all use one atomic claim batch; all paid
  choice/ stored-text answer replacements use one batch; any number of promo and
  registration activities use one batch; refunded-result persistence uses one;
- a committed write batch whose response is lost and retried creates no
  duplicate activity, booking, answer, ledger, claim, owner-case, or
  finalization row. Inject failure between every batch and prove completion is
  invisible until the final activity/completion batch succeeds;
- request-wide DB retry tables for zero, one, two, and refused third extra
  attempts, including no sleep before a refused retry and no payment-path
  interactive transaction retry;
- exact cold-ready request-total maxima for every row above, including both
  emails, 16 direct webhooks, SumUp staging/instrumentation, assignment,
  renewal, consolidated delivery failure, organic-maintenance refusal, and
  lazy-import/ cold-start contracts without subprocess-only coverage.

Split any touched source or test file over the repository's roughly 400-line
target. Keep claim races separate from refund recovery and fixture construction
separate from posting/assertion helpers. A file-size note in this historical
document is not authority for recreating a deleted monolith.

Mutation paths must mirror the current `scripts/mutation/test-map.ts`. Stripe
schema coverage lives under `test/shared/stripe/`; Square and SumUp coverage now
span their focused provider/module directories, and webhook mutation must name
the changed integration payment-ownership suites. Do not restore the deleted
`src/shared/square.ts` or obsolete test paths to satisfy this old inventory.

After implementation only: run targeted mirrored tests, coverage and inspect all
changed branches, `test:quality-audit`, targeted exhaustive mutation where
practical, `precommit`, then committed-diff `precommit:mutation`. This review
ran none of those commands.

## Adversarial review

This table records the design challenges and decisions that produced the
evidence above. "Resolved" means resolved in that design review unless the
as-built sections explicitly say the mechanism shipped; it is not a claim that
the remaining checkout cutover is live.

| Attack                                                                         | Evidence                                                                                                                                            | Verdict                                      | Exact plan correction                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Trusted provider fields may not exist                                          | Stripe's pinned union permits expanded PaymentIntent; Square uses unchecked optional casts; SumUp merchant/transaction fields are optional in 0.1.6 | **Resolved**                                 | Parse every documented Stripe shape; add Square runtime schemas; define SumUp's status-specific schemas from the reviewed pending/paid/failed/refunded fixtures                                                                                  |
| Fictional provider states can multiply normal branches                         | Optional wire fields and synthetic fixtures can invite defaults, fallback names, alternate normalizers, and recovery paths no endpoint produces     | **Constraint approved**                      | Normal schemas/states come only from pinned contracts, endpoint documentation, and required sanitized real fixtures; every contract violation maps once to `malformed`, and malformed tests stop at the parser boundary                          |
| Expected facts may be copied from observations                                 | Stripe callback “requested ID” came from the same embedded Session; SumUp callback DB cannot return plaintext reference                             | **Former proof was tautological/impossible** | Use path-aware expected variants. Treat Stripe ID as signed observed identity. Bind SumUp returned reference back to a row whose independently stored `sumupId` matches callback/fetched ID                                                      |
| Stripe child-parent proof is overstated                                        | Session only names `payment_intent`; no independent PaymentIntent parent or account field is read                                                   | **Partial relationship only**                | Claim only that processing uses the Session-named child. Support expanded IDs. Do not claim child existence, parent, or account continuity                                                                                                       |
| Square exact child proof was incomplete                                        | Browser expected child was null and observed schema dropped tender-selected ID; real Order has `tenders[]`                                          | **Correction approved**                      | Retain child selector IDs and returned Payments as collections; inspect at most eight IDs; require exactly one valid completed candidate and refuse ambiguity                                                                                    |
| SumUp exact child proof was incomplete                                         | Former observed shape omitted named transaction ID, array status, and transaction money while claiming successful child proof                       | **Resolved**                                 | Paid checkout schema requires `transaction_id` and exactly one matching transaction with successful status, money, currency, and merchant; pending/failed schemas preserve their observed omissions and arrays                                   |
| Ownership, status, site, and price were mixed                                  | Former “incomplete ownership” included status/money/metadata while exact contract excluded them                                                     | **Contradictory**                            | Use the seven ordered layers above; ownership authorizes no booking/refund by itself                                                                                                                                                             |
| Contract-backed paid money without usable processing facts can be acknowledged | Existing `blank_reference` is `settled: true`; valid proof with unreadable intent returns null and webhook acknowledges                             | **Correction approved**                      | For documented paid-without-child variants and valid-proof unreadable intent, add unresolved-paid outcomes, bind refund to the accepted attempt, return retryably, and upsert the approved private owner case; malformed wire data stops earlier |
| Browser and cancel states were underspecified                                  | Current missing returns HTML 400-like payment error; thrown availability errors become route 503; cancel reads unsigned metadata                    | **Correction approved**                      | Use the exact localized `400` permanent and `503` temporary pages and verify site proof before cancel listing lookup                                                                                                                             |
| Callback/pending matrix claimed impossible states                              | Stripe callback makes no provider read; Square skips non-completed events before reads; SumUp must read known IDs                                   | **Correction approved**                      | Keep the reachable-state matrix; Square non-completed notices acknowledge with zero reads; direct-test shared response mapping separately                                                                                                        |
| Replays are not stable under fresh proof                                       | SumUp staging expires; settings can change; completed rows use flat session IDs                                                                     | **Correction approved**                      | Write and consult the provider-qualified completed record before provider or staging IO                                                                                                                                                          |
| Forged SumUp IDs can amplify work                                              | One DB prefilter is bounded, but `logError` adds activity/ntfy/Sentry; body and ID sizes are unbounded                                              | **Correction approved**                      | Limit body/ID, do one DB lookup, zero provider calls and zero per-attempt external/error sinks                                                                                                                                                   |
| Configuration snapshot was not real                                            | Resolver, verifier, clients, comparisons, currency, and refunds reread mutable settings independently                                               | **Correction approved**                      | Introduce one bound attempt before authentication and use it through settlement                                                                                                                                                                  |
| Concurrency can refund through the wrong provider                              | `tryRefund` resolves provider again after acceptance                                                                                                | **Correction approved**                      | Pass bound settlement capability/context through every automatic refund and status confirmation                                                                                                                                                  |
| Exact 503 contract was wrong                                                   | `plainResponse` emits `text/plain; charset=utf-8`                                                                                                   | **Correctable**                              | Use the exact helper/header/body contract stated above; no parallel response constructor                                                                                                                                                         |
| Retry consequences were overstated                                             | SumUp documents four retries ending at 2 hours; configuration/staging failures may outlive them                                                     | **Correction approved**                      | Keep finite retry wording and the provider-qualified owner/completion record; do not rely on eventual redelivery as durable recovery                                                                                                             |
| Privacy promise did not cover actual sinks                                     | Raw payload logs, parser text, SDK errors, activity, ntfy, and Sentry remain upstream/downstream of converter                                       | **Correction approved**                      | Sanitize at parse/transport boundaries; expected outcomes are fixed console-only classes; only sanitized unexpected failures reach activity/ntfy/Sentry                                                                                          |
| No-new-persistence claim conflicts with recovery                               | Finite retries cannot repair invalid proof, missing child, expired staging, or changed configuration                                                | **Correction approved**                      | Add the one narrow provider-qualified completed/owner-action record; keep raw responses, metadata, payloads, credentials, and PII out                                                                                                            |
| Provider/DB call and 50-call claims were incomplete                            | Stripe retries multiply calls; SumUp is uncounted; settings, processing, refunds, diagnostics, and follow-up were omitted                           | **Resolved**                                 | One snapshot, atomic batches, 16-line/webhook bounds, two shared DB retries, one prebuilt-site assignment, and approved direct-only webhook delivery produce a 48-call maximum with two-call headroom                                            |
| Cold-start guarantee could regress                                             | Providers are currently lazy-loaded; a shared contract could statically import SDK-backed modules                                                   | **Feasible with constraint**                 | Keep pure schemas SDK-free and factories behind `providerLoaders`; add import-graph/cold-start contract coverage                                                                                                                                 |
| Proposed schema/API could not enforce its promise                              | Stateless methods begin after provider selection/signature and nullable transports erase read states                                                | **Correction approved**                      | Use the bound attempt plus real typed missing/unavailable outcomes, one parser-produced malformed outcome, and decision-produced contradictory outcomes                                                                                          |
| Old API removal missed callers                                                 | Source callers, test stubs, provider fallback calls, and `asSession` use old union                                                                  | **Incomplete migration**                     | Migrate the inventory above atomically; delete methods and old helper union with no aliases                                                                                                                                                      |
| Zero duplication and one-or-many were not satisfied                            | Existing key-mode helpers overlap; singular `ownedChild` sat beside provider arrays; browser/callback gathering could duplicate                     | **Resolved in plan**                         | Reuse `keyModeOf`; arrays everywhere; one provider-local gatherer parameterized by source; one shared decision/gate/response mapper; delete the superseded readers during migration                                                              |
| Under-800 source claim was not realistic                                       | Snapshot, transports, parsers, refunds, cancel proof, diagnostics, limits, splits, and instrumentation were omitted                                 | **Resolved, not a blocker**                  | Keep the full one-PR safety scope and honest 1,170-1,870 estimate; the former 800-line limit is relaxed                                                                                                                                          |
| Coverage/mutation/file-size plan was inaccurate                                | Missing direct mapper/schema tests, invalid mutation globs and target paths, touched tests/helpers already over 400                                 | **Resolved in plan**                         | Use the corrected direct suites, split touched files, map mutations by mirror path, and keep every resulting file below 400                                                                                                                      |

## Recommendation

The provider evidence, bounded processing core, direct-only webhook delivery,
strict SumUp observation, and M4 refund authority are retained as implemented
foundations. The 48-call conclusion and synchronous/no-outbox decision explain
the historical design; they are not authority for the final cutover. Remaining
work follows `PLAN.md` M6-M11, recalculates its budget from current code, and
activates only after it can delete every legacy whole-checkout path in the same
change.
