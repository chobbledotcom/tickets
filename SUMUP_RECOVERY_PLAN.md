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

Value once the two pull requests in section 5 ship, whether or not any later one
does — this plan itself changes no behaviour:

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

### Square: one rule, no machine

Square needs no lifecycle of its own — it has a webhook subscription that
redelivers, which is the whole thing SumUp lacks. It needs one rule, stated as a
refusal:

> A Square webhook naming a `COMPLETED` payment whose order is not readable is
> refused, never acknowledged. `readSessionOrder` throws when a `paidPaymentId`
> is present, matching `readOrderPayment` two functions down, and the boundary
> answers 503 so Square sends it again.

The browser redirect keeps today's behaviour: it supplies no `paidPaymentId`,
and there a `missing` order really does mean "not one of ours". The replay
identity is the **order id** — `retrieveSession` puts it on the session as
`id: order.id`, and that becomes `processed_payments.payment_session_id`, so a
redelivery reserves the same row. `payment.id` is only the payment reference;
Square's event id is not read at all.

### One declared machine, not five prose tables

Earlier drafts of this contract carried the states, the commands, the failures,
the retries, and the races as five hand-written tables. Every review finding so
far has been one of those tables disagreeing with another or with the code: a
column name nothing could look up, an outcome with two different retry owners, a
failure row that wrote no schedule while the retry table promised one. Fixing
each disagreement created the next, because nothing checked the tables against
each other.

So the machine is the contract. One declaration carries the nodes, the events,
and an exhaustive moves table, in the shape
`src/shared/schema-atlas/machine-spec.ts` already defines. Everything the five
tables used to say is a property of a node or an edge, and the tables below are
**projections of that one declaration, not separate sources**. It lands as
`src/shared/payment/sumup-recovery-machine-spec.ts`, joins
`SCHEMA_ATLAS_MACHINES`, and its mirror suite executes every (node × event ×
shape) cell against the real transitions — a cell absent from the table is a
declared refusal, and the sweep proves it refuses.

### Nodes

A node carries what the row is, plus the two facts the old tables kept
restating: whether it may hold money nobody has accounted for, and whether
pruning may delete it.

| Node       | Meaning                                             | `owesMoney` | `prunable` |
| ---------- | --------------------------------------------------- | ----------- | ---------- |
| `staged`   | Row written; SumUp has not given us a checkout id   | no          | yes        |
| `waiting`  | Checkout is live; the buyer may still pay           | **unknown** | **no**     |
| `unpaid`   | SumUp said this checkout was never paid             | no          | yes        |
| `finished` | Paid, and the payment engine reached a final answer | no          | yes        |
| `owed`     | Paid, and we could **not** reach a final answer     | **yes**     | **no**     |

`waiting` counts as unknown rather than no: until SumUp answers, we cannot say
the buyer did not pay, and the whole point of this work is that a lost callback
looks exactly like an unpaid checkout.

`nodeOf(row)` is total — it maps every stored row to exactly one node and throws
on a combination no writer can produce, the way `rowNodeOf` does for the payment
row. That is what makes the backwards scan possible: a row that does not map is
a defect the operator sees, not a silent default.

### Events

An event carries what it runs, and the two things the old concurrency and
failure tables kept separately: what it writes, and what its conditional
`UPDATE` fences on.

| Event                     | Actor     | Writes           | Fences on                   |
| ------------------------- | --------- | ---------------- | --------------------------- |
| `checkout_created`        | system    | state + schedule | `reference_index` (one row) |
| `read_unavailable`        | system    | schedule         | state + schedule            |
| `read_pending`            | system    | schedule         | state + schedule            |
| `read_expired_or_failed`  | system    | state + schedule | state + schedule            |
| `read_paid_booked`        | system    | state + schedule | state + schedule            |
| `read_paid_settled`       | system    | state + schedule | state + schedule            |
| `read_paid_unsettled`     | system    | state + schedule | state + schedule            |
| `read_paid_unreadable`    | system    | schedule         | state + schedule            |
| `read_paid_contradiction` | system    | state + schedule | state + schedule            |
| `owner_forces_check`      | **owner** | schedule         | state + schedule            |

The five `read_paid_*` events are exhaustive over what the payment engine can
answer for a paid checkout, and each is named for the **money fact** it
establishes, because that is what decides whether the row may be deleted:

