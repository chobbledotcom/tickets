# The recovery contract for SumUp and Square payments

Status: **shipped**. Both slices are live. This document is no longer a
specification. The code is the authority, and this document points at it.

| Slice                                                              | Shipped in                                    |
| ------------------------------------------------------------------ | --------------------------------------------- |
| Square: a completed payment whose order is not readable is retried | #2106, hardened by #2107                      |
| SumUp: every staged checkout must prove what happened to it        | #2109, with #2123 for invalid rows on the map |

Read this document for the reasons behind the machine, and for the arguments
against it. Read the code for what the machine does. Where the two disagree, the
code wins, and this document is what someone must fix. See AGENTS.md, "Once it
is built, the code is the authority".

## 1. The harm this closed

Two live paths let a provider take money from a customer. The site then held no
booking and no refund. In one case it held no record at all.

**SumUp.** `sumupApi.createCheckout` stages the booking metadata. It then hands
the buyer a hosted checkout whose `return_url` is our webhook. SumUp does not
sign that webhook. There is no subscription to redeliver against.

If the single callback was lost, and the buyer never returned to
`/payment/success?session_id=…`, nothing asked SumUp what happened. The staging
row was the only trace, and `runDatabasePruning` deleted it after 24 hours. The
buyer paid, received no ticket, and the operator found nothing.

**Square.** `readSessionOrder` mapped a `missing` order read to `null`. Through
`retrieveSession` and `resolveWebhookSession`, that `null` became `"skip"`.
`handlePaymentWebhook` then answered `webhookAckResponse({ status: "pending" })`
with HTTP 200, and Square stopped redelivery. But the webhook named a
**COMPLETED payment**. An order that does not read back yet is the same
eventual-consistency window that the file already treated as retryable two lines
below.

What is true now:

> A paid SumUp checkout is asked about until SumUp gives a usable answer, even
> when its only callback was lost. The site then answers for it. A Square
> webhook for a completed payment whose order is not readable yet is
> redelivered, not acknowledged.

Two conditions sit behind that, and both are real. The site must still hold
SumUp credentials. `enabled: () => settings.sumup.hasKey` gates the task.
`syncMaintenanceTaskRows` then removes a disabled task.

SumUp must also answer at last. A provider that returns nothing usable leaves
the row where it is through `read_unavailable`, which moves only the clock.

The two conditions fail differently. Without credentials the task does not run
at all, so nothing asks and the row is only retained. With credentials and an
unusable provider, the task keeps asking, and `read_unavailable` moves the clock
each time. Neither case deletes the row, and neither reads it as unpaid. The
task resumes when the key returns. The row is answered when SumUp returns a
usable response.

"Answered for" is not the same as "booked". A paid checkout that the engine
accepts becomes a booking. A paid checkout that the engine rejects does not
become a booking. Two rejections behave differently, and the difference is
deliberate.

A proof that verifies against a charge we must not keep takes the existing
refund path, through `settleRejectedCharge`. A proof that does not verify at all
takes no money action. `classifiedOutcome` returns `unverifiable` before
`processPaymentSession` runs, and `PAID_EVENTS` maps that answer to
`read_paid_contradiction`. The row lands on `owed`, and the site touches no
money on a proof that it cannot trust. A required refund that does not go
through also lands the row on `owed`.

The site keeps an `owed` row and never deletes it. No surface shows it yet. See
the open gap in section 4. The guarantee is that the money is never forgotten in
silence. It is not a promise that every payment ends in a ticket. The five
`read_paid_*` events carry exactly this distinction.

Production receivers: the `sumup_checkout_recovery` maintenance task,
`runDatabasePruning`, the `/admin/schema` page, and `POST /payment/webhook` for
Square.

Only **scheduled** maintenance (`src/features/scheduled.ts`) runs the recovery
task. The task declares `wakePolicy: "organic_safe"`, but that declaration is
moot for it. `maintenance.runOrganic` sets `externalAllowance: 0`. `taskFits`
refuses a task whose `maxExternalCalls` is above what remains. A task that must
call SumUp is therefore never selected after a public request.

## 2. The contract, and where it lives

### Trusted facts

