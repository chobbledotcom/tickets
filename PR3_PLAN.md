# PR 3: current payment-provider scope and resource relationships

## Status

**Approved for implementation.** The provider direction, behavioral choices,
SumUp schema, 16-line/webhook bound, two-attempt shared DB retry allowance,
one-prebuilt-site assignment bound, and direct-only registration-webhook policy
are settled. The reduced synchronous design fits below Bunny's limit with a
proven 48-call maximum and two-call headroom. The revised source estimate is
1,170-1,870 changed/added lines before deletions.

### Implementation progress

The first merge slice is intentionally narrow: registration webhooks make one
direct request per configured URL, never follow redirects, stop before sending
to more than 16 distinct URLs, and record one value-free failure. This slice
changes 222 lines in `src/`; the provider-observation implementation was removed
from the merge diff after it exceeded the agreed roughly 1,000-line source
limit.

The remaining provider work stays specified in this plan and must ship as
separate, independently green slices of roughly 1,000 changed `src/` lines or
less:

1. Add strict, evidence-backed Stripe observations and typed read outcomes.
2. Add strict Square observations, location/parent checks, and bounded tender
   selection.
3. Add strict SumUp checkout, transaction, merchant, and refund observations.
4. Bind one provider attempt through browser, callback, refund, and status
   paths.
5. Add the bounded webhook request/parser/privacy boundary and fixed retry
   response.
6. Add provider-qualified replay and private owner-action records.
7. Add shared payment retry credits and exact request-budget tests.

The bounded processing core is complete. A successful paid order now uses four
database calls when there are no answers and five when answers must be replaced:
one conditional processing claim, one paid-order snapshot, one atomic booking
and finalization batch, the optional answer batch, and one combined activity
batch. Email and webhook rendering add no database reads. Direct call-count
tests hold for orders at the 16-line bound. The completed slice passed 21,892
tests with 100% line and branch coverage, strict type checking and linting, zero
code clones, and targeted mutation at 100% for its substantive modules.

The completed slice changed the source tree by 6,487 added lines and 7,053
deleted lines, a net reduction of 566 lines. The gross additions exceed the
1,170-1,870 estimate because every touched source and test file was brought
under the 400-line limit. That required splitting several existing admin,
payment, email, listing, modifier, and code-quality monoliths and moving their
existing tests into focused suites. Those moved lines are modularization, not
new payment behavior. The behavioral part is the paid-order snapshot, atomic
claim/answer/activity writes, and removal of their superseded parallel readers.

## Goal and honest guarantee

PR 3 should put Stripe, Square, and SumUp browser returns and completion
callbacks through one current-observation boundary before booking or automatic
refund. The strongest guarantee available without a persisted historical
provider-account identity is narrower than historical provider ownership:

> A provider response may enter payment processing only when its current
> provider scope, top-level resource, and every child used by processing agree
> with independent request, signature, staging, and provider facts available on
> that path. Site proof, charge shape, price, and processing remain separate
> checks. Facts the provider does not expose are not invented.

This guarantee is named **current provider-scope/resource consistency**, not
historical provider ownership. It does **not** prove the Stripe account or
Square merchant that created an old checkout or preserve every checkout-time
provider fact. PR 3 does add a provider-qualified durable session record for
completed replay and private owner recovery; that record does not turn a current
observation into historical account proof.

## Current production evidence

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

The provider contract and bounded request design are evidence-backed and all
behavioral choices are approved. The implementation must keep these layers
distinct:

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

**One-response verdict:** pass for pending/paid/failed ownership and payment
observation. SumUp browser and known-callback paths use staging plus one
checkout read; no transaction read or checkout-time merchant persistence is
added. Refund-status confirmation keeps its existing one transaction read but
must parse `transaction_events[]` and compare successful refund-event totals
with the transaction amount instead of reading only top-level transaction
status. No SumUp provider call count increases.

All narrow schemas that promise rejection of unknown properties use
`v.strictObject`; ordinary `v.object` strips extras and must not be described as
rejecting them. Provider wire schemas and request-local ownership schemas are
different boundaries and must not be conflated.

## State and HTTP matrix

| Path/state                                              | Provider/DB work                                                                   | Processing                                                                                               | HTTP behavior                                                                                                                     |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Stripe callback, malformed/contradictory embedded facts | Zero Stripe reads                                                                  | No booking/refund while relationship or scope is unproven                                                | Exact retry response below                                                                                                        |
| Stripe callback, pending                                | Zero Stripe reads                                                                  | No booking/refund                                                                                        | Authenticated non-processing `200` pending acknowledgement while card-only creation remains enforced                              |
| Square callback, non-completed signed notice            | Zero provider reads                                                                | No booking/refund                                                                                        | `200` non-processing acknowledgement; ownership is not claimed because no resource read occurred                                  |
| Square completed callback                               | One Order + one signed Payment read                                                | Continue only after exact ID/parent/location, charge, site, and price checks                             | Existing handled success/pending response; rejection uses exact retry response when retryable                                     |
| Known SumUp callback                                    | Two staging DB reads + one checkout read                                           | Continue only after returned-reference binding and the evidence-backed checkout/transaction relationship | Existing handled success/pending response; retryable refusal uses exact retry response                                            |
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

