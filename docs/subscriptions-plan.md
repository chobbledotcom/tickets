# Subscriptions plan

Status: implementation. Each pull request owns its behaviour, safeguards, and regression tests.
This plan follows [the pull request workflow](pr-workflow.md).

## Goal

A site that uses Stripe can sell a ticket with a recurring price. Stripe takes
each recurring payment. The site shows each subscription, keeps its status
current, records every recurring payment in the ledger, and lets an owner cancel.

The feature set is small on purpose. The plan adds no pause, no plan change, no
refund of a recurring payment from the site, and no email about a failed payment.

## Decisions the owner made

1. The buyer pays the price of the ticket on the first day. The first recurring
   payment is one period later.
2. The ledger must record every recurring payment accurately. This is a hard
   requirement.
3. A cancellation is immediate. It refunds nothing, and the booking stays.
4. A recurring payment is the recurring price times the quantity, plus VAT by
   the tax settings of the site. It carries no booking fee and no discount.
5. An order can hold one subscription ticket at most. The price of that ticket
   must be above zero. The site refuses to delete a booking while its
   subscription is live.
6. Only an owner can cancel a subscription.

## Current-system value

A buyer on a Stripe site can subscribe through the ticket page, and the owner
sees the subscription and its recurring income on the site.

The production callers are:

- the listing form, which saves the recurring price and frequency
- `createCheckoutSession` in `src/shared/stripe.ts`
- the payment completion path behind `POST /payment/webhook` and
  `GET /payment/success`
- `POST /scheduled`, through one new maintenance task
- two new admin routes under `/admin/subscriptions`

## Providers

Stripe is the only provider in this plan. The listing form shows the recurring
fields while the Subscriptions feature is on. The owner can clear the recurring
price and choose Never after a provider change. A saved recurring price requires
Stripe with valid credentials. Checkout refuses subscription tickets without Stripe.

### SumUp: not possible

The SumUp documentation gave these facts on 2026-11-10:

- The API has no subscription, plan, or schedule resource.
- SumUp can save a card, but only through its Payment Widget. This site uses
  the hosted checkout page, which has no documented way to save a card.
- The card save is a separate checkout. SumUp authorises its amount and
  reverses it at once, so it cannot take the first payment.
- The site must start every later charge itself: one call to create a checkout
  and one call to process it with the saved token.
- The only webhook is `CHECKOUT_STATUS_CHANGED`.

SumUp support means that this site becomes the billing engine: schedule,
retries, failed cards, and customer authentication. That is a different
product.

### Square: possible, but a different and larger feature

The Square documentation gave these facts on 2026-11-10:

- A payment link can start a subscription, but only for a plan variation that
  exists in the Square catalogue. No price can go inline.
- The site must create one catalogue plan and one plan variation for each
  ticket price. Square never deletes a plan, and the phases of a variation
  cannot change.
- A cancellation takes effect at the end of the paid period. Square has no
  immediate cancellation, so decision 3 cannot hold.
- The payment link does not return the subscription. The site must search by
  customer or handle a `subscription.created` webhook.
- Square reports each renewal through invoice webhooks. Those need token
  permissions for subscriptions, invoices, customers, and catalogue items.
- The minimum charge is 1.00, and the documentation says that subscription
  items must be shipped.
- The documentation does not say that a subscription link can carry other
  order lines.

Square needs a catalogue sync, new webhooks, new token permissions, and
different cancellation behaviour. It is a separate plan if the owner wants it.

## Shared contract

### Where each fact lives

| Fact | Home |
| --- | --- |
| Feature switch | A `subscriptions` entry in `ADMIN_FEATURES` |
| Recurring price and frequency of a ticket | Two new columns on `listings`: `recurring_price` and `recurring_interval` |
| Plan of one subscriber | Five new columns on `listing_attendees` |
| Each recurring payment | Ledger transfers, one event group for each Stripe invoice |

The frequency is `week`, `month`, or `year`. A ticket with a `recurring_price`
of `0` is an ordinary ticket. `recurringOfferColumns` declares the two columns
once, for the listing and for the booking row.

The new `listing_attendees` columns are:

| Column | Value |
| --- | --- |
| `recurring_price` | Minor units that Stripe charges each period, for the whole quantity, VAT included. `0` means no subscription. |
| `recurring_tax` | The VAT part of `recurring_price`, in minor units |
| `recurring_interval` | `week`, `month`, `year`, or blank |
| `subscription_id` | The Stripe subscription id, or blank |
| `subscription_status` | The last status that Stripe reported, or blank |

