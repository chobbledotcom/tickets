# Behavior contract: a provider that took money is never acknowledged as nothing to do

Status: **awaiting human approval** (PR_WORKFLOW.md step 6). No tests or
implementation code has been written.

## 1. Current-system value

Two live paths today let a provider take a customer's money and leave this site
with no booking, no refund, and — in one case — no record at all.

- **SumUp.** `sumupApi.createCheckout` stages the booking metadata, then hands
  the buyer a hosted checkout whose `return_url` is our webhook. SumUp does not
  sign that webhook, and there is no subscription to redeliver against: if the
  single callback is lost and the buyer never comes back to
  `/payment/success?session_id=…`, nothing ever asks SumUp what happened. The
  staging row is the only trace, and `runDatabasePruning` deletes it 24 hours
  later (`boundedDelete("sumup_checkouts", "created_at < ?")`,
  `PRUNE_SUMUP_RETENTION_HOURS`). The buyer is charged, gets no ticket, and the
  operator has nothing to find.
- **Square.** `readSessionOrder` (`src/shared/square-provider.ts:130`) maps a
  `missing` order read to `null`. Through `retrieveSession` →
  `resolveWebhookSession` that `null` becomes `"skip"`, and
  `handlePaymentWebhook` answers `webhookAckResponse({ status: "pending" })` —
  HTTP 200. Square stops redelivering. But the webhook that arrived named a
  **COMPLETED payment**, and an order that does not read back yet is the same
  eventual-consistency window the file already treats as retryable two lines
  down (`UNUSABLE_METADATA.retryCompletedWebhook`, and `readOrderPayment`
  throwing when the payment does not read `COMPLETED`).

Value if nothing else ever ships:

> A SumUp checkout that was paid becomes a booking even when its only callback
> was lost, and a Square webhook for a completed payment whose order is not
> readable yet is redelivered instead of acknowledged.

Production receivers: the `sumup_checkout_recovery` maintenance task (run by
`features/scheduled.ts` and `maintenance.runOrganic` in
`features/app/request.ts`), `runDatabasePruning`, the `/admin/schema` page, and
`POST /payment/webhook` for Square.

## 2. Behavior contract

### Trusted facts

| Fact                                              | Source                                                        | Why it may be trusted                                                        |
| ------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `sumup_checkouts.sumup_id`                        | Written by `setSumupCheckoutId` before the buyer sees the URL | Ours by construction; not sensitive; the existing webhook pre-filter uses it |
| `sumup_checkouts.reference_index`                 | `hmacHash(reference)` at staging                              | Signed by our key; proves a fetched reference names this row                 |
| `sumup_checkouts.created_at`                      | Our clock at staging                                          | Ours; used only to schedule a check, never to decide a payment fact          |
| The signed price proof inside the staged metadata | `assembleCheckoutMetadata`                                    | Cannot be forged without our key; already the ownership test                 |
| Square webhook naming a `COMPLETED` payment       | Verified Square signature                                     | `requiresWebhookSignature: true`; the signature proves the sender            |

Observed facts, kept separate and never substituted for the above:

| Fact                                              | Source                                     | Trust                                                           |
| ------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------- |
| SumUp checkout status/amount/currency/transaction | `sumupApi.readCheckoutById(sumup_id)`      | A read, refused by the existing observation boundary if it lies |
| The `checkout_reference` SumUp echoes back        | Same read                                  | Only usable if it opens the sealed row (`openSumupCheckout`)    |
| Square order + payment                            | `squareApi.readOrder` / `readOrderPayment` | Absent is **not** unpaid — that is the whole Square defect      |

An unavailable read is never read as "not paid". A read we could not make is
never read as "nothing happened".

### Valid states

One new plaintext column, `sumup_checkouts.recovery_state`, is the authority for
a staging row's own lifecycle. It holds a state word only — never a reference,
an amount, or any buyer fact — so the row stays as unreadable as it is today.

