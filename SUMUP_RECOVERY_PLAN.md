# Shipped: a provider that took money is never acknowledged as nothing to do

Status: **shipped**. Both slices are live, so this document is no longer a
specification — the code is the authority and this points at it.

| Slice                                                              | Shipped in                                          |
| ------------------------------------------------------------------ | --------------------------------------------------- |
| Square: a completed payment whose order is not readable is retried | #2106, hardened by #2107                            |
| SumUp: every staged checkout must prove what happened to it        | #2109, with #2123 surfacing invalid rows on the map |

Read this for **why** the machine has the shape it has, and for the arguments
that were made against it. Read the code for **what it does**. Where the two
disagree, the code wins and this file is what needs fixing — see AGENTS.md,
"Once it is built, the code is the authority".

## 1. The harm this closed

Two live paths let a provider take a customer's money and leave this site with
no booking, no refund, and — in one case — no record at all.

- **SumUp.** `sumupApi.createCheckout` stages the booking metadata, then hands
  the buyer a hosted checkout whose `return_url` is our webhook. SumUp does not
  sign that webhook, and there is no subscription to redeliver against: if the
  single callback was lost and the buyer never came back to
  `/payment/success?session_id=…`, nothing ever asked SumUp what happened. The
  staging row was the only trace, and `runDatabasePruning` deleted it 24 hours
  later. The buyer was charged, got no ticket, and the operator had nothing to
  find.
- **Square.** `readSessionOrder` mapped a `missing` order read to `null`.
  Through `retrieveSession` → `resolveWebhookSession` that `null` became
  `"skip"`, and `handlePaymentWebhook` answered
  `webhookAckResponse({ status:
  "pending" })` — HTTP 200. Square stopped
  redelivering. But the webhook that arrived named a **COMPLETED payment**, and
  an order that does not read back yet is the same eventual-consistency window
  the file already treated as retryable two lines down.

What is true now:

> A SumUp checkout that was paid becomes a booking even when its only callback
> was lost, and a Square webhook for a completed payment whose order is not
> readable yet is redelivered instead of acknowledged.

Production receivers: the `sumup_checkout_recovery` maintenance task (run by
`features/scheduled.ts` and `maintenance.runOrganic` in
`features/app/request.ts`), `runDatabasePruning`, the `/admin/schema` page, and
`POST /payment/webhook` for Square.

## 2. The contract, and where it lives

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
| Square order + payment                            | `squareApi.readOrder` / `readOrderPayment` | Absent is **not** unpaid — that was the whole Square defect     |

An unavailable read is never read as "not paid". A read we could not make is
never read as "nothing happened".

### Square: one rule, no machine

Square needs no lifecycle of its own — it has a webhook subscription that
redelivers, which is the whole thing SumUp lacks. It needed one rule, stated as
a refusal:

> A Square webhook naming a `COMPLETED` payment whose order is not readable is
> refused, never acknowledged.

`readSessionOrder` (internal to `src/shared/square-provider.ts`) throws when a
`paidPaymentId` is present, matching `readOrderPayment` two functions down, and
the boundary answers 503 so Square sends it again. The browser redirect keeps
its old behaviour: it supplies no `paidPaymentId`, and there a `missing` order
really does mean "not one of ours".

The replay identity is the **order id** — `retrieveSession` puts it on the
session as `id: order.id`, and that becomes
`processed_payments.payment_session_id`, so a redelivery reserves the same row.
`payment.id` is only the payment reference; Square's event id is not read at
all.

### The machine is declared once, in code

`src/shared/payment/sumup-recovery-machine-spec.ts` holds the nodes, the events,
and the moves table. **This document does not restate them**, and neither does
anything else: the node union, the stored state words, the runtime guard, the
`/admin/schema` map, the queue, the prune rule and the live scan all read that
one declaration.

That is deliberate, and it is the lesson this plan cost the most to learn.
Earlier drafts carried the states, the commands, the failures, the retries and
the races as five hand-written tables. Every review finding was one of those
tables disagreeing with another or with the code: a column name nothing could
look up, an outcome with two different retry owners, a failure row that wrote no
schedule while the retry table promised one. Fixing each disagreement created
the next, because nothing checked the tables against each other. A sixth copy
here would be the same mistake — see the note this branch added to
PR_WORKFLOW.md.