| Fact                                              | Source                                                        | Why we trust it                                                                                                                                                                                                             |
| ------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sumup_checkouts.sumup_id`                        | Written by `setSumupCheckoutId` before the buyer sees the URL | Ours by construction. Not sensitive. The webhook pre-filter already uses it                                                                                                                                                 |
| `sumup_checkouts.reference_index`                 | `hmacHash(reference)` at staging                              | Signed by our key. It proves that a fetched reference names this row                                                                                                                                                        |
| `sumup_checkouts.created_at`                      | Our clock at staging                                          | Ours. `prune.ts` deletes a prunable row by it, and nothing else reads it. It schedules no check: `setSumupCheckoutId` sets the first `next_check_at` from the moment the checkout id lands. It never decides a payment fact |
| The signed price proof inside the staged metadata | `assembleCheckoutMetadata`                                    | Nobody can forge it without our key. It is already the ownership test                                                                                                                                                       |
| Square webhook that names a `COMPLETED` payment   | Verified Square signature                                     | `authenticateWebhook` refuses a missing signature when `providerWebhook(provider.type)` is not `null`, then `provider.verifyWebhookSignature` proves the sender                                                             |

Observed facts stay separate. They never stand in for the facts above.

| Fact                                                 | Source                                     | Trust                                                           |
| ---------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------- |
| SumUp checkout status, amount, currency, transaction | `sumupApi.readCheckoutById(sumup_id)`      | A read. The existing observation boundary refuses it if it lies |
| The `checkout_reference` that SumUp echoes back      | The same read                              | Usable only if it opens the sealed row (`openSumupCheckout`)    |
| Square order and payment                             | `squareApi.readOrder` / `readOrderPayment` | Absent is **not** unpaid. That was the whole Square defect      |

A read that failed is never read as "not paid". A read that we cannot make is
never read as "nothing happened".

### Square: one rule, no machine

Square needs no lifecycle of its own. It has a webhook subscription that
redelivers, which is the one thing that SumUp lacks. Square needed one rule,
written as a refusal:

> A Square webhook that names a `COMPLETED` payment whose order is not readable
> is refused, never acknowledged.

`readSessionOrder` is internal to `src/shared/square-provider.ts`. It throws
when a `paidPaymentId` is present. This matches `readOrderPayment` two functions
below, and the boundary answers 503 so that Square sends the webhook again. The
browser redirect keeps its old behaviour. The redirect supplies no
`paidPaymentId`, and there a `missing` order really does mean "not one of ours".

The replay identity is the **order id**. `retrieveSession` puts it on the
session as `id: order.id`, and that value becomes
`processed_payments.payment_session_id`. A redelivery therefore reserves the
same row. `payment.id` is only the payment reference. The code never reads
Square's event id.

### The machine is declared once, in code

`src/shared/payment/sumup-recovery-machine-spec.ts` holds the nodes, the events,
and the moves table. **This document does not restate them.** Nothing else
restates them either. All of these read that one declaration:

- the node union,
- the stored state words,
- the runtime guard,
- the `/admin/schema` map,
- the queue,
- the prune rule,
- the live scan.

This is deliberate, and it is the lesson that cost this plan the most. Earlier
drafts carried the states, the commands, the failures, the retries, and the
races as five hand-written tables. Every review finding was one table that
disagreed with another table or with the code. One example is a column name that
nothing can look up. Another is an outcome with two different retry owners. A
fix to one disagreement created the next one, because nothing compared the
tables.

A sixth copy in this document repeats that mistake. See the note that this
branch added to PR_WORKFLOW.md.

Read the declaration in this order:

1. `RECOVERY_NODES` — the five nodes. Each node carries `owesMoney` and
   `prunable`.
2. `RECOVERY_EVENTS` — the nine events. Each event carries its `kind` and
   whether it `movesMoney`.
3. `RECOVERY_MOVES` — the table. Every cell that is present is a required
   landing node. Every cell that is absent is a declared refusal, and the mirror
   sweep proves that it throws.
4. `recoveryNodeOf` — total over stored rows. It throws on a combination that no
   writer can produce. That behaviour is what makes the backwards scan possible.
5. `RECOVERY_TERMINAL_NODES`, `RECOVERY_CHECKABLE_NODES`, and
   `RECOVERY_PRUNABLE_NODES` — derived from the table and the node facts. Nobody
   maintains them beside it.

The declaration itself has one gap. `RecoveryEventId` is a hand-written union
beside the `RECOVERY_EVENTS` array, and the moves table is partial. A new id
added to the union alone still compiles. The sweep never visits it, and
`recoveryMoveTo` throws for it in production.

The declaration cannot carry the reasons below, so they stay here:

- **`waiting` counts `owesMoney` as unknown, not no.** Until SumUp answers, we
  cannot say that the buyer did not pay. A lost callback looks exactly like an
  unpaid checkout. That one choice is why `waiting` is not prunable.
- **The five `read_paid_*` events take their names from the money fact that they
  establish.** They do not take their names from what the engine did. The money
  fact decides whether the site can ever delete the row.
- **A replayed terminal failure is not its own event.** It carries the same
  money fact as a fresh one. It arrives as `read_paid_settled` or as
  `read_paid_unsettled`, and the table does the rest.
- **The callback path raises no event at all.** Only the recovery check moves a
  row. That is what lets `finished` refuse every event without a late callback
  that hits the refusal. A callback that arrives after a check closed the row
  goes through the payment engine. The engine answers the provider and leaves
  `recovery_state` alone.
- **A late callback replays the recorded outcome, which is not always a
  booking.** `handleReservationConflict` picks the replay by `attendee_id`. A
  booked row replays its booking through `alreadyProcessedResult`. A row closed
  as `unpaid`, or closed by a refund, replays its recorded terminal failure.
  `test/integration/server/sumup-recovery/late-callback.test.ts` proves the
  booked case.
- **A buyer's return replays only while the staged row survives.**
  `retrieveSession` reads that row through `getSumupCheckout`, and a `finished`
  row is prunable after `PRUNE_SUMUP_RETENTION_HOURS`. After the prune the
  return answers "not found" instead. The ticket itself is unaffected, because
  the booking already exists. No test advances the clock past the prune. That
  limit is read from the code rather than pinned by a test.
- **`owed` refuses `read_pending` and `read_expired_or_failed`.** Every `owed`
  row arrived from a read that said PAID, and SumUp never moves a checkout back
  off PAID. Either cell defends against the impossible.

### The laws, and what enforces each one

Prose can promise these laws. Only a check enforces them. Each law started as a
finding from this review. Each one is now something that cannot happen again.

| Law                                                               | Enforced by                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A node that can hold money is never `prunable`                    | `machine.test.ts`, "a row that may hold money is never deleted on age alone"                                                                                                                                                                                                           |
| A node that can hold money has an outgoing system edge            | `machine.test.ts`, "…always has something that will act on it"                                                                                                                                                                                                                         |
| A node that can hold money can still reach a closed answer        | `machine.test.ts`, "…can still reach a closed answer"                                                                                                                                                                                                                                  |
| A terminal node has no outgoing edge                              | `graph.test.ts`, "a closed row has no way back out"                                                                                                                                                                                                                                    |
| Every node is reachable, and every node can reach a closed answer | `graph.test.ts`                                                                                                                                                                                                                                                                        |
| The row boundary is total, and throws on the impossible           | Two functions carry it. `parseSumupRecoveryState` refuses a stored word the machine does not have, in the `machine.test.ts` unknown-word case. `recoveryNodeOf` takes an already typed state and refuses one that disagrees with the checkout id, in the `graph.test.ts` refusal cases |
| Every edge that lands on a non-terminal node writes the schedule  | Structure, across two writers. `applySumupRecoveryEvent` sets `next_check_at` unless the landing node is terminal. `setSumupCheckoutId` writes the `checkout_created` edge, and it sets `next_check_at` to `SUMUP_FIRST_CHECK_MS`                                                      |
| Every self-move fences on the schedule, not on the state alone    | Structure. `moveSumupRecoveryRow` is the only `UPDATE`. It matches `reference_index`, `recovery_state`, and `next_check_at`                                                                                                                                                            |

The last two laws are structural, not declared. The fence law has one write
helper behind it, `moveSumupRecoveryRow`, so no second implementation can drift.
The schedule law has two writers. `setSumupCheckoutId` writes the
`checkout_created` edge on its own, and it takes the landing state from
`recoveryMoveTo`, so it reads the same declaration.

Both writers obey the law today. Two writers are weaker than one. A test over
the declaration holds this law better than structure does.

Two laws deserve plain words. **The site never deletes a row that can hold money
nobody accounted for. That row always has something that will act on it.** That
is the safety property behind this whole feature. A check enforces it now. It is
no longer a promise.

### Where the built thing differs from the plan

Each item below is a decision that somebody took during the work. None of them
is a slip. They are recorded because the plan argued for something else.

1. **Nobody built `owner_forces_check`.** The plan declared an owner edge on
   `waiting` and on `owed`, and a "Check again now" POST behind
   `ownerFormHandler`. Neither shipped. The plan's own slice notes carried the
   reason. An edge whose only caller lives in a later slice is an export with no
   production caller. This repository deletes such an export.

   The laws hold without it, because both money-holding nodes keep their system
   edges. The scheduled retry is therefore the only thing that moves a row, and
   `owed` is still not a dead end. TODO.md holds the follow-up, "Give SumUp
   recovery anomalies a safe owner repair".
2. **A failed check moves the clock. It does not throw.** The plan called this
   "the one gap the machine cannot close", and left the retry to the maintenance
   runner and its `failureRetryIntervalMs`. Instead, `recoverOne` catches the
   read failure or the settle failure for that row alone. It then calls
   `delaySumupRecoveryCheck`, which writes the state back unchanged and moves
   only `next_check_at`. One checkout that fails no longer stops the rows behind
   it, and a row that fails repeatedly cannot hold the front of the queue.

   The code still does not catch a failure to write the answer. A refused write
   throws to the task's own retry.
3. **The batch is capped. The paid recoveries are not.** The plan promised "at
   most one paid recovery per run". The code caps the run at
   `SUMUP_RECOVERY_BATCH` checkouts, which defaults to 3. The task declares its
   cost as `maxDatabaseCalls` and `maxExternalCalls`, and the runner reads that
   declaration before it starts. A declared budget that the runner reads is the
   stronger form of the same promise.
4. **`read_unavailable` writes the state too.** The plan's events table said
   that it wrote only the schedule. It goes through the single writer like every
   other event, and it lands on the node that it started from. The stored state
   is unchanged either way.
5. **The events carry two facts that the plan did not name.** `kind` is
   `"check"` or `"create"`, and it derives the queue. `movesMoney` is what the
   map reads. Both exist so that a new event joins the queue and the map by
   declaration alone.
6. **The live check is not its own file.** The plan expected
   `src/shared/db/sumup-recovery-scan.ts`. The backwards check landed in the
   shared `src/shared/db/schema-anomaly-scan.ts` in #2123, beside the other
   stored-state anomalies. That is one mechanism that serves one more caller.
7. **Nobody wrote the Cucumber story.** The plan named
   `specs/payments/a-payment-with-no-callback.feature`.
   `test/integration/server/sumup-recovery/recovers.test.ts` covers the recovery
   contract instead. It calls the staging helper and the task directly, so it
   renders no page and runs through no scheduled receiver. The buyer journey is
   therefore still untested. TODO.md records it.

### Owner choices

Nobody added an owner choice. This work never picks a money outcome. The only
real ambiguity that it can produce is `owed`. `owed` is not a decision that the
system takes. It is the honest statement that a provider took money and the
booking did not happen. No surface shows that row to the owner yet, which
section 4 records as an open gap.

Recovery adds no refund path of its own. It reaches the two that the webhook
already runs. A validation, price, or balance failure inside
`processPaymentSession` goes through `refundAndFail`, which sends the money by
`requestSessionRefund`. A paid charge that the engine rejects goes through
`settleRejectedCharge`. Both keep the same rules and the same durable
`payment_charges` authority.

### Security and privacy

- The protection of the staging row is unchanged. The metadata stays encrypted
  under a key wrapped with the reference. The plaintext reference never rests in
  this table. `recovery_state` is a state word that carries no buyer fact and no
  provider fact. Data never moves to weaker protection.
- The recovery check re-obtains the reference the same way that the webhook
  does, from the response of SumUp itself. It decrypts only when
  `hmacHash(reference) === reference_index`.
- Untrusted input that can cause provider work: none that is new. The inputs of
  the task are our own staged rows. Unlike the webhook, no external caller can
  start it.
- `/admin/schema` and its live check are owner-only, like the rest of the page.
  The check lists `reference_index` as the record id, plus the state word.
  `reference_index` is `hmacHash(reference)`, a one-way code that this database
  cannot turn back into the buyer's reference. The scan reads `sumup_id` only to
  pick which fault the row has, and it shows no amount and no buyer fact.
- One HTTP entry point reaches this path: `POST /scheduled`, which
  `serve-app.ts` routes to `handleScheduledRequest`. It runs maintenance, and
  maintenance moves recovery rows. A bearer key guards it, so no untrusted
  caller starts it and no owner-facing control exists. The CSRF rules and the
  owner guard in the plan covered the "Check again now" control, which nobody
  built. They apply again if the TODO.md follow-up ships.

## 3. The module map

| What                           | Where                                                         | Names                                                                                                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The machine                    | `src/shared/payment/sumup-recovery-machine-spec.ts`           | `RECOVERY_NODES`, `RECOVERY_EVENTS`, `RECOVERY_MOVES`, `recoveryNodeOf`, `recoveryMoveTo`, `recoveryRowAfter`, `SumupRecoveryStateSchema`, `parseSumupRecoveryState`, and the three derived node lists |
| The pure rule                  | `src/shared/sumup/recovery.ts`                                | `sumupRecoveryOutcome(reading, outcome)`, `SumupCheckoutReading`                                                                                                                                       |
| One pass of the task           | `src/shared/sumup/recovery-run.ts`                            | `runSumupRecovery`                                                                                                                                                                                     |
| The queue and the fenced write | `src/shared/db/sumup-recovery.ts`                             | `getDueSumupCheckouts`, `applySumupRecoveryEvent`, `delaySumupRecoveryCheck`                                                                                                                           |
| One way to ask SumUp           | `src/shared/sumup/checkout-resolution.ts`                     | `resolveSumupCheckoutById`                                                                                                                                                                             |
| The engine, once               | `src/features/api/payment-callback.ts`                        | `settlePaymentCallback`, `CallbackOutcome`                                                                                                                                                             |
| The map entry                  | `src/shared/schema-atlas/sumup-recovery.ts`                   | `sumupRecoveryAtlas`                                                                                                                                                                                   |
| The backwards check            | `src/shared/db/schema-anomaly-scan.ts`                        | `scanSchemaAnomalies`                                                                                                                                                                                  |
| Pruning                        | `src/shared/db/prune.ts`                                      | reads `RECOVERY_PRUNABLE_NODES`                                                                                                                                                                        |
| The task                       | `src/shared/maintenance/registry.ts`                          | `sumup_checkout_recovery`                                                                                                                                                                              |
| The columns                    | `src/shared/db/migrations/2026-08-18_sumup_recovery_state.ts` | `recovery_state`, `next_check_at`                                                                                                                                                                      |
| Square's rule                  | `src/shared/square-provider.ts`                               | `readSessionOrder`, which is internal                                                                                                                                                                  |

The map held to two shape rules. Both are still true.

- **One engine, not a second one.** `settlePaymentCallback` is the whole of the
  payment work, and it returns an exhaustive `CallbackOutcome` union.
  `webhooks.ts` maps that union to a `Response`. The recovery task maps the same
  union to an event. That gives one production implementation per command, and
  the HTTP layer stays a thin shell. The browser redirect is a third caller with
  its own path: `processSessionAndRedirect` in
  `src/features/api/payment-success.ts` calls `validatePaidSession` and
  `processPaymentSession` directly.
- **One way to ask SumUp about a checkout id.** `resolveSumupCheckoutById` is
  that operation. Both the provider member and the recovery task call it. It is
  not an alias. The member keeps its interface job, and the shared mechanism is
  exposed directly.

`sumupRecoveryOutcome` is pure. Data goes in, an event comes out, and it does no
IO. It names the event that the observation amounts to. The moves table decides
where that event lands, not this function. It is exhaustive over the reading and
over `CallbackOutcome`.

A provider status that the boundary cannot read becomes `read_unavailable`
instead of a guess. A new callback outcome breaks the compile until somebody
decides what that outcome means for the money.

## 4. The arguments made against it

| Challenge                                          | Answer                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The provider read succeeds, the local write fails  | The booking commits atomically before the state write. A failed state write leaves the row where it was. The next check reads again, and `reserveSession` returns the recorded outcome. Proved in `crash-windows.test.ts`                                                                                                                                                                                                       |
| A callback replayed after recovery booked it       | The `processed_payments` primary key, and `alreadyProcessedResult`. Proved in `late-callback.test.ts`                                                                                                                                                                                                                                                                                                                           |
| Two paid checkouts, one buyer                      | Independent rows and independent session ids. Nothing correlates them                                                                                                                                                                                                                                                                                                                                                           |
| A wrong amount, currency, or parent                | Untouched. The existing observation boundary and `classifySessionIntent` decide, and a rejected paid charge takes the existing refund path                                                                                                                                                                                                                                                                                      |
| The buyer reloads during recovery                  | The redirect calls `retrieveSession`, which is already idempotent through the same reserve                                                                                                                                                                                                                                                                                                                                      |
| The task runs on a site with no SumUp              | `enabled: () => settings.sumup.hasKey` reads only `sumup_api_key`. `SUMUP_MERCHANT_CODE` is preloaded through `settingsKeys`, and it does not gate the task. `syncMaintenanceTaskRows` removes a disabled task                                                                                                                                                                                                                  |
| SumUp is disconnected while rows are `waiting`     | Nothing checks them and nothing deletes them, because `waiting` is not `prunable`. No surface lists them, because a valid `waiting` row is not an anomaly. See the open gap below                                                                                                                                                                                                                                               |
| The checkouts of a busy site flood the task        | An oldest-first page of `SUMUP_RECOVERY_BATCH`, then `requestFollowUp()`. A row that fails repeatedly moves its own check time forward, so it falls behind rows that became due meanwhile                                                                                                                                                                                                                                       |
| The budget of 50 subrequests on Bunny              | Three separate bounds. `validateTask` refuses a declaration whose `maxDatabaseCalls + maxExternalCalls` is above `MAINTENANCE_TASK_CALL_LIMIT`. `maintenanceStartupCalls` sums the enabled-check calls of every task against `MAINTENANCE_REQUEST_DATABASE_CALL_LIMIT` and `MAINTENANCE_REQUEST_CALL_LIMIT`. At run time, `taskFits` picks a task only if its declared calls fit what remains of the allowance for this request |
| Does this work refund money in the background?     | Only through the path that the webhook already runs for a rejected paid charge. It is the same engine, because a second engine was forbidden                                                                                                                                                                                                                                                                                    |
| Square: does the throw break the browser redirect? | No. Only the `missing` read is conditional: it throws when a `paidPaymentId` is present, and only the webhook supplies one. The redirect keeps `null` for `missing`, where a lost order really is "not ours". Any other unreadable status throws for both callers, as it did before                                                                                                                                             |
| A later change adds a node or an event             | The laws bind every node in `RECOVERY_NODES` and every event in `RECOVERY_EVENTS`. Such a change must satisfy them, or the suite fails: a money-holding node cannot be prunable and cannot be a dead end, and a terminal node cannot grow an edge. An id added to the `RecoveryEventId` union alone escapes the laws, because the sweep reads the array. See the note in section 2                                              |
| SumUp returns a status we do not know              | `SumupCheckoutStatusSchema` is a closed picklist. An unknown word fails the boundary and arrives as `read_unavailable`. The row stays where it is, and something asks again                                                                                                                                                                                                                                                     |

The review made one product choice and held it. **The site never deletes a row
on age alone, when that row can hold money that nobody accounted for.** That
rule covers `owed`, where somebody saw the money and nobody accounted for it. It
also covers `waiting`, which nothing proved either way.

Without that rule, the site deletes a checkout that was paid while SumUp was
unreachable for the whole retention window. That deletion is the exact harm that
this work closes. Age never deletes either state. A definitive answer is the
only thing that can close one.

The cost is that a site that disconnects SumUp keeps its unanswered `waiting`
rows. The rows are small. Their metadata stays sealed under a reference that
this database does not hold. Real incidents bound the growth, not traffic. The
alternative is a long backstop that deletes them in the end. That trades a rare
lost payment for a tidier table, which is the wrong way round.

**One gap is open, and it is not in the code above. No surface shows a retained
row to the operator.** `SUMUP_SCAN` in `src/shared/db/schema-anomaly-scan.ts`
selects three faults:

- a state word the machine does not have,
- a checkout id that disagrees with the state,
- a check time that does not fit the state.

A checkable row needs a well-formed check time. A closed row needs none at all.
The scan reports a broken row, not an unanswered one.

This covers both states that the site keeps:

- An `owed` row is well formed. It holds a known state, a checkout id, and a
  valid check time, so the scan passes over it.
- A `waiting` row on a site that removed its SumUp key is well formed for the
  same reasons.

`/admin/schema` renders the machine itself, the nodes and the edges. It does not
list stored rows. So the site retains the evidence of a payment that nobody
accounted for, and no page shows it. TODO.md records the work to close this.

## 5. What each slice shipped

### Slice 1 — a Square webhook for a completed payment is never acknowledged as pending

Shipped in #2106. `readSessionOrder` throws when a `paidPaymentId` is present
and the order reads `missing`. `retrieveSession` still answers `null` for the
browser redirect. The `missing → null → "skip" → 200` arm for paid webhooks is
gone.

Tests:

- `test/shared/square-provider/webhook.test.ts` — "refuses a completed payment
  whose order is not readable yet".
- `test/shared/square-provider/read-outcomes.test.ts` — "keeps an order Square
  cannot find retryable after a completed event".
- `test/integration/server/webhooks/square.test.ts` — "keeps a completed payment
  whose order is not readable yet retryable".

Two things differed from the plan. Nobody wrote the redelivery test that the
plan named. The slice recorded a reason for that, and the reason was wrong.

The replay suites configure Stripe. No Square test delivers the same completed
webhook twice. The replay identity of Square therefore has no direct test.
TODO.md records that gap.

#2107 then followed. It closed three gaps that the mutation gate found in the
same file:

- a payment id of one character, which the code discarded,
- two different order faults, which logged the same line,
- a blank payment status, which the code reported as an outage.

### Slice 2 — a staged SumUp checkout must prove what happened to it

Shipped in #2109. #2123 added the report of invalid rows on `/admin/schema`.
Section 3 holds the files and the names. Section 2 holds the differences from
the plan.

Deleted with it: the blind `boundedDelete("sumup_checkouts", "created_at < ?")`,
and the HTTP-shaped session handling inside `handlePaymentWebhook`.

Tests, by what each one holds:

- `test/shared/payment/sumup-recovery-machine-spec/machine.test.ts` — the laws
  over the declaration, and the mirror sweep. The sweep runs every cell of node
  by event by shape against the real transitions, and it includes every declared
  refusal.
- `test/shared/payment/sumup-recovery-machine-spec/graph.test.ts` — every node
  is reachable from `staged`. Every node reaches a closed answer. A closed row
  has no way back out. It also covers the refusals of `recoveryNodeOf`.
- `test/shared/sumup/recovery.test.ts` — `sumupRecoveryOutcome`, table driven,
  one case per reading and outcome. Each case names the event, not the landing
  node.
- `test/shared/db/sumup-recovery.test.ts` — the queue and the fenced write.
- `test/integration/server/sumup-recovery/recovers.test.ts` — books a paid
  checkout whose callback never arrived. It books that checkout exactly once
  when the check runs twice. It closes a checkout that SumUp says nobody paid.
  It asks again when SumUp cannot answer.
- `test/integration/server/sumup-recovery/late-callback.test.ts` — a callback
  after the check books nobody a second time. The buyer who returns later still
  sees the booking.
- `test/integration/server/sumup-recovery/crash-windows.test.ts` — a failed
  state write finishes the row on the next check.
- `test/integration/server/sumup-recovery/races-the-webhook.test.ts` — the
  webhook and the recovery run together. The test asserts one `attendees` row,
  one `processed_payments` row, and a row that does not end on `owed`. It reads
  no ledger row, so it does not prove that the ledger holds one group. TODO.md
  records that gap.
- `test/integration/server/sumup-recovery/lost-race.test.ts` and
  `test/integration/server/sumup-recovery/queue-order.test.ts` — the loser of
  the fence, and a stuck row that does not hold the front of the queue.
- `test/integration/server/sumup-recovery/prune.test.ts` — a `waiting` row and
  an `owed` row survive at any age. A `finished` row does not.
- `test/shared/db/migrations/2026-08-18_sumup_recovery_state.test.ts` — the
  derived states and check times for existing rows.
- `test/shared/schema-atlas/sumup-recovery.test.ts` — the map entry.

## 6. Where this sits against PLAN.md

Resolved. The work moved the task forward out of work package M7 onto the
current path. It needed nothing from the aggregate reader. It added no parallel
path and no dormant layer. The harm that it closes was live on every SumUp site
while somebody designed the cutover.

`PLAN.md` records this. Its M7 bullet states that the missed-SumUp-checkout task
already runs on the current path, as `sumup_checkout_recovery`. It states that
M7 adopts that task rather than a second build of it.
