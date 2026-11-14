# Subscription model checks

Status: approved. A human approved this contract before tests and implementation.
This plan follows [the pull request workflow](pr-workflow.md) and the
[model verification guide](model-verification.md).

## Current-system value

The fifth pull request checks the safety of the four subscription layers before release.
It adds executable evidence for checkout, renewals, cancellation, and retained records.
It changes no product behaviour, provider configuration, or production schema.

The branch is `subscriptions-models`. Its base is `subscriptions-cancel`.
The four lower pull requests keep their existing order and scope.

## Trusted facts

| Kind | Fact | Evidence or limit |
| --- | --- | --- |
| Observed | Checkout admission and plan attachment | Execute `subscriptionOrderError`, `subscriptionStartOf`, and `withSubscriptionPlan`. |
| Observed | Subscription status, retained rows, and ledger legs | Execute the production write paths against isolated copies of the production schema. Read stored results. |
| Observed | Request arguments and local handling of supplied provider replies | Capture request identities at the client boundary. Fixture reply contents remain assumptions. |
| Expected | Allowed orders, preserved plan identity, and cancellation order | State independent laws in TLA. Do not copy a production verdict into its expectation. |
| Expected | Cash, sale, VAT, and replay effects | Use exact integer arithmetic and the input invoice universe. Do not reuse the production money calculation as its oracle. |
| Assumed | Stripe reports truthful identities, statuses, amounts, and paid times | Local fixtures and models cannot establish provider truth. Keep the required Stripe test-mode proof. |
| Assumed | A successful SQLite transaction is atomic | Execute rollback and interleaving cases as separate evidence. Abstract induction does not establish database atomicity. |

Facts use synthetic customers and one fixed site currency. No producer reads live customer records or contacts Stripe.

An owner cancellation result confirms the provider end, not a completed local invoice pass.
If the invoice read refuses, the local row stays live for a later pass.
Observe stored rows and transfers separately from that return value.

## Valid states and shared identities

The subscription machine remains `src/shared/payment/subscription-machine-spec.ts`.
The models consume its production vocabulary and outcomes. They do not introduce another runtime machine.

| State | Required facts |
| --- | --- |
| None | The booking has no subscription plan. Its subscription columns hold their defaults. |
| Live | The booking retains its subscription id, observed status, amount, VAT, and interval. |
| Ended | The booking retains the same plan. A stale live observation cannot restore a live status. |
| Failed checkout | The retained row has quantity zero when valid signed order facts exist. A held claim identifies unfinished refund work. |

A failed provider read is not an ended subscription.
A quantity-zero row can still hold a live subscription.
Cancellation does not remove the booking or refund an ordinary successful purchase.

Keep scenario, attempt, booking, attendee, listing, subscription, invoice, event-group, and leg identities where each law needs them.
Keep the pass or stage identity when the same event appears more than once.
TLA sets must not collapse distinct attempts or equal-value invoices.

## Four model boundaries

| Model | Production evidence | Safety laws |
| --- | --- | --- |
| `SubscriptionCheckout` | Checkout admission, Stripe session parameters, `subscriptionStartOf`, `withSubscriptionPlan`, and stored plan columns | Unsupported orders refuse. Ordinary extra tickets remain valid. Exactly the subscribed booking receives the observed plan. Later listing or tax edits do not change it. |
| `SubscriptionRenewals` | `recordObserved`, `renewalTax`, `mapRenewal`, `postTransferGroups`, `renewalBookingGuard`, and stored transfers | Each eligible invoice posts once to its true attendee and listing. Cash equals the observed amount. Sale plus VAT equals cash. References and paid times remain exact. A changed booking identity cannot post from the old snapshot. |
| `SubscriptionCancellation` | `cancelOwnerSubscription`, `endFailedCheckoutSubscription`, the failed-checkout refund paths, and `statusWrite` | A failed checkout needs an observed ended status before a refund. An already-observed end needs no extra cancel call. Booked or orphaned ledger dispositions never enter that refund path. Stale checks cannot overwrite an ended status. An ended status becomes visible only with its final returned renewals. |
| `SubscriptionRecords` | The production edit, delete, merge, and subscriber-read paths | No permitted operation loses a live plan. Safe moves preserve it. Subscriber reads include live, ended, and quantity-zero plans exactly once per stored booking. |

Each model has its own law, domain explanation, and named controls.
Share fixture setup, fact schemas, and model plumbing where their meanings match.
Do not share the business oracle with production merely to reduce duplicate code.

