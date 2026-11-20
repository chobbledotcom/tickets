# Model walkthroughs

These pages explain each maintained TLA model in everyday words.
Each page maps the model rules to the TypeScript code that supplies or
writes the facts.

The pages are generated from `scripts/model-guides/guides/`.
Do not edit them by hand.

## What keeps the pages honest

The check reads every rule and every production declaration that a page
names. It also reads the generated Markdown back. The check fails when:

- a model rule or a production declaration changes.
- a page names a rule or a declaration that no longer exists.
- a rule in the model has no step in its page.
- a page is missing, extra, or out of date.

After a change, run `deno task model-guides`.
Then read the changed text and update the explanation.

## The pages

| Model | What it protects | Bad outcome it rules out |
| --- | --- | --- |
| [Editing one attendee's ticket without overfilling a listing](AttendeeCapacity.md) | This page follows one edit to one attendee's ticket. The edit writes all its lines or none. No accepted line puts more places on a listing than its limit. | A failed edit leaves one new line behind, or a listing accepts more places than its limit allows. |
| [A repeat payment callback does not book a second ticket](BookingReplay.md) | This page follows one paid session through repeat provider callbacks and temporary row loss. The session creates at most one ticket. No delivery refunds a live ticket. The durable ledger label agrees with the ticket count. | A late callback books a second ticket. Or a callback refunds a live ticket after the temporary row disappears. |
| [Pricing one checkout without compounding its discounts](CheckoutComposition.md) | This page follows one priced checkout through its modifier passes and its final fee check. Each pass reads the original price of the units it covers. A discount never removes more than those units hold. The final subtotal matches the list prices plus every pass effect, and the deposit plus the balance matches that subtotal. | A second discount reads a price that the first discount reduced. Or a discount takes a unit below zero, or the booking fee reads a subtotal that the modifiers changed. |
| [A door admits the right number of places](DoorScan.md) | This page follows one ticket at a door. Each scan admits no more places than the booking owns on each listing. A refunded row, a purchase-only row, and an unverified non-transferable row admit nothing. A failed fact stays visible. | A scan admits more places than the booking owns, lowers an admitted count, or admits from a refunded row. |
| [Create, cancel, and settle one attendee's invoice](InvoiceFlow.md) | This page follows one attendee with two invoice numbers. Every reachable state keeps at most one open invoice. Every accepted action reaches its own status, and no action changes the other invoice number. | Two open invoices for one attendee, a closed invoice that returns to open, or a status that does not match the action that caused it. |
| [Deleting a temporary payment row only after its refund work is done](JointState.md) | This page follows one temporary payment row and one durable refund request. A row claim or an existing request needs the payment reference first. Row deletion happens only after the provider cash returns and the local records are complete. | A callback deletes the temporary row while local refund records are still due. Or a row claim or a refund request appears before the payment reference. |
| [Splitting whole units without a lost penny or a broken cap](LargestRemainderSplit.md) | This page follows one whole-unit allocation after the floor shares. Every leftover unit goes to one eligible part. The awarded units plus the units still owed equal the original leftover. No part goes past its cap. | One unit disappears in the award loop, or a part takes a unit past its cap, or units remain with no eligible part to take them. |
| [Keep the admin window stack in order through close and restore](ModalLifecycle.md) | This page follows an admin window stack from no window to close and restore. Every observed event keeps a valid stack, a saved expanded position, and a point inside the limit. | A restore forgets the expanded position, a close reverses the survivors, or a point leaves the viewport. |
| [The shared rules behind every model](ModelRules.md) | This page explains four small rules that the other models share. Each rule turns one kind of evidence into a yes or no answer. | A refused action looks accepted, a sample sits in a state the machine does not declare, or a later success hides an earlier failure. |
| [Lease two notification flags between two recoveries](NotificationFlagLease.md) | This page follows two recoveries on one attendee. A claim reserves each positive flag and remembers its colour. A restore writes that exact colour back. A clear removes the debt only after an external send accepts. | A recovery clears an owed send and loses its origin, or two recoveries both claim the same work. |
| [Keeping a payment review case until the right evidence retires it](PaymentReview.md) | This page follows one review case on a payment row. A new case opens unseen with its stated reason. An acknowledgement keeps the same case id and reason. Only evidence for that reason retires the case. | An acknowledgement replaces the case with a new id, or partial-return evidence retires a shared-reference case. |
| [Reversing a returned refund once and never twice](RefundReversal.md) | This page follows one attendee's provider refund through the first ledger plan and a replay. A plan posts only inverse legs for groups with provider cash, no operator money, and a settled or payment-only account. A replay never reverses a group that the first plan recorded. | A repeated callback posts a second refund for the same order. Or a refund reverses a group with an operator adjustment or an unpaid balance. |
| [Parent and child pairs sold from a shared group pool](SharedGroupCapacity.md) | This page follows one parent listing and one required child that share a capped group. One pair uses two group places. The sale loop never reports more pairs than the pool holds. A static cap below two refuses the pair even when no date value exists. | A pool reports more pairs than its free places hold. Or a sold-out date-less pair passes the allow gate. |
| [Keeping a Square cancel handle while a payment link can still take payment](SquareLinkEnd.md) | This page follows one unpaid Square checkout from a missing handle to a deleted handle. A success reply without a cancelled order id proves nothing. The site keeps the handle until conclusive evidence or the retention cutoff. | A 200 reply with no cancelled order id deletes the only handle, and the Square link stays payable. |
| [One owner cancel and one failed checkout refund](SubscriptionCancellation.md) | This page follows an owner cancel and a failed checkout. An owner cancel records the final renewals before the row ends. A failed checkout keeps its zero-quantity plan, ends Stripe, and refunds at most once. A replay finishes stored work without a second provider refund. | A row ends while Stripe still charges, or a replay sends a second refund for one failed checkout. |
| [One subscription checkout and the plan that it stores](SubscriptionCheckout.md) | This page follows one subscription checkout from order admission to the stored plan. An admitted subscription order reaches Stripe with one recurring line and the first invoice reference. Every booking row keeps the plan of its own start, with VAT inside the recurring amount. | An unsupported order reaches Stripe, the first payment cites the wrong invoice or intent, or the plan lands on another person's row or the wrong row. |
| [The scheduled check and the owner cancel keep one paid renewal](SubscriptionLifecycle.md) | This page follows one booking row through the scheduled check and the owner cancel. A row becomes ended only when Stripe ends and every paid renewal sits in the ledger. The ledger never holds a renewal that Stripe does not hold as paid. | An ended row holds a paid renewal out of the ledger, or a refused read removes money that the row already holds. |
| [Subscription plans through edits, deletes, merges, and reads](SubscriptionRecords.md) | This page follows edits, deletes, and merges of subscription booking rows, and the subscriber list. A live plan survives every drop. A permitted write keeps the exact plan columns, and a refused write changes no row and no money. | An edit, delete, or merge discards a plan that can still charge, a copied plan loses a column, a refusal leaves a partial write, or the subscriber list drops or invents a row. |
| [One paid renewal reaches the ledger with cash, sale, and VAT legs](SubscriptionRenewals.md) | This page follows one Stripe renewal report into the ledger. A paid cycle invoice posts its cash, sale, and VAT roles for the right attendee and listing. A replay leaves those same legs in place. A changed booking identity posts no money. | A renewal posts money to the wrong attendee or listing, or a replay adds a second copy of one invoice. |
| [The two business classes of a stored subscription status](SubscriptionRules.md) | This page explains the two status classes that every subscription model shares. Six stored words still charge the buyer. Two stored words are ended. | A model treats an ended subscription as live, or a live subscription as safe to discard. |
| [Keeping a SumUp checkout recoverable when its callback is lost](SumupRecovery.md) | This page follows one SumUp checkout after the provider callback fails to arrive. A row that can still hold unaccounted money stays. It keeps a check that can ask SumUp again. Age alone never proves that nobody paid. | An old waiting or owed row is deleted, so a paid checkout leaves no row and no later check can find the money. |
| [Keeping one refund claim safe across two workers and an old lease](TwoWorkers.md) | This page follows one payment claim through two refund runs. A run takes the row only when no claim exists or the claim is stale. A settle needs the exact stored command, write time, and phase. An old run cannot release a replacement claim. | A paused run returns after its lease expires and clears the claim that a second run now holds. |
| [Keeping a saved VAT assessment stable across settings and refunds](VatLedger.md) | This page follows one booking's saved tax assessment. A settings change alone does not rewrite a recorded sale. An accepted save uses the setting at that moment. A refund keeps the recorded amounts and closes the sale. | A later VAT setting rewrites a past refunded sale, or a stale form saves over the current assessment. |

## The notation key

| Symbol | Meaning |
| --- | --- |
| `==` | This line defines a rule. It does not assign a value. |
| `x'` | The value of `x` after the step. |
| `/\` | Both conditions must hold. |
| `\/` | One of the conditions must hold. |
| `\A` | Every supplied value must satisfy the rule. |
| `\E` | At least one supplied value must satisfy the rule. |
| `\in` | The value belongs to the set. |
| `=>` | If the left condition holds, the right condition must hold. |

Read [the model verification guide](../model-verification.md) for the
method and its limits.