What to read, and in what order:

- `RECOVERY_NODES` — the five nodes, each carrying `owesMoney` and `prunable`.
- `RECOVERY_EVENTS` — the nine events, each carrying its `kind` and whether it
  `movesMoney`.
- `RECOVERY_MOVES` — the table. Every cell present is a required landing node;
  every cell absent is a declared refusal, and the mirror sweep proves it
  throws.
- `recoveryNodeOf` — total over stored rows, throwing on a combination no writer
  can produce. That is what makes the backwards scan possible.
- `RECOVERY_TERMINAL_NODES`, `RECOVERY_CHECKABLE_NODES`,
  `RECOVERY_PRUNABLE_NODES` — derived from the table and the node facts, never
  maintained beside them.

The reasoning that the declaration cannot carry, and that is worth keeping:

- **`waiting` counts `owesMoney` as unknown, not no.** Until SumUp answers, we
  cannot say the buyer did not pay — and a lost callback looks exactly like an
  unpaid checkout. That single choice is why `waiting` is not prunable.
- **The five `read_paid_*` events are named for the money fact they establish**,
  not for what the engine did, because the money fact is what decides whether
  the row may ever be deleted.
- **A replayed terminal failure is not its own event.** It carries the same
  money fact as a fresh one, so it arrives as `read_paid_settled` or
  `read_paid_unsettled` and the table does the rest.
- **The callback path raises no event at all.** Only the recovery check moves a
  row, which is what lets `finished` refuse everything without a late callback
  ever hitting that refusal: a callback arriving after a check has closed the
  row goes through the payment engine, replays the booking it already made,
  answers the provider, and leaves `recovery_state` alone. Same for the buyer
  returning to the success page days later. Both are checked, not assumed —
  `test/integration/server/sumup-recovery/late-callback.test.ts`.
- **`owed` refuses `read_pending` and `read_expired_or_failed`.** Every `owed`
  row got there from a read that said PAID, and SumUp never moves a checkout
  back off PAID, so either cell would be defending against the impossible.

### The laws, and what enforces each

Prose can promise these; only a check enforces them. Each began as a finding
this review produced, and is now something that cannot recur.

| Law                                                               | Enforced by                                                                                                                        |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| A node that may hold money is never `prunable`                    | `machine.test.ts`, "a row that may hold money is never deleted on age alone"                                                       |
| A node that may hold money has an outgoing system edge            | `machine.test.ts`, "…always has something that will act on it"                                                                     |
| A node that may hold money can still reach a closed answer        | `machine.test.ts`, "…can still reach a closed answer"                                                                              |
| A terminal node has no outgoing edges                             | `graph.test.ts`, "a closed row has no way back out"                                                                                |
| Every node is reachable, and every node can reach a closed answer | `graph.test.ts`                                                                                                                    |
| `recoveryNodeOf` is total, throwing on the impossible             | `graph.test.ts` refusal cases; `machine.test.ts` unknown-word case                                                                 |
| Every edge landing on a non-terminal node writes the schedule     | Structure: `applySumupRecoveryEvent` is the only writer, and it sets `next_check_at` unless the landing node is terminal           |
| Every self-move fences on the schedule, not just the state        | Structure: `moveSumupRecoveryRow` is the only `UPDATE`, and it matches `reference_index`, `recovery_state` **and** `next_check_at` |

The last two are structural rather than declared. One write helper carries both,
so there is no second implementation to drift — which is a stronger guarantee
than a test over a declaration, and is why they were not written as laws.

The two worth stating plainly: **a row that may hold money nobody has accounted
for is never deleted, and always has something that will act on it.** That is
the safety property this feature exists to provide, and it is checked rather
than promised.

### Where the built thing differs from what was planned

Each of these is a decision taken while writing the code, not a slip. They are
recorded because the plan argued for something else.

1. **`owner_forces_check` was not built.** The plan declared an owner edge on
   `waiting` and `owed`, and a "Check again now" POST behind `ownerFormHandler`.
   Neither shipped. The plan's own slice notes had already reasoned the way out:
   an edge whose only caller lives in a later slice is an export with no
   production caller, which this repository deletes rather than ships. The laws
   hold without it — both money-holding nodes keep their system edges — so the
   scheduled retry is the only thing that moves a row, and `owed` is still not a
   dead end. The follow-up that would give an operator a safe repair is in
   TODO.md, "Give SumUp recovery anomalies a safe owner repair".