The subscriber-page model checks its database projection and plan identity.
Existing rendered-page tests retain responsibility for access, labels, links, and personal data.

## Commands and events

| Event | Required observation |
| --- | --- |
| Start an eligible checkout | Keep the initial payment separate from the first later recurring charge. Bind the plan to the subscribed listing. |
| Complete or replay a paid checkout | Store one booking and its observed plan. Use the payment intent from the session's first invoice, not a later renewal. Durable booked or orphaned ledger dispositions prevent cancellation and refund. |
| Refuse a paid subscription checkout | Preserve the valid observed plan before cancellation. An observed ended status must precede refund. An already-observed end needs no extra provider call. |
| Read a paid renewal | Ignore the first invoice, non-renewal reasons, and zero payments. Post eligible invoices at their observed amounts and times. |
| Repeat an invoice | The stored legs remain equal. A different amount under the same identity fails loudly. |
| Observe a live status | Write only over the expected live status. Keep a concurrent ended status. |
| Observe an ended status | Record the returned paid renewals and the ended status in one local commit. |
| Cancel as an owner | Confirm the provider result. Keep the booking and its money records. |
| Edit, delete, or merge records | Refuse loss of a live plan. Permit a valid move or an operation on an ended plan. |
| Read subscribers | Return every expected subscribed booking, including quantity-zero rows. Exclude ordinary bookings. |

## Selected domain

Generate cases from the current status, interval, and provider unions.
Use exhaustive outcome projections so a new production case requires an explicit decision.

The domain must include:

- Every live and ended Stripe status, plus no subscription.
- Stripe, each unsupported provider, and no provider.
- One subscription line, an extra ordinary line, multiple subscription lines, packages, add-ons, deposits, balances, and a zero initial total.
- Quantities zero, one, and more than one where the production entry point permits them.
- Two distinct attendees, listings, subscriptions, and equal-value invoice identities.
- Every tax mode, zero tax, partial and excess observed payments, and half-unit VAT boundaries.
- Selected safe-integer money values near arithmetic limits, with exact independent expectations.
- Week, month, and year boundaries, including month ends and leap years.
- Found, absent, invalid, and unavailable provider outcomes where the provider union permits them.
- Fresh and stale row snapshots, a replaced booking, and each field of the booking identity fence.
- Exact replay, a conflicting invoice replay, and repeated callback or cancellation attempts.
- Returned invoice lists at zero, one, and the production limit of 100 entries.

The producer must explain which monetary cases reach Stripe and which check local arithmetic only.
It must not present local arithmetic cases as proof of provider admission.
Invalid external shapes must fail boundary validation, not disappear from the fact set.

## Failures, retries, and replay

| Boundary | Required result | Retry owner |
| --- | --- | --- |
| Subscription or invoice read refuses | Preserve local status and money. Do not invent success or an empty invoice list. | The owner, callback, or next scheduled pass, as production declares. |
| Stripe cancellation refuses | Read the current provider status. Proceed only when the required end is confirmed. | The current caller. |
| Stripe ends the subscription but the local write fails | Keep a recoverable local live record or held failure claim. Do not pretend that the local write succeeded. | The existing callback or scheduled path. |
| A ledger or companion statement fails | The whole batch rolls back. Preserve the invoice identity for retry. | The existing task retry. |
| An invoice conflicts with stored legs | Throw. Do not omit the conflicting group or advance the checkpoint. | The operator and existing task policy. |
| A model fact cannot be extracted | Fail the producer. Do not substitute a safe value or omit the event. | The author. |
| Apalache crashes, times out, or emits no trace for a control | Fail verification. Do not count the control as detected. | The author or infrastructure owner. |

Observe rollback after a failure that follows at least one otherwise valid write.
A refusal label alone is not evidence that earlier writes rolled back.

## Concurrency and interruption

| Overlap or interruption | Required evidence |
| --- | --- |
| Owner cancellation and scheduled check, in both orders | Real guarded SQL preserves the ended status. Record both accepted and refused writes. |
| Two renewal attempts for one invoice | One stored event with exact legs. A replay changes no amount or identity. |
| Attendee merge during an outstanding provider read | The old snapshot posts no renewal. A later pass posts to the retained booking and correct attendee. |
| An ended observation with a last invoice | The invoice reaches the ledger before the booking leaves the live query. |
| Failed checkout retry after cancellation or refund | The same session and claim resume the remaining work. Do not send a duplicate refund. |
| A record removal conflicts with a live plan | The complete operation refuses without partial data or money changes. |