| State      | Meaning                                                              | Facts required                     |
| ---------- | -------------------------------------------------------------------- | ---------------------------------- |
| `staged`   | Row written; SumUp has not given us a checkout id                    | `sumup_id = ''`                    |
| `waiting`  | Checkout is live; the buyer may still pay                            | `sumup_id != ''`                   |
| `unpaid`   | We asked SumUp and it said this checkout was never paid              | `sumup_id != ''`; a completed read |
| `finished` | We asked, it was paid, and the payment engine reached a final answer | `sumup_id != ''`; a completed read |
| `owed`     | It was paid and we could **not** reach a final answer                | `sumup_id != ''`; a completed read |

`staged` and `waiting` are set in the same statement as the fact they mirror
(`storeSumupCheckout`'s INSERT, `setSumupCheckoutId`'s UPDATE), so no consumer
routes on `sumup_id != ''` as a proxy for state (data law 4).

`finished` covers both endings the payment engine can give a paid session: a
booking, or a rejection whose money was sent back. Neither leaves anything owed.

### Commands and events

| Starting state               | Command or event                               | Required result                                                       |
| ---------------------------- | ---------------------------------------------- | --------------------------------------------------------------------- |
| —                            | `storeSumupCheckout`                           | `staged`                                                              |
| `staged`                     | `setSumupCheckoutId`                           | `waiting` (same UPDATE; still exactly one row or throw)               |
| `waiting`                    | Webhook or redirect completes the booking      | `waiting` (unchanged — see "Why the hot path does not stamp the row") |
| `waiting`                    | Recovery check, read says `EXPIRED` / `FAILED` | `unpaid`                                                              |
| `waiting`                    | Recovery check, read says `PAID`, engine final | `finished`                                                            |
| `waiting`                    | Recovery check, read says `PAID`, engine stuck | `owed`                                                                |
| `waiting`                    | Recovery check, read says `PENDING`            | `waiting` (checked again later)                                       |
| `waiting`                    | Recovery check, read unavailable               | `waiting` (checked again later)                                       |
| `owed`                       | Recovery check succeeds later                  | `finished`                                                            |
| `owed`                       | Owner presses "Check again now"                | Same three outcomes as a scheduled check                              |
| `staged`/`unpaid`/`finished` | Pruning past `PRUNE_SUMUP_RETENTION_HOURS`     | Row deleted                                                           |
| `waiting`                    | Pruning past the new unchecked backstop        | Row deleted, after the live check has been showing it as overdue      |
| `owed`                       | Pruning                                        | **Never** — it is the only record that money was taken                |

**Why the hot path does not stamp the row.** A completed webhook could mark its
staging row `finished` and save the later read. It deliberately does not: the
recovery check asking SumUp about _every_ checkout we created is precisely the
backwards check (AGENTS.md, "Check backwards from the data"). A site whose
webhooks have been failing silently for a week is discovered by it. The cost is
one provider read per created checkout, once, at least 2.5 hours after creation
— bounded per run by the task's declared external-call budget.

### Failure table

| Work completed             | Failure                               | Required result                                                     | Retry owner |
| -------------------------- | ------------------------------------- | ------------------------------------------------------------------- | ----------- |
| Nothing                    | SumUp read unavailable                | Row stays `waiting`; no state written                               | Scheduler   |
| Nothing                    | SumUp read `found` but not ours       | Row stays `waiting`; refusal logged (cannot happen — id is ours)    | Scheduler   |
| Read says `PAID`           | Echoed reference does not open row    | `owed` — SumUp contradicted itself about a checkout we created      | Owner       |
| Read says `PAID`           | Boundary rejects the money            | Existing `settleRejectedCharge`: refunded ⇒ `finished`, else `owed` | Scheduler   |
| Read says `PAID`           | Classify says `unverifiable`          | `unpaid` — another site's checkout, nothing owed by us              | —           |
| Read says `PAID`           | Classify says `unreadable`            | Row stays `waiting`                                                 | Scheduler   |
| Engine booked the attendee | State write fails                     | Booking stands; row stays `waiting`; next check is idempotent       | Scheduler   |
| Square: webhook accepted   | Order reads `missing` under a paid id | **Throw** — 503, Square redelivers                                  | Provider    |

