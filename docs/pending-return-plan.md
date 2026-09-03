# The waiting page for an unconfirmed payment return

TICKETS-84 records ten `E_PAYMENT_SESSION` errors on `GET /payment/success`
across four sites. Every event is a SumUp return whose checkout the provider
still answered `PENDING`. The visitor saw "Payment verification failed. Please
contact support." and the owner received an error alert. The checkout state is
normal: SumUp redirects the visitor when the checkout flow ends, and the
transaction status can settle later. The money already has a safety net. The
webhook and the recovery task book a checkout that turns paid later, so the
visitor still receives the ticket email.

This plan replaces the error page with a waiting page. It also stops the error
alert for this state.

## Current-system value

A visitor who returns while the provider has not confirmed the payment is told
the truth and gets a way forward. The production caller is the `unpaid` branch
of `validatePaidSession`
(`src/features/api/payment-processing/classify.ts:190`), reached from
`handlePaymentSuccess` on `GET /payment/success?session_id=<id>`. The owner
stops receiving an alert for a normal provider state, and the on-page owner
panel keeps the facts.

## Trusted facts

| Fact                      | Source         | Trust basis                                                                                                                                |
| ------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Session id in the URL     | Buyer browser  | Untrusted. Any visitor can open any id.                                                                                                    |
| Staged checkout row       | Our database   | Trusted. We wrote the row when the checkout was created. The row opens only when the provider echoes our own reference.                    |
| Checkout status           | Provider read  | Trusted as observed. `PAID`, `PENDING`, `FAILED`, or `EXPIRED` is the provider's answer at read time. A `PENDING` answer may change later. |
| Booking metadata          | Our staged row | Trusted. We wrote it under a sealed key.                                                                                                   |
| Owner session on the page | Session cookie | Trusted. The owner panel renders only for an owner session.                                                                                |

Expected fact versus observed fact: the signed price proof is an expected fact.
The checkout status is an observed fact. The waiting page depends only on the
observed status. It processes nothing, so no expected fact is spent.

## Valid states

No new stored state exists, so no new machine is declared. The table below
projects the existing branches of `validatePaidSession`. The SumUp recovery
machine (`sumup-recovery-machine-spec.ts`) is unchanged; every staged checkout
row keeps its existing lifecycle.

The answer of `GET /payment/success?session_id=<id>` is one of:

| Provider answer                                                                | Rendered result                           | HTTP       | Log                     |
| ------------------------------------------------------------------------------ | ----------------------------------------- | ---------- | ----------------------- |
| No remembered provider                                                         | Error page: provider not configured       | 400        | Error (unchanged)       |
| Checkout not found, or foreign                                                 | "We could not find this payment session." | 400        | Error (unchanged)       |
| Rejected session                                                               | Existing rejection page                   | Varies     | Error (unchanged)       |
| Status `failed`                                                                | Cancel page with "Try again"              | 200        | Cancel path (unchanged) |
| Status `unpaid`                                                                | **Waiting page, new**                     | **200**    | **Debug, new**          |
| Status `paid`, proof invalid                                                   | "Payment session not recognized"          | 400        | Error (unchanged)       |
| Status `paid`, booking unreadable                                              | Verification failed page                  | 503        | Error (unchanged)       |
| Status `paid`, booking readable                                                | Process, then token redirect or render    | 200 or 302 | As today (unchanged)    |
| The waiting page carries: the page title and heading, the message, a timed     |                                           |            |                         |
| reload of the same URL every 30 seconds while the reload counter is under 10,  |                                           |            |                         |
| so a tab left open stops reloading after about five minutes. The "Check again" |                                           |            |                         |
| link goes to `/payment/success?session_id=<id>` and resets the reload window.  |                                           |            |                         |
| The owner diagnostics panel renders for an owner session. The page carries no  |                                           |            |                         |
| `data-payment-result` attribute, so the popup notifier                         |                                           |            |                         |
| (`src/ui/client/admin/payment-result.ts`) posts nothing. A false               |                                           |            |                         |
| "payment-cancel" message could push a visitor to pay twice.                    |                                           |            |                         |