2. **A failed check moves the clock rather than throwing.** The plan called this
   "the one gap the machine cannot close" and left the retry to the maintenance
   runner's `failureRetryIntervalMs`. `recoverOne` instead catches the read or
   settle failure for that row alone and calls `delaySumupRecoveryCheck`, which
   writes the state back unchanged and moves only `next_check_at`. This is
   better than the plan: one checkout blowing up no longer stops the rows behind
   it, and a row that keeps failing cannot hold the front of the queue. Writing
   the answer is still not caught — a refused write throws to the task's own
   retry.
3. **The batch is capped, not the paid recoveries.** The plan promised "at most
   one paid recovery per run". What shipped is `SUMUP_RECOVERY_BATCH` (default
   3) checkouts per run, with the cost declared as `maxDatabaseCalls` and
   `maxExternalCalls` on the task and enforced by the runner before it starts. A
   declared budget the runner checks is the stronger form of the same promise.
4. **`read_unavailable` writes the state too.** The plan's events table said it
   wrote only the schedule. It goes through the single writer like every other
   event, landing on the node it started from, so the stored state is unchanged
   either way.
5. **The events carry two facts the plan did not name:** `kind`
   (`"check" | "create"`), which is what derives the queue, and `movesMoney`,
   which the map reads. Both exist so a new event joins the queue and the map by
   being declared.