The gap between provider success and local success is closed the way the rest of
the payment engine closes it: `processed_payments` (PK = session id = the SumUp
reference) is reserved before any work, so a replay returns the recorded outcome
rather than repeating it.

### Retry and replay table

| Question                             | Answer                                                                                                                                                                      |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stable identity                      | `processed_payments.session_id` = the SumUp `checkout_reference`; the staging row's `reference_index`                                                                       |
| What an exact replay returns         | `alreadyProcessedResult` / the recorded terminal failure — no second booking, no second refund                                                                              |
| Who retries after interruption       | The maintenance scheduler; the row keeps its state until a check writes a new one                                                                                           |
| What stops two workers               | `claimNextMaintenanceTask`'s lease, plus `reserveSession`, plus a conditional state write (below)                                                                           |
| Permanent failures                   | `unpaid` (never paid) and `unverifiable` (not ours). Everything else stays retryable                                                                                        |
| Can one failed item block later work | No — the page is selected oldest-first with a limit; a row that stays `waiting` or goes `owed` is skipped by the next page's ordering and retried on its own slower cadence |

### Concurrency table

| Operation A                    | Operation B                  | Required result                                                              | Protection                                                                                                          |
| ------------------------------ | ---------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Recovery check                 | Late webhook for the same id | One booking                                                                  | `reserveSession` on `processed_payments`                                                                            |
| Recovery check                 | Buyer's redirect             | One booking                                                                  | Same                                                                                                                |
| Recovery check on two isolates | Same task                    | One runner                                                                   | Maintenance lease (`claimNextMaintenanceTask`)                                                                      |
| Recovery state write           | `setSumupCheckoutId`         | No lost transition                                                           | `UPDATE … WHERE reference_index = ? AND recovery_state = ?` — the expected current value, checked by `rowsAffected` |
| Recovery check                 | Pruning                      | An `owed` row survives; a checked row may go                                 | Prune's WHERE names the states it may delete                                                                        |
| Owner "Check again now"        | Scheduled check              | One provider read wins; the other's conditional write finds 0 rows and stops | Expected current value                                                                                              |

### Owner choices

None are added. This work never chooses a money outcome: the only genuine
ambiguity it can produce is `owed`, and `owed` is not a decision the system
takes — it is the honest statement that money was taken and the booking did not
happen, shown to the owner with the SumUp checkout id and a control that tries
again. Any refund on this path is the one the existing `settleRejectedCharge`
already performs on the webhook, under the same rules and the same durable
`payment_charges` authority.

### Security and privacy

- The staging row's protection is unchanged: metadata stays encrypted under a
  key wrapped with the reference, the plaintext reference never rests in this
  table, and `recovery_state` is a state word carrying no buyer or provider
  fact. Data never moves to weaker protection (data law 6).
- The recovery check re-obtains the reference the same way the webhook does —
  from SumUp's own response — and it only decrypts when
  `hmacHash(reference) === reference_index`.
- Untrusted input that can cause provider work: none new. The task's inputs are
  our own staged rows. Unlike the webhook, no external caller can trigger it.
- `/admin/schema` and its live check are owner-only, matching the existing page.
  The "Check again now" control is rendered only where the owner can use it and
  only for a row that exists, so no dead or forbidden link is emitted.
- The live check lists the SumUp checkout id (not sensitive, already the
  pre-filter key) and the state word. No amount, no buyer fact.

## 3. Shared contract

- **One pure rule.** `sumupRecoveryOutcome(read, engineAnswer)` in
  `src/shared/sumup/recovery.ts` — data in, next state out. No IO. Exhaustive
  over `ProviderRead<SumupCheckout>` and the payment engine's answer, returning
  a `SumupRecoveryState` from a valibot picklist that also derives the type, the
  guard, and the state list (the `ContactFieldSchema` pattern).
- **One engine, not a second one.** `handlePaymentWebhook` currently interleaves
  the payment work with HTTP responses. Extract the work half — resolved session
  → classify → `settlePaymentCallback` → an exhaustive `CallbackOutcome` union —
  and have `webhooks.ts` map that union to a `Response`. The recovery task maps
  the same union to a state word. One production implementation per command; the
  HTTP layer becomes the thin shell.
