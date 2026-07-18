# Durable payment sessions

This is the agreed technical direction for completing staged checkout. It
replaces parallel checkout-stage, payment-reservation, callback, cleanup, and
replay paths with one durable lifecycle.

## Goals

- Never hold capacity while a customer pays.
- Recover provider success even when a response, redirect, or webhook is lost.
- Produce one booking or one full refund, never both and never twice.
- Route every old checkout and charge through the provider account that owns it.
- Keep exact token-free terminal status replay while removing PII and secrets as
  soon as possible.
- Use the shared durable booking-completion system after an isolate dies.
- Keep every request within Bunny's time and subrequest limits.

## One lifecycle

Replace `checkout_stages` and `processed_payments` with `payment_sessions`.
Create one row before provider IO for both booking and balance checkouts.

Use a stable application checkout UUID. Store its HMAC as the indexed lookup key
and its encrypted value only while provider work needs it. Browser and provider
callbacks carry the application checkout ID; provider IDs are assertions and
secondary indexed lookups, not the application's primary identity.

The states are:

- `creating`: the exact provider request is durable, but provider IDs may not be
  attached yet.
- `pending`: the provider checkout may be open, closed, or paid.
- `refunding`: activation is permanently forbidden and a full refund must
  finish.
- `succeeded`: immutable terminal booking or balance-payment success.
- `failed`: immutable handled failure, including a durably completed refund.

Processing ownership is orthogonal to state:

- `next_attempt_at`
- `lease_token` and `lease_expires_at`
- `attempt_count` and `last_attempt_at`

All state-changing SQL is fenced by the current lease token. Provider IO never
runs inside a database transaction. A stale worker may finish a provider call,
but cannot write after another worker owns the session.

## Session data

Define canonical intent with a Valibot `v.variant("kind", ...)`, not optional
fields shared by two cases. Non-terminal sessions store:

- kind-specific booking or balance intent
- immutable payment account
- expected amount and currency
- encrypted, versioned canonical checkout intent
- provider-create attempt identity and idempotency key/reference
- provider session and close IDs when known
- encrypted hosted URL while it can still be used
- staged attendee for booking sessions
- durable cancel request time
- payment reference once known
- refund reason, amount, attempt number, key, provider operation ID, and exact
  provider status while refunding
- due time, lease, and retry fields

The canonical intent freezes pricing, booking rows, answers, contact details,
callback URLs, provider expiry, and other request facts before the first provider
call. A retry must reproduce the same provider request rather than recalculate
fees or read changed settings.

Booking creation atomically writes the `creating` session, attendee, and
quantity-zero booking rows. The availability preflight remains advisory. Only
terminal activation changes quantities and claims capacity.

Booking intent requires its staged attendee, contact data, and quantity-zero
rows. Balance intent requires the existing attendee and exact amount owed, and
forbids booking contact placeholders or staged rows. If two balance sessions are
paid, the first valid settlement wins and every later captured payment enters a
full refund.

## Payment accounts

Provider type is not enough ownership. Add an encrypted payment-account
registry keyed by an immutable identity:

`provider + environment + provider-returned account or merchant ID`

Examples are Stripe's account ID, Square's merchant ID, and SumUp's verified
merchant code. Store mutable credentials in the account's encrypted config.
Rotating a key for the same account updates that config. Credentials for a
different account create a different account row instead of overwriting the old
owner.

Replace the active provider setting and global credential reads with
`active_payment_account_id`. New checkout creation alone uses that account and
binds it before provider IO. Redirects, webhooks, cancel, scheduled work,
automatic refunds, admin refunds, refreshes, and dashboard links resolve stored
ownership and never fall back to active settings.

Connection checks must return and validate account identity. Keep inactive
account credentials while a live session or refundable charge references them.
If credentials are missing, fail closed and name the account the operator must
restore.

Account-bound client constructors receive a validated encrypted config snapshot
and never read mutable global provider settings during an operation. Account
identity verification is an authenticated setup or pre-deploy action, not
provider IO inside a database migration.

Legacy charge ownership stays explicitly unknown until an authenticated
read-only provider probe proves one owner or the operator makes a required,
unselected choice. Never assign the currently active account as a migration
default.

### Webhook endpoints

Store each provider webhook endpoint separately with an opaque public route ID,
payment account, encrypted signing secret, provider endpoint ID, and
active/retiring state. The route ID selects a bounded local record before body
verification; it does not trust an account claimed by an unverified payload.
Verify with that endpoint's retained account-bound secret, then parse and
reconcile the session.

Keep retiring endpoints for their documented provider delivery window. SumUp's
unsigned boundary uses its route-bound account, an indexed local checkout-ID
lookup, and an authoritative provider refetch. Bound every webhook body and
never log raw payloads.

## Charges and replay

Store refundable charges separately from terminal outcomes. A charge records:

- owning payment account
- terminal payment session
- attendee
- owner-key-encrypted provider reference
- retained HMAC provider-reference index
- amount and currency
- provider-refunded time

Enforce one `(payment_account_id, provider_reference_index)` charge. This lets
the encrypted reference be redacted after refund or erasure without deleting
deduplication or replay history.