| Engine answer                                     | Event                     | Money                       |
| ------------------------------------------------- | ------------------------- | --------------------------- |
| Booked (including a replay of an earlier booking) | `read_paid_booked`        | Accounted for by a booking  |
| Handled failure, refunded or nothing to refund    | `read_paid_settled`       | Accounted for               |
| Handled failure, a required refund did not go     | `read_paid_unsettled`     | **Not** accounted for       |
| Reservation held elsewhere, or an unreadable one  | `read_paid_unreadable`    | Not yet known               |
| The reference does not open the staged row        | `read_paid_contradiction` | Not knowable from this side |

A replayed terminal failure is not its own event. It is classified by the same
money fact as a fresh one, so it arrives as `read_paid_settled` or
`read_paid_unsettled` and the table does the rest.

**The callback path raises no event at all.** Only the recovery check moves a
row, which is what lets `finished` refuse everything without a late callback
ever hitting that refusal: a callback that arrives after a check has closed the
row goes through the payment engine, replays the booking it already made,
answers the provider, and leaves `recovery_state` alone. The same is true of the
buyer returning to the success page days later. That is checked rather than
assumed — see the callback-after-recovery tests.

### The moves table

Every cell that is present is a required landing node. Every cell that is absent
is a declared refusal the sweep executes. This is the whole of what the old
states, commands, and failure tables said:

```typescript
export const EXPECTED_MOVES: MachineMoves<RecoveryNodeId, RecoveryEventId> = {
  staged: { checkout_created: "waiting" },
  waiting: {
    read_unavailable: "waiting",
    read_pending: "waiting",
    read_paid_unreadable: "waiting",
    read_expired_or_failed: "unpaid",
    read_paid_booked: "finished",
    read_paid_settled: "finished",
    read_paid_unsettled: "owed",
    read_paid_contradiction: "owed",
    owner_forces_check: "waiting",
  },
  owed: {
    read_unavailable: "owed",
    read_paid_unreadable: "owed",
    read_paid_booked: "finished",
    read_paid_settled: "finished",
    read_paid_unsettled: "owed",
    read_paid_contradiction: "owed",
    owner_forces_check: "owed",
  },
  unpaid: {},
  finished: {},
};
```

Read the refusals, because they are the contract too. `staged` takes no read
event — a row with no checkout id has nothing to ask SumUp about. `unpaid` and
`finished` take nothing at all: they are terminal, and a late event against them
is a bug, not a transition. `owed` has no `checkout_created`.

`owed` also refuses `read_pending` and `read_expired_or_failed`. Every `owed`
row got there from a read that said PAID, and SumUp never moves a checkout back
off PAID, so a cell for either would be defending against the impossible. The
round-one finding — a replayed terminal failure may not finish a row that says
money was seen — is now carried by the table itself rather than by a special
event: from `owed`, the only cells that reach `finished` are the two that
establish the money is accounted for.

### What drafting the code changed here

Writing the first slice against this table found four places where it did not
survive contact with the code. They are corrected above; they are listed here
because each one is a decision, not a typo, and the reviewer is approving the
corrected version:

1. **`checkout_created` writes the schedule too**, not the state alone. The
   Events table said state; the fourth law says every edge landing on a
   non-terminal node writes the schedule. A newly created checkout with no check
   time would never be asked about — the exact harm this work exists to close —
   so the law was right and the row was wrong.
2. **`replayed_failure` is gone.** It had no `waiting` cell, but the path is
   reachable and common: a callback that arrives, fails terminally, and leaves
   the row still `waiting` for its first check. Rather than add a cell, the
   event was removed — a replayed terminal failure carries the same money fact
   as a fresh one, so it classifies as `read_paid_settled` or
   `read_paid_unsettled` like any other.
3. **`read_paid_refunded` became `read_paid_settled`.** The engine has a
   handled-failure answer with nothing to refund (no charge was captured). The
   old name had no cell for it. The new name covers both, and says the thing
   that actually decides the row's fate: the money is accounted for.
4. **`owed` lost `read_pending`.** Every `owed` row got there from a PAID read,
   and a checkout never moves back off PAID, so the cell was defending against
   the impossible.

The first three were found by the laws and the totality requirement rather than
by reading — which is the argument for writing lifecycles this way.

### The laws over the declaration

Prose can promise these; only a check enforces them. Each is a test over the
declaration itself, so a future event or node cannot break it quietly. Every one
of them is a finding this review already produced, turned into something that
cannot recur:

| Law                                                                 | The finding it retires                        |
| ------------------------------------------------------------------- | --------------------------------------------- |
| A node with `owesMoney` other than `no` is never `prunable`         | Pruning deleting a paid-but-unchecked row     |
| A node with `owesMoney` other than `no` has an outgoing system edge | `owed` becoming a manual-only dead end        |
| Every edge landing on a non-terminal node writes the schedule       | A check that changed nothing left the row due |
| Every self-move fences on the schedule, not just the state          | Two same-state writes both believing they won |
| Every `actor: "owner"` edge names its route guard                   | The owner control with no stated CSRF policy  |
| A terminal node has no outgoing edges                               | A late event silently reviving a closed row   |
| `nodeOf` is total over stored rows, throwing on the impossible      | Existing rows with no derived state           |

The first two are the ones worth stating plainly: **a row that may hold money
nobody has accounted for is never deleted, and always has something that will
act on it.** Those two sentences are the safety property this whole feature
exists to provide, and after this they are checked rather than promised.

### What the projections say

The remaining contract facts are read off the declaration rather than maintained
beside it.

- **Retry owner** is not a column. A node's retry owner is "the scheduler"
  whenever it has an outgoing system edge, which by the second law every
  money-holding node has. The owner's edge is additive — it brings the next
  check forward, it does not own the retry.
- **Terminal** is not a list either — it is the two nodes no event can move,
  `unpaid` and `finished`. Only one of them is a failure: `unpaid` means SumUp
  says nobody ever paid, while `finished` means the money is accounted for, by a
  booking or by returning it. `owed` is not terminal, so it is never permanent —
  it is the one state that is still waiting for an answer.
- **What a replay returns** stays the payment engine's answer, unchanged:
  `processed_payments.payment_session_id` (= the SumUp `checkout_reference`) is
  reserved before any work, so `alreadyProcessedResult` or the recorded terminal
  failure comes back rather than a second booking or a second refund.
- **Who wins a race** is the fence column. Two runners are already kept apart by
  the maintenance lease (`claimNextMaintenanceTask`) and by `reserveSession`;
  within one row, the loser of any pair finds zero affected rows because every
  edge fences on the exact state and schedule it read.

### The one gap the machine cannot close

A failed state write can record nothing by definition, so no edge covers it: the
booking has committed and the schedule did not move. The task throws, and the
maintenance runner holds it off for its declared `failureRetryIntervalMs` before
running it again. The next check is idempotent, so the cost is one wasted
provider read. This is named here rather than modelled as an edge, because an
edge that cannot write is not a transition — and the laws above would rightly
reject it.

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
- **"Check again now" is a POST built with `ownerFormHandler`**
  (`src/shared/app-forms.ts`), which is `createAuthedHandler` under the
  `OWNER_FORM` policy — CSRF plus owner auth from the one shared mechanism, not
  new plumbing. The scheduled task has no external caller, but this control is a
  state-changing HTTP entry point and gets the same guard every other admin form
  has. All it may do is bring `next_check_at` forward under the fence above; it
  never reads the provider itself, so a replayed submission costs nothing. Tests
  cover a manager being refused and a missing or invalid token being refused.
- The live check lists the SumUp checkout id (not sensitive, already the
  pre-filter key) and the state word. No amount, no buyer fact.

## 3. Shared contract

- **The machine declaration is the contract**, not a description of it.
  `src/shared/payment/sumup-recovery-machine-spec.ts` holds the nodes, the
  events, and the moves table in section 2, and everything else derives from it:
  the node union, the state words, the runtime guard, the `/admin/schema` map,
  the live scan's queries, and the laws. Nothing restates it.
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
- **One pure rule, reading the declaration.**
  `sumupRecoveryOutcome(read,
  engineAnswer)` in `src/shared/sumup/recovery.ts`
  — data in, event out. No IO. It names the event the observation amounts to;
  the moves table, not this function, decides where that event lands. Exhaustive
  over `ProviderRead<SumupCheckout>` and the payment engine's answer, so a
  provider status the boundary cannot read becomes `read_unavailable` rather
  than a guess.
- **The sweep and the laws ship with it.** The mirror suite executes every (node
  × event × shape) cell against the real transitions, and the law tests in
  section 2 run over the declaration itself. It joins `SCHEMA_ATLAS_MACHINES`,
  so `/admin/schema` maps it with no other change.
- **The backwards check reads the stored data.** A bounded scan (the
  `joint-state-scan.ts` shape, `SCAN_LIMIT`-style cap) lists `owed` rows and
  `waiting` rows past their check window, keyed by the declaration's own literal
  states so a new state does not compile until the scan knows how to find it.

## 4. Challenging the contract