The owner asked for the plan on this row. Five plain columns keep the task
query and the guarded writes in SQL, and a later change to the listing cannot
reach them.

### Trusted facts

| Fact | Trusted | Basis |
| --- | --- | --- |
| Recurring price and frequency on the listing | Expected | The owner typed them. The listing can change at any time. |
| Tax policy | Expected | The checkout freezes the policy when it starts, as it does today. |
| Signed order total | Expected | The current price proof. The recurring line adds nothing to the first payment, so the proof does not change. |
| Subscription id, status, amount, and frequency | Observed | A Stripe read of the subscription with the secret key of the site |
| Listing id of the subscription | Observed | The site writes it to the subscription metadata, and the Stripe read returns it |
| Paid invoice: id, amount, currency, paid time, reason | Observed | A Stripe list of the paid invoices of one subscription |
| Cancel form | Untrusted | The owner session and the CSRF token authorise it |

The plan on the booking row comes from the Stripe subscription, never from the
listing. `recurring_tax` comes from the frozen tax policy and the observed
amount.

### Checkout

When the order holds a subscription ticket, the Stripe session changes in three
ways:

- `mode` is `subscription`.
- One recurring line joins the current one-time lines. Its quantity is `1`,
  and its amount is the recurring price times the ticket quantity. Under the
  `add_to_total` mode the amount also includes VAT. VAT rounds once, on the
  whole amount.
- `subscription_data` carries a `trial_end` one period after now, and the
  listing id in its metadata.

The one-time lines stay exactly as they are. The first payment is the signed
order total, with its booking fee, discounts, and tax.

Each booking path refuses an order with a subscription ticket that cannot
start a Stripe subscription:

- a site with no payment provider, or with a provider other than Stripe
- a deposit
- an order with nothing to pay today

The public form, direct QR checkout, API booking, and folded API booking all
use `subscriptionOrderError`.

Completion reads the subscription and the first invoice of the session. The
session names that invoice, so a renewal that Stripe adds later cannot take
its place. The payment intent that paid the first invoice becomes the payment
reference.

If the booking cannot proceed, the site keeps the observed plan and frozen VAT
on a quantity-zero row before it cancels the subscription. A held refund claim
and the failure marker let a retry finish the same work. Stripe must confirm
that the subscription ended before the site refunds or acknowledges completion.

The row keeps its original status until the scheduled check records any paid
renewals and the ended status. A missing charge reference creates no refund
anchor. Unreadable signed metadata supplies no valid booking slots or tax
policy. That path confirms cancellation but cannot store those unavailable facts.

### Valid states

`subscription_status` holds the Stripe status word. One exhaustive record maps
each word to a label and to a group.

| Group | Stripe status | Facts on the row |
| --- | --- | --- |
| None | blank | All five columns at their defaults |
| Live | `trialing`, `active`, `past_due`, `unpaid`, `paused`, `incomplete` | Plan, id, and status all present |
| Ended | `canceled`, `incomplete_expired` | Plan, id, and status all present |

Declare the machine once in `src/shared/payment/subscription-machine-spec.ts`,
in the shape of `machine-spec.ts`. The tables below are projections of it.

### Commands and events

| Start | Command or event | Result |
| --- | --- | --- |
| None | A paid checkout completes with a subscription | The row gets the plan, the id, and the observed status |
| Live | Scheduled check | The row gets the observed status. The ledger gets each paid renewal invoice that it does not hold. |
| Live | Owner cancels | Stripe cancels. The row gets `canceled`. |
| Ended | Scheduled check | The task records the remaining paid invoices once, then leaves the row |
| Ended | Owner cancels | Refused |
| Live | Delete the booking, the attendee, or the listing | Refused: "Cancel the subscription first." |
| Live | A merge or an edit that removes the booking | Refused with the same message |

Each command has one implementation. The scheduled task is the only writer of
recurring money. The site adds no new Stripe webhook event, so no site needs a
new webhook endpoint.

### Ledger entry for one recurring payment

One paid Stripe invoice with the reason `subscription_cycle` posts one event
group. The invoice id is the stable identity.

| Leg | From | To | Amount |
| --- | --- | --- | --- |
| `payment` | `external:world` | `attendee:<id>` | The amount that Stripe says the buyer paid |
| `sale` | `attendee:<id>` | `revenue:<listing id>` | The paid amount minus the VAT share |
| `vat` | `attendee:<id>` | `tax:vat` | The VAT share |