## Commands and events

| Starting state            | Command or event                                             | Required result                                                        |
| ------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Any staged checkout       | Visitor opens the return while the provider answers `unpaid` | Waiting page, HTTP 200, debug log. No write.                           |
| Waiting page shown        | The page's timed reload reaches it again                     | The same read and render, with the reload counter up by one. No write. |
| Waiting page shown        | Visitor clicks "Check again"                                 | The same read and render, reload counter reset. No write.              |
| Checkout answers `paid`   | Webhook or recovery task or return                           | Existing booking path. No change.                                      |
| Checkout stays `unpaid`   | Recovery task first check, then recheck                      | Existing recovery machine moves. No change.                            |
| Checkout expires or fails | Provider answer                                              | Cancel page, existing. No change.                                      |

One authoritative implementation exists per command: the branch in
`validatePaidSession` renders the waiting page. No second path renders it.

## Failure table

| Work completed        | Failure                         | Required result                           | Retry owner                  |
| --------------------- | ------------------------------- | ----------------------------------------- | ---------------------------- |
| Nothing               | Provider cannot answer the read | Existing throw and temporary failure page | Request retry by the browser |
| Nothing               | Staged row absent               | Existing not-found page                   | None, permanent              |
| Waiting page rendered | None: no write exists           | No local failure is possible              | None                         |

The gap between provider success and local success does not grow. The waiting
page writes nothing, so nothing can fail after the provider answered. A checkout
that turns paid later keeps its existing durable recovery owners: the webhook,
and the recovery task at 3 hours, then every 6 hours.

## Retry and replay

- The stable identity is the session id in the URL. Exact replay of the return
  re-reads the provider and renders the waiting page again, or the success path
  when the payment completed.
- The waiting page is idempotent by construction: it performs no write.
- The timed reload and the "Check again" link are replays of the same command.
  The `wait` counter in the reload URL counts them: a tab left open stops
  reloading at 10, and a click on the link starts a fresh window.
- The webhook and the recovery task already retry by the same identity and carry
  their own tests.
- Two requests cannot double-act on this state: there is no action to repeat.
- Nothing blocks later work. A waiting checkout never blocks other bookings.
- `Check again` is the retry a visitor can perform without support. A reload
  once the provider says paid books the ticket. The integration test proves this
  end to end.

## Concurrency

| Operation A                  | Operation B               | Required result                              | Protection                           |
| ---------------------------- | ------------------------- | -------------------------------------------- | ------------------------------------ |
| Visitor opens the return     | Webhook books the payment | Both succeed. Render reads only.             | None needed: no write                |
| Visitor clicks "Check again" | Webhook processes         | One booking, then the return renders success | Existing payment session idempotency |
| Two visitor returns together | Nothing                   | Two waiting pages                            | No shared write                      |

The race between a webhook booking and the visitor's re-read already has one
owner: `processPaymentSession` is idempotent by session id, and the
already-processed return renders the success page
(`src/features/api/payment-success.ts:116`).

## Owner choices

The human approved all three decisions on 3 September 2026: debug log only,
bounded auto-refresh, and the reference in the log line. The decisions are
recorded here as decided.

1. **Alert level.** Log a debug line only for the unconfirmed return. The owner
   keeps the on-page panel and the 24-hour system map line for unanswered rows.
   A normal provider state is not an outage. The ten-event "spate" then stops.
2. **Auto-refresh.** Decide: approved with auto-refresh. The page reloads itself
   every 30 seconds for up to 10 reloads, about five minutes, then it offers the
   "Check again" link only. A `wait` counter in the return URL counts the
   reloads, so a tab left open stops costing provider and database reads. The
   visitor's "Check again" link opens a fresh window without the counter. The
   counter is untrusted input and moves nothing but the render.