`setSumupCheckoutId` must be changed to require exactly one affected row before
the hosted URL is exposed. The `503` closes the normal pre-ID race only while
that write succeeds within SumUp's finite retry window; it is not durable
reconciliation.

## Concurrency, idempotency, and persistence

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
- Automatic refund and `isPaymentRefunded` must use the bound attempt that
  accepted the resource. Re-resolving global provider settings is forbidden.
- Add one provider-qualified durable session mechanism with a database `UNIQUE`
  constraint on `(provider, top-level resource kind, resource ID)`. Its
  exhaustive outcome is `completed` with the existing handled-result reference,
  or `owner_action_required` with a fixed reason (`paid_child_unusable` or
  `paid_intent_unreadable`), created/updated timestamps, and resolution state.
  It stores no raw response, metadata, payload, credential, mismatch value, or
  copied PII. Use an atomic upsert on that conflict target. Repeated failures
  update the same case rather than create duplicates. Migrate
  `processed_payments`, its processing claim, and ledger replay to this tuple;
  remove flat `payment_session_id` authority in the same slice.
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

- Read payment webhook bodies incrementally from `request.body.getReader()`
  before provider work. Preserve the collected raw bytes unchanged for signature
  verification. Accept exactly 64 KiB and cancel/reject as soon as accumulated
  bytes exceed that bound, regardless of `Content-Length` or chunking. Reject
  provider IDs over 255 UTF-8 bytes before DB/provider use. The current generic
  request buffering and webhook `arrayBuffer()` are unbounded
  (`src/features/request-body.ts:31-38`,
  `src/features/api/webhooks.ts:389-395`).
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

The former two stateless replacement methods are insufficient. Replace them with
one request-local bound provider attempt created before authentication. It owns
signature verification, browser and callback observation, current expected
scope, automatic refund, and refund-status confirmation using one captured
configuration/client. Secrets stay private to the attempt.

Required migration inventory:

- Delete `PaymentProvider.retrieveSession` and `resolveWebhookSession` after all
  source callers and provider implementations migrate.
- Migrate direct test stubs in
  `test/features/api/payment-processing/classify.test.ts`,
  `test/features/api/webhooks/provider.test.ts`, cancel/session-resolution/item-
  validation/unrecognized-session integration suites, all three provider suites,
  and `test/test-utils/payment-session.ts`.
- Keep checkout creation and admin refund/refresh outside the new observation
  API; automatic refunds caused by the observed session must use the bound
  attempt. Do not leave an alias or compatibility wrapper.
- Move new provider/read contracts out of `src/shared/payments.ts` because that
  file is already about 391 lines. Extract Square read schemas/transport from
  the roughly 966-line `src/shared/square.ts`; keep response/diagnostic mapping
  out of the 486-line webhook route and strict parsing out of the 735-line
  `payment-helpers.ts`.
- Consolidate Stripe key-mode parsing onto existing `keyModeOf` in
  `src/shared/db/settings/constants.ts`; remove `detectStripeKeyMode` rather
  than adding a third implementation.
- Keep provider-specific collection gathering behind lazy provider loaders.
  `ownership.ts` imports no SDK, no top-level IO is added, and SumUp/Stripe SDKs
  must not enter the shared route's eager module graph.

## Subrequest and source budgets

The old “no call increase” and 545-755-line claims are withdrawn.

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

### Settled provider maxima

| Path                             | Observation | Failed refund plus status confirmation | Combined provider maximum |
| -------------------------------- | ----------: | -------------------------------------: | ------------------------: |
| Stripe browser                   |           3 |                                      6 |                         9 |
| Stripe signed callback           |           0 |                                      6 |                         6 |
| Square browser, eight tender IDs |           9 |                                      3 |                        12 |
| Square completed callback        |           2 |                                      3 |                         5 |
| Square non-completed callback    |           0 |                                      0 |                         0 |
| SumUp staged browser or callback |           1 |                                      2 |                         3 |
| SumUp unstaged callback          |           0 |                                      0 |                         0 |

### One bounded processing mechanism

Do not preserve the old parallel readers. Build one paid-order snapshot with one
`queryBatch` after the processing claim. Its statements load ledger disposition,
current listings, package display/membership/prices, hidden membership, both
directions of listing relationships, referenced modifiers and their scopes, both
contact visit counts, public status, and question/answer facts. Fold and
validate the rows in memory. The same snapshot supplies booking creation, email
package display, webhook package prices, cancel rendering, and refunded-result
storage.

The maximum successful core is five DB calls regardless of line, modifier,
package, promo, or answer count within the 16-line bound:

1. One atomic conditional claim batch acquires a fresh or stale
   `processed_payments` row and returns an existing completed row on conflict.
2. One paid-order snapshot batch includes ledger preflight and every current
   read.