Every terminal session keeps a small non-PII outcome indefinitely:

- HMAC session index
- succeeded or failed state
- versioned public result
- terminal time
- immutable completion ID when booking effects exist

The permanent public result is PII-free and ticket-token-free. Ticket delivery
is a separate ephemeral handoff while the attendee remains live. Routine pruning
never removes the terminal row; it removes provider IDs, canonical intent,
hosted URL, refund details, payment reference, ticket delivery data, and
completion PII when each is no longer needed.

Redirect replay loads the terminal row before contacting a provider. The money
ledger remains the accounting record and an invariant check, not a second replay
implementation. New sessions with ledger effects but no terminal row are
corrupt and fail loudly.

## One reconciler

Every signal calls:

`reconcilePaymentSession(checkoutId)`

The operation first returns an immutable terminal outcome when one exists.
Otherwise it claims the session, loads its bound account, and performs the one
legal transition for its current state.

### Creating

1. Reproduce the frozen provider request with the stored attempt identity.
2. Recover the original checkout after an uncertain response.
3. Atomically attach all provider IDs and encrypted URL.
4. Move to `pending`, then expose the URL through a stable local checkout-status
   route. Browser forms carry that checkout ID before provider IO; JSON callers
   use an `Idempotency-Key`. Reusing an ID with different canonical intent is a
   conflict.
5. On authoritative create rejection, atomically remove staged booking rows and
   store a terminal `failed` result.
6. Stripe and Square creation uncertainty remains recoverable only within their
   documented idempotency lifetime. SumUp uses exact-reference lookup. If no
   provider can prove absence, retain and alert; never delete uncertain work by
   declaring it absent after a timer.

### Pending

1. Inspect authoritative provider state.
2. Before provider expiry, keep an open checkout due. At expiry or after a
   durable cancellation request, ask the provider to close it.
3. After authoritative unpaid closure, atomically remove the session's staged
   attendee and rows and store a terminal `failed` result.
4. On payment, compare provider amount and currency with the frozen intent. In
   one transaction, run staged activation, create the account-owned charge,
   store the terminal `succeeded` result, and attach the existing completion
   plan.
5. If activation cannot succeed, atomically enter `refunding` with every field
   needed for later recovery before refund provider IO.

### Refunding

1. Never evaluate activation again.
2. Inspect the durable refund operation before considering submission.
3. Reuse one attempt identity while its result is pending or uncertain.
4. Persist a new attempt identity only after authoritative terminal failure.
5. On full provider refund, atomically write refund ledger effects, transition
   to terminal `failed`, store the public result, update charge status, and clean
   staged rows.
6. On pending or uncertain results, release with bounded absolute backoff.

### Terminal

Return the stored token-free result and wake its durable completion by ID. Do not
call the payment provider merely to replay a result. Terminal rows never return
to a non-terminal state and routine cleanup never deletes them.

### Transition table

The schema and one pure transition function allow only:

| From | Authoritative fact | To |
| --- | --- | --- |
| `creating` | checkout ready or recovered | `pending` |
| `creating` | provider rejected before creation | `failed` |
| `creating` | result uncertain | `creating` with backoff |
| `pending` | open before expiry | `pending` with next due time |
| `pending` | closed unpaid | `failed` after staged cleanup |
| `pending` | paid and activation commits | `succeeded` |
| `pending` | paid but activation cannot succeed | `refunding` |
| `refunding` | pending or uncertain attempt | `refunding` with backoff |
| `refunding` | terminal attempt failure | `refunding` with new attempt |
| `refunding` | full refund and local commit | `failed` |
| terminal | replay | same terminal state |

Every transition is fenced by the session lease and checks the old state.
Database constraints reject state-specific fields in every other state. Model
tests enumerate and reject every unlisted pair.

## Provider contract

Every adapter implements the same operations:

- ensure the one durable checkout-create attempt
- inspect checkout as open, closed, or paid
- close an open checkout and report closed, paid, or uncertain
- inspect the current refund attempt
- submit one refund attempt with its durable identity
- declare maximum external calls and timeout for each operation

Every result distinguishes:

- authoritative success
- authoritative terminal failure
- pending provider work
- transport or response-parse uncertainty

Unknown enum values, missing required fields, malformed responses, timeouts,
429s, and 5xx responses are not terminal business failures. Validate provider
responses at the boundary and remove nullable `safeAsync` conversion from
reconciliation operations.

### Stripe

- Use the application checkout ID as the create idempotency key,
  `client_reference_id`, and minimal metadata marker.
- Disable hidden SDK network retries for reconciler calls; the durable runner
  owns retry timing and request budgets.
- Persist Stripe refund IDs. Poll a pending refund by ID instead of repeating
  the create call.
- Reuse the attempt key after uncertain transport. Allocate a new one only after
  Stripe reports `failed` or `canceled` for the old attempt.

### Square

- Use the stable checkout ID as `CreatePaymentLink` idempotency key and order
  reference.
- Persist both payment-link ID and order ID atomically.
- Read the Checkout API order's single `Tender.id`, then call `GetPayment`
  directly. Do not use `Tender.payment_id`, scan ten tenders, or call
  `ListPayments`.