3. **Reference in the checkout log line.** Approved. Extend
   `[SumUp] Checkout created id=…` with `reference=<our session id>`, so the
   nightly can reconstruct the return URL before payment. Square logs its own
   created order id the same way, and SumUp order ids already flow through
   browser URLs and error logs. The reference still never rests in the database:
   only its one-way code is stored.

## Security and privacy

- Who can act: any visitor can open the return URL, as today. The waiting page
  renders no booking metadata, no name, no email, and no amount. It names only
  the session id, provider, and status, and only in the owner panel.
- The owner panel keeps its existing gate: owner session only. Buyers and
  editors never see it.
- The waiting page adds no secret. The session id in the link is the id the
  visitor already holds in the URL.
- Untrusted input: the session id and the `wait` counter. The session id costs
  one indexed staged read and one provider read, as today. The counter moves
  nothing but the render: the branch clamps it to a whole number between 0 and
  the cap, so a forged value changes no other page fact. No provider write path
  is reachable from this page.
- The log debug line carries the session id only, which error lines at this
  boundary already carry today.

## Shared contract

- The branch stays provider-agnostic. Any provider session that answers `unpaid`
  renders the same waiting page, so Stripe, Square, and SumUp share one path.
- Template: `paymentWaitingPage` joins `paymentCancelPage` and
  `paymentErrorPage` in `src/ui/templates/payment.tsx`. The `paymentCancelPage`
  shape is the model: title, message, one action link.
- Copy lives in the catalog, group `payment`:
  - `payment.pending.title`: "Payment not confirmed yet"
  - `payment.pending.message`: "We have not received your payment yet. If you
    have paid, your ticket will be sent to you by email. This can take a few
    minutes."
  - `payment.pending.auto_check`: "This page will keep checking for you." —
    rendered only while the timed reload is on.
  - `payment.pending.check_again`: "Check again"
  - `payment.error.verification_failed`: "We could not confirm your payment.
    Please contact support." — replaces both hard-coded copies in `classify.ts`.
    The unreadable-booking branch keeps it; the unpaid branch stops using it.
- The reload window is one pure rule beside the template: the seconds and the
  cap are constants there, and one function answers whether the timed reload
  renders for a `wait` value. `classify` reads the `wait` value from the
  request, clamps it to a whole number between 0 and the cap, and passes it to
  the template.
- IO stays a thin shell: `validatePaidSession` decides, the template renders,
  and the page performs no database write.

## Adversarial review

- **The provider call succeeds and the local write fails.** The waiting page
  writes nothing, so this gap cannot open here. The later paid path keeps its
  existing recovery owners.
- **The callback is replayed.** Unchanged. The callback path is idempotent and
  covered by existing tests.
- **The follow-up read fails after a signed success event.** Unchanged. A
  provider that cannot answer makes the SumUp adapter throw, and the browser
  receives the temporary failure page.
- **The amount, currency, or resource id is wrong.** Unchanged. Those refusals
  happen in the rejection and classification branches before any render decision
  this slice touches.
- **Two requests run together.** See the concurrency table. No write, no
  interleave that this page can lose.
- **The visitor reloads after an interruption.** Render reads per request. A
  reload shows the waiting page or the success page, whichever the provider
  answer then supports.
- **A tab keeps reloading forever.** It cannot. The reload URL carries the
  counter, the counter climbs by one on every timed reload, and the render stops
  emitting the reload tag at the cap. A forged counter cannot loop either: the
  branch clamps it to the same range.
- **The same resource appears on another record.** The staged row opens only on
  a reference match, so a foreign checkout cannot render the waiting page for
  our session id.
- **One queued item fails.** No queue exists on this path. A waiting checkout
  never blocks recovery work on other rows.
- **The visitor never paid, and sees the waiting page hours later.** The copy
  makes a conditional promise only: "If you have paid…". The page offers no
  "book again" link, because a visitor who has paid could pay twice. The
  operator can point the visitor at the listing page when support is asked.