- `occurredAt` is the paid time of the invoice, so the income lands on the day
  of payment.
- The VAT share is `recurring_tax` when the paid amount equals
  `recurring_price`. For any other amount, the share keeps the same ratio.
- The cash leg always uses the observed amount, never the expected amount.
- The first invoice has the reason `subscription_create`. The current booking
  path records that payment, so the task skips it.
- An invoice in a currency other than the site currency posts nothing. The
  task logs an error and leaves the row as it is. The next run tries again.

### Scheduled task

`subscription_status_check` joins `MAINTENANCE_TASKS`.

- It is enabled when Stripe has a key and the feature is on.
- Its wake policy is `scheduled_only`, because it calls Stripe.
- It walks the live rows in id order from the task checkpoint, a small batch
  for each run. A full batch asks for a follow-up run.
- For each row it reads the subscription first. It then lists the newest paid
  invoices, posts the ledger groups, and writes the status if the status
  changed. The list comes after the status, so it holds each payment that
  Stripe took up to that status.
- A row that moves to an ended status gets one last invoice pass in the same
  run.
- The subscription and invoice reads ask Stripe once, with no retry. One run
  then makes a known number of external calls.

### Failure table

| Work complete | Failure | Result | Retry owner |
| --- | --- | --- | --- |
| Nothing | Stripe refuses the session | The current checkout error. No booking. | The buyer |
| Stripe took the first payment | The subscription read fails at completion | The current retry answer. No booking yet. | Webhook redelivery and the success redirect |
| The booking cannot proceed | Stripe does not confirm cancellation | The quantity-zero row keeps the plan. The refund waits. | Webhook redelivery and the success redirect |
| Stripe took the first payment | The booking write fails | The current payment recovery path | The current path |
| Nothing | The scheduled read fails for one row | That row keeps its status. The batch continues. | The next run |
| Stripe took a renewal | The ledger write fails | Nothing recorded. The error reaches the log. | The next run posts the same invoice id |
| Ledger write | The status write fails | The status is stale | The next run |
| Nothing | The Stripe cancel call fails | No local change. The owner sees an error. | The owner |
| Stripe cancelled | The status write fails | The status is stale | The scheduled check |

### Retry and replay table

A failed subscription checkout has three replay rules:

- A retry keeps the checkout time from Stripe and the parsed tax policy.
- A charge that becomes readable does not bypass subscription cancellation.
- An occupied session reservation returns a retry response without cancellation
  or refund.

| Command | Stable identity | Exact replay | Protection against two workers |
| --- | --- | --- | --- |
| Completion | Payment session id | The current two-phase claim returns the same booking | The current claim |
| Failed completion | Payment session id | The held claim resumes cancellation before refund. A successful booking never cancels. | The current claim and stored failure marker |
| Renewal entry | Stripe invoice id, as event group and leg references | The ledger store finds the same legs and inserts nothing | The maintenance task claim, then the ledger references |
| Status write | Subscription id | The same status again | A live status needs the status that was read. An ended status replaces any live status. |
| Cancel | Subscription id | Stripe refuses a second cancel. The site then reads the subscription and stores what it finds. | The same guarded write |

A refused Stripe read leaves that row for a later pass. The batch continues.
A database write failure or a ledger conflict stops the run. The maintenance
runner retries from its saved checkpoint.

### Concurrency table

| Operation A | Operation B | Result | Protection |
| --- | --- | --- | --- |
| Webhook | Success redirect | One booking, one plan | The current two-phase claim |
| Scheduled check | Scheduled check | One ledger group for each invoice | The task claim and the ledger references |
| Attendee merge | Renewal entry | The old booking cannot post after the merge. A later pass uses the copied booking. | The ledger batch checks the booking identity before it posts money. |
| Owner cancel | Scheduled check | `canceled` stays | A live status writes only where the row still holds the status that was read. An ended status is final, so the cancel replaces a live status that the check wrote first. |
| Owner cancel | Owner cancel | One Stripe cancel takes effect | The guarded write, and the read after a refused cancel |
| Listing edit | Checkout in progress | The buyer gets the plan that Stripe holds | The row copies the observed plan |

### Owner choices

None in the site. A payment that differs from the plan still posts at its
observed amount. Two cases stay with the owner:

- A change that a person makes in the Stripe dashboard. The site records the
  money that Stripe reports and shows the status that Stripe reports.
- A refund of a recurring payment. The owner makes it in Stripe and records it
  with the current manual ledger entry.

