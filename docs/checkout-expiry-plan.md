# Unpaid checkout expiry plan

## Current-system value

An unpaid checkout cannot take payment after about an hour on every provider.
Today a Square payment link takes payment for 180 days after its creation, and a
Stripe checkout session for 24 hours. A buyer can pay a months-old Square link,
claim the last capacity, and force a refund conflict.

Decided with the owner: the payment window is one hour, and an unpaid Square
checkout keeps a stored cancel handle.

| Provider | Unpaid page takes payment until | Who ends it                                                                                                                                     | Stored handle |
| -------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| Square   | creation plus the window        | our Square link expiry task                                                                                                                     | yes, sealed   |
| Stripe   | creation plus the window        | Stripe, from the `expires_at` we send at creation                                                                                               | none          |
| SumUp    | creation plus 30 minutes        | SumUp closes its hosted page itself. A hosted session lives 30 minutes and cannot live longer. `valid_until` can only close a checkout earlier. | none          |

Production routes: `createSquarePaymentLink` in `src/shared/square/checkout.ts`,
the Stripe create in `src/shared/stripe.ts`, the maintenance registry in
`src/shared/maintenance/registry.ts`, and the buyer return page behind
`validatePaidSession`.

The window is one limit constant, `CHECKOUT_WINDOW_MINUTES`, default 60. Square
and Stripe read it. SumUp reads nothing, because its page closes earlier on its
own.

## The Square link end machine

A new table `square_link_ends` holds one row per unpaid Square checkout. The row
carries the one fact that can end the checkout at Square: the payment link id.
The machine is declared with the `machine-spec.ts` shape, like
`sumup-recovery-machine-spec.ts`. The stored state word is also the node id.

Columns: `session_index` (primary key, the one-way HMAC of the session id, same
derivation as `checkout_pending_answers`), `state`, `sealed_handle` (the link id
sealed with `DB_ENCRYPTION_KEY`), `link_ends_at`, `next_attempt_at`.

### Nodes

| Node      | The link can still take payment | Prunable | Facts                                                                 |
| --------- | ------------------------------- | -------- | --------------------------------------------------------------------- |
| `pending` | yes                             | no       | `next_attempt_at` is when a worker can claim it                       |
| `ending`  | yes, until Square answers       | no       | a worker holds the lease. `next_attempt_at` is when the lease expires |

A row leaves the table when its link is observably ended, gone, paid, or refused
as paid. No row survives its own ending.

### Moves

| From      | Command or event                                                           | Result      | Guard or write                                                            |
| --------- | -------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------- |
| none      | Square checkout created                                                    | `pending`   | insert with `link_ends_at` = `next_attempt_at` = creation plus the window |
| `pending` | payment completes                                                          | row deleted | conditional on `pending`. A Square link dies with its first payment       |
| `pending` | worker claims a due row                                                    | `ending`    | conditional update. `now` must pass `next_attempt_at`                     |
| `ending`  | delete answered `200` with `cancelled_order_id`                            | row deleted | Square proved the order went `CANCELED`                                   |
| `ending`  | delete answered `404`                                                      | row deleted | the link is already gone                                                  |
| `ending`  | delete refused, and the refusal names a paid or completed order            | row deleted | the webhook and the return path own completion                            |
| `ending`  | delete answered `200` without `cancelled_order_id`, or failed on transport | `pending`   | `next_attempt_at` = now plus the failure retry                            |
| `ending`  | lease expired                                                              | `pending`   | `next_attempt_at` = now                                                   |

The task is `square_link_expiry` in the maintenance registry. It follows
`sumup_checkout_recovery`: batch `SQUARE_LINK_EXPIRY_BATCH` (10), interval
`SQUARE_LINK_EXPIRY_INTERVAL_MINUTES` (5), failure retry 5 minutes, budgets 10
external and about 21 database calls, enabled only when Square is configured,
wake policy `organic_safe`. A full batch requests a follow-up. Only
`POST /scheduled` can reach it, because organic maintenance carries an external
allowance of zero.

### Laws

These are tests, not promises.

1. A row exists exactly while its link can still take payment. Creation adds it.
   A confirmed end, a `404`, a paid-order refusal, and a completed payment
   delete it. Nothing else deletes a row.