3. One existing atomic booking/finalization batch writes attendee, bookings,
   modifier use, ledger, contact activity, and provider-qualified completion.
4. One optional answer-replacement batch uses `INSERT ... SELECT` for validated
   choice and stored-text IDs; no begin/statement/commit transaction remains.
5. One activity batch writes every promo and registration entry together.

Email and webhook rendering add zero DB reads. At most two registration emails
add two external calls. A prebuilt-site link joins the buyer confirmation
instead of creating a third email. Refunded-result
attendee/ledger/activity/note/terminal state is likewise one batch using the
snapshot rather than parallel rereads.

### Exact request totals

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
room for all three safe unexpected-error sinks instead; an attempted failure-
activity write is call 48 and reports its own failure to console only. No
diagnostic path exceeds 50.

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

### Approved direct-only webhook policy

Current registration webhooks follow five redirects and repeat the POST body, so
16 URLs can consume 96 fetches. The ordinary Square browser maximum would become
120 and the assignment-plus-renewal maximum 127 (128 with the consolidated
failure activity). No batching can make that fit.

Registration webhooks are **direct-only**: deduplicate non-empty configured
URLs, validate and count that set, then make exactly one POST per distinct
validated URL. Force `redirect: "manual"`. Every 3xx is a typed failed delivery
and is never followed. Attendee data is never sent to the redirected location.
Each request has a 10-second timeout covering connection and response-body work;
a timeout is a typed failed delivery so pending work always settles. No outbox
is required for the approved synchronous bound.

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

The remaining provider-safety scope ships through the bounded slices listed
above. The estimate includes the batching and hard-bound work; deleting the old
parallel readers is mandatory and may reduce net growth but not changed lines.

## Regression and mutation plan

The full test plan is fixed. It must include direct deterministic tests for:

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
  replay with valid, absent, and foreign site proof;
- 16 expanded lines and 16 distinct webhook URLs accepted. Refuse 17 before
  provider creation and after signed-intent parse with zero provider creation
  and zero webhook POSTs, while the confirmation email still succeeds.
  Site-assignment quantity one is accepted and two rejected, with no site-build
  call reachable from payment completion;
- direct registration webhook delivery for every 3xx and a stalled endpoint: one
  POST per distinct validated configured URL with `redirect: "manual"`, no
  redirected-target request or attendee-data disclosure, exactly one
  consolidated value-free failure activity for one, two, and 16 failures, zero
  for all-success, and no ntfy/Sentry fan-out;
- one paid-order snapshot DB round trip whose rows drive validation, modifier
  resolution, email, webhook, cancel, and refund rendering; direct query-count
  tests must fail if any removed parallel reader returns;
- fresh/conflicting/stale claims all use one atomic claim batch; all paid
  choice/ stored-text answer replacements use one batch; any number of promo and
  registration activities use one batch; refunded-result persistence uses one;
- a committed write batch whose response is lost and retried creates no
  duplicate activity, booking, answer, ledger, claim, owner-case, or
  finalization row;
- request-wide DB retry tables for zero, one, two, and refused third extra
  attempts, including no sleep before a refused retry and no payment-path
  interactive transaction retry;
- exact cold-ready request-total maxima for every row above, including both
  emails, 16 direct webhooks, SumUp staging/instrumentation, assignment,
  renewal, consolidated delivery failure, organic-maintenance refusal, and
  lazy-import/ cold-start contracts without subprocess-only coverage.

Split touched legacy files as part of migration: root Square provider tests and
its webhook suite already exceed 400 lines; `test/test-utils/webhooks.ts` is
over 400; the existing post-commit recovery suite is about 400. Split claim
races from refund recovery and split fixture construction from posting/assertion
helpers. Every resulting test file must be below 400 lines.

Mutation paths must mirror `scripts/mutation/test-map.ts`: Stripe schema uses
`test/shared/stripe/schemas.test.ts`; `src/shared/square.ts` uses
`test/shared/square/*.test.ts`; `src/shared/sumup.ts` uses
`test/shared/sumup.test.ts` and `test/shared/sumup/*.test.ts`. Webhook mutation
must also name the changed integration payment-ownership suites. The old
targeted paths `test/integration/server/payments-success-basic.test.ts` and
`payments-success-replay.test.ts` are invalid; the real paths are
`test/integration/server/payments/success.test.ts` and
`payments/replay.test.ts`. The root `test/shared/stripe-provider.test.ts` must
be included explicitly.

After implementation only: run targeted mirrored tests, coverage and inspect all
changed branches, `test:quality-audit`, targeted exhaustive mutation where
practical, `precommit`, then committed-diff `precommit:mutation`. This review
ran none of those commands.

## Adversarial review

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

The complete plan is approved for implementation. Provider evidence, request
reduction, and direct-only webhook delivery are reconciled. The complete
cold-ready maximum is 48 calls, leaving two below Bunny's limit; ordinary Square
success is 40 before organic maintenance and at most 42 after it. No outbox is
needed.