| Challenge                                          | Answer                                                                                                                                                                                           |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Provider read succeeds, local write fails          | The booking commits atomically before the state write. A failed state write leaves `waiting`; the next check re-reads and `reserveSession` returns the recorded outcome                          |
| Callback replayed after recovery already booked it | `processed_payments` PK; `alreadyProcessedResult`                                                                                                                                                |
| Two paid checkouts, one buyer                      | Independent rows and independent session ids; nothing correlates them                                                                                                                            |
| Amount/currency/parent wrong                       | Untouched: the existing observation boundary and `classifySessionIntent` decide, and a rejected paid charge takes the existing refund path                                                       |
| Buyer reloads mid-recovery                         | The redirect calls `retrieveSession`, which is already idempotent through the same reserve                                                                                                       |
| The task runs on a site with no SumUp              | `check.enabled` reads `SUMUP_API_KEY`/`SUMUP_MERCHANT_CODE`; disabled tasks are removed by `syncMaintenanceTaskRows`                                                                             |
| SumUp is disconnected while rows are `waiting`     | They are never checked and never deleted — `waiting` is not `prunable`. The live check shows them as overdue, which is the honest answer; see the open question below                            |
| A busy site's checkouts flood the task             | Oldest-first page with a small limit and `requestFollowUp()`; at most **one** paid recovery per run, because a rejection can spend refund subrequests                                            |
| Budget: Bunny's 50 subrequests                     | Declared in the task's `maxDatabaseCalls`/`maxExternalCalls`, which `maintenanceStartupCalls` already sums and the runner already enforces via `budget.remaining()`                              |
| Does this refund money in the background?          | Only through the path the webhook already runs for a rejected paid charge. It is the same engine or it is a second one — the plan forbids a second one                                           |
| Square: does throwing break the browser redirect?  | No. `readSessionOrder` throws only when a `paidPaymentId` is present, which only the webhook supplies. The redirect keeps `null` — there, `missing` really is "not ours"                         |
| A later change adds a node or an event             | It must satisfy the laws in section 2 or the suite fails: a money-holding node cannot be prunable or a dead end, a non-terminal edge cannot skip the schedule, a self-move cannot skip the fence |
| SumUp returns a status we do not know              | `SumupCheckoutStatusSchema` is a closed picklist, so an unknown word fails the boundary and arrives as `read_unavailable` — the row stays put and is asked again                                 |

Open question for the human, and the only product choice left: **a row that may
hold money we have not accounted for is never deleted on age alone.** That
covers `owed` (money seen, not accounted for) and `waiting` (never yet proved
either way — a checkout paid while SumUp was unreachable for the whole retention
window would otherwise be deleted, which is the exact harm this work exists to
close). Both end on a definitive answer or an owner decision, never on a clock.

The cost is that a site which disconnects SumUp keeps its unanswered `waiting`
rows. They are small, and their metadata stays sealed under a reference this
database does not hold, so the retained bytes are inert. Growth is bounded by
real incidents, and the live check shows the operator exactly what is
outstanding. The alternative — a long backstop that eventually deletes them —
trades a rare lost payment for a tidier table, which is the wrong way round.

## 5. Vertical pull requests

### PR 1 — A Square webhook for a completed payment is never acknowledged as pending