2. Every move is a conditional write on `state`, so two workers never act on one
   row together.
3. The expiry task never moves money and never writes attendee, capacity, or
   payment state. It ends links and rows only.
4. A row that can still take payment is never pruned by retention.
5. A staged answers row is deleted only after its checkout can no longer take
   payment. For Square that fact is observed: the handle row must be gone. For
   Stripe the staged `link_ends_at` is the fact, because Stripe ends its own
   page. A SumUp row keeps `link_ends_at` null and waits for the payments clock,
   as today.
6. A Square checkout whose expiry never ran keeps its answers until Square's own
   180-day clock closes its page. A site with no scheduled monitor therefore
   keeps today's behavior.

Law 5 has two arms, and whichever fires first wins. The monitor arm holds Square
answers until the handle row is gone. The fallback arm serves a site with no
scheduled monitor: a handle row that never ends holds its answers until
`created_at` passes the 180-day Square lifetime plus the webhook window. Past
that bound the link cannot take payment, because Square closed its own page, so
the answers go even though the row remains. The payments clock arm stays for
every provider.

A handle row past that same bound is itself prunable by retention: its link can
no longer take payment, so law 4 does not protect it. A younger unended row
stays, and the task keeps failing loudly on it.

## Trusted facts

Expected facts, ours and trusted:

- The signed price proof and the staged answers.
- The `link_ends_at` we computed at creation.

Observed facts, read from the provider:

- The delete answer. Only `cancelled_order_id` proves the order went `CANCELED`.
  A `200` without it proves nothing. Square has returned that shape while the
  link stayed payable and was later paid, so it is a failure, not a success.
- The order and payment reads behind `retrieveSession`.
- The signed Square webhook.

The task never substitutes an expected fact for a missing observed one. Only
`cancelled_order_id`, a `404`, or a paid-order refusal ends a row.

## Failure table

| Work completed         | Failure            | Required result                                                                 | Retry owner           |
| ---------------------- | ------------------ | ------------------------------------------------------------------------------- | --------------------- |
| Nothing                | Square unreachable | row stays `pending`                                                             | task, after 5 minutes |
| Delete sent            | answer lost        | lease expires, row returns to `pending`. The next delete sees `404` and ends it | task                  |
| Delete confirmed       | row delete fails   | row is claimed again. The next delete sees `404` and ends it                    | task                  |
| Delete refused as paid | row delete fails   | same path as a confirmed delete                                                 | task                  |
| Any row                | task-level failure | `/scheduled` answers `503` and the failure is reported. Rows stay unchanged     | monitor               |

No failure is permanent. A row that never ends keeps failing the task loudly. It
holds no money, so it is never an owner choice. Each row is classified on its
own answer, so one failed row never blocks the batch.

## Retry and replay

- Stable identity: `session_index`, the one-way HMAC of the Square order id. A
  retried checkout creates a new link and a new row. The old row still ends the
  old link.
- Deleting a deleted link answers `404`, so a repeat delete ends the row. The
  task is idempotent through Square's `404`.
- The claim lease stops two workers together. A crashed worker's lease expires
  back to `pending`.

## Concurrency

| Operation A                    | Operation B                   | Required result                                                                              | Protection                                     |
| ------------------------------ | ----------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Task claims a row              | webhook completes the payment | one wins the row. The loser reads the other's outcome                                        | conditional write on `state`                   |
| Two scheduled pings            | the same due row              | one claim                                                                                    | conditional claim plus the task interval fence |
| Buyer pays in the claim window | task deletes                  | the payment processes from its webhook or return evidence. A paid-order refusal ends the row | observed facts only                            |

## Owner choices

None new. A payment that arrives on a link we ended processes exactly as today:
the signed price proof and the atomic capacity guard decide. A sold-out late
payment goes to the existing captured-money conflict path, and the operator
decides the refund. The system never refunds on a guess.

## Security and privacy

Who can act:

- The expiry task runs only from `POST /scheduled` with the site key. Public
  traffic cannot spend an external call, because organic maintenance carries an
  external allowance of zero and every request stays inside the subrequest
  budget.