6. **The live check is not its own file.** The plan expected
   `src/shared/db/sumup-recovery-scan.ts`. The backwards check landed in the
   shared `src/shared/db/schema-anomaly-scan.ts` (#2123) alongside the other
   stored-state anomalies, which is the same mechanism serving one more caller.
7. **No Cucumber story was written.** The plan named
   `specs/payments/a-payment-with-no-callback.feature`. The journey is covered
   by `test/integration/server/sumup-recovery/recovers.test.ts` instead. This is
   the one promise that is simply outstanding; it is recorded in TODO.md.

### Owner choices

None were added. This work never chooses a money outcome: the only genuine
ambiguity it can produce is `owed`, and `owed` is not a decision the system
takes — it is the honest statement that money was taken and the booking did not
happen, shown to the owner with the SumUp checkout id. Any refund on this path
is the one `settleRejectedCharge` already performs on the webhook, under the
same rules and the same durable `payment_charges` authority.

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
  It lists the SumUp checkout id (not sensitive, already the pre-filter key) and
  the state word. No amount, no buyer fact.
- There is no state-changing HTTP entry point on this path. The plan's CSRF and
  owner-guard rules were written for the "Check again now" control, which was
  not built; they apply again if the TODO.md follow-up ships.

## 3. The module map

| What                           | Where                                                         | Names                                                                                                                                                                                              |
| ------------------------------ | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The machine                    | `src/shared/payment/sumup-recovery-machine-spec.ts`           | `RECOVERY_NODES`, `RECOVERY_EVENTS`, `RECOVERY_MOVES`, `recoveryNodeOf`, `recoveryMoveTo`, `recoveryRowAfter`, `SumupRecoveryStateSchema`, `parseSumupRecoveryState`, the three derived node lists |
| The pure rule                  | `src/shared/sumup/recovery.ts`                                | `sumupRecoveryOutcome(reading, outcome)`, `SumupCheckoutReading`                                                                                                                                   |
| One pass of the task           | `src/shared/sumup/recovery-run.ts`                            | `runSumupRecovery`                                                                                                                                                                                 |
| The queue and the fenced write | `src/shared/db/sumup-recovery.ts`                             | `getDueSumupCheckouts`, `applySumupRecoveryEvent`, `delaySumupRecoveryCheck`                                                                                                                       |
| One way to ask SumUp           | `src/shared/sumup/checkout-resolution.ts`                     | `resolveSumupCheckoutById`                                                                                                                                                                         |
| The engine, once               | `src/features/api/payment-callback.ts`                        | `settlePaymentCallback`, `CallbackOutcome`                                                                                                                                                         |
| The map entry                  | `src/shared/schema-atlas/sumup-recovery.ts`                   | `sumupRecoveryAtlas`                                                                                                                                                                               |
| The backwards check            | `src/shared/db/schema-anomaly-scan.ts`                        | `scanSchemaAnomalies`                                                                                                                                                                              |
| Pruning                        | `src/shared/db/prune.ts`                                      | reads `RECOVERY_PRUNABLE_NODES`                                                                                                                                                                    |
| The task                       | `src/shared/maintenance/registry.ts`                          | `sumup_checkout_recovery`                                                                                                                                                                          |
| The columns                    | `src/shared/db/migrations/2026-08-18_sumup_recovery_state.ts` | `recovery_state`, `next_check_at`                                                                                                                                                                  |
| Square's rule                  | `src/shared/square-provider.ts`                               | `readSessionOrder` (internal)                                                                                                                                                                      |

The two shape rules the map was held to, both still true:

- **One engine, not a second one.** `settlePaymentCallback` is the whole of the
  payment work, returning an exhaustive `CallbackOutcome` union. `webhooks.ts`
  maps that union to a `Response`; the recovery task maps the same union to an
  event. One production implementation per command, with the HTTP layer as the
  thin shell.
- **One way to ask SumUp about a checkout id.** `resolveSumupCheckoutById` is
  that operation, called by both the provider member and the recovery task. Not
  an alias — the member keeps its interface job, and the shared mechanism is
  exposed directly.

`sumupRecoveryOutcome` is pure: data in, event out, no IO. It names the event
the observation amounts to; the moves table, not this function, decides where
that event lands. It is exhaustive over the reading and over `CallbackOutcome`,
so a provider status the boundary cannot read becomes `read_unavailable` rather
than a guess, and a new callback outcome stops it compiling until someone
decides what that outcome means for the money.

## 4. The arguments made against it

| Challenge                                          | Answer                                                                                                                                                                                                                |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider read succeeds, local write fails          | The booking commits atomically before the state write. A failed state write leaves the row where it was; the next check re-reads and `reserveSession` returns the recorded outcome. Proved in `crash-windows.test.ts` |
| Callback replayed after recovery already booked it | `processed_payments` PK; `alreadyProcessedResult`. Proved in `late-callback.test.ts`                                                                                                                                  |
| Two paid checkouts, one buyer                      | Independent rows and independent session ids; nothing correlates them                                                                                                                                                 |
| Amount/currency/parent wrong                       | Untouched: the existing observation boundary and `classifySessionIntent` decide, and a rejected paid charge takes the existing refund path                                                                            |
| Buyer reloads mid-recovery                         | The redirect calls `retrieveSession`, which is already idempotent through the same reserve                                                                                                                            |
| The task runs on a site with no SumUp              | `check.enabled` reads `SUMUP_API_KEY`/`SUMUP_MERCHANT_CODE`; disabled tasks are removed by `syncMaintenanceTaskRows`                                                                                                  |
| SumUp is disconnected while rows are `waiting`     | They are never checked and never deleted — `waiting` is not `prunable`. The live check shows them, which is the honest answer                                                                                         |
| A busy site's checkouts flood the task             | Oldest-first page of `SUMUP_RECOVERY_BATCH`, then `requestFollowUp()`. A row that keeps failing moves its own check time forward, so it falls behind rows that became due meanwhile                                   |
| Budget: Bunny's 50 subrequests                     | Declared as the task's `maxDatabaseCalls`/`maxExternalCalls`, which `maintenanceStartupCalls` sums and the runner refuses to start if they exceed `MAINTENANCE_TASK_CALL_LIMIT`                                       |
| Does this refund money in the background?          | Only through the path the webhook already runs for a rejected paid charge. It is the same engine, because a second one was forbidden                                                                                  |
| Square: does throwing break the browser redirect?  | No. `readSessionOrder` throws only when a `paidPaymentId` is present, which only the webhook supplies. The redirect keeps `null` — there, `missing` really is "not ours"                                              |
| A later change adds a node or an event             | It must satisfy the laws or the suite fails: a money-holding node cannot be prunable or a dead end, and a terminal node cannot grow an edge                                                                           |
| SumUp returns a status we do not know              | `SumupCheckoutStatusSchema` is a closed picklist, so an unknown word fails the boundary and arrives as `read_unavailable` — the row stays put and is asked again                                                      |

The product choice that was made, and held: **a row that may hold money we have
not accounted for is never deleted on age alone.** That covers `owed` (money
seen, not accounted for) and `waiting` (never yet proved either way — a checkout
paid while SumUp was unreachable for the whole retention window would otherwise
be deleted, which is the exact harm this work closes). Both end on a definitive
answer, never on a clock.

The cost is that a site which disconnects SumUp keeps its unanswered `waiting`
rows. They are small, their metadata stays sealed under a reference this
database does not hold, and growth is bounded by real incidents. The alternative
— a long backstop that eventually deletes them — trades a rare lost payment for
a tidier table, which is the wrong way round.

## 5. What each slice shipped

### Slice 1 — a Square webhook for a completed payment is never acknowledged as pending

Shipped in #2106. `readSessionOrder` throws when a `paidPaymentId` is present
and the order reads `missing`; `retrieveSession` still answers `null` for the
browser redirect. The `missing → null → "skip" → 200` arm for paid webhooks is
gone.

Tests: `test/shared/square-provider/webhook.test.ts` ("refuses a completed
payment whose order is not readable yet"),
`test/shared/square-provider/read-outcomes.test.ts` ("keeps an order Square
cannot find retryable after a completed event"), and
`test/integration/server/webhooks/square.test.ts` ("keeps a completed payment
whose order is not readable yet retryable").

Two things differed from the plan. The redelivery test it named was not written:
the existing idempotency tests already deliver the same Square webhook twice and
assert one attendee, so a third would have restated a pinned test. And #2107
followed, closing three gaps the mutation gate found in the same file — a
one-character payment id being discarded, two different order faults logging
identically, and a blank payment status reported as an outage.

### Slice 2 — a staged SumUp checkout must prove what happened to it

Shipped in #2109; #2123 added the invalid-row reporting on `/admin/schema`. The
files and names are in section 3, and the differences from the plan are in
section 2.

Deleted with it: the blind `boundedDelete("sumup_checkouts", "created_at < ?")`,
and the HTTP-shaped session handling inside `handlePaymentWebhook`.

Tests, by what they hold:

- `test/shared/payment/sumup-recovery-machine-spec/machine.test.ts` — the laws
  over the declaration, and the mirror sweep executing every (node × event ×
  shape) cell against the real transitions, including every declared refusal.
- `.../graph.test.ts` — every node reachable from `staged`, every node able to
  reach a closed answer, no way back out of a closed one, and `recoveryNodeOf`'s
  refusals.
- `test/shared/sumup/recovery.test.ts` — `sumupRecoveryOutcome`, table driven,
  one case per reading × outcome, naming the event rather than the landing node.
- `test/shared/db/sumup-recovery.test.ts` — the queue and the fenced write.
- `test/integration/server/sumup-recovery/recovers.test.ts` — books a paid
  checkout whose callback never arrived, books it exactly once when the check
  runs twice, closes one SumUp says was never paid, keeps asking when SumUp
  cannot answer.
- `.../late-callback.test.ts` — a callback after the check books nobody twice;
  the buyer returning later still sees their booking.
- `.../crash-windows.test.ts` — a failed state write finishes on the next check.
- `.../races-the-webhook.test.ts` — webhook and recovery together, one attendee
  and one ledger group.
- `.../lost-race.test.ts`, `.../queue-order.test.ts` — the fence's loser, and a
  stuck row not holding the front of the queue.
- `.../prune.test.ts` — `waiting` and `owed` rows survive however old; a
  `finished` row does not.
- `test/shared/db/migrations/2026-08-18_sumup_recovery_state.test.ts` — the
  derived states and check times for existing rows.
- `test/shared/schema-atlas/sumup-recovery.test.ts` — the map entry.

## 6. Where this sits against PLAN.md

Resolved. The task was pulled forward out of work package M7 onto the current
path, because it needed nothing from the aggregate reader, added no parallel
path and no dormant layer, and the harm it closes was live on every SumUp site
while the cutover was being designed.

`PLAN.md` records this: M7's bullet now reads that the missed-SumUp-checkout
task "already runs on the current path as `sumup_checkout_recovery`; M7 adopts
that task instead of building it again."
