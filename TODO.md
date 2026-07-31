# TODO — remaining follow-ups

This file tracks work that was planned but **not yet done** when the root-level
planning/design docs were retired (they had served their purpose once the bulk
of each feature shipped). Each section is written to stand on its own — you
should not need the deleted docs to pick up an item. If you do want the full
original design, it is in git history:

```
git log --diff-filter=D --name-only -- '*.md'      # find the deletion commit
git show <deletion-commit>^:booking-unification.md  # read the old doc
```

The retired docs and their git-recoverable filenames: `parents.md`,
`editors.md`, `packages.md`, `listing-templates.md`, `tests.md`, `review.md`,
`settings-plan.md`, `pages.md`, `edit-pages.md`, `servicing.md`,
`TEST_QUALITY_IMPROVEMENTS.md`, `booking-unification.md`,
`booking-unification-phase2.md`. All were fully or substantially shipped;
everything still outstanding is captured below.

---

## The payment rewrite does not have full test coverage yet

*Origin: bringing `base/payment-aggregate` (#1962) up to date with main. The
merge itself is finished and both the Deno suite (21,629 tests) and the
Cucumber suite (181 scenarios) pass; `deno task test:coverage` does not.*

The repository requires 100% line and branch coverage, and 26 files the payment
rewrite added or reworked are short of it. None of them was touched by the
merge repair — the gap belongs to the rewrite itself and predates that work —
so it is written down here rather than papered over.

Every one is a payment file. The largest are `webhooks.ts` (38 lines),
`completion-refund.ts` (30) and `store-refund.ts` (16), and the shape is
consistent: the paths that are missing are the unhappy ones — a provider that
cannot be reached, a refund that comes back part-paid, a completion that has to
be picked up again later. Those are exactly the branches that most want a test,
because they are the ones nobody exercises by hand.

Starting point: `deno task test:coverage`, then work down this list. Where a
branch turns out to be unreachable, delete it rather than test it.

- `src/features/admin/attendees-edit.ts` — lines: 144/150 covered; missing 232-237; branches: 27/28 covered; missing 234
- `src/features/admin/attendees.ts` — lines: 271/278 covered; missing 85-90, 92; branches: 33/34 covered; missing 85
- `src/features/admin/payments/form.ts` — lines: 109/113 covered; missing 148, 150-152; branches: 12/13 covered; missing 150
- `src/features/api/payment-processing/completion-booking.ts` — lines: 174/190 covered; missing 60-61, 72-74, 211-213, 237-244; branches: 9/13 covered; missing 61, 72, 211, 238
- `src/features/api/payment-processing/completion-deliveries.ts` — lines: 94/101 covered; missing 56, 59-60, 88-90, 92; branches: 13/16 covered; missing 56, 58, 90
- `src/features/api/payment-processing/completion-refund.ts` — lines: 200/230 covered; missing 51, 69-74, 99-101, 103, 165-168, 190-192, 194, 241-248, 281-283; branches: 25/34 covered; missing 51, 70, 99, 165, 190, 242, 245, 281
- `src/features/api/payment-processing/index.ts` — lines: 135/139 covered; missing 70-73; branches: 28/30 covered; missing 70, 72
- `src/features/api/payment-processing/store-refund.ts` — lines: 142/158 covered; missing 116-118, 120-122, 183-185, 232-234, 236, 238-240; branches: 7/12 covered; missing 116, 120, 183, 232, 238
- `src/features/api/webhooks.ts` — lines: 319/357 covered; missing 76, 78-80, 212-216, 225-232, 309-314, 329-331, 334-335, 337-340, 365-366, 385-388; branches: 96/110 covered; missing 76, 78, 154, 215, 227, 230, 309, 312, 329, 334, 337, 339, 365, 388
- `src/shared/accounting/queries.ts` — lines: 185/189 covered; missing 85-88
- `src/shared/db/attendees/queries.ts` — lines: 187/194 covered; missing 366-367, 369-371, 373-374
- `src/shared/db/migrations/legacy-payment-schema.ts` — lines: 203/207 covered; missing 169-172; branches: 26/27 covered; missing 171
- `src/shared/db/notes/queries.ts` — lines: 103/104 covered; missing 51; branches: 8/9 covered; missing 51
- `src/shared/db/payments/charges.ts` — lines: 246/257 covered; missing 278-283, 285, 334, 343-345; branches: 49/52 covered; missing 281, 334, 343
- `src/shared/db/payments/completion-fence.ts` — lines: 42/49 covered; missing 9-12, 52-54; branches: 0/1 covered; missing 52
- `src/shared/db/payments/decision-attempts.ts` — lines: 203/250 covered; missing 132-145, 147-151, 157-159, 161-171, 173-175, 177-181, 191, 195-199; branches: 48/55 covered; missing 148, 167, 179-180, 191, 195, 198
- `src/shared/db/payments/decision-claim.ts` — lines: 119/126 covered; missing 59-61, 127, 133-135; branches: 4/7 covered; missing 59, 126, 133
- `src/shared/db/payments/decision-completion.ts` — lines: 142/165 covered; missing 33-34, 49-55, 147-149, 153, 173-175, 229-231, 238-240, 242; branches: 16/24 covered; missing 32, 48, 53, 147, 153, 173, 229, 238
- `src/shared/db/payments/legacy-copy.ts` — lines: 284/294 covered; missing 199-202, 204-206, 261-263; branches: 59/61 covered; missing 204, 261
- `src/shared/db/payments/legacy-sessions.ts` — lines: 161/171 covered; missing 155-157, 159, 183-185, 263-265; branches: 9/12 covered; missing 155, 183, 263
- `src/shared/db/payments/redaction.ts` — branches: 27/28 covered; missing 192
- `src/shared/db/payments/sessions.ts` — lines: 170/180 covered; missing 93, 115-117, 128-129, 131-134; branches: 22/25 covered; missing 93, 115, 127
- `src/shared/listings-actions.ts` — lines: 287/293 covered; missing 479-481, 492-494; branches: 115/117 covered; missing 479, 492
- `src/shared/payment-runtime/operator-claim.ts` — lines: 119/142 covered; missing 23-25, 27, 49-64, 141-143; branches: 17/22 covered; missing 23, 48, 52, 54, 141
- `src/shared/payment-runtime/operator.ts` — lines: 253/284 covered; missing 70-72, 80-82, 158-163, 175, 205-207, 239-242, 265-267, 270-271, 323-325, 329-331; branches: 58/68 covered; missing 70, 80, 161, 175, 205, 241, 265, 270, 323, 329
- `src/shared/payment-runtime/process.ts` — lines: 238/259 covered; missing 128-130, 174-179, 201-203, 211-213, 282-283, 298, 319-321; branches: 60/67 covered; missing 128, 177, 201, 211, 282, 298, 321

---

## Eight Codex findings on the payment aggregate base

*Origin: Codex review of PR #1962 at commit `484b278d`, while that branch was
being brought up to date with main.*

These are about the branch's own payment logic, not about the merge, so none
were acted on there. Two were spot-checked against the code and the shape they
describe is really there; the other six are recorded as claimed and still need
checking. None has a regression test yet.

**Money can stop moving**

- `src/shared/payment-runtime/maintenance.ts:200` — a saved owner decision that
  fails against the provider is stored as retrying and then rethrown, and
  `runPaymentMaintenance` awaits it before reconciliation. So one stuck decision
  holds up every checkout, completion and refund behind it. *(Checked: the two
  steps are awaited in that order, so a throw in the first does skip the
  second.)* Suggested: treat the stored failure as that item's outcome and carry
  on.
- `src/shared/payment-runtime/process.ts:224` — the "completion still pending"
  branch is tested before the "refunding" one, so a payment queued by
  refund-all resumes its old completion first, `finishCompletion` refuses the
  refunding → completed move, throws, and reschedules for ever. The refund
  never runs. *(Checked: those branches are in that order.)* Suggested: handle
  the stored bulk-refund request first.
- `src/shared/payment-runtime/create.ts:101` — a provider create answering
  `null` is always recorded as created and retried, but the wrappers also
  answer `null` for permanent refusals, so the same request repeats every
  minute and the buyer's encrypted details never become eligible for tidying.
  Suggested: separate "cannot reach the provider" from "the provider said no".

**The buyer can get the wrong thing**

- `src/features/api/payment-processing/completion-booking.ts:76` — completion
  run later by maintenance reloads the listing and the booked quantity, so an
  owner edit between taking the money and finishing the work changes what the
  buyer receives (quantity 1 → 2 reserves two sites against a payment for one).
  Suggested: write the delivery facts down when the booking commits.

**Repair paths that are not there**

- `src/shared/db/payments/legacy-copy.ts:93` — a `checkout_stages` row with no
  processed result copies across as a legacy pending payment with no
  reconcile time and no case, and maintenance only looks at current sessions.
  A later provider callback then reads it as a conflict with nothing to fix it
  by. Suggested: open a needs-action case for it.
- `src/features/admin/payments/data.ts:62` — the legacy case page resolves every
  configured payment account with `Promise.all`, so one provider being down
  hides the whole page, including choices that use a working provider.
  Suggested: resolve them separately and mark only the one that is unavailable.

**Smaller**

- `src/shared/square-payment-pages.ts:29` — reconciling an order walks the
  location's payment list (eight pages of 100) rather than asking for the
  tender payment ids the order already carries. Past about 800 payments a
  recent one is never reached and reconciliation reports the provider as
  unavailable. Suggested: fetch each documented payment directly.
- `src/shared/listings-actions.ts:495` — the attachment is deleted from storage
  before `deleteListing` takes its transaction, so if a completion turns up in
  between, the file is gone but the listing stays, showing a link to nothing.
  Suggested: take the database claim first.

---

## Nine more Codex findings on the payment aggregate base

*Origin: Codex review of PR #1962 at commits `95c4367d` and `bd012b2e`, while
that branch was being brought up to date with main. Recorded as claimed — none
has been checked against the code or given a regression test yet.*

**Money can go missing**

- `src/shared/db/payments/sessions.ts:213` — `getPaymentRefundTargets` skips
  sessions whose origin is `legacy`, and a copied booking keeps that origin
  even after the owner names the provider. So no booking made before the
  upgrade is offered a refund, on its own page or in refund-all. Suggested:
  load resolved legacy sessions too, or promote one once its provider facts
  are confirmed.
- `src/features/admin/attendee-refunds.ts:130` — a single refund the provider
  answers as pending returns before `recordAttendeeRefund`, and the later
  confirmation only finishes the ledger for bulk refunds. The money is handed
  back but the site keeps showing it. Suggested: store the retryable local
  completion on this path too.
- `src/shared/db/attendees/delete.ts:91` — the guard only fences a pending
  completion, so a booking with a refund still in flight can be deleted and
  its payment detached. The later confirmation then has no booking to record
  against. Suggested: fence on an unfinished refund as well.

**The buyer or owner can get the wrong thing**

- `src/features/api/webhooks.ts:156` — a SumUp return carries the local
  payment id in `session_id`, but only `payment_id` is read as local, so a
  provider change while the checkout is open makes the site ask the new
  provider about SumUp's id and the buyer cannot reach their ticket.
- `src/shared/payment-runtime/terminal.ts:42` — a cancelled SumUp checkout is
  stored as failed-and-ignored and shown the normal cancellation page, but a
  reload takes the terminal path and answers `conflict`, telling the buyer
  their payment needs review when nothing does.
- `src/shared/email.ts:514` — the business email is not rechecked before a
  queued message goes out, so changing it after a payment completes sends the
  owner notification, with the buyer's details in it, to the old address.

- `src/shared/square-provider.ts:23` — a Square `payment.updated` event for a
  dashboard or till payment carries no `order_id`, but the check demands one,
  so verification calls it invalid and the handler answers 400. Square then
  retries that unrelated event for ever. Read the order id as optional and
  accept an event that cannot name an order.

**Recorded from the same round, still to be looked at**

- `src/shared/db/migrations/2026-07-26_payment_aggregate.ts:190`
- `src/features/admin/attendees-edit.ts:209`
- `src/shared/payment-runtime/operator-context.ts:158`
- `src/shared/db/migrations/legacy-payment-retirement.ts:9`
- `src/shared/db/payments/redaction-eligibility.ts:31`
- `src/shared/db/payments/redaction-values.ts:58`
- `src/shared/db/payments/legacy.ts:300`
- `src/shared/db/payments/completion-deliveries.ts:40`
- `src/shared/payment-runtime/provider-refund.ts:65`
- `src/shared/sumup.ts:85`

---

## The rest of the Codex findings on the payment aggregate base

*Origin: the same Codex reviews of PR #1962. The two sections above cover the
findings recorded while the branch was being merged; these are the remainder,
gathered when every review thread was answered. Recorded as claimed — none has
been checked against the code or given a regression test yet.*

**Money can move when it should not**

- `src/features/admin/attendees-edit.ts:206` — "Refresh payment" passes a
  part-refunded charge to the refund path, so an action that reads as a
  read-only refresh can hand back more money with no operator choice.
  Suggested: refresh should only re-read the provider, never refund.
- `src/features/admin/refunds/provider.ts:82` — a bulk refund that goes out at
  the provider but fails to reach the money ledger is only logged, so the money
  is gone with nothing left to repair it by. Suggested: queue the ledger repair.
- `src/shared/payment-completion.ts:66` and
  `src/features/api/payment-processing/completion-refund.ts:279` — when a
  captured payment cannot be booked, only the provider refund is treated as
  critical, so the ledger entry and the note explaining it wait behind a refund
  that may never finish. Suggested: write the money and the note first.

**Work that repeats or stalls**

- `src/shared/renewal.ts:151` — two paid renewals for the same site share one
  deadline instead of taking turns, so one can overwrite the other's extension.
- `src/shared/payment-runtime/process.ts:152` — when resolving the payment
  account fails, the claim is not released and the failure is not written down,
  so the payment retries against the same broken account for ever.
- `src/shared/sumup-provider.ts:216` (also `src/features/api/webhooks.ts:376`) —
  an unknown SumUp id is sent to the provider before being checked locally, so
  unsigned junk ids each cost a provider call.
- `src/features/api/payment-processing/completion-deliveries.ts:123` — one
  permanently failed delivery holds up every later delivery in the queue
  instead of being moved aside.
- `src/shared/db/payments/bulk-refunds.ts:57` — a refund is queued while the
  booking's completion is still pending, and the two then fight.
- `src/shared/db/migrations/2026-07-26_payment_aggregate.ts:241` — paging stops
  while raw legacy ids are still left, so the tail of a large table is skipped.
- `src/shared/db/migrations/2026-07-26_payment_aggregate.ts:55` — a SumUp
  payment's two ids can land in different migration pages and be copied twice.

**Records that end up wrong**

- `src/features/api/payment-processing/create.ts:192` — a newly paid booking is
  stored with an empty `payment_id` while the attendee panel and the CSV export
  still read that field, so both now show nothing for new bookings.
- `src/features/api/webhooks.ts:239` — a ticket token handed out before
  completion finishes is not consumed, so it can be used again.
- `src/shared/merge/attendee-merge.ts:828` — merging an attendee with a paid
  delivery still pending leaves the delivery and any reserved site pointing at
  the attendee that was deleted.
- `src/shared/sumup.ts:176` — a retried SumUp amount is converted with the
  current currency rather than the one stored on the payment.
- `src/shared/db/payments/redaction-eligibility.ts:21` — a fully refunded
  session with no completion plan is never redacted, so its personal details
  are kept for ever.
- `src/shared/db/payments/redaction-values.ts:66` — redacting the completion
  input drops the marker that says the payment was a balance payment.

---

## Marketing screenshot visual cleanup

_Origin: visual audit of the mobile Retina screenshots generated from
`../tickets-site/scripts/screenshots/` on 2026-07-18._

The screenshots use real application pages with scenario-specific custom CSS.
Keep fixes in those scenarios unless the same problem also appears in the normal
application UI. Regenerate each affected PNG and inspect the final image at its
actual size before marking an item complete.

**High priority:**

- **Fix the logistics card overflow and buttons.** In
  `scripts/screenshots/logistics.js`, the white booking card extends past the
  right edge of its blue day panel in `logistics-deliveries.png`. Both orange
  “Mark done” buttons are too narrow: the text touches the pill edges and looks
  vertically cramped. Keep the card inside its parent with border-box sizing,
  then give the buttons enough inline and block padding for the full label.
- **Give the daily-calendar states distinct, readable colours.** In
  `scripts/screenshots/daily-events.js`, the selected 3 August date uses white
  text on pale yellow in `daily-events-calendar.png`, which has poor contrast.
  The selected date and the other highlighted date also look almost identical.
  Use dark text and visibly different selected/today treatments while keeping
  both states clear without relying on colour alone.
- **Remove accidental focus outlines from checkout captures.** Several images
  end with whichever control was filled last still focused, producing an
  unrelated black or white outline: `charity-family-fun-day-checkout.png`,
  `promo-codes-and-add-ons-checkout.png`, `equipment-hire-booking.png`,
  `the-tempest-group-checkout.png`, and `garden-party-package-checkout.png`. Add
  one shared scenario helper that blurs the active control before capture, then
  use it for all filled checkout scenarios. Keep deliberate focus only in a
  screenshot that is specifically demonstrating keyboard focus.
- **Stack the Garden Party email field on mobile.** In
  `scripts/screenshots/packages.js`, “Your Email” and its input are squeezed
  onto one row in `garden-party-package-checkout.png`, unlike the name field
  above it. Make contact-field labels and controls consistently full-width so
  the input does not crowd the label.

**Polish:**

- **Shorten the bulk-email preview.** In `scripts/screenshots/bulk-email.js`,
  `bulk-email-preview.png` is about twice as tall as it needs to be because the
  warning copy, line height, and section gaps are oversized. Reduce the scenario
  font size/line height and vertical spacing without hiding or rewriting the
  real warning. Keep the recipients, subject, warning, and full message preview
  visible.
- **Tighten the balance summary.** In
  `scripts/screenshots/deposits-and-balance-payments.js`, the three totals in
  `deposits-and-balance-payments.png` have large vertical gaps and the payment
  action sits in an oversized empty panel. Reduce those gaps and panel padding
  while preserving a clear order: full price, already paid, balance due, then
  payment action.
- **Tighten oversized checkout headings.** The headings in
  `charity-family-fun-day-checkout.png` and `equipment-hire-booking.png` wrap
  with more line spacing than the forms use. Adjust only the scenario heading
  line-height and bottom margin so each title remains prominent but does not
  dominate the image.
- **Use the theme colour for custom-question controls.** In
  `scripts/screenshots/custom-questions.js`, the selected radio in
  `custom-questions-checkout.png` uses the browser’s bright blue default, which
  clashes with the brown bakery theme. Set `accent-color` to the scenario’s
  accessible brown accent and confirm the selected state remains obvious.
- **Reduce the listing-form crop height if it stays readable.** In
  `scripts/screenshots/listing-management.js`,
  `summer-sessions-listing-form.png` is nearly 2,000 pixels tall despite already
  being limited to the Basics fieldset. Tighten field hints, editor height, and
  section spacing rather than removing the date or venue. Keep all text
  comfortably readable at the rendered `split-image` size.

**Final visual check:**

- Regenerate every scenario-owned screenshot after the fixes and inspect for
  clipped text, overflowing boxes, accidental focus rings, low contrast,
  overlapping labels, inconsistent padding, and empty space at all four crop
  edges. Also render the affected `split-image` pages at desktop and mobile
  widths so a good source PNG is not undermined by its website placement.

---

## Booking unification — phases 3 & 4

_Origin: `booking-unification.md`, `booking-unification-phase2.md`._

**Background.** Bookings used to have three independently-grown models: a normal
listing, parent/child listings (`listing_parents`), and packages (`is_package`
groups, `group_listings`). The unification collapses all three into one
**booking-node tree** (`BookingTree`/`BookingNode`) where required / optional /
fixed / hidden items are just configurations of one structure, walked by five
generalized passes: render, fold, price, capacity, revalidate.

**Already shipped (phases 1 & 2, PR #1462) — do not redo:**

- Tree model + pure builder: `src/shared/booking/tree.ts`, `build-tree.ts`
  (`buildBookingTree`). The public renderer
  `src/ui/templates/public/
  reservations/` (entry point `ticket-page.tsx`)
  drives field names/rendering off the tree.
- Unified walks: `fold-tree.ts` (`foldBookingTree`), `price-tree.ts`
  (`effectivePrice`, `priceRuleByListingId`, `packageMemberPriceRule`),
  `capacity-tree.ts` (`packageQuantityCap`, own-cap + group-pool arms).
- `foldSelectedChildren` (`src/features/public/ticket-payment.ts`) is now a thin
  adapter over `foldBookingTree`. Pricing flows through `effectivePrice` in
  `ticket-payment.ts`, `ticket-submit.ts`, `api/index.ts`,
  `payment-processing.ts`, `webhook.ts`.
- v2 signed per-node metadata: `BookingItemSchema`
  (`src/shared/.../payments.ts`, ~line 67) is `{e,q,p}` plus optional edge tags
  `k` (`"p"`/`"g"`) and `r` (group id); `signed-metadata.ts` (`signedEdgeFor`);
  webhook re-walk in `payment-processing.ts` (`validateAllItems`,
  `packageBundleMismatch`, `classifySession`).
- A package member may itself be a parent: `isPackageableMember`
  (`src/shared/.../groups.ts`, ~line 115) now permits it.
- **Row-level admin identity + per-path bookings (multi-package orders).** The
  same listing id may now legitimately book through more than one path in a
  single order (a package member beside its own standalone row; the model also
  supports two overlapping packages). One `CheckoutItem`/booking row per path,
  each tagged `packageGroupId`; the booking-slot unique index and the
  merge/check-in row keys are widened with `package_group_id`
  (`2026-07-05_package_slot_identity` migration, `bookingKey`,
  `bookingSlotKey`). `PagePackage` + `buildBookingTree` build one node per path,
  and `/order` sells packages alongside listings via the pure `#shared/order`
  evaluator (`options.ts`/`evaluate.ts`). The admin attendee editor matches: one
  editable line per stored booking row (labelled with its path), plus blank
  per-(package, member) lines behind a pure-CSS toggle, so an operator can view,
  edit, and create every path combination a public buyer could — JS-free
  (`attendee-form-model.ts`, `attendee-page-data.ts`).

**Remaining:**

- **Phase 3 — unified edge store (optional; one-way door).** Collapse
  `listing_parents` and `group_listings` into a single edge table (or make one a
  view of the other). This is the only schema-migrating, hard-to-reverse phase,
  so only take it once a concrete need demands it. Shipping phases 1–2 and
  stopping here is an explicitly _successful_ outcome, not a half-finished one.

- **Phase 4 — buyer-choice children inside a package (optional).** Let a package
  member offer a buyer-selected child (the parent/child choice UI, nested under
  a package). Build on demand when a real booking requires it.

- **`/order` live availability: fold required-child demand into options.** The
  order gallery's evaluator (`#shared/order`) judges an option by its direct
  listings' units; the children the booking form auto-folds under a parent (a
  sole bookable child fills to the parent quantity) are not part of the demand,
  so two selections contending for a shared child pool read as available on the
  gallery and are refused at the form. Advisory-only today (the form is the
  authority — documented in `src/features/public/order.ts`); fixing it means
  loading each option's children in `loadOrderCatalog` and adding the guaranteed
  folded units (and their group pools) to `unitsByListingId`.

- **Per-path sale amounts in the ledger projection.** A booking posts ONE `sale`
  leg per listing (`bookingFactsFromOrder` sums the order's lines by listing id;
  the leg reference is `["sale", listingId]`), and `pricePaidFromLedger` splits
  that total across the listing's sibling rows in quantity proportion. When one
  listing books through two paths at DIFFERENT prices in one order (package
  override beside its own standalone row), the per-row `price_paid` readback is
  therefore quantity-averaged — e.g. 4×400 package units + 1×500 standalone
  reads back 1680/420 instead of 1600/500. Order totals, revenue sums, and
  refunds are exact (the shares telescope); only per-row display/merge
  granularity blurs, and only when per-path prices differ. Fixing it needs a
  SQL-queryable per-path discriminator on sale legs (a transfers schema addition
  — `reference` is a hash, `kind`/`dest_id` feed reports) or re-storing the
  per-row amount, plus a fallback for pre-upgrade rows whose legs are untagged.
  Do it when per-row money display matters more than the schema stability of the
  append-only ledger.

- **Confirm the v1 drain bridge is genuinely unnecessary.** The original plan
  called for a bounded-window read-only parser for pre-cutover (v1) signed
  metadata plus a regression test for an old-shape session paid during the
  cutover window. No dedicated bridge was built. In practice the v2 schema added
  `k`/`r` as _optional_ fields to the existing `e/q/p` line shape, so old
  sessions still parse (as standalone lines). Verify this covers every
  in-flight-session case and, if so, close this out; otherwise add the bridge +
  drain-window test.

---

## Entity pages migration — slices 4–5

_Origin: `edit-pages.md`._

**Background.** "Entity pages" is one declarative, schema-driven, tabbed
framework (`defineEntityPage`) that replaces every hand-assembled admin "edit X"
page. A page becomes data: tabs of typed sections (summary / activity / actions
/ custom), with per-tab authorization, path-segment tabs, and in-place 400-error
re-rendering. Migration is deliberately gradual and hardest-first.

**Already shipped — do not redo:**

- Framework: `src/shared/entity-pages/core.ts`,
  `src/features/admin/
  entity-pages.ts`,
  `src/ui/templates/admin/entity-pages.tsx`.
- Attendees: `src/features/admin/attendee-page.ts` (slice 1, PRs #1500, #1502,
  #1503).
- Listings: `src/features/admin/listing-page.ts` (slice 2).
- Groups: `src/features/admin/group-page.ts` (part of slice 4).
- Holidays: `src/features/admin/holiday-page.ts` (part of slice 4).
- Modifiers: `src/features/admin/modifiers.ts` (slice 3).
- Users, built sites, and attendee statuses (part of slice 4).
- API keys and logistics agents also use the framework.
- Site pages and news also use the framework through
  `src/features/admin/site-content-page.ts`.

**Remaining slices (each is roughly one PR; keep them small):**

- **Slice 4 — the long tail.** Questions and `history/:hmac` remain. Groups,
  holidays, users, built sites, and attendee statuses are complete.
- **Slice 5 — generalize `system_notes`: done.** A note now names the kind of
  record it is about and which one (`entity_type`, `entity_id`), and the notes
  module works in those terms (`src/shared/db/notes/`). What remains is per-page
  work: add `"listing"` (or whichever record is next) to `NOTE_ENTITIES` in
  `notes/target.ts`, give that record's delete path the notes delete statement,
  and add the notes section to its entity page. The list drives the database
  `CHECK`, so adding a kind ships with a small rebuild migration — as
  `2026-06-20_free_text_questions` did for `questions.display_type`.

---

## Servicing — read-only guard (optional variant)

_Origin: `servicing.md` (+ its review docs `review.md`, `tests.md`)._

**Background.** The servicing-events feature (attendee-kind rows that hold
listing capacity without being customers) shipped and was hardened across PRs
#1395, #1499, #1501: all P0/P1/P2 review defects fixed, a unified currency-aware
money schema introduced at `src/shared/validation/money.ts`
(`parsePositiveMinorUnits` / `validatePrice`), and the read-only default-deny
guard added (path-based allowlist, fails closed). The last money site — the
modifier `calc_value` / `min_subtotal` fields — was then made currency-aware:
`min_subtotal` through the shared `parseOptionalMinorUnits`, and the polymorphic
fixed `calc_value` through a `calc_kind`-aware `exceedsCurrencyPrecision` guard
in `validateModifier` (so a percentage or multiplier keeps its precision).

**Remaining (optional):**

- **Registry-driven read-only default-deny.** The current path-based allowlist
  already fails closed. The fuller variant — resolve the route first, then
  consult a per-route `readOnly: "allow"` flag — is an optional future refactor,
  not a fix.

---

## Test quality

_Origin: `TEST_QUALITY_IMPROVEMENTS.md`._

**Background.** The goal is to move past coverage-as-floor toward proving
_assertion strength_. The priority-1 initiative — **mutation testing as a gate**
— is fully shipped: `scripts/mutation.ts` + `scripts/mutation/`,
`deno task
mutation` and `precommit:mutation` (staged-file gate, batched to
bound file descriptors — PRs #1478 and others). A weak-assertion audit script
also exists: `scripts/test-quality-audit.ts`.

**Remaining:**

- **Mutation tests removed from `deno task precommit`.** The
  `precommit:mutation` step was too slow for the standard precommit run and was
  removed from `scripts/precommit/steps.ts`. The mutation gate still exists as
  `deno task precommit:mutation` and `deno task mutation` — run it manually on
  changed src/test pairs before merging. Re-wire it into precommit (perhaps
  behind a flag or with a tighter changed-set bound) only if the per-commit
  mutation cost comes down.

- **Property-based tests (item 5).** `fast-check` is currently used in only one
  test (`test/shared/booking/fold-tree.test.ts`). Add properties for: slug
  generation, CSV round-trips (commas / quotes / CRLF), date formatting across
  timezones, token parsers, and URL safety.
- **Weak-assertion audit lifecycle (item 6).** The script exists but isn't wired
  into CI. Escalate it: informational → CI warning → review gate for touched
  files.
- **Production-shape checks (item 7).** Stand up a scheduled or release-blocking
  suite distinct from the unit run: edge-bundle smoke test, backup/restore
  drills, concurrent-reservation race, webhook replay/idempotency, load tests,
  security scans.
- **Ongoing ratchets (items 2 & 3).** In new/touched files, keep replacing
  compound-boolean assertions with specific ones and strengthening bare presence
  checks. These are permanent review habits, not a one-time sweep.
- **Metrics.** Surface mutation-score baselines / surviving-mutant counts as a
  tracked artifact so regressions in assertion strength are visible.

---

## Settings on-demand loading — generation counter

_Origin: `settings-plan.md`._

**Background.** The eager `settings.loadAll()` (decrypt every settings row on
every request) was replaced by keyed, on-demand loading:
`prepareRequestEnvironment` calls `settings.loadKeys(settingsForPath(path))`,
per-route bundles live in `PREFIX_SETTINGS`, `loadAll` is deleted, and a
dev-mode read-audit (`src/shared/db/settings-audit.ts`, wired into `snap()`)
keeps the bundles honest by failing when a route reads a key it didn't declare.

**Remaining (deferred by design):**

- **Generation counter for concurrent partial-load/write races.** Only add this
  if profiling shows real concurrency between a partial load and a settings
  write. Not needed today.

---

## Packages / choice slots (parent members with a pick count)

- **Chooser own-cap footgun.** A choice slot is a package member that is a
  parent listing; its own `max_quantity` feeds the bundle cap
  (`min(own_cap, child_units) ÷ pick_count`). A chooser left at the default
  `max_quantity: 1` under a pick-2 slot silently caps the whole package at 0,
  with no save-time warning. Fix: reject (or warn on) a parent package member
  whose per-order cap is below its pick count.

- **Capacity edge cases beyond the shipped model.** The shipped bundle-cap model
  (per-member child caps, sole-child pools, all-children forced demand) covers
  the common configurations but is not a full per-candidate feasibility solver:
  partial-overlap cases stay approximate — pool-subset unions (e.g. three pick-1
  slots over two 1-spot pools), a multi-pool candidate double-counted as
  alternative supply, and jointly-infeasible cross-slot mixes. All fail SAFE
  (the atomic submit write rejects; capacity is never clamped, only rejected),
  so the cost is a rare dead-end submit or an over-advertised bundle, never
  overbooking. Revisit only if a real configuration hits it.

- **Deferred choice-slot semantics.** Optional slots (a min/max pick count, e.g.
  "choose 0–2"); a per-slot "distinct picks" flag; per-package-unit pick mixes
  (today N packages × pick-K allows any mix of N×K picks, following the
  parent-quantity distribution); and a group-edit "add choice slot" affordance
  that mints the chooser listing plus its child edges in one step with sensible
  default caps.

## Listings offered under multiple parents / "can be booked by itself"

- No outstanding items — the row-identity fix (per-parent attendee rows, paid
  mapping by listing id, remainder rows) and the `bookable_alone` flag shipped.

## Test-suite speed — remaining opportunities

_Origin: the test-suite performance pass (lazy Sentry, fast `toContain`,
migration-suite sharding, `withVirtualBackoff`, `cachedAdminPage`; see the Fast
Tests section of AGENTS.md). These were identified during profiling but
deliberately left for later:_

- **Per-file module-graph evaluation.** Every test file re-evaluates the app's
  module graph (~0.35s each after the lazy-Sentry fix, ~250 files ≈ 80-90s of
  CPU per run). The biggest remaining import-time chunks are `@libsql/client`
  (~65ms, needed) and the `#routes` feature tree (~150ms). Any further
  import-time work moved behind `once()`/dynamic import pays for itself ~250×
  per run — profile with a `performance.now()` probe around `import("#test-utils")`
  under `deno test` before and after.
- **`test/scripts/stripe-mock/ports.test.ts` (~4s)** spawns real child processes
  to test the harness's port handling; each spawn is inherently slow. If it
  grows, the port-conflict cases could stub the child-process layer the same
  way the supervisor tests do.

---

## Capacity rules — feature-layer adoption (stage 3)

_Origin: the capacity-rules consolidation (`src/shared/capacity-rules.ts`)._
Stages 1–2 shipped: the declarative `CAPACITY_RULES` table exists, and the SQL
guard (`src/shared/db/capacity.ts`), the JS preflight
(`src/shared/db/attendees/capacity.ts`, `update.ts`), and the booking-page
limits (`booking/model.ts`, `booking/package-cap.ts`) all derive their
per-date-vs-running-total decisions from it. Stage 3 shipped too: the
feature-layer capacity-date call sites (`ticket-payment.ts` `bookingDateFields`,
`qr-book.ts` `buildCheckoutIntent`, `api/listings.ts` child availability,
`api/booking.ts` `resolveBookingDate`) consult `capacityDateFor`/`countsPerDate`
instead of branching on `listing_type === "daily"` by hand. Only the
_capacity-date_ decisions belong to the table — the remaining calendar/UI daily
branches (date pickers, sorting, display, duration spans) are date-selection
logic and should stay as they are. Nothing further planned here.

---

## Payment-processing review follow-ups (from PR #1692)

Both items describe behaviour that predates the payment-processing split (the
code was moved verbatim from the old `payment-processing.ts` monolith). They are
recorded here because the split PR was a pure reorganisation — changing this
behaviour there would be out of scope — and CodeRabbit flagged them as worth a
look.

- **Per-item DB reads not batched**
  (`src/features/api/payment-processing/items.ts` `validateAllItems`, and
  `package-pricing.ts` `loadPackagePricingByGroup`). `validateAllItems` calls
  `getListingWithCount` once per item in a loop, and `loadPackagePricingByGroup`
  makes two sequential round-trips per group. Under the edge subrequest budget
  these accumulate for larger orders. Fix direction: add/use a batched
  `getListingsWithCount(ids)` for all order listing ids at once and group the
  package-pricing loads, preserving the existing validation and fail-closed
  behaviour. See the "Respect the subrequest budget" guidance in AGENTS.md.

## Request performance: consolidate AsyncLocalStorage scopes

`src/features/app/request.ts` enters eleven nested request scopes for locale,
client IP, request ID, request cache, query logging, flash, session memoization,
iframe mode, CSRF, saved form data, and settings auditing. Replace them with one
typed `RequestContext` in one `AsyncLocalStorage`; retain domain methods where
they add behavior, but migrate every internal caller with no aliases or
compatibility wrappers. Preserve direct-render test behavior,
production-disabled audit cost, and concurrent/nested request isolation for
every mutable field. Pending work and storage overrides have different lifetimes
and need a separate decision. Benchmark before and after: the synthetic result
was about 38us/request for eleven scopes versus 2us for one. This needs a
dedicated PR because it crosses eleven state modules and their concurrency
contracts.

## Dead-export scanner matches raw text (from PR #1745 review)

`test/scripts/code-quality/detectors.ts` scans raw file contents when deciding
whether an export is used (`IMPORT_CLAUSES` → `isSymbolImported` /
`importedSymbolsOf`, and `isUsedInSameFile`). A clause-shaped snippet inside a
comment, JSDoc, or string literal therefore registers a phantom "usage" — a
CodeRabbit review on PR #1745 pointed out a JSDoc example in that very file
doing this (fixed by rewording the comment), and the fixture strings in
`detectors.test.ts` still contribute contrived names like `routeFoo` to the
test-corpus symbol set. Consequences are mild today: a phantom symbol in the src
corpus can silently mask a genuinely dead export of the same name; one in the
test corpus can only make an export look test-used (which then flags it,
loudly). This is a long-standing property of the whole detector file, not new to
the dynamic-import clauses.

Proposed fix (the reviewer suggested syntax-aware parsing): a code-only
preprocessing pass before matching. The file already has the pieces — the
call-site scanner's `skipString`/`skipComment` lexer helpers skip comments and
string literals correctly. The pass must drop BOTH comments and ordinary
string/template-literal contents from the matchable text (a fixture string
containing `import { foo }` is exactly the stated failure mode), while still
letting the lazyExport clause see its quoted name — lazyExport names live INSIDE
a string literal (`…, "routeAdmin")`), so either match the lazyExport shape
before stripping and stitch its names in, or blank string contents except when
the lexer sees the string directly in lazyExport's second-argument position. Add
regression coverage for import-shaped text in a line comment, a JSDoc block, and
an ordinary string/template literal, plus a lazyExport entry that must still be
detected after the pass. Out of scope for PR #1745 (cold-start work; the
detector change there was collateral hardening) — the concrete self-match it
introduced was fixed in-place instead.

## Stop patching @std/expect's `toContain` (from PR #1712)

`test/test-utils/fast-expect.ts` globally overrides `@std/expect`'s built-in
`toContain` via `expect.extend`, to skip the built-in's eager pretty-printing of
the whole searched value on every (passing) assertion — the speed win documented
in AGENTS.md's "Fast Tests" section (landed in PR #1702). PR #1712 removed the
`#test-utils` barrel that used to side-effect-import it, so the override is now
loaded via a `--preload ./test/test-utils/fast-expect.ts` flag on the test
harness (`scripts/test-harness.ts`) and the mutation runner
(`scripts/mutation/runner.ts`).

The preference is to **not** patch a standard library if we can avoid it. This
is genuinely out of scope for the barrel-removal PR (it would touch far more
than that PR's remit), so it's recorded here rather than done there.

Fix direction: replace the global `toContain` override with `@std/assert`'s
native `assertStringIncludes` (and `assertArrayIncludes` where a `toContain` is
used on arrays), which is already fast — it does not pretty-print on success —
so no `@std` behaviour is patched. Migrate the `expect(bigHtml).toContain(...)`
call sites (thousands, mostly rendered-HTML assertions), then delete
`fast-expect.ts`, its test, the `--preload` flag in both runners, and the "Fast
Tests" note that documents the override. Confirm the suite's slow-test report
(`SLOW_TEST_THRESHOLD_MS`) doesn't regress. Start points: `fast-expect.ts` for
what it did and why, and grep `\.toContain(` under `test/` for the call sites.

---

## Code-quality detector & test-strengthening follow-ups (from PR #1729)

_Origin: CodeRabbit review of PR #1729, deferred as out of scope for that
complexity-only refactor (which had to preserve behavior). All of these are
pre-existing behaviors carried over unchanged from `main`, not regressions._

### 1. `skipTemplateSubstitution` should skip comment contents

`test/scripts/code-quality/detectors.ts` — the template-substitution scanner
tracks brace depth but does not skip comments, so a `}` inside a comment inside
a `${...}` prematurely closes the substitution; a later nested backtick can then
end the outer template early and leak commas into `parseArgList`. Repro shape:
`` `${/* } */ `x,y`}` ``.

Fix direction: within the depth loop, skip line/block comments (a `skipComment`
helper) before the brace-depth checks, and add a direct regression test for the
comment-with-`}`-then-nested-template case asserting `parseArgList` doesn't
misinterpret the comma.

## Restrictions audit — "why can't I combine X with Y?" follow-ups

_Origin: an audit of every place the app refuses a combination a user might
expect to work, aimed at cutting "why can't I select this?" support queries.
Each restriction was judged on whether its reason is genuinely insurmountable
(structure, money-correctness, capacity, privacy, security) or a soft limit
worth relaxing. The clearest informative wins already shipped — the package
"which listing and why" messages, the daily-add-on "needs a date" reason, the
payment-provider "your other key is kept" note, and the free-text "can't set a
price" note. What's left is captured below, split into rule-relaxations (let the
combination through) and message/UX fixes (keep the rule, stop the user hitting
it blind). All are pre-existing behaviour — deliberate design choices, except
the percentage-surcharge cap noted below, which is a latent correctness bug
(harmless today because of the multiplier workaround)._

### Keep the rule — stop the user hitting it blind

- ~~**SumUp is offered on a currency it can't use.**~~ **Done.** The provider
  registry (`src/shared/payment-providers.ts`) now records each provider's
  currencies (`null` = takes them all), and
  `providerCurrencyBlock(id, currency)` turns that into the one sentence every
  surface shows. The settings page renders an unusable provider switched off
  with the reason beside it, the provider choice refuses to save, and the SumUp
  credentials save keeps its refusal.

- **An answer's price-modifier dropdown silently omits the operator's
  modifier.** `src/features/admin/questions.ts` (`answerTriggerModifiers`) only
  lists `trigger === "answer"` modifiers, so a "+£5" built as _Automatic_ or an
  add-on never appears and reads as a bug. Fix: add a hint by the selector (in
  the answers UI, `src/ui/templates/admin/questions.tsx`) — "only
  answer-triggered modifiers appear here; create one on the Modifiers page."

- **Group-homogeneity messages are hardcoded English and terse.**
  `groupListingTypeError` (`src/shared/db/groups.ts`) returns raw strings ("This
  group already contains … listings — all listings in a group must be the same
  type"), so they bypass the `I18N_REPLACEMENTS` rebranding pass and never say
  _why_. Fix: move them into `src/locales/en/*.json`, add the reason (the group
  shows one shared date/day-count selector, so members must match), and ideally
  grey out incompatible listings in the add-listings picker rather than erroring
  on save. Same treatment for the hardcoded "Customisable days cannot be
  combined with Allow Pay More" in `src/shared/listings-actions.ts`.
- **Incompatible listings are offered by the add-listings picker.** The
  group-homogeneity messages now live in the catalog and say why (`error.group_*`
  in `src/locales/en/groups.json`), but the operator still only learns of a clash
  when the save is refused. Better: grey out the listings that cannot join this
  group in the add-listings picker, so the clash is visible before saving. The
  rule to render from is `groupListingTypeError` (`src/shared/db/groups.ts`) —
  same type, and same customisable-days setting, as the members already there.

- **Two save-time either/ors would be clearer as disabled controls.** (a)
  customisable-days vs Allow Pay More (`validateCustomisableDays`,
  `src/shared/listings-actions.ts`) — the two fields sit in different form
  sections, so the operator never sees them as related; (b) a paid-default
  status that is also a reservation (`src/features/admin/settings-statuses.ts`
  ~line 69) — both checkboxes render side by side. Fix: mutually disable the
  paired controls client-side with a one-line "why", turning a save-time error
  into an obvious affordance.

- **"Refund processed but not recorded" reads like a failure.**
  `src/shared/refund-ledger.ts` only auto-reverses a fully-paid clean account;
  on a partial/credit/mixed account the provider refund fires but the operator
  sees `error.refund_not_recorded` ("do not re-refund") with no next step. Fix:
  link the manual-adjustment page straight from that flash and frame it as "one
  more step", not an error.

- **A multi-item cart with no shared date/length dies silently.**
  `dayCountsEveryListingSupports` / `computeSharedDates`
  (`src/shared/booking/
  model.ts`, `src/features/public/ticket-payment.ts`)
  leave the buyer with a bare "No dates/booking lengths are currently available"
  when two items simply share no common date or duration — undiagnosable
  mid-checkout. Fix: detect the empty-intersection case and name the conflicting
  items ("these don't share a common date — book them separately"). Highest
  buyer-facing value.

- **A manager hits a bare "Forbidden" on owner-only pages.**
  `src/features/
  auth.ts` (~line 462) returns plain text for
  users/statuses/bulk-email/settings. Fix: ensure the nav hides these for
  managers (the "never render a forbidden link" rule) and give the 403 an
  "owner-only" hint.

- **A child's duration mismatch with its parent is invisible until you open both
  day-price tables.** `children_err_child_duration` / `durationsCompatible`
  (`src/shared/listing-parents-rules.ts`) states the rule but not the clash.
  Fix: surface the actual mismatch at save time ("parent offers 2–3 days; this
  child prices only 1").

- **The order gallery advertises availability it can't honour** once required
  children fold in — already tracked above under _Booking unification →
  "`/order` live availability: fold required-child demand into options"_. Same
  fix; cross-referenced here because it's the buyer-facing half of this audit.

### Relax the rule — let the combination through

- **Only one payment provider active at a time.** `getActivePaymentProvider`
  (`src/shared/payments.ts`) reads a single `payment_provider` setting. This is
  _not_ forced by the webhook — `getWebhookSignatureHeader` already scans every
  provider's signature header — so the block is the single scalar plus no
  per-order provider choice. Relaxing needs checkout-time provider selection,
  header-based webhook dispatch, and a multi-select UI. Reasonable to leave for
  a single-merchant site; revisit if operators ask.

- **A status in use by attendees can't be deleted, with no way out.**
  `src/features/admin/settings-statuses.ts` (~lines 200–221) blocks the delete
  outright. Fix: add a "reassign these N attendees to <status>, then delete"
  flow (the same move already used to retire a default status).

- **The embed widget refuses to add a package to the cart.**
  `src/ui/client/
  order.ts` (~line 489) force-navigates away from a package
  ("it could never combine with other listings"), but the internal cart
  (`src/features/public/
  cart.ts`) _does_ combine packages with listings. Fix:
  add the package slug to the running cart and build a multi-slug
  `/ticket/<slug>+<slug>` URL like the internal gallery.

- **An answer can trigger only one modifier.** `answers.modifier_id` is a scalar
  (`src/shared/db/questions/aggregates.ts`). Everything downstream already
  handles arbitrary modifier sets; only the link is one-to-one. Fix: an
  `answer_modifiers` join table. Low frequency; do on demand.

- **A package can't contain a pay-what-you-want listing.** `packageMemberBlock`
  (`src/shared/package-membership.ts`) blocks it because a package needs a fixed
  member price. Relaxable if you define bundle pricing for a pay-more member
  (use its base price, or let the buyer choose within the bundle) — a semantics
  decision, not a structural wall.

- **A manager can't edit the public site, but a lower-trust editor can.**
  `SITE_ADMIN_LEVELS` (`src/shared/types.ts` ~line 556) is `["owner","editor"]`
  by history. Add `manager` if desired — a pure policy call.

- **Two-level listing nesting (A→B, then B→C).** `childEdgeIneligibility`
  (`src/features/admin/listings-parents.ts`) caps nesting at one level; the
  booking fold-tree and `capacity-rules.ts` both assume exactly parent+child.
  Real work (recursive fold + capacity), not a toggle — build only when a
  concrete booking needs it. (See also the booking-unification phases above.)

- **Child-scoped opt-in add-ons.** An add-on reachable only through a folded-in
  child is blocked because "v1 has no child-scoped add-on render/parse path"
  (`src/features/admin/listings-parents.ts`, `modifier-resolve.ts`). The
  `bookable_alone` flag is the current escape hatch; the real fix is to build
  that render/parse path.

- **The same pay-what-you-want add-on under two parents must share one price.**
  `foldChild` (`src/shared/booking/fold-tree.ts` ~line 281) keys the
  custom-price map by listing id. Per-allocation pricing would allow different
  prices; niche, do on demand.

---

## Design note: a shared "reasons" shape for validation failures

_Origin: reviewing the package-restriction work (PR #1770). The recurring shape
is "reject if any of N reasons holds, tell the user WHICH, sometimes list ALL" —
e.g. `packageMemberBlock`, `packageChildEdgeConflict`, `groupListingTypeError`,
the listing-input `?? next` chain. Worth writing down where this could go before
it sprawls into an over-built framework._

**What already exists (don't rebuild it):**

- **i18n keys ARE de-facto error codes.** ~113 `error.*` keys in
  `src/locales/en/errors.json` are stable machine identifiers already decoupled
  from any one rendering. A "new error-code system" would mostly re-label these.
- **Declarative first-match rule tables** already appear twice:
  `EDGE_ERROR_RULES` (`src/shared/listing-parents-rules.ts` — a
  `readonly EdgeRule[]` matched with `.find(r => r.rejects(a,b))?.error(...)`)
  and `CAPACITY_RULES` (`src/shared/capacity-rules.ts`). `packageMemberBlock`
  (this PR) is a third, hand-rolled instance of the same idea.
- **Sentry is for the _unexpected_ only.** Validation failures never reach it
  today, which is correct — an operator picking an invalid combo is not a bug,
  and routing every "you can't do that" to Sentry would bury real incidents.

**What a slick version is — and, honestly, mostly ISN'T worth building here:**

- **NOT worth it:** a global error-code registry/enum, per-code guide
  deep-links, or converting every fail-fast validator to collect-all. That is a
  large cross-cutting refactor whose value this app's size doesn't justify, and
  collect-all is often _worse_ UX (fix-one-resubmit beats a wall of ten errors).
  Fail-fast is a feature, not a limitation, for most forms.
- **Worth it, but only when a real need pulls it (do not do speculatively):**
  1. **One `reasons` combinator.** A tiny
     `Rule<T> = { code; when(x): boolean;
     message(x): string }` list with
     two runners — `firstReason(rules)(x)` and `allReasons(rules)(x)` — so a
     call site picks fail-fast vs list-everything from ONE rule definition.
     `EDGE_ERROR_RULES`/`CAPACITY_RULES`/ `packageMemberBlock` would converge on
     it. Extract on the _third_ real collect-all need, not before (two tables
     sharing a shape is not yet a framework).
  2. **A `kind` on each error: `user_error` vs `invariant_violation`.** This is
     the one with actual operational payoff and it's small. Most `error.*` keys
     are `user_error` (stay out of Sentry). A handful are "should never happen,
     an operator must act" — `error.refund_not_recorded` (refunded at the
     provider but not recorded in the ledger — `attendee-refunds.ts`,
     `attendees-edit.ts`) is the exemplar. Tag those `invariant_violation` and
     route only them to Sentry (breadcrumb + alert), so the money-integrity
     cases surface without drowning in expected validation noise.

**Recommended first step, if any:** just the `kind` tag on the ~2-3 invariant
errors + a single Sentry breadcrumb at the flash boundary. Skip the combinator
until a real collect-all site (e.g. the multi-item-checkout "no shared date"
diagnostic above) makes it pay for itself.

**A payment can be described in the wrong currency.** The work that goes out
after a payment — the registration webhook and the ticket attached to the
buyer's email — reads the site's *current* currency setting rather than the
currency the payment was actually taken in
(`src/features/api/payment-processing/completion-deliveries.ts`, around where
it reads `settings.currency`). The payment already carries what it charged, in
`current.payment.expected`. If the owner changes the site currency between the
buyer paying and that work running, the amount is labelled with the wrong
currency — and, where the two currencies count pennies differently, scaled
wrong too. Use the payment's own currency.

**Retrying a SumUp checkout can ask for a hundred times the money.** When an
uncertain SumUp checkout is tried again, the amount is converted to major units
using the site's live currency setting, while the saved payment still carries
the currency it was created with (`src/shared/sumup.ts`, the `toMajorUnits`
call). Switch the site from a currency with pennies to one without, and a £10
payment is retried as 1000 of the new currency. The reply is read back with the
same live setting, so the check on the way in does not catch it. Convert using
`expected.currency`, not the setting.

**One destination that can never succeed blocks all the others.** The queue that
sends out what a payment bought always hands back its oldest unfinished row
first (`deliverNextPaidCompletion` in
`src/features/api/payment-processing/completion-deliveries.ts`). If that row can
never succeed — an email or webhook refused outright, or a saved address that is
no longer safe to call — it throws without being moved on, so every later run
picks the same row again and the webhooks, sites and renewals behind it never go
out. Give a destination a way to be marked finished-badly or needing the owner,
so the rest can carry on and the owner has something to act on.

**Deleting a booking mid-refund loses the money's trail.** The guard that stops
a booking being deleted while work is outstanding only looks at whether its
*completion* is pending (`src/shared/db/attendees/delete.ts`). A booking with a
refund still in flight passes it, and the delete unlinks the payment. When the
provider then confirms the refund, the single-refund path has no booking left to
record it against and the bulk path throws looking for one — so the money goes
back while Money still shows it as held, and the page that could repair it is
gone. Block the delete while refund work is unfinished, or keep something for
the refund to finish against.

## The snapshot check in `decision-attempts.ts` reports as uncovered

`currentSnapshotMatches` in `src/shared/db/payments/decision-attempts.ts` is
reported as uncovered by both `deno coverage` locally and the CI gate, while
instrumenting proves it is entered five times by the existing tests in
`test/shared/db/payments/decision-attempts.test.ts`.

**The likely cause is now known, from fixing the same symptom elsewhere.** In
`src/shared/square-provider-read.ts` a guard body showed exactly this: proved to
run by instrumenting, yet reported uncovered. It was not a measurement fault.
The reads reaching that guard could only ever be "found" or "missing", so two of
its three arms could never be taken; the tool was reporting real dead code, and
the multi-line shape made the report point at the whole block rather than the
arms. Narrowing the type to the two cases that actually arrive deleted the dead
arms, and the file went to 100% on both lines and branches.

So the thing to check here is the same: which terms of the `&&` chain can never
decide the answer, given what the callers can actually pass? Do that before
concluding anything about the coverage tool — the earlier suspicion that the
measurement was at fault was wrong once already.

Ruled out along the way, and still ruled out:

- The case is still `needs_action` at the claim's revision after the payment
  changes, so the guard in front of `snapshotMatches` does not skip it.
- The stored decision reloads with `reviewed.kind === "charges"`, so it is the
  current-payment branch that runs, not the legacy one.
- A test written specifically to make every term of the `&&` chain evaluate
  still leaves the lines reported uncovered.

**Checked since, and this is now the leading explanation.** The fast claim in
`decision-claim.ts` is one statement testing three things: the decision is due,
the case still needs action at the saved revision, and the snapshot still
matches. The slow path re-derives all three in TypeScript only to say which one
failed — and it reaches the snapshot check only after the first two have
already passed. At that point the claim's failure can only have been the
snapshot, so `snapshotMatches` can only answer "no". Its "yes" is unreachable,
which is exactly the shape found in `square-provider-read.ts`.

The one thing that could make it reachable is a change landing between the two
statements, since they are not one transaction. Whether that window is worth a
check is the design question below, so this is deliberately left alone rather
than deleted to satisfy the coverage gate.

Separately, and regardless of the above: the TS check here duplicates the
SQL condition in `decision-claim.ts`, and only ever runs to explain why that
SQL claim failed. If the two can never disagree, the honest fix is to collapse
them — when the fast claim fails and the case is unchanged, the reason *is*
that the payment moved, so `closeStaleDecision` can be called without
re-deriving anything. That is a behaviour change on a money path and wants its
own change with its own tests.
## Deferred Codex suggestions from PR #1975 (API documentation examples)

*Origin: Codex review of PR #1975, which made the API documentation examples
checkable and fixed eighteen real inaccuracies in them. Both items below are
valid and were deliberately left out: they guard mistakes nobody has made yet,
and each costs more machinery than the defect it would catch.*

- **Validate admin request fields against their production constraints.**
  `test/shared/admin-api-example/helpers.ts`'s `isBlank` judges a documented
  request value by its sign and whether it is zero. A positive *fractional*
  value (Codex's example: `duration_days: 1.5` in the listing create body)
  therefore passes, while `API_BODY_FIELD_RULES` requires a safe integer and
  the real endpoint answers 400. Fixing it properly means running each request
  example through the endpoint's own field rules rather than a hand-written
  check. Starting point: `API_BODY_FIELD_RULES` in `src/features/admin/api.ts`.

- **Derive the documented create slug from what a create really does.**
  `crudDocs` in `src/shared/admin-api-example.ts` builds the create response
  from the example record, so it keeps `summer-workshop`; the listing and group
  POST converters call `generateUniqueSlug`, which emits a random five-character
  slug. The documented create response therefore cannot result from its own
  request. Left alone because the honest fix — showing `a7f3k` — makes the page
  harder for a person to read, which is a documentation judgement rather than a
  correctness one. Starting point: `generateUniqueSlug` in `src/shared/slug.ts`.

## Deferred CodeRabbit suggestions from PR #1772 (servicing test relocation)

_Origin: CodeRabbit review of PR #1772, which only `git mv`s the servicing
db-module tests into `test/shared/db/attendees/servicing/` (plus a 4-line cwd
fix in `code-quality.test.ts`). CodeRabbit reviewed the moved content as if new
and raised 13 findings; every one is on **pre-existing** test code carried over
unchanged from `main`, so they were out of scope for a rename-only PR and
recorded here._

**Done — the two vacuous tests + the corruption-repair cleanups (a follow-up
PR).** Both suspects were confirmed and fixed:

- `corruption-repair.test.ts` — the `UPDATE … kind = 'staff'` did throw under
  the CHECK and was swallowed by `catch { return }`, so the exclusion assertions
  never ran (confirmed empirically). Now the corrupt row is written past the
  CHECK via `PRAGMA ignore_check_constraints` (libsql supports it), so the
  reader predicates are genuinely exercised — and a separate test asserts the
  CHECK rejects the write directly. The dead `queryOne` import, the
  `string | null` param on `insertRowWithKind`, and the redundant dynamic
  imports were removed.
- `lifecycle-concurrency.test.ts` (~87-110) — the raw SQL deletes were replaced
  with the production `deleteListing`, and the orphan assertion strengthened
  (attendee row survives; its booking on the deleted listing is gone).

**Done — assertion-strengthening in
`test/shared/db/attendees/servicing/ledger.test.ts` (a follow-up PR).** All
seven were applied: `expectCostFormError` now asserts an error flash and that no
leg of any kind was posted (total-transfer snapshot); idempotency keys are fixed
strings, not `crypto.randomUUID()`; the memo-only replay test asserts the error
flash; the `recordServiceCost` replay test asserts the exact
`COST_REPLAY_MISMATCH` message (via `expectRejects` now accepting an exact
string); the ordering test seeds a same-`occurredAt` pair to exercise the
`(occurred_at, transfer_id)` tie-break; the encrypted-memo test asserts the full
plaintext memo is absent; and the `visibleTransfers` filter test adds a second
listing and asserts the result is scoped to the requested listing.

**Done — split the file (a follow-up PR).** The 826-line `ledger.test.ts` was
split into five focused files under `test/shared/db/attendees/servicing/`
(`ledger-accounts`, `ledger-idempotency`, `ledger-cost-editing`,
`ledger-validation`, `ledger-reader`), each well under 400 lines. The shared
fixtures (`recordBoilerCost`, `postCustomerSale`, `listingProfitOf`,
`expectCostFormError`, `transfersOfKind`, `SERVICE_DATE`) moved to a new
`#test-utils/servicing-ledger.ts`, and the generic non-empty flash assertions
(`expectFlashError`/`expectFlashSuccess`) moved to `#test-utils/assertions.ts`
next to `parseFlashCookie`. A pure reorganisation — the same 40 tests run, no
test behaviour changed.

_Nothing remains open in this section._

## Logistics run sheet — should servicing events appear?

`getAttendeesByIds` (in `src/shared/db/attendees/queries.ts`) filters to
`kind: "attendee"` — the exact behaviour the pre-existing query had before the
attendee-read centralisation (PR #1790). Its only caller is the logistics run
sheet (`src/features/admin/deliveries.ts` → `loadLegLookups`), so servicing
events (`kind = "servicing"`) never show there.

A reviewer (CodeRabbit on #1790) suggested making the lookup kind-agnostic so
servicing rows with logistics agents would appear on the run sheet. That is a
product/behaviour change, not a refactor, so it was left out of #1790. If
servicing events are meant to carry delivery legs and appear on the run sheet,
drop the `kind` filter on that read (pass `kind: "attendee-or-servicing"`) and
add a run-sheet test that a servicing event with agents shows up. If they are
correctly excluded, no change is needed — this note just records that the
exclusion is deliberate, not accidental.

---

## Test suite speed — remaining tail work

_Origin: the test-suite performance PR (grouped isolates + run-scoped test
state)._

The full runner now shares isolates between test files
(`scripts/test-groups.ts`) and prebuilds the DB setup state once per run
(`test/test-utils/test-state.ts`). The remaining wall-clock tail is a handful of
genuinely long suites, which now bound the slowest groups:

- **Migration chain shards** (`test/integration/db/migration-restore/`, ~20s
  each ×4 shards). They already shard by `index % shardCount`; raising the shard
  count (4 → 8) would halve each shard and shorten the tail groups. Purely
  mechanical — the factory takes the count.
- **Slow-test report entries >2s** (printed after every full run): the
  migration/legacy-migration suites and a few e2e journeys dominate. Each one
  fixed shortens the longest group directly.

Starting point: run `deno task test`, read the slow-test report at the end, and
profile the top entry.

## Split the admin questions template test file

_Origin: review of PR #1796 (the `[object Object]` error-box fix). Flagged by
CodeRabbit while that PR hardened the questions template's mutation coverage._

`test/ui/templates/admin/questions.test.ts` is ~876 lines — over the ~400-line
target for test files (it was already ~795 before #1796 added the hardening
assertions; it stays under Biome's 1,000-line hard limit, so it is not
grandfathered and CI passes). Smaller, focused test files also let mutation runs
map `questions.tsx` to a narrower suite.

Split it into focused sibling suites sharing one fixtures helper, roughly:

- `questions-list.test.ts` — `adminQuestionsPage` (the reorderable list).
- `questions-detail.test.ts` — `adminQuestionPage` + `ListingQuestionsPanel`.
- `questions-answer.test.ts` — `adminAnswerEditPage` /
  `adminAnswerRecalculatePage`.
- `questions-delete.test.ts` — `adminQuestionDeletePage` /
  `adminAnswerDeletePage`.

Extract the shared fixtures (`colourQuestion`, `TEST_LISTINGS`, `TEST_SESSION`,
the answer/question factories) into a local helper the suites import, and keep
`questionTextFlat` + `buildAnswerSummaryRows` with whichever suite reads most
naturally. Preserve every existing assertion — behaviour must not change. The
attribute template test (`attributes.test.tsx`) is the shape to mirror.

## Pre-existing issues surfaced during the min-tokens-20 dedup (PR #1795)

CodeRabbit flagged these while reviewing the dedup PR. Each is a real point but
pre-existing (the dedup preserved the behaviour, it did not introduce it), so
they were left out of that PR's scope.

- **Bulk email draft cleared after the send, not before**
  (`src/features/admin/bulk-email.ts`, the
  `sendBulkEmails → recordContacts →
  bulkEmailDraft("") → logActivity`
  sequence). `sendBulkEmails` is non-idempotent, so if `recordContacts` throws
  after the send, a retry can resend to the whole audience. Moving the
  draft-clear before the send trades that for the opposite risk (a failed send
  loses the draft with no retry), so it needs a deliberate decision — likely a
  "draft consumed" marker distinct from "draft empty". Not a dedup regression:
  the ordering is byte-identical to before the PR.

- **Tautological admin-API example test**
  (`test/shared/admin-api-example.test.ts`:
  `toAdminListing output matches the
  documented example`).
  `ADMIN_API_EXAMPLE_ADMIN_LISTING` is defined as
  `toAdminListing(API_EXAMPLE_LISTING)` and the test compares
  `toAdminListing(API_EXAMPLE_LISTING)` against it — both sides derive from the
  same call, so the assertion cannot catch a `toAdminListing` shape regression.
  Fix: author an independent `AdminListing` fixture (or assert against an
  admin-listing schema). Pre-existing — the base had the same tautology via the
  now-removed `ADMIN_API_EXAMPLE_LISTING` alias.

- **Bulk-group-duplicate form loses inputs on a failed POST**
  (`src/ui/templates/admin/bulk-actions.tsx` `adminDuplicateGroupPage`). On a
  validation error the form re-renders with defaults (`${group.name} (copy)`,
  blank find/replace/date) instead of the submitted values. Pre-existing: the
  page's `values` param was already unused before this branch (this dedup only
  deleted the dead param), so the form has never re-filled on error. Fix: thread
  the submitted values back into the `TextField`/`TextFields` inputs, following
  the flash/form-refill pattern other admin forms use.

- **Attempt-lockout expired-row cleanup is not TOCTOU-safe**
  (`src/shared/db/attempt-lockout.ts` `lockoutActive`). The expired-row delete
  is unconditional, so a request that observes an expired lockout can delete a
  fresh lockout another request wrote in between, losing rate-limit state for
  that IP. Pre-existing: the two attempt tables (`login_attempts`,
  `token_attempts`) both deleted unconditionally before this branch merged them
  into one helper. Fix: make the delete conditional on the stored `locked_until`
  still equalling the observed value, in one atomic statement.

- **`deployAndReport` lets an activity-log failure mask a successful deploy**
  (`src/shared/site-update.ts`). Only the deploy runs inside `tryStep`; the
  `logActivity` write after it is not, so a transient log-write failure throws
  out of `deployAndReport` as a raw 500 even though the deploy succeeded (before
  this dedup each route's own try/catch returned its normal error page). The
  right fix is to make the activity-log write best-effort — a successful deploy
  should return success even if the log line can't be written — with a
  regression test that stubs `logActivity` to reject. Introduced by folding the
  two update routes onto the shared helper.

- **Update success/log copy is hardcoded, not in the catalog**
  (`src/shared/site-update.ts` `deployAndReport`, fed by
  `src/features/admin/update.ts` and `built-sites.ts`). The success flash
  (`"${successPrefix} to ${name} — the new version will be active shortly"`) and
  the activity-log line (`"${logPrefix} to ${name} (${tag})"`) are built from
  hardcoded `successPrefix`/`logPrefix`/tail strings rather than `t()` keys.
  This copy is byte-identical to what lived in `update.ts` on `main` before the
  dedup (the flash string
  `"Updated to … — the new version will be active shortly"` was already there);
  the dedup only moved it into the shared helper. Fix: add ICU keys with
  `{name}`/`{version}` placeholders and pass the two call sites' prefix choices
  as keyed variants, so the flash and log line read from the catalog. Out of
  scope for a dedup PR (pre-existing copy, not a new string).

- **Admin API docs prose is hardcoded, not in the catalog**
  (`src/ui/templates/admin/api-keys.tsx` — the authentication intro
  `"Admin API endpoints require authentication…"`, the
  `"Public API endpoints
  require no authentication. All responses are JSON."`
  line, the admin-group intro
  `"Requires <code>Authorization: Bearer YOUR_API_KEY</code> header."`, and the
  `"Use it with: <code>…</code>"` copy-notice line). These are all present
  unchanged on `main` — the dedup restructured the page onto `DocsSection`/
  `sectionsRenderer` but did not touch the wording. Developer-facing API-doc
  copy may keep literal technical terms, but the surrounding prose still belongs
  in `src/locales/en/*.json` (the sibling `api_keys.public_api_note` already is
  a catalog key). Fix: add `api_keys.*` keys for the four strings, rendering the
  `<code>`-bearing ones via `Raw`. Out of scope for a dedup PR (pre-existing
  copy).

- **The `/api/*/book` docs show a free response for a priced sample**
  (`src/shared/admin-api-example.ts`). Both `POST /api/listings/:slug/book` and
  `POST /api/packages/:slug/book` document their response as
  `API_BOOK_FREE_EXAMPLE_JSON` (`amountOwed: 0`, a ticket token), even though
  the package sample request is a priced bundle whose real response would carry
  a `checkoutUrl` (`API_BOOK_PAID_EXAMPLE_JSON` already exists). Pre-existing:
  on `main` both endpoints used a local `API_EXAMPLE_BOOKING_RESPONSE` const
  that is byte-identical to `API_BOOK_FREE_EXAMPLE_JSON`, and this dedup only
  merged that duplicate into the shared constant — it did not change which
  example shows. Fix (a doc-accuracy pass, not a dedup): pick the example per
  endpoint — a paid response for the priced package bundle, or document both
  free and paid shapes — so the sample response matches the sample request.

## Placeholder refund — replay marker gap when the atomic ledger batch fails

_Origin: Codex review on PR #1822 (atomic placeholder payment + refund ledger)._

`recordPlaceholderRefund` (`src/shared/refund-ledger.ts`) posts the payment and
completed-refund legs as one atomic `postTransferGroups` batch, so a refund-leg
conflict rolls the payment back too (the PR's core requirement). When that batch
fails outright, NO ledger legs land for the booking event group. The payment
flow's durable replay guard is the ledger preflight (`replaySessionFromLedger` →
`bookingLedgerDisposition`: `unrecorded` when no legs exist), and the primary
guard (`markSessionFailed`'s `failure_data` row) is pruned by `prunePayments`
once it ages past retention. So after pruning, a late webhook/redirect for the
same already-refunded session re-enters `processReservedSession`, sees
`unrecorded`, and re-creates a placeholder attendee + re-calls `tryRefund`
(idempotent, so no double payout) instead of acknowledging the session as
already handled.

This is NOT fully new: on main before PR #1822 the same gap existed for a
payment-post failure (the first `postTransfers` threw → no legs). PR #1822
widens the failure surface from "payment-post failure only" to "payment-post OR
refund-post failure" (because both are now one atomic batch). Closing it
properly needs a durable handled marker that survives idempotency-row pruning
without breaking the atomic rollback — e.g. a ledger leg that survives even when
the refund leg conflicts (which would violate #1822's acceptance criterion: "a
refund-reference collision proves neither transfer group is committed"), or a
separate replay-state row outside the prunable `processed_payments` table. The
staged-checkout runtime (deferred foundations item 6 in `PR_SPLIT_PLAN.md`)
carries the proper replay/activation machinery to resolve this. Starting point:
the preflight in `src/features/api/payment-processing/index.ts`
(`replaySessionFromLedger`), the pruner in `src/shared/db/prune.ts`
(`prunePayments`), and the classification in `src/shared/session-ledger.ts`.

Build this through the unified payment aggregate described below, not through
another replay marker beside `processed_payments` and the ledger.

## Stripe webhook setup hardening — deferred edges (from PR #1827)

_Origin: CodeRabbit and Codex review of PR #1827 (the same-URL cleanup + atomic
credentials + shared URL helper PR). The create-first refactor and
endpoint-limit fallback were applied in that PR; the one edge below was judged
out of scope and recorded here._

`setupWebhookEndpointImpl` in `src/shared/stripe.ts` creates the new endpoint
only — old same-URL endpoints are deleted by a separate
`cleanupOldWebhookEndpoints` call that the settings route invokes AFTER
`settings.update.stripe.webhookConfig` saves the new endpoint ID + secret to the
DB. This ordering ensures a DB-save failure leaves the old endpoint (whose
secret matches the DB) in place. If Stripe rejects the create because the
account is at its webhook-endpoint cap, setup deletes same-URL strays (keeping
the recorded endpoint intact) and retries the create. One edge remains:

- **Same-URL stray listing doesn't paginate.** `fetchWebhookEndpoints` calls
  `client.webhookEndpoints.list({ limit: 100 })` once and returns `.data`
  without following Stripe's `has_more` cursor. A site that has accumulated more
  than 100 webhook endpoints (rare — would require many failed setups or a
  long-running test environment) would leave strays beyond the first page
  un-deleted. Impact is limited: the new endpoint is already live and the DB
  points at it, so leftover strays are duplicate-delivery-only, not a
  signing-secret mismatch. Fix direction: follow the `has_more`/cursor loop in
  `fetchWebhookEndpoints` so the same-URL filter sees every endpoint. Starting
  point: `src/shared/stripe.ts` (`fetchWebhookEndpoints` and
  `listSameUrlEndpointIds`).

---

## Bunny subrequest budget follow-ups

_Origin: request-fan-out audit for PR #1820._

Bunny stops an edge request after 50 subrequests. PR #1820 adds a request-scoped
database guard that blocks libsql call 51 and fixes the concrete failures found
in fresh setup, group duplication, ordinary backups, reset/restore, and bulk
refunds. The paths below still have data-dependent fan-out. The guard makes the
database-only cases fail loudly, but it cannot count provider or storage calls.

- **Package carts and payment completion.** `resolveCartSlugs` and
  `handleCartBySlugs` in `src/features/public/cart.ts` do four package reads per
  slug, so 13 packages can make 52 calls. `loadPackagePricingByGroup` in
  `src/features/api/payment-processing/package-pricing.ts` does three reads per
  group, so 17 groups can make 51. `getPackageDisplaysByIds` in
  `src/shared/db/groups.ts` also reads displays one group at a time. Batch group
  resolution, member/day prices, and displays for all package ids.
- **Registration logs and outgoing webhooks.** `logAndNotifyRegistration` and
  `sendRegistrationWebhooks` in `src/shared/webhook.ts` can insert one activity
  row per booking, load two overrides per package, and fetch every distinct
  webhook URL. Add one bulk log insert and one batched override read. Persist
  outbound webhook jobs for bounded out-of-band delivery.
- **Multi-entry check-in.** `handleCheckinPost` in `src/features/checkin.ts`
  calls `updateCheckedIn` once per eligible booking line. A token set with 51
  lines therefore makes 51 updates. Replace it with one set-based update over
  all attendee/listing pairs.
- **Order availability by duration.** `poolBySpan`, `remainingBySpan`, and
  `groupRemainingBySpan` in `src/features/public/order.ts` run six capacity
  reads per distinct duration/group combination; nine distinct durations can
  make 54 calls. Load one capacity snapshot for the widest span and derive each
  duration in memory.
- **Automatic built-site assignment.** `assignSitesForEntries` and
  `assignSiteWithRenewal` in `src/shared/site-assignment.ts` mix per-unit DB
  writes with provider calls. Eleven Deno site units, or nine Bunny site units,
  can exceed 50. Reserve assignments in one batch, queue provider provisioning,
  and batch-persist the successful renewal states.
- **Old database migration.** `runPendingMigrations` in
  `src/shared/db/migrations.ts` uses at least two marker calls per migration; 25
  pending migrations exceed the limit before their own work.
  `applySchemaChanges` in `src/shared/db/migrations/schema-sync.ts` also runs
  each missing-column ALTER separately. Move long migrations out of band or make
  progress resumable in bounded request-sized steps, and batch safe ALTERs.
- **Large in-app backups and storage cleanup.** After the first-page batch,
  `exportTable` in `src/shared/db/backup-snapshot.ts` still needs one call per
  later page; a 25,000-row table at the default page size needs about 50 pages
  by itself. `cleanupStalePendingFiles` in `src/features/admin/backup.ts` and
  `pruneOldBackups` make one storage delete per stale object. Send large backups
  through the existing out-of-band workflow and cap cleanup work per request.
- **Bulk email.** `sendBulkEmails` in `src/shared/email.ts` can create more than
  50 provider batches for very large audiences. Queue bulk sends out of band or
  stop at a fixed aggregate request budget and resume the remainder later.
- **Attendee CSV export.** `allAttendeeBookings` in
  `src/features/admin/attendees-list.ts` reads 100 attendees per page; 5,001
  matches need 51 calls. Generate large exports out of band and give the
  synchronous route a strict cap.
- **Admin seed generation.** `createSeeds` in `src/shared/seeds.ts` uses one
  attendee batch per 50 rows; 2,501 attendees exceed 50 calls, while the form
  permits far more. Move seed generation to CLI/background work or cap the total
  from the request budget.
- **Remaining group admin reads.** `validateListingTypesForGroup` in
  `src/features/admin/groups.ts` reloads siblings per listing, and
  `loadGroupContext` in `src/features/admin/listings-view.ts` loads each group
  and capacity separately. Load siblings once and batch all group/capacity rows.

The `scripts/backup.ts` command and fleet loops in GitHub Actions run outside
Bunny and are not subject to this per-request limit. Restore replay and catalog
import already use bounded batches.

---

## Resumable paid-booking completion

_Origin: CodeRabbit review of PR #1833._

The attendee, booking rows, ledger, modifier use, contact activity, and payment
finalization commit atomically, but `completePaidBooking` then saves answers,
logs promo-code use, and calls `logAndNotifyRegistration` after that commit. If
one of those effects fails, `processed_payments.attendee_id` already marks the
session as finished. A later webhook or redirect therefore replays success
without retrying the unfinished work. This gap predates PR #1833, but that PR
made the boundary easier to see. It deliberately excludes schema changes, so a
durable completion system is outside that atomic-write-only change.

Build one resumable completion mechanism rather than retrying these calls ad
hoc. Store the completion input and per-effect state against the payment session
in the same transaction that finalizes the booking. Claim unfinished effects
with a stale lease so racing webhook and redirect requests cannot both run them.
Make each database effect and its completed marker one transaction. Give
external deliveries a stable idempotency key where the provider supports one,
and do not prune payment rows with unfinished work. Fresh completion,
lost-result recovery, processed-payment replay, and ledger replay must all call
the same resume function.

Starting points: `src/features/api/payment-processing/completion.ts`,
`src/features/api/payment-processing/index.ts`,
`src/shared/db/payment-finalize.ts`, `src/shared/db/processed-payments.ts`,
`src/shared/db/prune.ts`, `src/shared/webhook.ts`, `src/shared/email.ts`, and
`src/shared/site-assignment.ts`. Tests must interrupt each effect, retry through
both webhook and redirect paths, and prove answers, activity, messages, site
assignments, and renewal time are neither lost nor duplicated.

Store this completion progress on the unified payment aggregate described below.
Do not add a second completion queue with a different lease or replay rule.

---

## Consistent database backup snapshots

_Origin: CodeRabbit review of PR #1836._

`createBackup` batches each table's first page, then `exportTable` reads later
pages with standalone queries. A write during those reads can make a backup mix
rows from different database states. PR #1836 only moves the existing exporter
into `src/shared/db/backup-snapshot.ts`; it deliberately preserves the current
queries, replica routing, pagination, and round-trip behavior.

Add a dedicated read-only transaction or snapshot API in
`src/shared/db/client.ts`. Do not reuse `withTransaction`: that helper opens a
primary-routed write transaction, serializes writers, and enforces a write
round-trip limit. Keep the first-page multi-table read efficient, account for
the edge subrequest budget, and use the same snapshot for every later page. Add
a regression test in `test/shared/db/backup-snapshot.test.ts` that changes rows
between page reads and proves the exported rows all come from one database
state.

---

## Backup storage edge cases

_Origin: CodeRabbit review of PR #1837._

PR #1837 only moves the existing backup storage helpers out of
`src/shared/db/backup.ts`; it deliberately preserves their behavior. These
possible behavior changes need separate decisions and regression tests:

- **Keep every database namespace non-empty and distinct.** `dbName` in
  `src/shared/db/backup-storage.ts` returns an empty name for a parseable local
  `file:` URL and strips the first dashed part from non-Bunny hostnames. Decide
  the supported URL schemes and hostnames, return a named local folder for local
  URLs, and only remove Bunny DB's UUID prefix for `.lite.bunnydb.net`. Start
  with tests for `file:database.db` and two distinct dashed HTTPS hostnames.
- **Reject future-dated backups from the update gate.** `hasRecentBackup` in
  `src/shared/db/backup-storage.ts` treats every future timestamp as recent
  because its age is negative. Decide how much clock skew is acceptable, then
  require a non-negative age (or a documented tolerance) before applying the
  maximum age. Add a test with a future backup filename.

---

## Checkout stage attendee cleanup

_Origin: Codex review of PR #1840._

Before any runtime path writes `checkout_stages`, include those rows in attendee
deletion, purge, and merge handling. The table has no foreign key, so leaving
the current hard-coded dependent-table lists unchanged would keep a stage linked
to an attendee that no longer exists. Start with
`src/shared/db/attendees/delete.ts` and `src/shared/merge/attendee-merge.ts`.
Add direct regressions proving deletion removes a stage and merging repoints it
without losing the unique attendee invariant. If both attendees have stages,
require an explicit conflict decision instead of silently choosing or deleting
one.

The payment-schema review below found that `checkout_stages` should not become a
second payment runtime. Prefer replacing it with the unified payment aggregate
and dropping it in a new migration. Keep this cleanup requirement only while the
table exists.

---

## Test improvements surfaced by PR #1873 (move-only)

_Origin: CodeRabbit review of PR #1873 — "Move eight integration tests to
test/integration/". PR #1873 was a move-only refactor: files were relocated with
`git mv` and only relative import paths were updated. The four findings below
are about pre-existing test code that was already on `origin/main` before the
move; they are recorded here so a future PR can pick them up without re-reading
the review. Each item names the file/path, what CodeRabbit proposed, why it was
out of scope for #1873, and a starting point._

- **Reuse shared `#test-utils` KEK helpers in `test/integration/kek-v2.test.ts`
  (lines 46–92).** `unwrapUserKey` and `ownerDataKey` repeat admin unwrap logic
  that may already live in
  `test/test-utils/{crypto.ts,session.ts,test-state.ts}`. A future PR should
  check whether a shared helper for "unwrap a v2 user's DATA_KEY with the
  per-user-salted password KEK" and "unwrap the shared owner DATA_KEY" already
  exists or should be extracted, then fold this file's local copies into it.
  Keep `seedV1User` local (it constructs a legacy-only fixture) and leave
  `sharesOwnerDataKey` as the spec-specific check. Start by searching
  `test/test-utils/` for `deriveKEKFromPassword`, `unwrapKey`, and
  `getUserByUsername` to see what is already shared.

- **Assert the required `LATEST_DB_UPDATE_KEY` row directly in
  `test/integration/migration-round-trip-budget.test.ts` (line 134).** The test
  uses `marker.rows[0]?.value` with optional chaining, so a missing marker row
  would fail with an unhelpful `undefined !== LATEST_UPDATE` rather than naming
  the missing row. A future PR should replace it with
  `expect(marker.rows.map(({ value }) => String(value))).toEqual([LATEST_UPDATE])`
  (or an equivalent that names the missing row) so the assertion fails loudly
  when the row is absent. This aligns with the offensive-programming rule
  against `?.` papering over a value that should always exist.

- **Assert the computed cutoff in `test/integration/renewals.test.ts` (lines
  187–192).** The test is titled "pushReadOnlyFrom is called exactly once with
  computed cutoff" but only checks the call count via
  `expectReadOnlyFromPush(secretStub)`, discarding the returned
  `{ scriptId, secretValue }`. If the cutoff month math regresses, the test
  would still pass despite its name. A future PR should capture `secretValue`
  from `expectReadOnlyFromPush` and assert it equals `addMonthsIso(baseDate, 2)`
  (the expected quantity-2 cutoff) while keeping the exactly-once assertion.
  `baseDate` is already destructured from `withRenewalTest` in neighbouring
  tests.

- **Assert the error log in `test/integration/renewals.test.ts` (lines
  204–210).** The test is titled "siteToken present but no matching site logs
  error, no Bunny call" but only asserts `expectNoBunnyCall(secretStub)` — the
  "logs error" half of the title is unverified. A future PR should add a
  `console.error` assertion using the existing error-spy helper (search `test/`
  for `spy(console, "error"` or an `errorSpy` helper) so the test verifies the
  error is emitted for the missing site-token match, or rename the test to drop
  the unverified claim. Start by reading `applyRenewalsForEntries` in
  `src/shared/webhook.ts` to confirm it calls `console.error` (or `logError`) on
  a missing site-token match.

- **Extract scanning helpers from `test/integration/code-quality.test.ts` into a
  focused module.** CodeRabbit suggested (PR #1872 review) pulling
  `forEachScannedFile`, `collectLineViolations`, `collectFileViolations`,
  `scanSourceLines`, `scanSourceFiles`, `ensureLoaded`, the `getAll*Files`
  helpers, `repoRelative`/`getRelativePath`/`isCodeQualityFile`, and the
  `SRC_DIR`/`TEST_DIR`/`SCRIPTS_DIR`/`CLI_DIR`/`E2E_PAYMENTS_DIR`/`REPO_ROOT`
  path constants out of the test file — they're file-discovery and scanning
  plumbing, not test assertions. The file is currently 699 lines (under the
  Biome 1,000-line hard ceiling but over the 400-line soft target). A
  `test/scripts/code-quality/scan-context.ts` module exporting `ScanContext`,
  `loadScanContext`, `collectLineViolations`, `collectFileViolations`, and the
  path constants would let the test file import them and keep only the
  assertions and per-rule config. Start from the file-discovery helpers already
  at the top of `code-quality.test.ts` (lines 295–360) and the
  `ensureLoaded`/`forEachScannedFile`/`collect*Violations`/`scanSource*` helpers
  inside the `describe("code quality", …)` block (lines 360–540). This is a
  structural refactor (no behavior change); add a regression test that re-runs
  the no-`../` rule against a fixture file via the extracted helpers to prove
  parity with the inline implementation.

---

## Admin debug test coverage follow-ups

_Origin: CodeRabbit review of PR #1875 ("Move admin debug tests and add a
template rendering test"). PR #1875 is test-only: it `git mv`s
`test/lib/server-debug*.test.ts` into `test/features/admin/debug/`, extracts
shared state into `test/test-utils/debug.ts`, and adds a direct-rendering test.
CodeRabbit raised two findings that are valid as code-quality observations but
out of scope for that PR's brief — recorded here for a follow-up._

- **Inspect the Sentry test envelope, not only the request count.** In
  `test/features/admin/debug/sentry.test.ts` (around lines 63-68), the "sends a
  tagged test error and confirms delivery" test stubs `fetch` with the shared
  `stubFetch` helper and asserts only that one request was made. It does not
  prove the emitted event is tagged or carries the intended test-error message.
  Replace the shared stub with a local fetch recorder inside that test, then
  assert the captured Sentry envelope body contains the literal message
  `"Test Sentry notification from the admin debug page."` and the
  `source=admin-debug` / `test=true` tags (the literal values
  `src/shared/sentry.ts` `sendSentryTest` writes today — keep them in sync with
  that source when the follow-up lands). Retain the existing request-count,
  redirect, and flash assertions. Starting point: read `sendSentryTest` in
  `src/shared/sentry.ts` (lines ~74-101) to confirm the exact envelope values,
  then look at `test/test-utils/fetch-stub.ts` to see what the shared stub
  exposes today.
- **Assert semantic debug sections, not CSS-class counts.** In
  `test/ui/templates/admin/debug/rendering.test.tsx` (around lines 38-40), the
  "keeps the debug navigation and section structure" test asserts the page
  contains exactly 3 `class="prose"` and 13 `class="table-scroll"` occurrences.
  Those counts couple the test to presentation wrappers, so a layout change can
  fail it without changing page behaviour. PR #1875 carried these counts in
  because the brief explicitly asked for them as the current-main contract; a
  follow-up can replace them with assertions on the rendered section headings.
  Keep the `href="/admin/debug"` link assertion. Maintain the expected heading
  set as an explicit literal list inside the test (`t("debug.section.build")`,
  `t("debug.section.runtime")`, etc.) — do **not** derive it from
  `DEBUG_SECTIONS` in `src/ui/templates/admin/debug.tsx`: deriving the oracle
  from the same source list the template renders against lets a removed or
  renamed section pass undetected when both the rendering and the oracle shift
  in lockstep. An independent literal list makes a section
  addition/removal/rename a deliberate test review, which is the only way the
  test catches the failure mode it is meant to catch.

---

## Recover paid SumUp checkouts without a webhook or redirect

_Origin: follow-up to the SumUp provider work, surfaced 2026-07-25 while
documenting SumUp in `README.md` / `src/docs/payments.ts` (PR #1918)._

SumUp does not sign its webhooks. If its webhook is lost and the customer never
returns to the redirect URL, SumUp can charge the customer without creating a
booking or payment record. Only the staged checkout remains, and database
pruning removes it after 24 hours.

Add a bounded maintenance task to `src/shared/maintenance/registry.ts` that
checks a page of staged SumUp checkouts on each run. Fetch each checkout once.
When SumUp reports it as `PAID`, pass the fetched session through the same
classification and `processPaymentSession` path used by webhooks and redirects.
Extract a shared entry point that accepts an already fetched session so the task
does not make a second provider request. Keep each run within the edge request
budget and request a follow-up run when a full page remains. Add a regression
test that runs webhook, redirect, and maintenance attempts concurrently and
proves they create the attendee and ledger rows exactly once.

Build this as one reconciler over the unified payment lifecycle described below.
The webhook, redirect, and maintenance task must feed the same normalized
provider observation into the same state transition.

---

## Square PENDING refunds — propagate a pending result, not a plain false
## Stale equivalent-mutant line numbers across recent refactors

_Origin: running `deno task mutation:audit-equivalents` while hardening
`src/shared/square.ts` for the confirmed-Square-refunds job._

`scripts/mutation/equivalent-mutants.txt` carries several entries whose
`file:line:col` no longer points at a generated mutant, so
`deno task mutation:audit-equivalents` aborts with "No generated mutant
matches". The mutants are still real and equivalent; only the code moved.
Confirmed stale entries span at least:

- `src/shared/uptime-kuma/socket.ts` (lines 107, 130, 167, 187 —
  `===`/`!==`↔loose)
- `src/shared/uptime-kuma/monitors.ts` (lines 87, 101, 116, 119, 138, 193, 227,
  250, 306, 325 — `===`/`!==`↔loose and `1000→1001`)
- `src/shared/scheduled-access.ts:16:20 ??→||`
- `src/shared/storage.ts:376:18 application/octet-stream→""`
- `src/ui/templates/admin/images.tsx:84:28` and `:85:20 ??→||`
- `src/features/app/routes.ts:235:14 →"mutated"`

These most likely drifted when the Uptime Kuma modules were split into
one-concept-per-file (#1906) and other recent move/refactor PRs. The audit is a
standalone task (`mutation:audit-equivalents`, not part of
`deno task
precommit`), so CI doesn't gate on it; it surfaced here only because
the Square-refunds job ran exhaustive mutation and used the audit to validate
its own equivalent entries. The `square.ts` entries in the equivalent-mutants
registry have been refreshed in place (they drift as the source shifts lines —
the audit command's own output lists every stale `file:line:col`);

Fix: for each stale entry, re-run
`deno task mutation <file> '<tests>'
--exhaustive`, locate the surviving
equivalent mutant's current `file:line:col` from the report, and update the
line/col in `equivalent-mutants.txt` (or remove the entry if the static gates
now kill it — `mutation:audit-equivalents --write` does this automatically for
entries the lint/type-check gates catch). Then re-run the audit until it reports
no stale entries. Starting point: the audit's own output lists every stale
`file:line:col`.

---

## Replace the lossy payment-session shape with one payment aggregate

_Origin: Codex review of PR #1911 plus the final standards review and payment
schema investigation for PR #1905._

`ValidatedPaymentSession` in `src/shared/payments.ts` compresses a provider
checkout, all money collected for it, and all refund activity into one session
id, one amount, one `paymentReference`, and one payment status. The provider
interface then reduces refunds to booleans and callback decisions to a session,
`"retry"`, `"skip"`, or `null`. That shape cannot say which resource failed,
represent more than one charge, retain a pending refund id, distinguish a
partial refund from a full one, or carry a permanent conflict to the HTTP and
persistence layers. Provider adapters consequently make business decisions that
should be shared, and malformed or ambiguous states get defaulted, logged,
retried, or acknowledged in different ways.

Define the payment domain from Valibot schemas before changing more provider
branches:

- `Money`: a safe non-negative integer in minor units plus an uppercase
  currency.
- Provider session, charge, and refund resources: discriminated by provider and
  resource kind, with a required non-empty id. A Stripe checkout session, Square
  order/payment, and SumUp checkout/transaction must not be interchangeable
  strings.
- `ChargeLeg`: one independently refundable provider charge with captured money,
  confirmed refunded money, and its provider refund observations. A payment has
  an array of charge legs; one charge is an array of one.
- `PaymentObservation`: the provider session identity, account/mode, expected
  money, signed/staged ownership proof, parsed booking intent, creation time,
  and all charge legs.
- `ProviderRead`: `found`, `missing`, `unavailable`, or `invalid`, carrying the
  exact provider resource and a typed reason.
- `PaymentResolution`: `ready`, `pending`, `fully_refunded`, `retry`,
  `conflict`, or `ignore`. Remove the string sentinels and nullable
  fall-throughs.
- `RefundResolution`: `completed`, `pending`, `partial`, or `failed`, carrying
  validated money and the provider refund id when one exists. Remove
  `refundPayment` / `isPaymentRefunded` booleans and route automatic, single,
  bulk, and refresh refunds through this one result.

Provider adapters should validate and report facts only. One pure resolver
should enforce the shared rules and choose `PaymentResolution`; an exhaustive
record should map each resolution to persistence and HTTP behavior. Require:

- Every returned resource id and parent id matches the resource requested.
- Every session, charge, and refund uses the same currency.
- Captured and refunded amounts are safe, and every supported paid charge is
  positive. A generic provider `Money` may be zero, but a paid booking charge
  may not.
- The sum of captured charge legs equals both the provider order total and the
  signed checkout total. Preserve every leg even when current hosted checkout
  flows normally create one; more than one completed leg is a typed conflict
  until an operator decides how to handle it.
- Confirmed refunds never exceed their charge. A status string alone is not
  proof of a full refund, and a pending refund keeps its id for later polling.
- A successful HTTP response missing its documented resource, or carrying a
  mismatched id, is invalid provider data. Only transport/provider availability
  failures are retryable.
- An absent Square metadata object may identify a foreign order, but every value
  in a present metadata object must be text. Do not silently drop null values.
- SumUp webhooks require non-empty text `event_type` and `id`; checkout and
  transaction responses require runtime schemas instead of SDK assertions.

Provider-specific reads must still collect the facts each shared schema needs.
Square must keep a `PENDING` refund id and retrieve that refund until it is
`COMPLETED`, `REJECTED`, or `FAILED`; `refunded_money` alone is not a terminal
status. SumUp must fetch and validate the original and total refunded amounts;
its `REFUNDED` status means full or partial. Stripe must retain refund amount,
currency, parent charge/payment intent, and status instead of reducing the
response to an id and boolean. During the migration, make the existing Square
resolver return before `hasTerminalPaymentOutcome` when the observed refunded
amount is zero, so ordinary paid callbacks do not spend an unnecessary primary
database round trip.

This directly fixes the malformed SumUp webhook, SumUp partial-refund claim,
Square missing/mismatched resource responses, nullable metadata values,
zero-value payment contradiction, first-completed-tender fallback, pending
refund loss, and empty payment reference. It also makes provider identity part
of every stored charge, so old references are never sent to whichever provider
happens to be active now.

Split the code along the schema while doing this. Put payment schemas, pure
classification, and persistence in focused `payment-state/` and `db/payments/`
modules. Split `src/shared/square.ts` (959 lines) into transport, schemas,
checkout, refunds, connection, and webhook modules. Move metadata codecs and
session validation out of `src/shared/payment-helpers.ts` (778 lines). Derive
Square and SumUp domain types from their schemas, remove the unused export on
`FindCompletedPaymentResult`, and delete replaced aliases and compatibility
surfaces. Keep providers lazy-loaded and preserve the cold-start budget.

Tests need table-driven examples for every provider state and pure cross-field
invariant, including mismatched ids/currencies, unsafe and zero paid amounts,
two completed Square payments, valid-plus-invalid tenders, partial/full/pending
refunds, and a paid session with no refundable charge. Mutation-test the schema
checks and exhaustive resolver. This is a technical contract refactor; the
operator conflict flow below needs the acceptance stories.

---

## Split oversized test files moved by PR #1903

_Origin: Codex review of PR #1903 ("Load heavy modules only when needed"). That
PR is a cold-start import reduction; as a side effect it relocated several test
files via `git mv` to mirror their source module paths (the mutation gate
requires mirror-located direct tests). Two of the moved files are over the
~400-line target in AGENTS.md:_

- **`test/features/admin/auth.test.ts` (651 lines).** Was
  `test/lib/server-auth.test.ts` (658 lines on `main`) — the move did not grow
  it. Covers login, logout, sessions, roles, invalid credentials, CSRF, and
  `wrappedDataKey` edge cases. A future PR should split it into focused files by
  concern (e.g. `login.test.ts`, `logout.test.ts`, `sessions.test.ts`,
  `roles.test.ts`) under `test/features/admin/auth/`, mirroring the
  `test/features/admin/users/` folder pattern already in place. Run
  `deno task test:files test/features/admin/auth/*.ts` after the split to
  confirm coverage stays at 100%.

- **`test/ui/templates/checkin.test.ts` (533 lines).** Was
  `test/lib/server-checkin.test.ts` (499 lines on `main`) — the move grew it
  slightly via the row-scoped assertion rewrite in `64475d4f`. Covers GET/POST
  `/checkin/:tokens` rendering, column visibility, check-in/out flows,
  refunded-attendee blocking, shared-token behaviour, and route matching. A
  future PR should split it by concern (e.g. `checkin/rendering.test.ts`,
  `checkin/flows.test.ts`, `checkin/routes.test.ts`) under
  `test/ui/templates/checkin/`. Keep the `rowFor` helper in a shared helper file
  (or move it to `#test-utils` if a second caller appears) rather than
  duplicating it across the split files.

Both files are well under the Biome hard 1,000-line ceiling
(`noExcessiveLinesPerFile`), so neither is in the `biome.json` override list.
Splitting them now was deliberately deferred because doing it inside the
cold-start PR would balloon the diff with unrelated mechanical test moves and
re-conflict with the import-only changes that are the actual subject of the PR.
The ~400-line target is guidance, and the cold-start PR's brief was explicitly
about import-graph narrowing, not test reorganisation.

## Mutation coverage of `src/features/api/folded-booking.ts` (direct tests)

Direct tests at `test/features/api/folded-booking.test.ts` and
`test/features/api/folded-booking/parent-booking.test.ts` kill every non-equivalent mutant on the unchanged `folded-booking.ts`.
Five equivalents (lines 87, 118, 176, 301, 381) are recorded in
`scripts/mutation/equivalent-mutants/` with proofs — no unsuppressed survivors remain.
`test/features/api/folded-booking/parent-booking.test.ts` kill every
non-equivalent mutant on the unchanged `folded-booking.ts`. Five equivalents
(lines 84, 115, 173, 297, 377) are recorded in
`scripts/mutation/equivalent-mutants.txt` with proofs — no unsuppressed
survivors remain.

---

## Make the payment aggregate the durable payment runtime

_Origin: CodeRabbit and the final standards review/payment-schema investigation
for PR #1905. This combines the old SumUp refund, Square conflict, and callback
retry entries instead of adding three parallel state systems._

Persist the schema-first aggregate above as one authoritative payment lifecycle:

- `payment_sessions`: one local payment id created before provider IO, provider
  and account/mode, provider session resource, expected money, encrypted
  canonical booking intent, fulfilment state, attendee/result, lease, and
  completion progress.
- `payment_charges`: one row per refundable charge leg, with its provider,
  encrypted reference, blind index, captured money, confirmed refunded money,
  refund state, pending refund id/idempotency key, and last observation time.
- `payment_cases`: retrying, needs-action, and resolved issues keyed by the
  payment/resource/reason, with first/last attempt, consecutive count,
  `alerted_at`, encrypted evidence, required operator decision, actor, revision,
  and resolution time.

These tables are parts of one aggregate, not independent workflows. Do not put
callback retries into `processed_payments`: its null/empty state encoding,
five-minute stale cleanup, pruning, and one-row-per-session key conflict with
pre-session provider reads and long-lived operator work. Migrate its
reservation, terminal result, payment reference, refund marker, ticket handoff,
and resumable completion responsibilities into the aggregate, then remove the
old runtime surface. Do not activate `checkout_stages` as another queue. Keep
the ledger as the accounting source, but stop using it as a parallel
payment-replay machine for new sessions.

Before returning 503, persist a retry with its exact resource and reason. After
three consecutive observations of the same reason and at least 15 minutes,
atomically move it to `needs_action` and set `alerted_at`; a bounded scheduled
reconciler must do this even if the provider never delivers again. A changed
reason resets the consecutive count. A later successful provider observation
uses the same resolver and clears the issue without creating another booking,
charge, refund, or ledger leg.

Persist permanent conflicts before acknowledging them. This includes invalid
provider data for a proven local payment, partial refunds before fulfilment,
more than one completed charge, amount/currency disagreement, and a paid session
without a refundable charge. Add an owner-only Payments page. Its schema-driven
form must require a reason-specific choice with no default, reject a stale case
revision, and run the same reconciler rather than a second booking/refund path.
Choices may include completing a proven booking or refunding the remaining
money; never offer a generic dismiss action while the customer may be charged.

Persist a refund request and stable idempotency key before provider IO. A
pending response keeps the provider refund id and is polled; it is not posted as
a new request. Only authoritative cumulative refunded money equal to every
charge may mark the payment fully refunded and post the full ledger reversal.
For SumUp, fetch and validate original and total refunded amounts because
`REFUNDED` means full or partial. If the provider cannot prove the amount, open
a case instead of guessing. No provider network call may run inside a database
transaction.

Use token-fenced leases for webhook, redirect, and maintenance races. The same
reconciler must also recover paid SumUp checkouts with no callback, resume the
post-booking effects already listed under "Resumable paid-booking completion",
and close the placeholder-refund replay gap. Never prune pending, refunding,
needs-action, or unfinished-completion rows. Prune/redact only bounded terminal
history after retaining the indexes needed for replay and refund safety.

Legacy rows do not always say which provider/account owns a reference. Do not
assign the currently active provider by default. Preserve ambiguous references
in an operator repair queue and require an explicit assignment before provider
IO. Migration and restore tests must cover databases from before every affected
payment migration.

Direct tests must cover atomic upsert/claim, expired leases, concurrent webhook,
redirect, and maintenance attempts, reason changes, threshold timing, one alert,
pending-to-completed refunds, failed provider call followed by local recovery,
terminal replay with zero provider calls, encryption/index separation, pruning,
and every allowed/forbidden state transition. Add acceptance stories for retry
recovery and each required operator conflict choice through the real rendered
form.

## Give provider webhook tests one owner

_Origin: branch review of `split/authoritative-payment-callbacks`._

Stripe webhook refresh cases are duplicated between
`test/shared/stripe-provider.test.ts` and
`test/shared/stripe-provider/operations.test.ts`, leaving both files above 500
lines. Square webhook resolution remains in the 600-line
`test/shared/square-provider.test.ts` as well as the new
`test/shared/square-provider/webhook.test.ts`.
`test/features/api/webhooks/resolution.test.ts` is 426 lines and also owns five
success-redirect cases that belong in a focused redirect suite. Starting point:
move every provider webhook-resolution case into one dedicated webhook suite per
provider, move redirect behavior out of the generic webhook response suite,
delete parallel cases from the older suites, and split the remaining provider
tests by operation until each file is near or below 400 lines. Add a focused
SumUp webhook suite with its payload schema. Keep one shared fixture/helper
rather than adapting duplicate test paths.

## Strengthen payment provider call and error assertions

_Origin: branch review of `split/authoritative-payment-callbacks`._

`test/features/api/payment-processing/refunds.test.ts` claims `tryRefund("")`
does not call a provider, but it only checks the returned `false`. Removing the
early return still produces `false` when no provider is configured, so the test
would pass. Starting point: configure a provider with spies for both
`refundPayment` and `isPaymentRefunded`, call `tryRefund("")`, and assert the
exact false result plus zero calls to both methods. Remove or rename the older
integration case that fails before `tryRefund` is reached.

Apply the same rule to the other provider short circuits touched by this branch:
an unknown staged SumUp checkout must make zero SumUp API calls, a non-completed
Square webhook must make zero order/payment reads, and a Stripe live-session
refresh must make exactly one fetch. Where a money-path test inspects
`calls[0]`, assert the exact call count first so an accidental duplicate refund
or provider request cannot pass. Schema-failure tests should assert `ValiError`
and the relevant field/path instead of accepting any thrown exception.

## Split `render-selector.test.ts` by what each case actually checks

_Origin: Codex review on PR #1926 (test reorganisation)._

`test/integration/server/parents-gate/render-selector.test.ts` holds four cases
with three different subjects: one changes a setting and checks the effect, one
checks how the parent booking page renders its fields, and two only exercise the
test helper `selectOptionsFromHtml` (they assert it throws when the select is
missing, and that it ignores a non-select element of the same name). Whichever
source is mutation-tested, three quarters of the file is unrelated work.

Out of scope for #1926, which was file moves only — separating these needs edits
inside the tests. Starting point: move the two helper cases next to the helper
they test — it now lives at `test/test-utils/parents-gate/helpers.ts`, so they
belong in `test/test-utils/parents-gate/helpers.test.ts` — keep the rendering
case in the integration tree, and let the settings case sit with the other
settings behaviour.

## Let the misplaced-test list see past request helpers

_Origin: Codex reviews on PRs #1926 and #1929 (test reorganisation)._

The misplaced-test list only considers a test that resolves to exactly one
source. Start-up helpers (`describeWithEnv`, the env overlay) used to drag the
database, config and storage in as extra subjects, which pushed real findings
over that limit and hid them; those two helpers are now skipped.

The blanket version of that skip — ignoring all of `test/test-utils/` — is not
safe, and the numbers show why. It raises the list from 1 entry to 8, but at
least two of the new entries are wrong in a way that would damage the suite if
followed: `test/features/app/request/organic-maintenance.test.ts` and
`test/features/admin/built-sites/server.test.ts` drive real pages through
`session.ts` and import a database module only to check the result. Skipping
`session.ts` throws away the route they are actually about and leaves the
incidental database import as the sole subject, so the list recommends moving a
correctly placed HTTP suite into a database mirror.

The fix is in the report rather than the walk: a test that loads the app should
count as an integration test however it reaches it. Today `findMisplacedTests`
only checks for a direct `#routes` import, so reaching the app through a helper
is invisible to it. Make that check consider the whole walk (including helpers,
and route modules under `#routes/…`, not just the entry itself), and the blanket
skip becomes safe — worth roughly seven extra genuine findings.

Starting points: `findMisplacedTests` in `scripts/unit-tests-report-imports.ts`
(the `test.imports.includes(appEntry)` guard and the `subjects.length !== 1`
guard), and `SHARED_SETUP_FILES` in `scripts/test-subjects.ts`.

## Split the compact test reporter (from PR #1944 review)

Codex flagged `scripts/compact-test-reporter.ts` at 561 lines, above the ~400
target. It holds five separate jobs: reading the `deno test` arguments and
guessing how many tests will run, parsing TAP failure reports, drawing the
progress bar, printing the run summary, and running the child process.

The tests for it already sit in `test/scripts/compact-test-reporter/` as
`estimate`, `diagnostics`, `progress`, `reporter` and `summary`, so the source
can be split into a folder of the same names and each pair stays mirrored (which
is what the mutation gate wants). Out of scope for #1944, whose job was closing
the mutation gaps rather than moving the file around; the file scores 100% as it
stands, so the split can be a pure move.

---

## Two suites now cover the attendees list

*Origin: Codex review of PR #1993 (direct tests for the four testless modules).*

`test/features/admin/attendees-list.test.ts` was added because the mutation
gate needs a test at the source's mirrored path. It calls the handlers
directly. But `test/integration/server/attendees-list.test.ts` already drives
the same behaviour over HTTP — authentication, the listing filter, sort order
and paging — and `test/integration/server/attendees-csv.test.ts` covers the
export. So the same rules are now checked twice.

That costs runtime on every suite run, and lets the two sets of fixtures and
expectations drift apart. The fix is to consolidate: move the route-level cases
into the mirrored feature suite (which can call the handler directly *and* go
through the router where that is the point), and delete what is left behind.

Not done in #1993 because that change touches suites the PR otherwise had no
reason to open, and the mirrored suite had to exist first. Worth doing next
time either file is opened.

Starting point: the three files named above.
## Mutation gaps in `src/shared/crypto/encryption.ts`

_Origin: mutation run while speeding up owner-key encryption (PR #1945)._

`deno task mutation --source src/shared/crypto/encryption.ts --test
test/shared/crypto/encryption.test.ts`
reports **41 survivors out of 90**, a score of 54%. None came from that change;
they are gaps the run happened to surface. They fall into three groups.

**The binary file format** (`encryptBytes` / `decryptBytes`, the `ENCB` header —
roughly lines 254 to 301). Most of the survivors are here: the magic bytes, the
version byte, the header offsets, and both format errors can all be mutated
without a direct test noticing. These functions are only reached today through
integration tests (`test/features/images.test.ts`,
`test/integration/attachment-route.test.ts`,
`test/ui/templates/admin/settings/header-image.test.ts`), which the direct-test
run does not include. They want unit tests in `test/shared/crypto/` covering the
header layout byte by byte, a wrong magic, and a wrong version.

**Key caching and change notification** (lines 65 to 136): clearing the two
resolved-key caches and running the registered change callbacks can be removed
without a test failing. A test that changes the key and then checks the _next_
encryption uses the new one would close this.

**The key import flag** (line 119): `false` → `true` on the `extractable`
argument of `crypto.subtle.importKey`. No behaviour can tell these apart,
because the key is never exported — a genuine equivalent mutant. Either record
it in `scripts/mutation/equivalent-mutants.txt` with that reasoning, or find an
assertion on the imported key itself. `importRsaKey` in
`src/shared/crypto/keys.ts` has the same shape.

Start with the binary format: it is the bulk of the count and the group where a
surviving mutant would represent a real risk to stored files.

---

## Let Deno-hosted sites with a Bunny database be migrated

`POST /instance/site-credentials` (`src/features/instance.ts`) only returns
sites whose `hostingProvider` is `"bunny"`, but the builder also supports
`hostingProvider: "deno"` with `dbProvider: "bunny"`. Those sites hold a Bunny
database and cannot be moved with `deno task migrate:sites`, because the menu
never sees them.

A reviewer on PR #1940 suggested returning the hosting provider and id from the
endpoint and dispatching the secret update through `resolveHostingProvider`
(`src/shared/site-assignment.ts`), which is the right shape. It was left out of
that PR because relaxing the filter changes what the deploy workflow receives:
`.github/workflows/deploy-clients.yml` posts new code to
`api.bunny.net/compute/script/<script_id>` for every site the endpoint returns,
so a Deno-hosted site appearing in that list would break the deploy. Doing this
properly means the workflow (and `.github/actions/backup-site/action.yml`) must
learn to skip or handle non-Bunny hosting first.

Starting points: the `hostingProvider === "bunny"` filter in
`src/features/instance.ts`, `setSiteSecrets` in `src/shared/site-assignment.ts`,
and the per-site loop in `.github/workflows/deploy-clients.yml`.

---

## Split the hybrid encryption section out of `src/shared/crypto/keys.ts`

_Origin: reviewer suggestion on PR #1945._

`keys.ts` is 499 lines and holds three separate jobs: KEK derivation, symmetric
key wrapping, and hybrid RSA+AES encryption. The hybrid section is the natural
one to lift out — `hybridEncrypt`, `hybridDecrypt`, their TTL decrypt cache,
`encryptWithOwnerKey` / `decryptWithOwnerKey`, and the RSA key import pair. That
would leave `keys.ts` about 370 lines and focused on keys, and would sit
naturally beside `src/shared/crypto/aes-gcm.ts`.

It was left out of #1945 because that PR did not cause the overage: `keys.ts`
was already 494 lines before it and grew by five. (The same rule did apply to
`encryption.ts` there, which the change pushed from 391 to 443, and that one was
split.)

The move itself is mechanical, but it is wide: `encryptWithOwnerKey` and
`decryptWithOwnerKey` are used across attendee PII, the activity log, email
preferences, and bulk email drafts, so every importer needs repointing. Remember
`src/docs/crypto.ts`, which re-exports whole crypto modules for the generated
API docs — a moved export silently disappears from them otherwise.

Starting point: the "Hybrid Encryption" section of `src/shared/crypto/keys.ts`,
and `grep -rn "encryptWithOwnerKey\|decryptWithOwnerKey\|hybridEncrypt" src/`.

---

## Decide what happens to undated bookings when a listing starts being booked by the day

*Origin: found while migrating the multi-day tests to stories (PR for batch 8).*

A listing booked as one date can be switched to being booked by the day. The
people who booked before the switch have no day of their own (`start_at` is
NULL), and the per-day capacity count deliberately excludes them on a daily
listing — see the null-start_at case in
`test/e2e/duration-days/booking-flows.test.ts`.

The effect is that a full listing stops being full the moment it is switched. A
Hall with room for 2, with both places taken, accepts a further booking on any
day after the switch, so it ends up holding 3 people. The listing's *total*
check still counts them (`attendeesApi.hasAvailableSpots(id, 1)` with no date
returns false), so the two checks disagree.

This may be intended — an undated booking genuinely has no day to block — but
nothing states the intent, and an organiser switching a sold-out listing would
not expect it to reopen. Worth an explicit decision: either give the undated
bookings a day at the point of the switch, count them against every day, or
refuse the switch while undated bookings exist.

It was out of scope for the migration, which only moves existing tests into
stories. A story asserting "people booked before the change still take up room"
was written and then removed, because the product does not do that today.

Starting point: `attendeesApi.hasAvailableSpots` and the per-day capacity SQL in
`src/shared/db/attendees/capacity.ts`, plus the listing-type switch in
`src/features/admin/listings-edit.ts`.

## A payment we cannot prove is ours is dropped without a trace

When a provider's answer about a checkout breaks its own schema, the reply is
rejected before the signed price proof inside it can be read. With nothing to
prove the payment is ours, the callback is acknowledged and the payment is left
alone: no booking, no refund, no case, and nothing written down.

For a payment made through this site that is fine in practice, because the
payment record is written before the provider is ever called, so ownership is
known from our own record and a broken answer becomes an operator case. The gap
is a checkout with no local record — one adopted from a signed link — where a
malformed answer means real money can go unnoticed.

Worth an explicit decision: keep quiet as now, or record the dropped callback
so somebody can look. Recording it must not let a stranger's callback create
noise, which is why unprovable answers are ignored today.

Found while repairing the payment tests: the webhook cases that used to fail
loudly here now pass through this path, so they assert the quiet behaviour and
name it in their titles.

Starting point: `resolvePayment` in `src/shared/payment-state/resolve.ts` (the
`invalid` and `unavailable` arms), `storedObservationFacts` in
`src/shared/payment-runtime/provider-read.ts`, and the `ignore` arm of
`webhookResponse` in `src/features/api/webhooks.ts`.

## A broken payment link no longer says anything in the log

A visitor landing on the payment success or cancel page without a usable link —
no session in the address, an address with the wrong parameters, or a provider
that is not set up — is shown a plain error and nothing is written to the error
log. The old callback wrote a line naming which parameters arrived and where
the visitor came from, which is what an operator needs to tell a broken redirect
from a stray visit.

Nothing writes that line now. Worth deciding whether to bring it back, since a
misconfigured return address is invisible until somebody complains. It must stay
free of anything personal: the old line carried parameter names and the
referring page only.

Found while repairing the payment tests: the cases that checked those lines now
only check the page the visitor sees, and the helper that paired a response with
its log line was removed with them.

Starting point: the callback entry points in `src/features/api/webhooks.ts`
(`processSessionAndRedirect` and the cancel route beside it).

---

## Tell the story of a refused "stop selling this on its own"

*Origin: reviewer suggestion (Codex) on PR #1952.*

The site refuses to stop selling an add-on on its own when doing so would leave
another add-on with no way to be bought — `strippedPageOrphanedAddOn` in
`src/shared/listings-actions.ts` re-runs the reachability guard and blocks the
save. The story `bookings.add-ons-sold-on-their-own` covers only the plain
cases, where nothing depends on the page, and its rule is worded to say so.

The refusal is an operator-facing rule worth telling: the organiser is stopped,
and told which add-on would be stranded. It was left out of that PR because
setting it up needs a child-scoped optional modifier, which no story support
builds yet — a bigger piece of scaffolding than the migration it sat in.

Starting point: `strippedPageOrphanedAddOn` and
`firstChildUnreachableAddOnForListings` in `src/shared/db/modifier-resolve.ts`,
plus whichever direct test already covers the guard, for the shape of the
fixture.

---

## Test the door's confirmation steps in the browser script

*Origin: reviewer suggestion (Codex) on PR #1959.*

`src/ui/client/scanner.js` is the only part of checking people in that nothing
tests. It is the script that shows the organiser the question the door asked —
"this ticket is for another listing, let them in anyway?" and "check this
person's ID first" — and sends the second request carrying their answer.

The story `attendees.checking-people-in-at-the-door` reads a ticket, gets the
query back, and then sends the answer, which is the same pair of requests the
script makes. What it cannot do is press the button: `TestBrowser` runs no
JavaScript, so a broken confirmation prompt would leave the story green.

That is a pre-existing gap — `scanner.js` had no test before this story either,
and it is the only client script in `src/ui/client/` with none. Closing it needs
a DOM test in the shape of `test/ui/client/order.test.ts`, which was too much
scaffolding to add inside a test migration.

Starting point: `src/ui/client/scanner.js`, the confirmation branches around its
handling of `wrong_listing` and `verify_id`, and `test/ui/client/order.test.ts`
for how a client script is driven without a real browser.

---

## Payment findings from the review of the aggregate base branch

*Origin: Codex review on PR #1962 (the payment-aggregate base branch).*

These are real problems the reviewer found in the payment rewrite. None is a
test failure, so none was fixed while getting the branch's tests green; each
should be picked up as its own chunk when that part of payments is peeled off.

**Old payments cannot be refunded from an attendee's page.** After an existing
site upgrades, its copied payments are stored as `origin = 'legacy'`, but every
attendee refund path loads payments through a query that only looks at current
ones (`getCurrentPaymentSessions` in `src/shared/db/payments/sessions.ts`). So
a booking paid for before the upgrade looks like it has no payment to give
back. Either keep a path for the old ones, or promote them once they are
resolved. Start at that query and at
`src/shared/payment-runtime/refund-targets.ts`.

**A refund can be blocked just because new checkouts are switched off.** When
the owner picks "none" as the payment provider, each stored payment still
records the provider and account that took its money, but the single-attendee
refund refuses before reading them
(`paymentProviderIsConfigured` in `src/features/admin/attendee-refunds.ts`).
The bulk path over the same targets still refunds. Better: go through the
stored payment and only report a setup problem when its own account no longer
works.

**Money the owner sent back is not written into the books.** Choosing
"refund the rest" on a case for a booking that already exists marks the
provider side fully refunded and closes the case, but nothing records the
refund against the attendee, so Money still shows the cash as held
(`src/shared/payment-runtime/operator.ts`, around the `refund_remaining`
arm). It needs to finish the attendee's own refund before reporting the
decision as done.

**Some finished payments are never tidied up.** A payment can end
`fully_refunded` with no completion plan — the provider refunded it before
the booking was made, or a balance was refunded because the amount changed.
The tidy-up only accepts payments whose completion finished
(`src/shared/db/payments/redaction-eligibility.ts`), so those keep the buyer's
details for ever instead of for the retention period.

**A paused refund can jam the queue.** When an automatic refund comes back
part-done, or a provider failure hands the payment to the owner, the payment
is released with no next-check time while its completion is still pending —
a state the table's own rule forbids, and one the queue then rejects, holding
up every payment behind it
(`src/features/api/payment-processing/completion-refund.ts`).

**Merging a booking mid-delivery loses the site it was given.** If a payment
has handed out a site but its remaining work is still queued, merging the
booking repoints the payment and deletes the old booking, leaving the queued
work pointing at a booking that is gone
(`src/shared/merge/attendee-merge.ts`). The delete paths already refuse in
this situation; the merge should too, or move the queued work with it.

**Tickets handed out early are kept for ever.** A buyer who is sent straight
to their ticket gets its tokens before the payment's remaining work finishes,
so the copy kept with the payment is never used up — and tidy-up skips
payments whose tickets are marked ready. Unless the buyer returns to the
provider's success address later, the tokens and the unredacted payment stay
put (`src/features/api/webhooks.ts`).

**A SumUp return can be read by the wrong provider.** A new SumUp checkout
puts our own payment id in `session_id`, but the return address only treats
`payment_id` as one of ours. Switching or switching off the provider while a
SumUp checkout is open means the buyer's return cannot find their payment
(`src/shared/payment-runtime/legacy-sumup.ts`, and the return handling in
`src/features/api/webhooks.ts`).

**The attendee's payment id is cleared, but pages still read it.** New paid
bookings store an empty payment id, while the payment panel and the attendee
export still read that field — so the panel disappears and exports carry a
blank transaction id even though the payment aggregate has the reference
(`src/features/api/payment-processing/create.ts` writes the empty value;
`src/features/admin/attendee-page-data.ts` and
`src/features/admin/listings-export.ts` read it).


**An upgraded site cannot copy a payment whose booking row was deleted.** The
schema for an old payment insists a completed row has both an attendee and a
listing (`LegacyProcessedPaymentSchema` in `src/shared/db/payments/legacy.ts`).
The reader hands back a null listing when the booking is gone, so the copy
rejects the row and the upgrade stops, every time it is retried.

Half of this is fixed: the reader used to skip bookings refunded down to no
quantity, which are ordinary and still name their listing, so those sites now
upgrade (see the test "brings forward a paid booking refunded down to no
quantity"). What is left is the booking row being deleted outright, where there
is no listing to name at all. A finished result requires a listing everywhere
downstream, so deciding what such a payment means is a real decision rather
than a one-line relaxation.

**Two renewals paid at the same time can undo each other.** A paid renewal
checks that the site's current read-only date still matches the one taken when
the payment started, and pushes the new date if so
(`src/shared/renewal.ts`, around line 151). Two payments taken close together
both remember the same starting date, so whichever lands second either walks
past the first one's extension or is mistaken for a repeat of it. The renewal
needs to claim the site before it moves the date, so the second one extends
from the first one's result instead of from a stale reading.

**A stuck refund leaves a quantity-0 booking with no payment record and no
note.** For a kept-but-refunded placeholder the refund is the one step that
must finish before the rest run (`src/shared/payment-completion.ts`). When the
provider's refund is still pending, or fails, everything behind it waits —
including the payment leg in the ledger and the note that tells the operator
what happened. So the booking sits there with no money recorded against it and
nothing on screen explaining why. Recording the money taken and the note does
not depend on the refund coming back, so they should not be queued behind it.

**An unsigned SumUp notice can make the site call SumUp.** SumUp's webhooks
carry no signature, so a notice with no recognised header is treated as
SumUp's (`webhookProviderType`). With a checkout id the site has never seen,
`src/shared/sumup-provider.ts` (around line 216) still asks SumUp about it
before anything has established the payment is ours. Anyone can therefore
make the site call SumUp over and over and use up its rate limit, which stops
real payment callbacks getting through. The check that answered an unknown id
from what the site already had, without calling out, needs to come back.

**A bulk refund that pays out but cannot be recorded has no way back.** When
the provider returns every refund but the ledger write fails for one person,
`src/features/admin/refunds/provider.ts` (around line 81) counts an error and
moves on. By then the payment is already marked fully refunded with nothing
scheduled, so the background finisher will never pick it up, and a later
refund-everyone run skips it because the provider has already refunded it.
The money is out but the books never say so, and no screen offers a repair.
It should be put in front of the owner as a case, the way the queued path
already does.

**Upgrading a busy site can split one SumUp payment in two.** The copy works
in pages of 25 old payment ids. A SumUp payment is known by two ids — the
site's own reference in one old table and SumUp's checkout id in the other —
and they can land on different pages (`2026-07-26_payment_aggregate.ts`,
around line 55). The first page uses the row that links them and then clears
it, so the second page no longer knows the two belong together and makes a
second payment record for the same money. Its outcome, ticket, and refund
facts are then split across the two. Pages need to keep a payment's ids
together rather than cutting the list wherever 25 falls.

## Finishing the payment branch's test coverage

*Origin: the coverage gate on the payment-aggregate base branch, which only
started running once the suite itself went green.*

The payment rewrite arrived with a lot of code no test ever reached. The gate
that would have caught it never got to run, because the suite was failing
before it. With the suite green the real number showed: **1011 lines and 257
branches across 78 files**.

This is being worked through file by file, largest gap first, with each file
committed on its own. To see what is left:

```bash
deno task test:coverage
```

Run it with nothing else running — two runs at once share the `coverage`
folder and give a nonsense answer.

Three things come up over and over, and are worth knowing before starting a
file:

- Some of what is uncovered is **code nothing can reach**. A guard below the
  code that already guarantees it, for example. Delete it rather than write a
  test that keeps it alive — and check the branch really is unreachable first.
- Every new test file has to be checked against the duplicate-code gate. Tests
  for one module tend to repeat their setup, and repeat it against the older
  test files next door. Pull the shared part out.
- A private helper cannot be tested directly, and must not be exported just so
  a test can reach it. Drive it through the surface that uses it.

Done so far: handing out a site when someone pays for one, and the SumUp
answers a read can get.

## An upgrade that runs out of database calls cannot give back its lock

*Origin: found while fixing the payment branch's upgrade, which was spending
fifty-eight of its fifty allowed database calls.*

An upgrade runs inside a request, and a request may make fifty database calls.
Going over is not just a failed upgrade — it is a stuck one:

1. the run stops at the call that goes over
2. writing down what it had done needs a call, so nothing is recorded
3. giving back the lock needs a call too, so the lock stays held
4. the next request is refused for two minutes, then does the same thing

The site never gets past it. The cost was brought down to about thirty-one
calls, so there is room again, but the trap is still there: the next thing that
adds a few calls to an upgrade brings it straight back, and the failure gives
no hint that a call budget is the cause.

Worth making the upgrade keep back the few calls it needs to write down its
progress and let go of the lock — so going over ends a request early, as it is
meant to, instead of stopping the site from ever finishing.

Starting point: `initDbUncached` and `runAcquiredMigrations` in
`src/shared/db/migrations.ts` for where the batch size is chosen,
`countDatabaseRoundTrip` in `src/shared/db/query-log.ts` for the counter, and
`recordMigrationBatch` in `src/shared/db/migrations/markers.ts` for the write
that never happens.

## More payment findings from the review

*Origin: Codex review on PR #1962.*

**Confirming a full refund closes the case but not the books.** When the owner
picks "already fully refunded", `src/shared/payment-runtime/operator.ts`
(around line 112) updates the charges and reports success, but never moves the
payment itself to refunded or finishes the attendee's ledger. The case closes
while the payment still reads as needing action and the money still shows as
held, and later callbacks keep reading the stale state.

**An old payment whose reference is only in the attendee's record is dropped.**
On an upgrade, a finished old payment from before the reference column existed
keeps the provider's id inside the attendee's encrypted record. The first pass
makes a payment with no charge, and the `NOT EXISTS` check at
`2026-07-26_payment_aggregate.ts` (around line 188) then skips that attendee in
the only pass that reads the encrypted record — so the payment ends up with no
evidence and no case for the owner to work from.

**A Stripe refund that has vanished is polled forever.** In
`src/shared/stripe/provider-refund.ts` (around line 65), a refund the provider
says is gone is treated the same as one it could not answer about right now.
The charge stays pending, the same id is read again every time, and nothing is
ever put in front of the owner. A refund that is genuinely missing should be
treated as failed.

**A checkout the provider refuses outright is retried forever.** Square and
SumUp return nothing both for a network wobble and for a permanent refusal such
as a bad key. `src/shared/payment-runtime/create.ts` (around line 100) files
every one as created and asks again in a minute, so a spell of bad settings
leaves rows that keep calling the provider long after it is fixed. A refusal
that will never succeed should be filed as failed.

**Reading a Square payment scans the whole location.** When a return or a later
run needs an order the webhook has not finished yet,
`src/shared/square-client.ts` (around line 348) looks for the payment by
scanning the location's payment list oldest-first, and stops after eight pages.
At a location with more than eight hundred payments, a new one is never found,
so the buyer's paid booking never completes. Square can be asked for a payment
by its id, which the order already names.

## Six more payment findings from the review

*Origin: Codex review on PR #1962, commit c2f3b889.*

**One stuck owner decision stops every other payment moving.** The scheduled
worker runs the owner's due decisions and the ordinary payment catch-up
together. If a decision throws — say the provider cannot be reached while
giving an old payment an account — the whole run stops there
(`src/shared/payment-runtime/maintenance.ts`, around line 201), so nothing
behind it happens: no checkouts finish, no bookings complete, no refunds go
out. Both the run and the decision come back a minute later and do it again.
The decision has already been written down as needing a retry by that point,
so its failure should not take the rest of the work with it.

**Tickets still work after the buyer's details are cleared.** When old payment
records are cleared, the copy kept for the books still carries the ticket
codes inside the finished result
(`src/shared/db/payments/redaction-values.ts`, around line 58). The codes are
what a ticket page is opened with, so they keep working long after everything
else about the buyer is gone. They should be emptied along with the rest.

**Editing a booking before it finishes changes what was bought.** The work
that finishes a paid booking builds its emails, announcements, and sites from
the listing and booking as they are *now*, not as they were when the money was
taken (`src/features/api/payment-processing/completion-booking.ts`, around
line 76). An owner who changes the quantity in that window can hand out two
sites for one paid place; one who turns site-giving off can leave a buyer
without the site they paid for. The facts should be written down when the
payment commits.

**Refunding everyone can leave someone never refunded.** A refund-all past the
first three people queues the rest by setting the payment to refunding
(`src/shared/db/payments/bulk-refunds.ts`, around line 57). If that payment
had not finished its booking yet, the catch-up does the booking first, which
is then not allowed to complete from refunding — so it goes round forever and
the refund never happens, while the page says it is continuing in the
background.

**One provider being down hides every old payment needing a decision.** The
page of payments waiting on the owner asks every configured provider for its
account at once, and one that cannot answer fails the whole page
(`src/shared/payment-runtime/account.ts`, around line 96). That hides
decisions which never needed that provider — keeping an old payment as it is,
or giving it a working account with another provider. Each should be asked
separately, and the one that is down shown as such.

**A listing that could not be deleted loses its attachment anyway.** Deleting
a listing removes its attached file first, then removes the listing inside a
guard that refuses if a payment landed in the meantime
(`src/shared/db/listings/delete.ts`, around line 11). When that guard does
refuse, the listing stays but its file is already gone, so the link on it
leads nowhere. The record should be claimed before anything outside the
database is removed.

## Four more upgrade findings from the review

*Origin: Codex review on PR #1962, commit 3e950d2c.*

**The owner cannot pick the right account for an old payment.** An old
payment that was still being paid when the site upgraded already knows which
provider it used — that came across with it — but not which account or whether
it was live or test. The check at
`src/shared/db/payments/decision-attempts.ts` (around line 164) treats
"provider known, account not" as nothing to decide, so it closes the case
before asking the provider, and the list of choices offered leaves out the
provider the payment actually used. On a site with one provider, which is
most of them, the owner is left with no usable choice at all. This one
matters most of the four: it is the repair path the others rely on.

**A payment that was mid-flight at upgrade never reaches the owner.** If the
upgrade finds a checkout that had started but no record of it finishing,
`src/shared/db/payments/legacy-copy.ts` (around line 93) copies it as still
going and stops there, without raising anything for the owner. Nothing picks
it up afterwards — the catch-up only looks at payments made since the
upgrade, and a later callback just reports a clash. So a payment or refund
that was in the air stays invisible for good. It should be put in front of
the owner as something to sort out.

**Old payment details are kept for ever.** Payment history is meant to be
cleared after a set time. A payment that came from before the upgrade keeps
at least one copied charge, and the check at
`src/shared/db/payments/redaction-eligibility.ts` (around line 31) reads that
as "still legacy, skip" — permanently. Choosing "keep the older record" closes
the case but changes nothing, so the details are never cleared, including the
buyer's encrypted personal details when that old payment was the only place
they were referenced.

**Upgrading can hand out tickets that were already used.** A finished old
payment whose ticket codes were already handed over has them blanked. The
upgrade sees the blank and falls back to the copy still sitting in the
half-finished checkout record (`src/shared/db/payments/legacy.ts`, around
line 299), so it marks the tickets as ready to give out again — and keeps them.
A finished payment should be believed even when its ticket field is empty; the
half-finished record should only be read when there is no finished one.

## Three more findings, one of them ours

*Origin: Codex review on PR #1962, commit 1a40b5eb.*

**Refreshing cannot repair a refund the books never recorded.** *This one was
introduced while repairing this branch, in the change that stopped a refresh
moving money on its own.* `refreshLoadedPayment`
(`src/features/admin/attendees-edit.ts`, around line 205) only chases charges
still waiting on the provider. If an earlier refresh got the money back but
failed to write it into the books, there is nothing left to chase: the list
comes back empty, so the page says the status is current and the books stay
wrong, with no button that fixes it.

The condition to fix is `allRefunded`. It currently means "we chased
something and it all came back", and it needs to mean "nothing is still owed"
— which is true both when this refresh brought the money back and when an
earlier one already did. Then the books are written either way, and writing
them again is safe, because a refund already recorded is left alone. Write the
failing test first: a payment whose charges are all fully refunded but whose
books have no refund entry, refreshed, must record it.

**Copying old payments can stop early and fail the upgrade.** The copy takes
twenty-five old ids at a time and treats a short page as the end
(`2026-07-26_payment_aggregate.ts`, around line 239). A SumUp payment is known
by two ids that merge into one, so a full page can come out short while there
are still ids left. The copy then declares itself finished, the later check
finds rows it did not copy, and the upgrade fails with a server error instead
of the "still going" answer it should give. Decide the end from how many old
ids there were, not how many payments came out.

**An old copy of the site can delete payments mid-upgrade.** The upgrade takes
several requests, and an older running copy of the site still recognises the
schema in between. Writes to the old payment tables are blocked while this
happens, but deletes are not
(`src/shared/db/migrations/legacy-payment-retirement.ts`, around line 9), so
that older copy can still tidy up payments or remove an attendee. If it
removes a row before the upgrade has copied it, the check that everything was
copied sees an empty table and is satisfied — the payment is gone with nothing
saying so. Deletes need blocking too, with a way for the upgrade itself to
clear rows it has already copied.

## A SumUp refund state we do not know is asked about for ever

*Origin: found while writing the tests that cover SumUp's transaction reading
on the payment-aggregate base branch.*

SumUp reports what happened to a payment as a list of events. A refund event
carries a state, and only four of them mean anything to us. Any other state
makes the reading refuse, which is right — but the refusal is then treated the
same as SumUp being unreachable (`src/shared/sumup/boundary.ts`, `toRefundFact`;
the reading is wrapped by `readSumupTransport` in `src/shared/sumup.ts`).

So the payment is filed as "we cannot answer right now" and asked again a
minute later, for ever, and nothing is ever put in front of the owner. Unlike a
network wobble, this one can never come good on its own: the answer will carry
the same unknown state every time.

A state we do not know is a permanent problem with what SumUp is telling us, so
it should be raised for the owner instead of retried. The test that pins the
current behaviour is "cannot answer about a refund reported in a state we do
not know" in `test/shared/sumup/refund-events.test.ts` — it will need changing
when this is fixed.

## Guards on the owner-decision path that nothing can reach

*Origin: working through the payment branch's coverage tail, after the same
shape turned up in `square-provider-read.ts` and was deleted there.*

`preparePaymentDecision` (`src/shared/payment-runtime/operator-claim.ts`) starts
by refusing any decision that was not offered for these payment facts. That one
check makes two of its own guards impossible to reach:

- **"Payment has no reviewed charges"** (`reviewedCharges`). Every choice
  offered for a current payment — finish the booking, refund what is left,
  confirm it was refunded — is only offered when the payment has current
  charges. So by the time this runs there is always at least one.
- **The whole "old payment" half of `chargeSnapshot`** (about sixteen lines,
  including "has no assigned account"). An old payment is only ever offered
  "keep this as it is" or "give it an account", and both are sent to
  `legacyAssignmentSnapshot` instead. So this branch never sees one.

Both should go, the way the Square one did. It needs a little care with types:
the remaining path has to narrow the payment to a current one, and the pattern
to copy is `requireCurrentPayment` in `src/shared/payment-runtime/operator.ts`.

Left alone for now because deleting guards on the money path deserves its own
change rather than being folded into coverage work. The choices that *are*
reachable now have tests in
`test/shared/payment-runtime/operator-claim.test.ts`.

## Three more payment findings from the review

*Origin: Codex review on PR #1962, commit eaf7bb54.*

**A failed payment tells the buyer to seek a review that does not exist.**
When a checkout is cancelled or refused, it is filed as failed and ignored, and
no case is raised for the owner. A later callback or reload does not go back
through that path: it hits the terminal map instead, where a failed payment
answers "conflict" (`src/shared/payment-runtime/terminal.ts`, the handler map).
Reloading a cancelled SumUp return therefore no longer matches
`cancelledSumupResponse` in `src/features/api/webhooks.ts`, which needs the
answer "ignore", so instead of the cancel page the buyer is told the payment
needs review — while the owner has nothing to review.

*Note for whoever fixes this:* the test "puts a refused payment in front of the
owner" in `test/shared/payment-runtime/terminal.test.ts` pins the current
answer. It was written to cover the line, before this was known to be wrong, so
it must be changed rather than worked around.

**A payment can hold its claim for ever when the account cannot be resolved.**
If the provider's credentials are removed after checkout, or the account lookup
is briefly unavailable, `resolvePaymentAccount` throws after the session has
already been claimed (`src/shared/payment-runtime/process.ts`, around line 150).
Only valibot errors are turned into a read, and nothing releases the claim on
the way out, so the payment keeps its five-minute lease with no retry written
down and no case raised. With credentials missing this repeats for ever and the
booking never completes. The failure should either be written down as a retry
or a case, or the claim released before it propagates.

**Mail queued before the business email changed still goes to the old address.**
A paid completion prepares its outgoing mail up front. When the messages are
sent, only some settings are compared first (`src/shared/email.ts`, around line
530), so a changed business email is not among them. The owner's notification —
which carries the buyer's details — is still sent to the old address, and the
buyer's confirmation can still carry it as the reply-to, even though the guard
is meant to refuse mail once the email settings have changed. Messages aimed at
the business address should record that, and the address should be checked
against the current setting before sending.

## The owner-decision guards that nothing can reach

Preparing an owner's decision has two refusals the tests never reach, and
working out why is the same story as the rest of this branch: they are
guarded a few lines earlier by something that has already made them
impossible.

`preparePaymentDecision` (`src/shared/payment-runtime/operator-claim.ts`)
first refuses any choice that is not on offer for that payment, and only then
builds the written-down review. So by the time the review is built, the choice
and the payment already agree.

**"Legacy payment ... has no assigned account"** (around line 55) is in the
branch that builds a *money* review for an *old* payment. The only choices
offered for an old payment are "say which provider took it" and "keep it as it
is" — both of which build a different kind of review. A money review for an old
payment cannot be asked for.

**"Payment ... has no reviewed charges"** (around line 23) needs a current
payment with no current charges. Refunding and confirming a refund are only
offered when there are current charges, and completing a booking is only
offered when the stored evidence proves it — which itself requires a charge.

Both look safe to delete, which would also remove the last uncovered lines in
the file. They sit on the path that claims a payment for a decision, so the
call belongs to whoever owns that code rather than to a coverage pass. If they
are kept, they need recording as deliberately unreachable instead.

**The same shape repeats when the decision is run.** Running a claimed
decision (`runClaimedDecision` in `src/shared/payment-runtime/operator.ts`)
switches on the choice the owner made, and several arms then re-check
something the offer step already settled:

- "Payment ... is not current" guards refunding and confirming a refund. Both
  are only ever offered for a current payment — the choices for an old payment
  are a different list entirely — and a payment only ever moves from old to
  current, never back.
- "Stored payment evidence no longer proves this booking" guards completing a
  booking, which is only offered when that evidence already proves it, and a
  decision whose facts change before it runs is sent back for review first.

So most of the uncovered lines in `operator.ts` are the same re-checks, one
step later. Worth deciding as a group rather than one at a time: either they
go, or they are recorded as deliberately unreachable. Each needs its own read
before removal — this note is where that reading starts, not a substitute for
it.

## The charge review index that cannot be missing

`currentSnapshotCondition` in `src/shared/db/payments/decision-claim.ts`
builds one review index per charge, then looks each one up by position and
raises `Payment charge ... has no review index` if it is not there:

```ts
const indexes = await paymentDecisionChargeIndexes(snapshot);
const charges = snapshot.charges.map((charge, index) => {
  const referenceIndex = indexes[index];
  if (referenceIndex === undefined) { throw ... }
```

It cannot be missing. `paymentDecisionChargeIndexes` maps straight over
`snapshot.charges`, so the two lists are the same length by construction —
the refusal is guarding against the list it just built being the wrong size.

Fixing it needs a small change across two files rather than a test, because
the lookup is what convinces the type checker the value is there. The tidy
shape is for `paymentDecisionChargeIndexes` to hand back each charge
together with its index, so nothing is looked up by position at all. Its
other caller is `decision-attempts.ts:129`, which wants the plain list, so
that one needs looking at in the same change.

Left for its own change: it touches a shared helper on the path that claims
an owner decision, and this pass was closing gaps one file at a time.
## Prove a bundle's blank price really charges the thing's own price

*Origin: reviewer suggestion (Codex) on PR #1968.*

The story `bookings.selling-things-as-one-bundle` proves the *saving* half of
the blank-price rule: leaving a part's price empty on the bundle form stores no
price of its own for that part. It does not prove the *charging* half — that the
customer is then asked for that thing's own price rather than nothing.

Its rule is worded to say only what it proves. Closing the gap needs a paid
bundle taken all the way through a payment provider, which is what the money
stories already set up (`test/specs/support/money-drivers.ts`), so the natural
home is a scenario there rather than another one here. A bundle mixing an
overridden part with a blank one, bought and paid for, should be charged the
override plus the blank part's own price.

Starting point: `packageMemberMaps` in `src/shared/db/groups.ts` for what counts
as an override, and `test/integration/server/cart-packages.test.ts` for how a
priced bundle reaches checkout today.

---

## Give the stripe-mock install lock the same shape as every other file lock

*Origin: noticed while unifying the locks behind `scripts/lock-file.ts`.*

Every lock that is a file — the precommit gate, the browser-asset build, the
stripe-mock start, each mutation run — now goes through `withFileLock`, which
holds one advisory lock and checks that the lock it holds is still the file at
its path. (The database migration lock is not one of these: it is a row in a
table, and is named below for the pattern it shares.)

`scripts/stripe-mock/install.ts` is the exception: it has a second,
hand-rolled protocol underneath (`createNew` to claim the lock, a timestamp
written inside it, and `removeStaleInstallLock` to break a lock whose owner
died), guarded by a `withFileLock` on a separate guard file.

It answers a question the shared lock cannot: "whoever claimed this walked away,
so take it from them". Two other places answer that same question their own way:
the mutation runner uses a record with a status, a pid, and a startup grace plus
`processExists`, and the database migration lock
(`src/shared/db/migrations/lock.ts`) writes an owner into a settings row and
lets anyone break a claim older than `MIGRATION_LOCK_TTL_MS`. Three mechanisms
for one job.

Worth folding into one: either teach `lock-file.ts` about an owner that can go
away, or let the install reuse the run-record shape. It stayed out of PR #1957
because it is a whole protocol, not a shared helper, and the install path has
its own timing tests.

Starting point: `tryAcquireInstallLock`/`removeStaleInstallLock` in
`scripts/stripe-mock/install.ts`; `acquireMigrationLock` in
`src/shared/db/migrations/lock.ts` is the best-worked-out version of the pattern
and the one to copy; `activeByRecord` in `scripts/mutation/isolation-cleanup.ts`
is the third; and `test/scripts/stripe-mock/install/stale-locks.test.ts` and
`waiting.test.ts` say what the timing tests expect.

## Tell a clear-up's hold on a run apart from the run's own

*Origin: reviewer suggestion (Codex) on PR #1957.*

`processBelongsToRun` in `scripts/mutation/isolation-cleanup.ts` decides a run
belongs to the process in its record when that process is alive *and* somebody
is holding the run's lock. A clear-up deleting that run's folder holds the same
lock, so during a deletion the two are indistinguishable.

That matters in one case: the record's process id has since been given to some
unrelated program. `--kill` then reads "alive and locked" as proof and signals a
process that has nothing to do with us. Deleting a whole checkout copy takes
long enough for the window to be real.

It needs the lock evidence tied to the run's own child rather than to whoever
holds the lock — the holder could write who it is, or a clear-up could hold
something a run never holds. Either is a change to what a lock means here, which
is why it did not ride along with PR #1957.

Starting point: `processBelongsToRun` and `removeRun` in
`scripts/mutation/isolation-cleanup.ts`, `signalRun` in
`scripts/mutation/isolation.ts` for what acts on the answer, and
`scripts/held-lock-process.ts` for the process that holds a lock on our behalf.

---

## Watch for ports being taken between tests

*Origin: the chunk that took `scripts/stripe-mock/install.ts` to a full
mutation score (#1966), and the flaky runs it uncovered.*

The tests under `test/scripts/stripe-mock/install/` failed about one run in
three: five failed runs out of roughly fifteen, a different test each time, and
each one passing when run on its own.

The cause was a port being taken between choosing it and using it.
`withUnusedPort` opens a port to find a free one, closes it, and hands the
number over. Another test starting at that moment can take the same number. The
starter then sees something already listening and reports success, so a test
that asked for a failure was handed somebody else's mock instead.

`expectStartFails` now treats that as "ask again on a fresh port" rather than a
pass, and gives up loudly if it keeps happening.

What is left is a wider version of the same problem: any test that picks a port
and then lets go of it before use can be gazumped. The install tests are the
ones that noticed, because they are the ones that assert a failure. Worth
looking at whether ports should be handed out so that no two tests in a run can
ever receive the same one.

It has since been seen once more, in `test/scripts/stripe-mock/lifecycle.test.ts`
("stops trying once the mock has been started as many times as asked", on CI for
PR #1968), with a second symptom worth knowing about. That test counts how many
times the fake mock was started and expects one start per try asked for. A try
whose freshly picked port already has something listening on it is abandoned
*before* the mock is started, so the count comes up short and the test fails —
even though the starter did try the number of times it was asked to. Handing out
ports so no two tests can receive the same one would fix this too; short of that,
the count is the wrong thing to measure.

---

## The gap between a mutation child ending and its supervisor taking the lock

*Raised by Codex on [PR #1976](https://github.com/chobbledotcom/tickets/pull/1976),
about `scripts/mutation/isolation.ts` and `scripts/mutation/isolation-cleanup.ts`.*

A run's copy is protected by its lock, held by the child while it works and by
the supervisor afterwards. Between the child ending and the supervisor taking
the lock, nobody holds it. A mutation command starting in that moment sees a
record that says "running" with a process that has gone, and — once the run is
older than the startup grace — may delete the run's folder.

Today that costs a run its copy-back: the read fails, the run is reported as
failed, and the work has to be run again. It is loud, not silent, and it needs
a second mutation command to start inside a window of a few milliseconds.

The fix is to stop judging a run's liveness by the child alone. If the record
also carried the supervisor's process id, a run would count as live for as long
as the supervisor is up, closing the gap. That means changing what
`runProcessIsUp` and `activeByRecord` in `isolation-cleanup.ts` consider alive,
and thinking again about the startup grace, which exists because a process id
can be given to somebody else after the original has gone. Start at
`RUN_STARTUP_GRACE_MS` in `isolation-state.ts` and the comment above it.

## Four feature modules had no test at their mirrored path — now they do

*Origin: `deno task precommit:mutation` on the notes-migration branch, which
could not start. Closed by the direct-test pass that followed.*

All four now have a direct test at their mirrored path, so the gate no longer
refuses to start on a branch that touches them:

- `src/features/admin/attendee-page.ts` → `test/features/admin/attendee-page.test.ts` (100%, two recorded equivalents)
- `src/features/admin/attendees-list.ts` → `test/features/admin/attendees-list.test.ts` (100%)
- `src/features/admin/listing-page-data.ts` → `test/features/admin/listing-page-data/` (100%, one recorded equivalent)
- `src/features/api/payment-processing/store-refund.ts` → `test/features/api/payment-processing/store-refund.test.ts` (100%)

Every one of them now catches every mutation the gate demands, so a branch
touching any of them can pass without first writing the tests that should
already have existed.

`src/features/admin/attendee-notes.ts` was in the same state and was fixed
earlier: its route suite drives real pages through the session helpers, so it
moved from `test/integration/admin/` to `test/features/admin/`, which is where
that kind of suite belongs (see "Let the misplaced-test list see past request
helpers" above).

## Two people setting a site up at the same moment can both succeed

Raised on #1988 by both automated reviewers, and confirmed against the code.
It is a production bug, not a test gap, and it is deliberately left out of that
pull request because that branch changes no production code and this sits in
the most security-critical path we have.

**What happens.** `handleSetupPost` (`src/features/setup.ts`) asks
`isSetupComplete()` and then calls `settings.setup.complete`. Nothing holds
between the asking and the doing, so two requests that arrive together can both
be told the site is empty. `completeSetup`
(`src/shared/db/settings/setup.ts`) then runs its batch twice.

The unique index on `username_index` saves us only when both people pick the
*same* name. Two different names both insert, and the second batch's
`settingUpsert` calls overwrite `PUBLIC_KEY` and `WRAPPED_PRIVATE_KEY` with a
second keypair. The first owner is left holding a wrapped data key for a data
key the site no longer uses — they can sign in and read nothing.

**Why it is not simply "add a guard".** The batch cannot decide anything
mid-flight, so making the owner insert conditional still leaves the four
setting upserts landing unconditionally. Whatever fixes it has to make the
whole ceremony refuse to run twice — an interactive transaction that re-reads
`setup_complete` inside the write lock, or a single conditional write that
every other statement hangs off. That is a design decision in the code that
holds everybody's encryption keys, so it wants its own change and its own
review, not a corner of a test PR.

**Where to start.** `completeSetup` in `src/shared/db/settings/setup.ts` —
`withTransaction` from `src/shared/db/client.ts` is the tool, and the header
comment on the current batch explains why it is a plain batch today (all values
are computed up front). The guard in `handleSetupPost` at
`src/features/setup.ts:114` stays useful as the cheap first check.

**Proving it.** A story cannot show this today: Cucumber awaits each step, so
the two posts never overlap. #1988 covers the neighbouring case it *can* reach
honestly — a person who had the setup page open before somebody else finished,
sending their stale form afterwards. A real test for this one needs both posts
started together behind a barrier, and it should be written with the fix.

---

## An answer filed under a listing nobody booked

*Origin: review of PR #1990 (the booking-check slice), 2026-07-29.*

Free-text answers travel through checkout filed under the listing they belong
to, as `{"12": [{"q": 3, "s": 400}]}`. `ListingKeySchema` in
`src/shared/booking-intent.ts` checks that the key is written the way a listing
id is written, so a key of any other shape stops the booking rather than losing
the answers under it after the buyer has paid.

What it cannot check is whether that listing was one of the ones actually
bought. A key of `"12"` on an order for listings 3 and 7 passes the shape rule,
and `saveSessionAnswers` in `src/features/api/payment-processing/create.ts` then
looks up each booked listing in turn, finds nothing under 3 or 7, and saves no
answers. The buyer answered a question and the answer quietly goes nowhere.

The schema is the wrong place for the check: it validates one booking's metadata
on its own, and the listings that were bought are decided later, once the items
have been priced and loaded. The natural home is next to
`saveSessionAnswers`, which already has both the answer map and the booked
listings — compare the two sets and raise any key that matches no booked
listing, the same way an unreadable booking is raised.

Start at `saveSessionAnswers`, and at `test/shared/booking-intent.test.ts`,
where the shape rule is covered and the "names a booked listing" rule is not.

---

## A create whose row can't be read back should not look retryable

*Origin: Codex review on PR #2002, which added the loud failure for a create
whose just-written row can't be read back.*

`writeEntity` (`src/shared/rest/write-entity.ts`) writes the row, commits, then
reads it back on the primary. When a create's read-back finds nothing it now
raises an error. That error leaves the API write path in
`src/shared/rest/crud-api.ts` and reaches the request handler
(`src/features/app/request.ts`), which turns any unhandled error into the shared
503 page. The row itself was committed, so a client that treats the 503 as
"try again" can post the same create twice and end up with two rows.

The reviewer's suggestion was to read the row back *before* committing, so a
failed read-back rolls the insert back and there is nothing to duplicate. That
is more than a local change: each resource can supply its own
`lookupAfterWrite`, several of which join extra columns, and every one of them
would need a version that reads inside the open transaction. It also trades one
rare wrong answer for another — a row read before the commit can still be
reported to the caller when the commit afterwards fails.

`writeTableRow` in `src/shared/db/table.ts` already inserts and reads back
inside one transaction (see `test/shared/db/table/write-row.test.ts`), so it is
the place to start if the pre-commit read-back is the direction taken. The
smaller alternative is to keep the failure after the commit but answer with a
response that says plainly the create is not to be repeated, and carries the id
of the row that was made, rather than falling through to the generic 503.

Note that the id that made this reachable in the first place is now checked at
the insert (`insertedRowId` in `src/shared/db/client.ts`), so this is about the
answer given for a failure that should no longer happen — not a live fault.
## Ten more findings from the review of the aggregate base branch

*Origin: automated review of PR #1962 at commit `cdac3314`, 2026-07-29.*

All ten are in payment logic this branch moved but did not introduce, and each
needs a regression test of its own. They are recorded together because they
share a shape: something the site decided once, at payment time, is looked up
again later from live settings or live state, and the two can disagree.

### The currency a delayed delivery is labelled with

`src/features/api/payment-processing/completion-deliveries.ts` (around line 37)
reads the site's current currency when the non-critical delivery step runs,
rather than `current.payment.expected.currency`, which was frozen when the buyer
paid. An owner who changes the site currency in between gets a ticket
attachment and a registration webhook labelling the stored minor units with the
wrong currency — and currencies whose smallest coin is a different size will
show a wrong amount, not just a wrong symbol. Build the delivery from the
payment's own currency.

### A SumUp retry converted with the live currency

`src/shared/sumup.ts` (around line 176) divides `expected.amount` into major
units using the live currency setting, while sending the stored
`expected.currency` in the same request. Retrying a £10 checkout after the site
switches to a currency with no decimal places sends `1000 GBP`, and the response
parser converts the same wrong way, so it can accept that as matching. Pass the
stored currency into both conversions.

### A permanently refused delivery blocks the queue behind it

`completion-deliveries.ts` (around line 123) lets a permanent 4xx from a prepared
email or webhook throw before the row is marked done.
`getPendingPaymentCompletionDeliveries` then picks the same oldest row every
time, so nothing behind it ever runs, and because payment maintenance takes one
due payment per page and lets the error out, later payments can starve too.
Record a failed or needs-action outcome for a permanent refusal and carry on.

### Deleting an attendee mid-refund

`src/shared/db/attendees/delete.ts` (around line 87) fences deletion on
`completion_state = 'pending'` only. A payment that finished booking but still
has a refund out at the provider passes the fence, and the batch detaches the
payment and deletes the attendee. When the refund lands there is no attendee to
record it against: the single-attendee path has nowhere to write, and the bulk
path throws on a null `attendeeId`. Money is then unreconciled after real funds
went back. Fence on unfinished refund state as well.

### A single refund left pending is never finished

`src/features/admin/attendee-refunds.ts` (around line 130) returns before
`recordAttendeeRefund` when a single Stripe or Square refund comes back pending.
Maintenance can later move the aggregate and charge to `fully_refunded`, but
`processDuePaymentSession` runs the local ledger completion only for payments
carrying the bulk-refund case — so the attendee stays unrefunded in Money, with
no case open, after the provider has returned the money. Persist the local
completion work for single refunds too.

### A refused payment reads as needing review on reload

`src/shared/payment-runtime/terminal.ts` (around line 42) turns the second read
of a declined or cancelled SumUp checkout into a `conflict`, where the first
read stored `failed` with an `ignore` outcome and the buyer got the normal retry
page. A reload therefore tells the buyer their payment needs review when no case
exists. Keep the original failed/ignored outcome for a terminally refused
payment.

### Queued mail sent to a business address that has changed

`src/shared/email.ts` (around line 514) records only the provider and the
from-address with a prepared message, so a business email changed before
maintenance sends it still matches. The owner notification — which carries the
buyer's personal details — then goes to the old address, and the buyer's
confirmation can keep it as reply-to. Store and check the business recipient
alongside the rest.

### An account lookup that fails leaves the payment stuck

`src/shared/payment-runtime/process.ts` (around line 150) throws when resolving
a due paid checkout's provider account fails — a temporary Stripe outage, or
credentials that were removed. The claimed payment keeps its stale due time and
lease until expiry, no case is raised, and the same paid booking can repeat
without ever appearing on the Payments page. Store a transient failure as a
retry and a configuration failure as a needs-action case.

### A SumUp return routed by the current provider setting

`src/features/api/webhooks.ts` (around line 156) treats only `payment_id` as a
local locator, but a new SumUp checkout puts the aggregate's own id in
`session_id`. Change or disable the active provider while a hosted checkout is
open and the buyer's return is routed to the new provider, or refused before the
lookup, so a paid return cannot hand over the ticket. Recognise SumUp's returned
local id whatever the current provider setting says.

### Pre-upgrade bookings cannot be refunded

`src/shared/db/payments/sessions.ts` (around line 214) excludes every session
with `origin = 'legacy'`, which is what an upgraded site's copied attendee
payments keep. The attendee refund page and the refund-all candidate builder
therefore see no payment for any booking made before the upgrade — even after
the owner has assigned the legacy charge to a provider account. Either promote a
resolved legacy session or give the refund paths a legacy-aware target.

### Merging an attendee with a paid site still being set up

`src/shared/merge/attendee-merge.ts` (around line 828) repoints the payment
session and deletes the source booking, but a stored delivery and any
already-reserved `built_sites` row still name the source attendee. Completion
then assigns or keeps the bought site against an attendee that no longer exists,
rather than the one it was merged into. Either block the merge until completion
finishes, or repoint the delivery and the assigned-site facts in the same
transaction.