**Shipped** in #2106. The code is now the authority: `readSessionOrder` in
`src/shared/square-provider.ts` throws when a `paidPaymentId` is present and the
order reads `missing`, and `retrieveSession` still answers `null` for the
browser redirect. The tests are `test/shared/square-provider/webhook.test.ts`
("refuses a completed payment whose order is not readable yet"),
`test/shared/square-provider/read-outcomes.test.ts` ("keeps an order Square
cannot find retryable after a completed event"), and
`test/integration/server/webhooks/square.test.ts` ("keeps a completed payment
whose order is not readable yet retryable").

Two things differ from what is written below. The redelivery test named here was
not written: the existing idempotency tests already deliver the same Square
webhook twice and assert one attendee, so a third would have restated a pinned
test rather than added one. And #2107 followed it, closing three gaps the
mutation gate found in the same file — a one-character payment id being
discarded, two different order faults logging identically, and a blank payment
status reported as an outage.

The original plan for this slice, kept for the record:

- Value: a paid Square booking whose order lags is redelivered, not dropped.
- Change: `readSessionOrder` learns whether a `paidPaymentId` is in play and
  throws on `missing` when it is, matching `readOrderPayment` two functions
  down. The redirect keeps returning `null`.
- Old path deleted: the `missing → null → "skip" → 200` arm for paid webhooks.
- Files: `src/shared/square-provider.ts`. **~20 src lines.**
- Call budget: unchanged (no new reads).
- Replay key: the order id, as section 2 states it.
- Tests: a direct test proving a `missing` order under a completed payment id
  throws and the same read without a payment id still returns `null`; a webhook
  integration test proving 503 instead of 200; and a redelivery test that lets
  the order become readable and then delivers the webhook twice, asserting one
  attendee, one ledger group, and no second refund. The regression test must
  fail on today's code first.
- Contract rows: the whole of "Square: one rule, no machine" in section 2.

### PR 2 — A staged SumUp checkout must prove what happened to it

- Value: the paid-but-lost checkout becomes a booking; the evidence stops being
  deleted at 24 hours; the owner can see anything still owed.
- Change: the `recovery_state` and `next_check_at` columns, with the migration's
  `after` hook deriving both for existing rows; the state words as a valibot
  picklist; the pure `sumupRecoveryOutcome`; `resolveSumupCheckoutById` lifted
  out of the provider member; the `settlePaymentCallback` extraction with
  `webhooks.ts` reduced to mapping its outcome to a `Response`; the
  `sumup_checkout_recovery` maintenance task, selecting and re-scheduling on
  `next_check_at`; prune scoped to the `prunable` nodes; the machine spec, its
  law suite, and its atlas entry; the bounded live check; the owner-only "Check
  again now" action. The spec lands **first**: the task, the prune rule, the
  scan, and the map all read it, so nothing in this PR restates a node or an
  edge.
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
  scheduled retry. `owner_forces_check` moves with the action that raises it,
  not with the machine: an edge whose only caller is in a later slice is an
  export with no production caller, which this repository deletes rather than
  ships. The laws hold either way — the money-holding nodes keep their system
  edges without it.
- Call budget: startup adds 1 settings read + 1 database call to the task check.
  Per run: ≤3 database reads, ≤3 SumUp reads, ≤1 paid recovery (which may spend
  the existing refund path's calls). Well inside `MAINTENANCE_TASK_CALL_LIMIT`.
- Contract rows: every node, every event, every cell of the moves table, and
  every law in section 2.

Tests proving each row: the mirror sweep executing every (node × event × shape)
cell against the real transitions, including every declared refusal, over the
shared `registerConformanceSweep` / `registerTableChecks` harness with its size
pinned; a law suite over the declaration itself — no money-holding node is
prunable, no money-holding node lacks an outgoing system edge, no edge landing
on a non-terminal node skips the schedule, no self-move skips the fence, no
terminal node has an outgoing edge, and `nodeOf` is total; a graph suite proving
every node is reachable from `staged` and every node can reach a terminal one;
direct unit tests for `sumupRecoveryOutcome` (table driven, one case per read ×
answer, naming the event rather than the landing node); fault-injected tests
(`test/test-utils/db-fault.ts`) at each of the three windows — failing before
the booking, during the refund of a rejected charge, and after the booking
commits but before the state write — each proving the next check reaches the
same single outcome; a test that puts a recorded terminal failure with an
unreturned charge under an `owed` row and proves the replay leaves it `owed`
rather than `finished`, and its pair that proves a refunded one does finish; a
migration test starting from rows with and without a `sumup_id` and asserting
the derived states and check times; a starvation test proving a permanently
stuck row does not hold the front of the queue while newer rows wait; a test
that two concurrent checks on one `waiting` row leave exactly one new
`next_check_at`, and that an owner-forced check is not overwritten by a
scheduled one that raced it; route tests refusing a manager and refusing a
missing or invalid CSRF token on "Check again now"; a concurrency test running
webhook and recovery together and asserting exactly one attendee and one ledger
group; a prune test proving `waiting` and `owed` rows survive and a `finished`
row does not; a scan test reading the declared states back out; and a Cucumber
story — `specs/payments/a-payment-with-no-callback.feature` — buying through the
real public booking page, dropping the callback, running maintenance, and
finding the ticket.

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
2. never deleting a `waiting` or `owed` row on age alone — declared as
   `prunable: no` on both nodes and enforced by the first law. This is the one
   that keeps unanswered rows on a disconnected site;
3. checking **every** created checkout once, rather than stamping the row from
   the completion path;
4. pulling the task forward from M7 (section 6).

The moves table and the laws in section 2 are the parts worth reading closely,
because they are what the code will be held to. In particular the refusals: a
cell left empty there is a promise that the transition throws, and the sweep
will prove it. If a cell should exist that does not, or one exists that should
not, that is a product decision, not an implementation detail.