- **One way to ask SumUp about a checkout id.** `resolveWebhookSession` already
  is that operation; lift its body to `resolveSumupCheckoutById(sumupId)` and
  have both the webhook member and the recovery task call it. Not an alias — the
  member keeps its interface job, the shared mechanism is exposed directly.
- **The machine is declared, not described.** `sumup-recovery-machine-spec.ts`
  with nodes, events, and an exhaustive moves table; a missing cell is a
  declared refusal the sweep executes. It joins `SCHEMA_ATLAS_MACHINES` so
  `/admin/schema` maps it with no other change.
- **The backwards check reads the stored data.** A bounded scan (the
  `joint-state-scan.ts` shape, `SCAN_LIMIT`-style cap) lists `owed` rows and
  `waiting` rows past their check window, keyed by the declaration's own literal
  states so a new state does not compile until the scan knows how to find it.

## 4. Challenging the contract

| Challenge                                          | Answer                                                                                                                                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Provider read succeeds, local write fails          | The booking commits atomically before the state write. A failed state write leaves `waiting`; the next check re-reads and `reserveSession` returns the recorded outcome  |
| Callback replayed after recovery already booked it | `processed_payments` PK; `alreadyProcessedResult`                                                                                                                        |
| Two paid checkouts, one buyer                      | Independent rows and independent session ids; nothing correlates them                                                                                                    |
| Amount/currency/parent wrong                       | Untouched: the existing observation boundary and `classifySessionIntent` decide, and a rejected paid charge takes the existing refund path                               |
| Buyer reloads mid-recovery                         | The redirect calls `retrieveSession`, which is already idempotent through the same reserve                                                                               |
| The task runs on a site with no SumUp              | `check.enabled` reads `SUMUP_API_KEY`/`SUMUP_MERCHANT_CODE`; disabled tasks are removed by `syncMaintenanceTaskRows`                                                     |
| SumUp is disconnected while rows are `waiting`     | They are never checked, the live check shows them as overdue, and the new unchecked backstop finally prunes them. They are not silently kept forever                     |
| A busy site's checkouts flood the task             | Oldest-first page with a small limit and `requestFollowUp()`; at most **one** paid recovery per run, because a rejection can spend refund subrequests                    |
| Budget: Bunny's 50 subrequests                     | Declared in the task's `maxDatabaseCalls`/`maxExternalCalls`, which `maintenanceStartupCalls` already sums and the runner already enforces via `budget.remaining()`      |
| Does this refund money in the background?          | Only through the path the webhook already runs for a rejected paid charge. It is the same engine or it is a second one — the plan forbids a second one                   |
| Square: does throwing break the browser redirect?  | No. `readSessionOrder` throws only when a `paidPaymentId` is present, which only the webhook supplies. The redirect keeps `null` — there, `missing` really is "not ours" |

Open question for the human, and the only product choice left: **`owed` rows are
never pruned.** They are small (one row, no PII) and they are the only record
that money was taken, so growth is bounded by real incidents. The alternative —
age them out after a long retention — loses the evidence. The contract assumes
"never", resolved by the owner's action.

## 5. Vertical pull requests

### PR 1 — A Square webhook for a completed payment is never acknowledged as pending

- Value: a paid Square booking whose order lags is redelivered, not dropped.
- Change: `readSessionOrder` learns whether a `paidPaymentId` is in play and
  throws on `missing` when it is, matching `readOrderPayment` two functions
  down. The redirect keeps returning `null`.
- Old path deleted: the `missing → null → "skip" → 200` arm for paid webhooks.
- Files: `src/shared/square-provider.ts`. **~20 src lines.**
- Call budget: unchanged (no new reads).
- Tests: a direct test proving a `missing` order under a completed payment id
  throws and the same read without a payment id still returns `null`; a webhook
  integration test proving 503 instead of 200. The regression test must fail on
  today's code first.