- **The popup flow reads the page as a result.** The waiting page carries no
  `data-payment-result` attribute, so the popup notifier posts nothing and the
  embedding page keeps its own waiting state.
- **A paid checkout shows the waiting page.** Not possible: the branch reads the
  live provider answer, and `paid` answers route to the processing path. A
  booking the webhook already processed renders the existing success page on
  reload.

## Pull requests

One vertical pull request. The whole invariant is one branch of one read path,
and splitting it thinner would leave dormant helpers.

Scope:

- `src/features/api/payment-processing/classify.ts`: the unpaid branch. Turn the
  failure page into the waiting page, turn the error log into a debug log, and
  route the unreadable-booking copy through the new catalog key.
- `src/ui/templates/payment.tsx`: `paymentWaitingPage`, shaped on
  `paymentCancelPage`, without `data-payment-result`.
- `src/locales/en/payment.json`: the new keys above.
- `src/shared/sumup.ts`: the checkout log line gains `reference=<id>`.
- `e2e-payments/src/providers/sumup-callback.ts` and
  `e2e-payments/src/providers/sumup.ts`: one shared log-line reader beside
  `readLoggedId`, replacing the two private copies and reading the id and the
  reference.
- `e2e-payments/src/browser.ts`: a second-page helper in the visitor context.
- `e2e-payments/src/cucumber/steps/booking.ts`: three steps for the new
  scenario, plus one pay-only step ("the visitor pays on SumUp's hosted
  checkout") because the new scenario must not submit the booking twice.
- `e2e-payments/src/targets.ts`: register `live-payments.sumup-return-pending`
  in the sumup target.
- `e2e-payments/specs/live-payment-providers.feature`: one new rule and one new
  scenario under the SumUp area.
- `e2e-payments/README.md`: name the new leg.

Source budget: about 50 changed lines in `src/`, and about 180 across
`e2e-payments/` and tests. Database and provider call budget: unchanged. One
staged read and one provider read per return visit, no writes, one settings read
for an owner panel.

Out of scope, recorded for a follow-up issue: the remaining hard-coded payment
error copies in `classify.ts` and `cancel.ts` ("Payment provider not
configured", "Payment session not recognized", "Listing not found").

## Tests that prove the contract

Direct tests, written first:

1. `test/integration/server/webhooks/sumup.test.ts`: stage a signed SumUp
   checkout, stub `readCheckoutById` to answer `PENDING`, open
   `/payment/success?session_id=<ref>`. Assert HTTP 200, the waiting copy in the
   catalog, the `Check again` link to the same session id, the timed reload tag
   with the counter at one, no `E_PAYMENT_SESSION` in the error spy, and the new
   debug line present. This test fails today: the branch answers 400 with the
   verification failed copy and logs the error.
2. Same file: the reload-recovery leg. Book through the pinned webhook stub
   (`PAID`), then open the same return. Assert the success page and the one
   attendee row. This proves the remedy the page promises.
3. `test/features/api/payment-processing/classify.test.ts`: rewrite "refuses a
   checkout the provider does not call paid" as "shows the waiting page for an
   unconfirmed checkout". Assert page copy, link target, and debug-not-error
   logging. A pure-table case loads the reload window: the tag renders below the
   cap, not at the cap, and a clamped forged counter cannot restart it. The
   three TICKETS-84 owner tests keep the owner panel and the buyer-editor
   separation, now beside the waiting page.
4. `e2e-payments`: the new scenario drives visitor to the hosted checkout, reads
   the reference from the extended log line, opens the return in a second page,
   asserts the waiting copy through the catalog and that the page keeps checking
   for the visitor, asserts no payment error line in the app log, pays on the
   hosted page, delivers the genuine callback twice, then replays the exact
   payment return and asserts the booking confirmation, one attendee, and the
   captured income once.

Regression proof: each new direct test fails against today's code for the named
reason before the fix lands.

TICKETS-84 closes with the pull request that ships this page.