### Security and privacy

- Owners and managers can open the Subscriptions page, as they can open the
  attendee pages. An editor cannot, because the page names customers. Only an
  owner sees the Cancel button, and the cancel route refuses every other role.
- The menu shows the Subscriptions link only while the feature is on. The page
  itself follows its audience alone, as the Invoices page does.
- The page decrypts the name of each subscriber at render time, and nothing
  else.
- The Stripe subscription id is not personal data. It stays in plain text.
- The cancel route takes a booking row id. The site reads the subscription id
  from its own row, so a form cannot name a foreign subscription.

## Self-challenge

| Question | Answer |
| --- | --- |
| The Stripe call succeeds and the local write fails? | The failure table covers the first payment, each renewal, and the cancel. Each has a retry owner. |
| A callback arrives twice? | The current claim handles the completion. No new webhook event exists. |
| The amount or currency is wrong? | The first payment keeps the current price proof. A renewal posts the observed amount. A foreign currency posts nothing and logs an error. |
| The task stops for a long time? | The task reads the newest 100 paid invoices of each subscription. That is almost two years of weekly charges. |
| The owner turns the feature off? | The site refuses while a live subscription or a recurring price exists, through `inUseSql`. |
| The owner changes provider? | Live subscriptions stay with Stripe. The task runs while the Stripe key exists. The page shows no warning when the key is absent. |
| The owner changes the tax settings? | A live subscription keeps its frozen plan. Only a new subscription uses the new policy. |
| Someone merges or moves the booking? | The plan columns move with the row. The merge refuses a decision that throws away a booking whose subscription is live. |

## Operational limits

- The Subscriptions page shows no warning for an invoice in a foreign
  currency. The task logs the error.
- The task reads only the newest 100 paid invoices of a subscription. If the
  task stops for longer than 100 periods, it does not record older invoices.
- One run checks five subscriptions. A full batch asks for another run one
  minute later.
- Stripe stops automatic collection when the owner cancels. If a person
  collects an open invoice by hand after cancellation, the owner must record
  it with a manual ledger entry.

## Stripe test-mode proof

These facts need a real Stripe test-mode run. The `sandbox` environment that
holds the CI Stripe key accepts only `main`. The owner must permit the branch
before this proof can run.


### Required provider facts

Prove these facts in Stripe test mode before release. If one fails, revise the
contract and the code together.

1. A session in `subscription` mode with a trial charges its one-time lines at
   once and starts the recurring line at the end of the trial.
2. The completed session then reports `payment_status: "paid"` and an
   `amount_total` equal to the one-time lines.
3. Stripe copies `subscription_data.metadata` to the subscription.
4. `expand[]=payments` on the first invoice of the session returns the
   payment intent of the first payment, for refunds.
5. `trial_end` must be 48 hours or more ahead. All three frequencies pass.
6. stripe-mock at the pinned version can serve these calls, or the tests need
   fixtures.

## Pull requests

One stack of four. Each layer is green and useful alone.

| Layer | Behaviour | Story |
| --- | --- | --- |
| 1 | The feature switch, recurring prices, Stripe checkout, the stored plan, and cancellation before a failed checkout refunds | "Buying a subscription ticket" |
| 2 | The Subscriptions menu and page | "Seeing who subscribed" |
| 3 | The scheduled check: status and recurring payments in the ledger, with VAT | "Recurring payments reach the books" |
| 4 | The owner cancels. Edits, deletes, and merges must keep live subscription plans. | "Cancelling a subscription" |

Layer 1 replaces no old path. No layer adds a compatibility surface.

The Stripe call budget is:

- completion: two more reads, the subscription and the first invoice, at the
  same time
- failed completion: one cancel call, then one read if Stripe refuses the
  cancel. A subscription that Stripe already reports as ended needs neither.
- scheduled check: two reads for each row, one after the other
- cancel: one call, one read after a refusal, and one invoice list

Each subscription and invoice read asks Stripe once, with no retry.

Direct tests cover every branch. The stories prove the journeys and are never
the only coverage. The tests for each layer are:

- Layer 1: listing validation, the session parameters for each tax mode, the
  completion write, and the refusals in decision 5.
- Layer 2: the page for each role, the feature gate, and the label for every
  status.
- Layer 3: the machine laws, the ledger legs for each tax mode, replay of one
  invoice, the stale status guard, and one fault test for each failure row.
- Layer 4: the cancel for each start state, the role refusal, the race with the
  check, and the delete refusal.