- Contract rows: the Square row of the failure table.

### PR 2 — A staged SumUp checkout must prove what happened to it

- Value: the paid-but-lost checkout becomes a booking; the evidence stops being
  deleted at 24 hours; the owner can see anything still owed.
- Change: `recovery_state` column and its migration; the state words as a
  valibot picklist; the pure `sumupRecoveryOutcome`; `resolveSumupCheckoutById`
  lifted out of the provider member; the `settlePaymentCallback` extraction with
  `webhooks.ts` reduced to mapping its outcome to a `Response`; the
  `sumup_checkout_recovery` maintenance task; prune scoped to the states it may
  delete plus the unchecked backstop limit; the machine spec and its atlas
  entry; the bounded live check; the owner-only "Check again now" action.
- Old path deleted: the blind
  `boundedDelete("sumup_checkouts", "created_at < ?")`, and the HTTP-shaped
  session handling inside `handlePaymentWebhook`.
- Files: `src/shared/db/sumup-checkouts.ts`, `src/shared/db/prune.ts`,
  `src/shared/db/migrations/` (+ schema), `src/shared/sumup/recovery.ts`,
  `src/shared/sumup-provider.ts`, `src/features/api/webhooks.ts`,
  `src/features/api/payment-callback.ts` (new),
  `src/shared/maintenance/registry.ts`, `src/shared/limits.ts`,
  `src/shared/payment/sumup-recovery-machine-spec.ts`,
  `src/shared/schema-atlas/`, `src/shared/db/sumup-recovery-scan.ts`, the
  `/admin/schema` action, and `src/locales/en/*.json` (not counted).
- **~640 src lines**, under the 800 cap. If it overruns, the split is by
  invariant: the task and its machine first, the live check and owner action
  second — but only if the first still leaves `owed` reachable through the
  scheduled retry.
- Call budget: startup adds 1 settings read + 1 database call to the task check.
  Per run: ≤3 database reads, ≤3 SumUp reads, ≤1 paid recovery (which may spend
  the existing refund path's calls). Well inside `MAINTENANCE_TASK_CALL_LIMIT`.
- Contract rows: every row of the state, failure, retry, and concurrency tables
  except the Square one.

Tests proving each row: direct unit tests for `sumupRecoveryOutcome` (table
driven, one case per read × answer); the machine spec sweep executing every cell
including the declared refusals; a fault-injected test crashing between the
booking commit and the state write and proving the next check is idempotent; a
concurrency test running webhook and recovery together and asserting exactly one
attendee and one ledger group; a prune test proving an `owed` row survives and a
`finished` row does not; a scan test reading the declared states back out; and a
Cucumber story — `specs/payments/a-payment-with-no-callback.feature` — buying
through the real public booking page, dropping the callback, running
maintenance, and finding the ticket.

## 6. Where this sits against PLAN.md

`PLAN.md` currently lists the missed-SumUp-checkout task inside work package M7
("M7 attaches scheduled retries, the missed-SumUp-checkout task, and the
original checkout's handled marker to this same lifecycle"), and M6–M11 activate
only as one atomic cutover. This contract proposes pulling it forward onto the
current path instead, because:

- it needs nothing from the aggregate reader — it uses the current
  `processed_payments` engine, which M8 will displace along with every other
  current completion writer;
- it adds no parallel path and no dormant layer: one task, one engine, one
  machine, all live the day it merges;
- the harm it closes is live today on every SumUp site, and the evidence for it
  is being deleted every 24 hours while the cutover is designed.

If the plan is approved, `PLAN.md`'s M7 bullet and the "Where we are" table need
the same-commit amendment PLAN.md's own rules require, recording that the
missed-SumUp-checkout task shipped on the current path and that M7 inherits it
rather than building it.

## 7. Approval

This plan is not approved. Per PR_WORKFLOW.md step 6, please confirm or change:

1. the two PR slices and their order;
2. `owed` rows never being pruned (section 4's open question);
3. checking **every** created checkout once, rather than stamping the row from
   the completion path;
4. pulling the task forward from M7 (section 6).