- The webhook stays HMAC-verified. The return path reads the provider.

What an unpaid checkout already carries today, unchanged by this plan:

- The buyer's email and phone go to Square as `pre_populated_data` at creation
  (`src/shared/square/client.ts`).
- The typed answers sit sealed in `checkout_pending_answers`.
- The basket rides the order metadata.

So the Square account can show an unpaid checkout's buyer contact and basket for
up to 180 days today. This plan cuts that provider-side lifetime to about an
hour. The cancel handle adds no personal fact of its own. It is an opaque
provider token, sealed with `DB_ENCRYPTION_KEY` and keyed by the same one-way
HMAC as the answers table. A database dump alone reads HMAC keys and ciphertext.

Residual, accepted by the owner: with a database dump plus the environment key,
an attacker who can already decrypt the staged answers gains the matching Square
link id. Sealing does not close that pair, because the same key opens both. It
keeps a bare dump clean.

Untrusted input cannot cause provider work: the task selects its own rows, the
webhook is HMAC-verified, and `/scheduled` is key-gated and rate-limited at the
CDN.

## Shared contract

- One window constant, `CHECKOUT_WINDOW_MINUTES`, default 60, read through the
  `limit()` convention and documented in `docs/env-vars.md`. It replaces
  `SQUARE_LINK_LIFETIME_MS` and feeds Stripe `expires_at`, Square
  `link_ends_at`, and the task's due time.
- `SquarePaymentLink` keeps the payment link id from the create answer, as
  `linkId`. Square returns it today and the parse drops it.
- The Stripe create sends `expires_at` = creation plus the window. Its read
  result stages `linkEndsAt`, so its answers can prune at the window plus the
  webhook window. Stripe accepts 30 minutes to 24 hours, so one hour is valid.
- The buyer return page: a session the provider reports ended renders the
  existing cancel page with its try-again link, not the waiting page. SumUp
  already maps `EXPIRED` there. Square maps a `CANCELED` order there. Stripe
  maps an expired session there.
- The handle is staged in the Square create path, not in the shared
  `makeCreateCheckoutSession` wrapper. The fact is Square-specific: only Square
  needs a stored id to end its checkout. Stripe ends its own page and SumUp ends
  its own page, so they stage no handle.
- A completed Square payment deletes its handle row, conditionally on `pending`.

## Slices

Build the Square slice first. It is the harder one.

1. **Square window and expiry task.** The window constant, the sealed handle
   table with its machine, the delete transport with the answer classification,
   the answers-prune coupling, the completion hook, the `CANCELED` order buyer
   page, and the maintenance task. Expected 300 to 450 changed `src` lines.
   Deletes `SQUARE_LINK_LIFETIME_MS`.
2. **Stripe window and ended-session page.** Stripe sends `expires_at`, stages
   `linkEndsAt`, and maps an expired session to the cancel page. Expected 100 to
   200 changed `src` lines.

Each slice is complete on the provider it touches. After slice 1, a Square
checkout cannot take payment after its window, and Stripe keeps its 24-hour
session until slice 2 lands. The every-provider guarantee holds only after both
slices ship.

## Tests

- Machine laws as direct tests: every move, every refusal, the claim fence, the
  lease expiry, and the mirror sweep over the moves table.
- Provider conformance: Stripe sends `expires_at`. Every provider maps its ended
  checkout to the cancel page.
- Task registration: budgets declared, disabled without Square settings, batch
  bound, follow-up requested when full.
- The answers-prune law: Square answers wait for the handle row. Stripe answers
  wait for the window. The 180-day fallback holds.
- Sandbox e2e in the Square leg: the delete answer classification, with a delete
  against a paid order. Pin the exact refusal shape there.
- Regression: a buyer returning to an expired Stripe session sees the cancel
  page. This test fails today, because the page shows the waiting page.

## Decisions

1. SumUp keeps its native 30 minutes. Its hosted page cannot live longer. No
   build.
2. An expired Stripe session shows the cancel page with its try-again link.
   Slice 2 builds it.
3. The maintenance monitor pings every 15 minutes by default, so a Square link
   can live about 1 hour 15 minutes at worst. The owner accepts this bound.