- Treat multiple tenders as an unsupported provider state and retain the
  session; never guess which payment won.
- A full inspect-and-close sequence is bounded at five external calls.
- A fully refunded payment still proves the checkout was paid. Inspect refund
  state separately by the stored Square refund ID.

### SumUp

- Use the application checkout ID as `checkout_reference` and recover uncertain
  creation by listing that exact reference.
- Delete `sumup_checkouts`; canonical intent and SumUp ID belong to the common
  session.
- Inspect `simple_status`, `refunded_amount`, and refund events. Top-level
  `REFUNDED` may be partial and is not enough for local full-refund finalisation.
- SumUp has no provider idempotency key for refund POSTs. After an ambiguous
  submission, inspect transaction events and never blindly submit again. If the
  provider cannot prove an outcome, retain the refunding session, alert the
  operator, and fail closed rather than risk a duplicate refund.

## Durable completion

Implement [COMPLETION_DESIGN.md](COMPLETION_DESIGN.md) as a separate prerequisite
PR after scheduler infrastructure and before payment sessions. It moves every
free and paid booking writer onto one durable completion plan, makes each target
independently retryable, and removes current catch-and-settle delivery paths.

The payment-session transaction stores only the immutable completion ID produced
by that shared mechanism. It does not add a paid-only outbox or duplicate effect
state on the terminal payment row.

## Scheduled execution

The separate prerequisite PR in
[SCHEDULED_DESIGN.md](SCHEDULED_DESIGN.md) supplies the authenticated all-site
endpoint, durable task claims, per-site key lifecycle, and one declarative local
maintenance registry. This payment PR does not modify that route or create
another interval mechanism.

Register payment reconciliation as a scheduled-only task with the shared
registry. Redirects, webhooks, cancel, checkout-status requests, and creation
signals invoke the reconciler directly; unrelated organic requests never inherit
provider cold-start or latency. The task declaration provides minimum interval,
deadline, and database/provider cost, then packs due sessions by each bound
provider's worst case. Session leases, retry backoff, provider idempotency, and
payment-specific deadlines remain here rather than in generic scheduler code.

## Deadlines and budgets

Keep this ordering invariant:

`provider timeout < session work deadline < request deadline < lease expiry`

Stop claiming work early enough to commit one final fenced database update.
Begin with conservative values and prove physical calls in tests rather than
trusting logical SDK operation counts. Square's bounded five-call close path
sets the largest checkout-inspection unit. Paid activation and completion costs
must be measured separately before setting batch size.

## Migration

Do not delete unresolved provider work during schema migration. Before deploy,
an explicit drain operation closes or reconciles every open stage and unresolved
payment reservation. The final migration asserts that none remain and refuses
to continue rather than deleting rows to satisfy the assertion. Restore, merge,
and attendee deletion use the same close-or-refuse rule.

Support fresh databases and every historical backup chain. Historical migrations
for tables later removed must still verify or be explicitly superseded before
the final drop migration. Restore tests start before each old payment-table
migration, not only from the immediately previous schema.

Preserve terminal payment history:

1. Create payment accounts, webhook endpoints, payment sessions, charges, and a
   legacy-reference repair queue.
2. Resolve configured provider account identities through authenticated setup or
   pre-deploy checks. Database migration itself performs no provider IO.
3. Copy terminal `processed_payments` outcomes into terminal sessions.
4. Copy processed-payment reference ciphertext into the repair queue without
   claiming an account or blind index. Older references that exist only inside
   owner-encrypted attendee PII stay on a named authenticated compatibility path
   until the owner migrates them.
5. An owner-authenticated repair decrypts a reference, probes configured accounts
   read-only, and creates an indexed charge after one proven match or a required
   explicit choice. Zero or multiple matches never default to the active account.
6. Mark old successful completion as legacy-unknown or complete; never resend
   notifications whose delivery cannot be proven.
7. After the drain assertion, drop `checkout_stages`, `processed_payments`, and
   `sumup_checkouts`, and remove their ordinary runtime APIs in the same change.
8. Remove ledger-based replay for new sessions. Keep only named migration-era
   repair paths for already-pruned terminal rows and PII-only references, each
   with an owner-visible count and removal milestone.

## Implementation order

Prerequisites: merge and deploy the independent scheduled-maintenance PR, then
the unified durable booking-completion PR.

1. Add pure schemas and model-based transition tests.
2. Add payment accounts and account-bound provider clients.
3. Add the unified session, charge, lease, and terminal-outcome schema.
4. Move checkout creation before provider IO for booking and balance payments.
5. Implement provider ensure, inspection, close, and refund contracts.
6. Route account-bound webhook endpoints, redirects, cancel, automatic refunds,
   admin refunds, and replay through the session owner.
7. Attach the existing shared completion plan during terminal booking.
8. Register scheduled-only reconciliation with the maintenance registry.
9. Drain unresolved legacy work, then remove old tables, provider metadata,
   replay fallbacks, and dead ordinary runtime surfaces.
10. Run historical restore, fault injection, concurrency, exact call-count,
    coverage, full precommit, and targeted mutation suites.