Models explore abstract event order over production-derived facts.
Database tests execute selected interleavings and faults at the real write boundary.
Neither form proves that the scheduler eventually runs or that an external request eventually returns.

## Negative controls and evidence quality

Each named control must change its target and produce an invariant violation with a trace.
Use initial controls for corrupt domains or missing coverage.
Use step controls for unsafe transitions and money effects.
Give each independent amount, identity, and time law a separate control.
Do not hide a weak law behind another fault in the same control.

Controls must expose these faults:

- A plan attached to the wrong booking or rewritten from an edited listing.
- A refund before confirmed cancellation.
- A stale live write after an ended status.
- A duplicate renewal or two distinct invoices that collapse onto one event.
- Wrong cash, VAT, attendee, listing, or paid time.
- Money posted from a replaced booking snapshot.
- A partial ledger or status commit.
- A live plan lost through edit, delete, or merge.
- An omitted quantity-zero subscriber.

Producer tests must inject a faulty boundary outcome or stored result before extraction.
They must show that the emitted facts expose that fault.
Do not rely only on a control that edits the final model text.

Build the expected event universe separately from returned outcomes.
Check exact coverage, refused cases, reachable accepted cases, and joins between models.
One successful fixture must carry the same plan through checkout, subscriber read, renewal, and cancellation.
A separate failed-checkout fixture must join retained identity, confirmed cancellation, and refund authority.

## Shared design and source budget

Reuse `ModelRules.tla`, `schemaClientWith`, the existing record renderers, and the lazy model registry.
Keep the registry free of application IO at import time.
Declare each producer and relevant production source as review context.
Use the existing SQLite fault and payment observer patterns. Add no production test hooks.
Statement producers use `schemaClientWith`. Full-function producers install the isolated client through the existing `setDb` seam and restore it afterwards.

Expected files are four TLA modules, their producers, focused fixture or schema helpers, direct tests, and four flat registry entries.
Keep each file near 400 lines and below the enforced 500-line limit.
Production behaviour, schema, environment keys, and provider call budgets remain unchanged.
Producers use isolated synthetic databases and local provider fixtures only.
No new generic verification framework, compatibility export, or baseline increase is in scope.
No production purity declaration or effect root changes are planned.

## Owner choices, security, and privacy

There is no new product choice or operator action.
Existing owner-only cancellation, owner and manager page access, CSRF, and read-only mode remain runtime-test obligations.
Fixtures contain no real customer data or secrets.
Model registration context excludes environment files, databases, generated facts, and customer records.

## Self-challenge

| Challenge | Required answer |
| --- | --- |
| The model only mirrors the moves table? | Observe production decisions and stored writes. Keep the independent law separate. |
| A safe invariant excludes every bad transition? | Check unrestricted induction, coverage, accepted and refused witnesses, and effective negative controls. |
| A set removes two equal payments? | Keep separate invoice and attempt identities until all count and attribution laws finish. |
| A total is correct but money belongs to the wrong ticket? | Check each leg and its attendee, listing, invoice, and time before totals. |
| Floating-point multiplication changes VAT? | Compare the production result with exact integer arithmetic over the stated domain. |
| Separate models pass but their assumptions differ? | Check explicit identity, amount, time, and multiplicity joins on shared fixtures. |
| Stripe changes outside the site after cancellation? | State the existing operational limit. Do not claim later manual collection is covered. |
| A new checker exposes a production defect? | Keep the law and domain. Pin the defect with a regression test and correct its owning layer before the final proof. |

## Acceptance and verification

The fifth PR is complete only when all four models have production-backed facts, effective controls, direct producer tests, and explicit limits.
Run `deno task verify:models` for initial safety, unrestricted induction, and every declared control.
Inspect the proof results and the control violation and trace results.

Also run:

- `deno task test:files` for changed producer tests and affected subscription regressions.
- `deno task check:tla` and `deno task cpd:tla`.
- The repository light gates, including Markdown and comment STE checks.
- The existing subscription scenarios when a production boundary changes.
- `deno task grade:code` for the new TLA modules, with declared context.

Grades are advisory. They cannot replace proof, source review, SQL observations, or provider evidence.
The existing full model suite passed before this contract. This is baseline evidence, not a result for the proposed models.
The required real Stripe test-mode proof remains separate and incomplete.
