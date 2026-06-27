# Listing "Parents" — required-child selection

## Summary

Add an optional **parent/child relationship between listings**. Any listing may
declare one or more **parents**, where a parent is just another listing. The
relationship is read in reverse at the till: when a listing that is *a parent of
something* is added to an order, the buyer **must also pick exactly one of that
parent's children** (per parent) before they can check out.

Nothing here invents a new kind of entity. A "child" is an ordinary listing with
its own price, capacity, dates, questions and booking row; the parent system is
purely a **link table + a checkout-time gate + admin/edit UI + booking-page UI**.

This document began as a plan and is now **implemented and shipped** on branch
`claude/listing-parent-system-nphuka` (PR #1363). The design sections below still
read as a forward-looking plan (kept as the rationale of record); the
**Implementation status & nuances** section immediately after this summary records
what was actually built, every behavioural decision that was settled, and the
edge cases discovered during the build + review cycle that the original plan did
not fully anticipate. Where the plan and the status section disagree, **the status
section wins** — it reflects the merged code.

---

## Implementation status & nuances discovered

**Status: complete, always-on, green.** The full feature is on
`claude/listing-parent-system-nphuka`: schema + admin config + the booking-page
gate/fold + discovery/share suppression + JSON API handling + progressive-
enhancement JS + duplication, merged up to `main` (it coexists with the
checkout-ledger/transfers feature that landed in parallel). Every commit passes
the repo gate: 100% line+branch coverage, 0% jscpd duplication, biome, typecheck,
edge build, full test suite.

There is **no feature flag**. It was built behind `LISTING_PARENTS_ENABLED` purely
as build-time scaffolding and then removed entirely — the feature is always on,
and the "Required child listings" config lives in an **Advanced settings**
`<details>` on the listing edit page.

### Decisions settled (all open questions resolved)

Every item in "Open questions" and "Distilled decisions" below is resolved. The
three that were still marked open at planning time landed as:

- **Edit on the parent** ("require a choice from these listings"). *(Q1)*
- **Children may still be group members**, but a child is **suppressed from the
  group form's selectable set** (and every discovery surface), so it can only be
  booked through a parent. *(Q6)*
- **No child-scoped opt-in add-ons in v1** — and this is *hard-blocked*, not just
  unsupported: see "Add-on reachability" below. *(Q16)*

### Nuances discovered during the build / review cycle

These are the non-obvious things the implementation had to get right (most were
surfaced by the automated review pass and fixed):

- **Availability is evaluated, never cached.** The relationship accessors return
  the relationship only; bookability is recomputed per date/duration at
  render/submit (invariant I3). One curried predicate library
  (`shared.tsx`: `selectableChild([...atoms])`) is the single source of truth,
  composed differently per surface — date-less for discovery, date-aware for the
  submit fold, span-aware for the render unions.
- **Daily vs standard date-less sold-out.** A *daily* child's date-less
  `isSoldOut` aggregate is meaningless (it reads true once full on *any* one
  date), so only *standard* (cumulative-capacity) children are judged by it at
  render; a daily child's per-date capacity is enforced by the date-aware fold /
  `checkBatchAvailability`. Globalising the daily flag wrongly marked parents
  sold out for every date.
- **Inherited span correctness.** A fixed multi-day daily parent's customisable
  child must be *priced for the inherited span*; discovery, the date selector and
  the day-count selector must check that a valid **full-span** start exists (not
  just any one-day start); a fixed daily child folds only when its own
  `duration_days` equals the inherited span. The render selectors are constrained
  to the **union over selectable children** so the form never offers a
  date/day-count the fold would reject.
- **Combined parent+child group demand.** A parent and its required child in the
  same capped group consume **two** units per order, so the parent's
  sold-out projection *and* its quantity ceiling use the combined demand, not each
  row's individual remaining. (Groups are type-homogeneous, which makes a
  daily-parent + standard-child shared-group case unreachable — documented and
  locked with tests rather than coded around.)
- **Discovery ⇄ slug-guard consistency.** A booking can never start from a child,
  so *every* child is CTA-suppressed on discovery surfaces (cards, feeds, `/order`
  gallery, admin multi-booking builder, per-listing share/QR). A child with a
  bookable parent shows "available as an add-on"; a child whose every parent is
  inactive/sold-out/closed has no usable path, so it renders **"Currently
  Unavailable"** instead of a dead add-on link.
- **Add-on reachability (the child-scoped-add-on hard block).** Since a child's
  own page is suppressed and the parent page loads add-ons only from its own
  direct page ids (`[parent.id]`, *not* group siblings, and only **active**
  pages), an opt-in add-on reachable *only* through a child would be a dead end.
  This is blocked from **both** directions — making a listing a child, and
  re-scoping/activating a modifier — via one shared `scopeIsChildDeadEnd` core,
  and **re-checked on a listing save that changes `group_id`** (a group-scoped
  add-on's reach depends on group membership).
- **Thank-you URL through the paid round-trip.** A single parent's configured
  `thank_you_url` survives a folded child: it's carried explicitly on the
  `CheckoutIntent`/signed `SessionMetadata`. It must be capped/omitted **before
  signing** — against *both* the provider per-value length cap *and* the entry-
  count cap (Square's 10) — so the signed price proof and the emitted metadata
  stay identical (otherwise the webhook reads it as tampered). The ticket token is
  stored on the direct-render success path so a reload keeps the ticket link.
- **No-JS baseline + progressive enhancement.** Per-child quantity selects,
  pay-more price and child questions render **non-required** server-side (the fold
  is authoritative); JS then reveals and re-requires *the chosen children's*
  questions and price inputs (the question-visibility script keys off an effective
  selected-listing-id set that includes every child given a positive `child_qty_*`,
  since folded children have no `quantity_<id>` control), and shows a live "X of Q
  chosen" hint per parent. The live running-total already posts the child fields.

- **Per-unit child selection (selection-model change, 2026-06-23).** The gate
  moved from "one child choice per parent" to **per-unit selection**: a parent
  booked at quantity Q requires the buyer to choose **Q child units in total**,
  distributed across the parent's bookable children in any mix (Q of one child, or
  1 of A + 1 of B, …). The field model is a per-child quantity
  **`<select name="child_qty_<parentId>_<childId>">`** over `0..min(parentQty,
  childMaxPurchasable)` (default 0); a sole bookable child renders a **hidden**
  `child_qty_*` carrying Q (auto-select preserved); sold-out/inactive children
  render a disabled select fixed at 0. A visible "Choose Q add-on(s) in total"
  note plus the live hint guide the buyer. The server fold
  (`foldParent`/`resolveChildSelections` in `ticket-payment.ts`) reads each
  bookable child's `child_qty_*`, auto-assigns Q to a sole child when nothing was
  submitted, **rejects a positive quantity for a non-bookable/unknown child**, and
  requires the per-parent total to **equal Q exactly** (`child_too_few` /
  `child_too_many` messages — distinct from the legacy `child_required`, still used
  for the unknown-child case). Each chosen child is folded **at its own quantity**
  (not Q); a child chosen for multiple units or under multiple parents **sums** into
  one line, re-validated against `maxPurchasable` (reject, never clamp). Only the
  **selection mechanism** changed — the curried availability atoms in
  `shared.tsx` remain the single source of truth for "bookable", and every
  downstream per-listing path (capacity, questions, pricing, dayCount, contact
  fields, thank-you) is unchanged.
- **JSON API.** Discovery omits children, and a child's detail/availability
  returns the same not-bookable outcome as the web (404 / unavailable); a **parent
  booking is rejected** on the API (it has no child-selection input). A malformed
  (non-array) `child_listing_ids` on an admin API update is **rejected**, never
  treated as "clear all edges".
- **The fold feeds every per-listing path.** Capacity, registration-item
  building, contact-field requirements, site-assignment, questions +
  answer-modifiers, pricing and `dayCount` serialization all run against the
  folded order (page listings ∪ selected children), so children behave as ordinary
  lines downstream and the webhook needs no parent-awareness.
- **Duplication.** Single-listing duplicate copies the parent's child edges
  (validated); group duplication remaps intra-group edges to the cloned ids and
  preserves edges to listings outside the group.

### Code-shape notes (two unification passes)

The availability/scope logic was deliberately consolidated to avoid the same idea
being re-phrased per surface:

- `src/ui/templates/public/shared.tsx` — curried child-availability **atoms**
  (`childActive`, `childOpen`, `childStandardInStock`, `childCalendarOrInStock`,
  `childPricedForSpan`, `childDurationMatches`, `childDateOk`,
  `combinedGroupDemandFits`) + combinators `selectableChild`,
  `constrainOptionsByChildUnion`, `resolveInheritedDuration`.
- `src/shared/db/listing-parents.ts` — `groupEdges` (one batch edge loader, both
  directions) and `firstTouchingEdgeError` (one curried traversal backing both
  save-time edge re-checks — field compatibility and add-on reachability).
- `src/shared/db/modifier-resolve.ts` — one `scopeIsChildDeadEnd` reachability
  core shared by the edge-save and modifier-save guards.

---

## Confirmed behaviour (operator guidance, 2026-06-21)

These decisions are now settled by the operator and the rest of the plan should
be read in this light (they resolve several of the original open questions):

- **Primary use case:** hiring a **base unit** (the parent) that requires a
  **customisable add-on** (the child). Almost always **one parent → one child**;
  multi-parent / shared-child cases are rare corners, not the main path.
- **Cardinality (per-unit selection):** the buyer must choose children
  **totalling the parent's quantity, in any mix** — a parent booked at quantity Q
  requires **Q child units in total**, distributed across that parent's bookable
  children however the buyer likes (Q of one child, or 1 of child A + 1 of child
  B, …). The per-parent total **must equal Q exactly** (reject below or above).
  **Child selection is always required** — there is no "skip". The earlier
  "exactly one child per parent" rule is now the special case "one child whose
  quantity = Q". (Resolves Open Question 2.)
- **Single child ⇒ auto-select.** When a parent has only one (bookable) child,
  the system **assigns the whole parent quantity to it** rather than forcing a
  pointless choice (rendered as a hidden per-child quantity field). The buyer can
  still see it; they just don't have to pick.
- **Child is a normal paid listing** charged at its **own price** (the add-on's
  price). (Resolves Open Question 11.)
- **Hidden children are fully supported.** A `hidden` listing is **still pickable
  and auto-selectable** as a child. Being a child does **not** auto-hide a listing
  — the operator controls visibility with the existing `hidden` flag. (Resolves
  Open Question 12.) Two new UI requirements come with this:
  1. **"Hidden" badge in the admin listings table**, shown next to the public URL
     for **every** hidden listing (not just children).
  2. **Info message at the top of the product/edit page — separate copy per case**
     (a child is not necessarily hidden): a **hidden** listing gets "hidden from
     search engines and the main site"; a **child** listing (regardless of `hidden`)
     gets "offered as a choice under another listing; shown during booking." Never
     tell the operator a *visible* child is undiscoverable — it still appears on
     public cards (only its standalone booking CTA is suppressed). See Admin section
     for the exact split.
- **Child quantities total the parent's quantity.** If the buyer hires **2 of the
  base unit**, they choose **2 add-on units in total** — distributed across the
  parent's children in any mix (2 of one add-on, or 1 of two different add-ons).
  Each chosen child line's quantity is what the buyer entered for it (via a
  per-child `child_qty_<parentId>_<childId>` select); their sum must equal the
  parent's quantity. The previous "child quantity slaved to the parent" behaviour
  is the single-child special case. (Resolves Open Question 4.)
- **Child inherits the parent's date/duration — but *date* and *duration* inherit
  separately.** The add-on has no date/day-count controls of its own; it takes the
  base unit's. Two independent dimensions:
  - **Date** — only a **daily** child carries one (it inherits the parent's date). A
    **standard** (non-daily) child must fold with `date: null`, never the parent's
    date: a dated row uses date-overlap capacity while a dateless row uses cumulative
    counting (`buildCapacityCondition`), so writing the parent's date onto a standard
    child would flip it to per-date capacity and oversell across parent dates.
  - **Duration** — any **`customisable_days`** child inherits the parent's resolved
    day-count so its `day_prices` and the checkout `dayCount` use the chosen span —
    **including a *standard* customisable child** (which still folds `date: null`).
    A non-customisable child is duration 1 (or its own fixed `duration_days` for a
    daily child, which must match the parent — admin rule).
  A daily child may only sit under a daily parent; a customisable child needs a
  duration-producing parent (see admin validation). (Resolves Open Questions 14 and
  17.)
- **Add-ons can be "pay what you want".** A child may be `can_pay_more`, so the
  booking page must render the child's **custom-price input** and the gate must
  collect it. (Resolves Open Question 15.)
- **Parents are bookable through every channel a normal listing is** — website
  form, multi-item URL, gallery/order page, **JSON API**, and **QR quick-buy**. So
  no channel may simply "block" a parent: each must **enforce the gate *and* let
  the buyer supply the child**. In practice the single-child auto-select makes the
  common base-unit-plus-one-add-on case work everywhere with no extra interaction;
  channels that can't show a chooser (QR skip-to-checkout) must **fall back to the
  form when the parent has more than one child** (or the per-unit total can't be
  auto-resolved), and the **API contract gains child selections** so a parent can
  be booked programmatically. (Resolves Open Questions 9 and 10.)
- **A booking can never *start* from a child.** A child listing is bookable **only
  through one of its parents** — it is never an independent entry point. Its own
  `/ticket/<childSlug>` page, the gallery/order page, the API, and QR must **not**
  let a buyer begin an order with a child alone (show it as "available with …"
  rather than a buy button). This is a major simplifier: children are **never
  standalone cart lines**, so the gate's only input is the per-parent set of
  per-child quantity selectors — the "standalone child / parent+child URL"
  ambiguities disappear. (Resolves Open Question 13; reshapes Open Question 6.)
- **No nesting.** A child cannot also be a parent (and vice versa) — the graph is a
  single level. (Resolves Open Question 3.)
- **A parent with no bookable child is treated as sold out.** If every child is
  unavailable (inactive / sold out / closed for the date), the parent itself can't
  be booked. (Resolves Open Question 5.)
- **The same child under two parents (or chosen for multiple units) sums.** If a
  child is chosen under two in-cart parents, or for multiple units within one
  parent, the folded line's quantity is the **sum** of every contribution (P1's 2
  + P2's 3 ⇒ quantity 5 of the child). We do **not** disallow this; the summed
  quantity is re-validated against the child's `maxPurchasable` (reject, never
  clamp). (Resolves Open Question 8.)
- **Admin manual add/edit warns, doesn't block.** Operators can still build an
  order that doesn't satisfy the gate (with a warning). (Resolves Open Question 7.)
- **Renewal/subscription tiers are out of scope** — they can't be parents *or*
  children. (Resolves Open Question 18.)
- **Duplicating a listing or group copies its parent/child links** (remapped to the
  new ids). (Resolves Open Question 19.)

---

## Canonical invariants (single source of truth)

The detail/sequence/test sections below elaborate these but **must not restate them
divergently** — if behaviour changes, change it here and adjust references:

- **I1 — Per-unit child selection, always required.** The buyer chooses children
  whose quantities **sum to exactly the parent's quantity Q**, in any mix across
  the parent's bookable children (the old "exactly one child" rule is the special
  case "one child, qty = Q"). Auto-filled to Q when a parent has a single bookable
  child.
- **I2 — Per-parent child quantities total the parent's quantity** (the buyer
  enters each child's quantity; their sum must equal Q — reject below or above).
- **I3 — A booking can never start from a child.** Children enter an order *only*
  via a parent's per-parent selector; child slugs in any ticket URL are **rejected**
  (not silently dropped). No standalone child cart line ever exists.
- **I4 — Date and duration inherit *separately*:** a **daily** child takes the
  parent's date; a **standard** child folds `date: null` (cumulative capacity); any
  **`customisable_days`** child inherits the parent's *resolved duration* for
  `day_prices`/`dayCount` (even when standard).
- **I5 — A child is a normal line once selected** — but folding it must feed
  *every* per-listing path (capacity, contact fields incl. provider-imposed,
  pay-more price, answers/answer-modifiers, add-ons, site-assignment, quantity caps,
  thank-you redirect, `hasCustomisable`/`dayCount` serialization). See the fold
  checklist.
- **I6 — A parent with no bookable child is sold out** (everywhere: gate, cards,
  feeds, API availability).
- **I7 — Availability uses combined parent+child demand** (a shared capped group
  consumes one spot per side).
- **I8 — Every booking entry point enforces I1–I7** (web form, multi-slug URL,
  `/order`, group page, JSON API book/discovery/availability, QR, admin manual
  add, attendee merge, renewals) and every discovery/share surface suppresses
  standalone-child links.
- **I9 — No-JS first:** all child controls render non-`required` (per-child
  quantity selects default 0); requiredness/totals are enforced server-side — only
  the chosen children's prices/questions are validated; unselected (qty 0) /
  zero-quantity-parent child fields are ignored, not rejected. A positive quantity
  for a non-bookable/unknown child IS rejected.
- **I10 — Shared/multi-unit child sums** (summed quantity across parents and
  units, one `(listing_id, date)` line); reconcile only the fields the child
  carries; reject (don't clamp) over-capacity.
- **I11 — Admin/merge warn, don't block** on a per-parent child-total violation;
  but admin **listing/edge saves hard-block** an incompatible edge (date/duration,
  renewal tier, unreachable child-scoped add-on).
- **I12 — Hidden children stay pickable/auto-selectable**; being a child does not
  auto-hide; renewal/subscription tiers are never parents or children; duplication
  copies/remaps edges.

---

## Terminology (pin this down first)

The word "parent" is ambiguous, so fix it once and use it everywhere:

- A listing row stores **its parents** — "this listing is offered *under* these
  other listings."
- Therefore, from a parent's point of view, **its children** are *all listings
  that name it as a parent*. Children are always a **reverse lookup**, never a
  stored column on the parent.
- The gate fires on the **parent** being in the cart: parent in cart ⇒ must
  select a child.

So the stored edge is **child → parent** (the child knows its parents); the
runtime query we care about most is **parent → children** (given a listing in
the cart, what must the buyer choose from).

> Naming note for the eventual UI: "parents" is what the spec uses, but operators
> may find "this listing requires a choice from: …" (configured on the *parent*)
> more intuitive than "this listing's parents are: …" (configured on the
> *child*). We can store the edge one way and present it either way. See Open
> Question 1.

---

## Current architecture (what we're extending)

Grounding references, so the plan stays honest about the code as it exists today.

### Listings

- Table `listings` — `src/shared/db/migrations/schema.ts:63-123`. Columns include
  `id`, `slug`/`slug_index`, `group_id`, `active`, `hidden`, `purchase_only`,
  `unit_price`, `max_quantity`, `max_attendees`, plus trigger-maintained
  aggregates `booked_quantity` / `tickets_count` / `income`
  (`schema.ts:106-113`).
- Type `Listing` / `ListingWithCount` — `src/shared/types.ts:230-269`.
- Cache — `src/shared/db/listings.ts:268-298`. A `cachedEntityTable`
  (`createKeyedCache`) keyed by `id` and by `slug_index`, with a declared
  cross-table dependency on `listing_attendees` aggregate columns
  (`listings.ts:288-293`) so attendee writes invalidate it. `getListing`,
  `getAllListings`, `getListingWithCountBySlug`, `getListingsBySlugsBatch`.
- Delete — `deleteListing` (`listings.ts:344-357`) is a single batch that already
  cleans up the listing's `listing_attendees`, `listing_questions` and
  `activity_log` rows. **Our new link rows must be added to this batch.**

### Existing listing↔listing relationship: groups

- Table `groups` — `schema.ts:425-445`; junction is the `group_id` column on
  `listings` (`schema.ts:76`).
- Groups give a **shared booking form** (`/group/:slug`) and an optional **shared
  capacity pool**. Group members must share `listing_type` and `customisable_days`
  (`src/shared/db/groups.ts`).
- Groups are the closest precedent for "several listings booked together on one
  page" and we will reuse that page machinery (below). But groups do **not**
  express a *requirement* ("you must pick one"), only *co-location*.

### Junction-table convention

No foreign keys; the app keeps integrity via indexes + explicit cleanup. The
reference shape is `modifier_listings` (`schema.ts:480-495`):

```
modifier_listings(modifier_id INTEGER NOT NULL, listing_id INTEGER NOT NULL)
  UNIQUE INDEX (modifier_id, listing_id)
  INDEX (listing_id)
```

We mirror this exactly.

### Booking / checkout flow (no persistent cart)

- There is **no `orders`/`cart` table**. An "order" is a set of
  `listing_attendees` rows sharing one `attendees` row. Booking input is
  `AttendeeInput { bookings: ListingBooking[] }` —
  `src/shared/db/attendee-types.ts:50-86`.
- The booking page is multi-listing by URL: `/ticket/<slugA>+<slugB>` →
  `parseSlugs` splits on `+` (`src/features/public/types.ts:69-71`). The render
  context is `TicketCtx` (`types.ts:13-35`) carrying `slugs`, `listings`,
  `questions`, `questionListingMap`, `addOns`, etc.
- Form fields per listing: `quantity_<listingId>`, optional
  `custom_price_<listingId>`, plus shared `date` / `day_count`, contact fields,
  `question_<questionId>` (the **same** field name for radio, select, *and*
  free-text answers — there is no separate `answer_`/`text_` field;
  `renderQuestions`/`readQuestionAnswer`/`parseFreeTextAnswer` all use
  `question_<id>`), `addon_<modifierId>`, `promo_code`. Parsing: `parseQuantities`
  → `Map<listingId, qty>`, `listingsWithQuantity`, `parseAddOnSelections`
  (`src/features/public/ticket-form.ts:186-235`).
- Submission: `ticket-submit.ts` `processSubmission` → `prepareOrder` (parse +
  validate, no writes) → `handlePaidPath` / `handleFreePath`.
  `ticket-payment.ts`: `checkAvailability`, `buildRegistrationItems`,
  `createFreeReservation`, `runCheckoutFlow`.
- Pricing: `checkout-pricing.ts` `priceCheckout(intent)`; intent type
  `CheckoutIntent` in `src/shared/payments.ts:25-117` (`items`, `modifiers`,
  `listingAnswerIds`, …). The intent is serialized into the Stripe/Square/SumUp
  session metadata and **reconstructed in the webhook** to create the booking —
  so any child the buyer picks must be present as a normal `items[]` line *before*
  the payment session is created.
- Live quote: `POST /calculate/<slugs>` runs the same pricing without contact
  validation and returns an order-summary fragment (`ticket-submit.ts`).
- The closest existing "selecting X pulls in Y" mechanism is **answer-triggered
  modifiers** (`answers.modifier_id`) and **opt-in add-ons** (`addon_<id>`), but
  neither *requires* a sibling listing. Parents are net-new requirement
  semantics.

---

## Data model

### New table: `listing_parents`

Stores the directed edge **child → parent** (the child names its parents):

```
listing_parents(
  parent_listing_id  INTEGER NOT NULL,   -- the PARENT (another listing)
  child_listing_id   INTEGER NOT NULL,   -- the CHILD
)
  UNIQUE INDEX idx_listing_parents_pair  (parent_listing_id, child_listing_id)
  INDEX        idx_listing_parents_child (child_listing_id)  -- child → parents
```

> **Shipped schema (commit `67ad15e`).** Columns are `parent_listing_id` /
> `child_listing_id`. There is no separate parent-side index: the unique pair
> index `(parent_listing_id, child_listing_id)` already serves the hot
> parent→children lookup via its leading column, so only the reverse
> child→parents index is added (mirroring `modifier_listings`). Booking-gate SQL
> must use these exact names and rely on the pair index for parent→children.

- No FKs, matching house style (`schema.ts` note on `listing_attendees`).
- The unique pair index's leading `parent_listing_id` serves the checkout gate's
  hot path (given a listing in the cart, find its children); the child index
  serves the reverse lookup (edit page / "offered under").
- **A SCHEMA addition alone is not enough for existing databases.** Adding the
  table to `SCHEMA` (`src/shared/db/migrations/schema.ts`) makes *fresh* databases
  correct, but the migration runner refuses a SCHEMA-only change: if the live
  schema differs and no named migration is pending, `restoreStaleSchemaMarkers`
  throws *"Every SCHEMA change must ship with a new entry in MIGRATIONS."*
  (`src/shared/db/migrations.ts:309-313`). So the change must ship as **three
  coordinated edits**, mirroring the most recent migration
  (`migrations/2026-06-20_user_kek_v2.ts`):
  1. add the table (and, if adopting config (a), the parent rule columns) to
     `SCHEMA`;
  2. add a new dated migration file under `src/shared/db/migrations/` that creates
     the table + indexes additively, and register it in the `MIGRATIONS` array
     (`migrations.ts:177`);
  3. bump `LATEST_UPDATE` (`migrations/schema.ts`) to describe the change.
  Without step 2, fresh databases work while upgrades fail at boot with stale
  schema markers.

### Per-edge configuration — not needed for v1

The minimal table above encodes only "C is a child of P," which is **all v1 needs**:
the rule is fixed at **exactly one child per parent** (Open Question 2, resolved),
so there are **no per-parent min/max columns** — adding `child_selection_min/max`
would let the schema/admin API express `min=0` (skip) or `max>1` (multi-select)
states the gate, UI, and tests are deliberately **not** built to honour. If a future
version ever needs variable cardinality, the natural home is columns on the parent
(`listings`) for a uniform rule, or on `listing_parents` for a per-edge rule — but
that is explicitly out of scope now.

### Types

- Extend nothing on `Listing` for the relationship itself (keep the link out of
  the wide row). Instead add a small relationship accessor:
  - `getChildrenOf(parentId): Promise<ListingWithCount[]>` — the parent's child
    *listings*. **Important: this returns the relationship, not an
    availability-filtered list.** Bookability (sold out / closed / capacity) is
    *date- and duration-specific* for daily listings and group caps — e.g.
    `getGroupRemainingByListingId` deliberately skips daily listings when `date`
    is null (`src/shared/db/attendees/capacity.ts:100-106`). So the lookup must
    return the edges/listings and let the **render and submit paths evaluate
    availability against the submitted `date`/`durationDays`**, exactly as the
    existing booking page does. Do **not** cache a parent-only "bookable children"
    list, or a parent with a daily child can be allowed/blocked against the wrong
    date.
  - `getParentsOf(childId): Promise<number[]>` — for the edit page.
  - A batch variant `getChildrenForParents(parentIds[])` for the booking page,
    which may have several parents in the cart at once (avoid N+1).
- If we adopt config option (a), add the two ints to `Listing` /
  `ListingWithCount` and the columns list, the same way every other listing flag
  is threaded (form field → `extractCommonFields` → input → row → type).

### Caching

- Children/parents are small and change rarely. Two viable approaches:
  1. **Dedicated keyed cache** for relationships (`parentId → childIds[]`),
     invalidated on any `listing_parents` write. Cleanest separation.
  2. **Declare `listing_parents` as a dependency of the existing listings cache**
     (`listings.ts:288-293` already declares cross-table deps) and resolve
     children by intersecting cached listings with edge rows.
- Recommendation: **(1)** a tiny dedicated cache for the edges (just integer id
  arrays), then hydrate to `ListingWithCount` through the existing listings cache.
  Edges carry no PII, so the cache holds plain integers. The cache stores **only
  the relationship** (parent id → child ids); availability is computed at
  render/submit against the submitted date, never cached (see the accessor note
  above).
- **Invalidate the edge cache on whole-database replacement too**, not just on
  `listing_parents` writes: `restoreFromSql` clears the init/listings/groups/users
  caches after replaying backup SQL (`backup.ts:411-419`); the new edge cache must
  be added to that list, or a restore that changes parent links leaves the isolate
  enforcing the pre-restore graph until TTL/restart.

### Deletion / integrity

- Add to `deleteListing`'s batch (`listings.ts:344-357`):
  `DELETE FROM listing_parents WHERE listing_id = ? OR parent_id = ?` — a deleted
  listing must vanish from **both** sides of every edge. **Also invalidate the
  relationship (edge) cache** in this path: the cache stores `parentId → childIds[]`,
  so deleting the rows without clearing it would leave a stale edge that still
  renders/enforces the old child gate until the isolate restarts. (Mirror how the
  listings cache is invalidated on write.)
- Deactivating (`active = 0`) or hiding a listing does **not** delete edges; the
  gate must filter unbookable children at runtime (see Edge cases).

### Duplication / integrity

- **Duplicate flows must carry the edges (resolved: copy/remap).**
  `buildDuplicateListingInput` (`src/shared/listings-actions.ts:148`) copies only
  the listing **row**, and group duplication clones listings from that row input —
  neither carries `listing_parents` rows. So duplicating a configured parent or
  child (or a whole group for a new date) would **silently drop the required-child
  gate** on the copy. v1 **requires copy/remap**, not clearing: the duplicate paths
  must recreate the `listing_parents` edges on the new listing ids, **per endpoint**:
  - an edge with **both** endpoints cloned together (e.g. a child cloned alongside
    its parent in a whole-group duplicate) → **remap both** ids to the clones;
  - an edge with **one** endpoint cloned and the other outside the cloned set (e.g.
    duplicating a group whose parent's required child lives outside the group, or a
    cloned child whose parent is external) → keep the **original** opposite endpoint
    so the clone still has its gate / is still reachable.
  Clearing edges is **not** an accepted option, because it produces a bookable copy
  with no gate — exactly the silent drop this guards against. (Open Question 19.)

---

## Admin: configuring parents

On the listing edit page (`src/features/admin/listings.ts`, fields in
`src/ui/templates/fields.ts`):

- Add a **multi-select / checkbox list** of *other* listings. Per the
  terminology note, decide whether this control sets *"this listing's parents"*
  (edit the child) or *"children that must be chosen under this listing"* (edit
  the parent) — store the same edge either way (Open Question 1). Recommended:
  present it on the **parent** as *"Require the buyer to choose one of these
  listings"*, because that's where the operator is thinking about the upsell.
- Show the **reverse** relationship read-only too ("This listing is offered under:
  …") so the operator can see both directions from one screen — consistent with
  the "malleable software / expose the structure" preference in AGENTS.md.
- Persist edges by diffing submitted vs existing (insert new, delete removed) in
  one batch, mirroring how group/question assignments are saved.
- **Expose the edges on the admin JSON API too**, not just the edit page. The owner
  admin API (`/api/admin/listings` create/update, `src/features/admin/api.ts`) is a
  separate path used for scripted changes and bulk imports; if it can't set the
  parent/child fields (with the **same diff + validation** as the form), API-created
  or duplicated listings can't preserve their required-child gates and API updates
  bypass the relationship validation.
- **"Hidden" badge in the listings collection table.** On `/admin/listings`, show
  a small **"hidden" badge next to the public URL** for every listing with
  `hidden = 1` (this is general — it applies to all hidden listings, not only
  children), so the operator can see at a glance which listings are kept out of the
  index.
- **Visibility info message(s) on the product/edit page — separate copy for the
  two cases**, because a child is *not* necessarily hidden:
  - **Hidden listing** (`hidden = 1`): "Hidden from search engines and the main
    site." (Plus, if it's also a child, the child note below.)
  - **Child listing** (regardless of `hidden`): "This listing is offered as a choice
    under another listing; it's shown during booking when a buyer must choose between
    it and another child." For a **visible** child, do **not** claim it's
    undiscoverable — it still appears on public cards (only its standalone booking
    CTA is suppressed).
  Show whichever apply; never tell the operator a visible child is hidden.
- **Suppress/rewrite the per-listing share generators for a child.** A child's
  listing detail page still exposes its **public URL, embed snippet, and QR
  generator** (which signs `/ticket/<child>/qr-book`). Left as-is, an operator can
  copy/publish a standalone child entry point that the runtime rules then reject as
  a dead end. For a child, these generators must be **suppressed or rewritten to the
  parent** (with an "available with …" note), consistent with the no-standalone
  rule applied to public cards/feeds.

### Admin validation

- **No self-edge** (`listing_id != parent_id`).
- **No nesting (resolved).** Enforce that **a child cannot itself be a parent** and
  **a parent cannot itself be a child** — the graph is a single level, bipartite
  into "parents" and "children." This sidesteps recursion/cycles in the checkout
  gate entirely (no DFS needed). (Open Question 3.)
- Validate that referenced listing ids exist and are not soft-deleted.
- **A child needing a date/duration needs a parent that produces one — split by
  what it needs.** Don't blanket-require a *daily* parent for every
  `customisable_days` child, because a **standard `customisable_days` parent** still
  renders the shared day-count selector (`sharedDayCounts`/`dayConfig` work off
  `customisable_days`, regardless of `listing_type`) and can supply an inherited
  duration while a standard child folds with `date: null`. So split the rule:
  - a **daily child** (needs a *date*) may only attach to a **daily parent**;
  - a **`customisable_days` child** (needs a *day-count*) inherits the parent's
    **resolved duration**, which *every* parent has — `day_count` for a customisable
    parent, `duration_days` for a daily parent, and **1 for a plain standard
    parent**. Validate by the **child's `day_prices`**, not the parent kind, but
    **split static vs runtime**:
    - **Fixed-duration parent** (standard = 1 day, or fixed daily =
      `duration_days`): the duration is known at save time, so statically require the
      child to have a `day_prices` entry for it (a standard customisable child under
      a standard parent priced for 1 day is valid).
    - **Customisable parent**: there is **no single duration at save time** (the
      buyer picks `day_count`), so only require the parent's and child's day ranges
      to **overlap** at save; enforce the chosen duration **at booking** via the
      day-count filter (which drops day-count options the selected child can't
      serve). Don't reject a valid 1–3 parent / 1–2 child edge statically.
  - a plain **standard child** is fine under any parent (folds date-less).
- **Daily parent/child durations must actually match.** "Both daily" is not
  enough: the ordinary-line booking helper uses a non-customisable daily listing's
  **own `duration_days`** (`ticket-payment.ts:162-166`), so a 3-day fixed parent
  with a 1-day fixed child would reserve the child for 1 day, not the inherited 3.
  So for fixed-duration daily edges, require the child's `duration_days` to **equal
  the parent's** (or carry an explicit per-line duration override in the fold).
  This holds across the daily parent/child duration combinations, but the fix is
  "make the spans agree," not a blanket ban: a customisable child under a fixed
  parent must accept the parent's `duration_days`; and the **inverse — a
  fixed-duration child under a customisable parent — is fine *iff* the parent's
  selectable/priced day-counts can be constrained to the child's fixed
  `duration_days`** (e.g. a 1–3-day parent with a child fixed at 2 days: filter the
  shared `day_count` to 2 and both lines reserve the same span, per the child-derived
  day-count filtering rule). Only **forbid** when the parent's day-count range can't
  be constrained to the child's fixed duration (no overlap), or carry a per-line
  duration override.
- **Re-check edges on *any* listing save, not just when editing the relationship.**
  The compatibility rules above (dated-child-needs-dated-parent, renewal-tier ban)
  can be broken *after the fact* by editing a listing's `listing_type` /
  `customisable_days` / `months_per_unit` — e.g. flipping a parent from daily to
  standard while it still has a daily child. So a normal listing save must
  re-validate every parent/child edge touching that listing and **block** a save
  that would leave an incompatible edge (force the operator to repair or remove the
  edge first) — not merely warn. Persisting an impossible edge would let
  public/API/QR paths hit a config that can't be dated or priced. (Warn-only is
  right for *manual attendee bookings*, but a listing **save** must hard-fail.)
- **Forbid parent relationships on renewal tiers** (`months_per_unit > 0`) in v1 —
  neither side of an edge should be a renewal tier — because folding a normal child
  into a renewal order breaks the renewal-qualification rule (see the Renewals
  entry point). Relax only if renewal-specific gate handling is designed.
- Respect the existing dropdown of selectable listings (active + maybe hidden);
  decide whether inactive listings can be linked (probably yes, with a warning,
  since they may be activated later).

---

## Public: the booking-page gate

This is the heart of the feature and the trickiest part, because the current
booking page is built from an **explicit set of slugs in the URL**, whereas
children are **implicit** (pulled in because a parent is on the page / in the
cart).

### Surfacing children

When the booking page renders a listing that has children, render each child as a
**selectable sub-option beneath its parent** in the same form. Concretely:

- Extend `TicketCtx` (`types.ts:13-35`) with the parent→children mapping for the
  listings on the page, and load children in the context provider alongside
  questions/add-ons.
- **Field shape — a per-parent child *selector*, namespaced per parent.** Because
  the rule is "exactly one child per parent" and the child quantity is **derived
  from the parent** (not chosen), the control is a simple per-parent radio
  `child_<parentId>` whose value is the chosen **child id** (server-side
  auto-filled when the parent has a single child). It is namespaced per parent so
  two in-cart parents never share a field. A `can_pay_more` child adds a price
  input **namespaced by both parent and child** — `child_price_<parentId>_<childId>`
  — because the no-JS baseline renders a price input for *every* pay-more child of
  the parent, and a parent-only name (`child_price_<parentId>`) would be reused
  across them so `form.get` would keep only one value and mis-charge. (No per-child
  quantity field — it's `quantity_<parentId>`; no per-child date field — it's
  inherited.)
- **The child selector itself must be non-`required` in markup.** On a
  multi-listing or group page where this parent's quantity is `0` (the buyer is
  only booking a *different* listing), an HTML-`required` `child_<parentId>` radio
  would block submission. So the selector — like the child's questions and price —
  is **non-required in markup**, validated **server-side only when the parent's
  quantity is positive**; JS may toggle `required` on for the active parent.
- **Child dates: inherited from the parent (resolved).** The add-on always uses the
  **base unit's** date and duration, so there are **no per-child date controls** at
  all — the child is not given its own date selector, and at fold time it takes the
  parent line's `date`/`durationDays`. **But child availability must still feed the
  *parent's* date choices.** The shared date selector is built by
  `computeSharedDates`, which intersects only the listings it's passed
  (`ticket-payment.ts:345-359`); if we leave children out, a daily parent could
  offer a date on which its (only) child is unavailable, then fail at submit —
  contradicting "no bookable child ⇒ sold out". So a parent's offered dates must
  account for child availability — but **with multiple children on different
  calendars, use the *union* of the children's bookable dates, not the
  intersection.** (If Child A is bookable Monday and Child B Tuesday, both days are
  valid; intersecting every child would hide both.) Offer `parentDates ∩ (union of
  bookable child dates)`, and **disable each per-child option on dates that child
  can't serve**, so whatever date the buyer picks, at least one child is bookable
  and the chosen child is valid for it. **A standard (dateless) child has no date
  list of its own** — treat it as available on **every** parent date (subject only
  to its non-date capacity), so a dateless child contributes "all parent dates" to
  the union rather than an empty set (otherwise a parent whose only child is
  dateless would offer no dates at all). **Apply this per *selected* parent, not
  globally at render.** On a multi-listing/group page, several parents (and plain
  listings) share one date selector, and `computeSharedDates` intersects whatever it
  is given — so folding an **unselected** parent's child calendar into the shared
  set would wrongly remove dates for a *different* listing the buyer is actually
  booking (e.g. an unselected parent whose only child is Monday-only could strip
  Tuesday). So a parent's child-derived date constraint must apply **only when that
  parent's quantity is positive** (JS-toggled as the buyer selects it; validated
  server-side against the selected parents), never as a global render-time
  intersection.
- **A candidate date must clear the parent+child *combined* demand, not each
  listing's standalone calendar.** Capacity aggregates demand by group before
  checking caps (`capacity.ts:393-397`), so a parent and its auto-selected child in
  the **same capped group** consume **two** group spots per order. A date where the
  parent and child each have one spot left looks individually bookable but can't
  actually be booked. So the date filter (and the final submit check) must evaluate
  the folded parent **and** selected-child quantities together per candidate date,
  not just each child's own availability.
- **Day-count choices: union before selection, per-child at/after selection** —
  mirror the date rule exactly. At no-JS render of a customisable parent with
  multiple children there is **no selected child yet**, so the shared selector must
  offer `parentDayCounts ∩ (union of child-supported day counts)` — **not** an
  intersection of all children or a filter against one current child (which would
  drop, say, day 1 supported only by child A and day 2 only by child B). Then
  **disable/reject each child for submitted spans it doesn't support**, and validate
  the selected child's span at submit. **As with the date rule, only constrain the
  shared selector by a parent's child-union when that parent has positive
  quantity** — on a group/multi-listing page an *unselected* parent must not remove
  valid spans for the listing the buyer is actually booking.
- **Quantity cap: union/max before selection, selected child at/after — using
  *combined* demand.** Since child quantity follows the parent (and a single child
  auto-selects), the parent quantity control (driving `parseQuantities` off
  `TicketListing.maxPurchasable`) must reflect child capacity. Each candidate child's
  contribution to the cap must be computed from the **combined parent+child folded
  demand**, not the child's remaining spots in isolation: if parent and child share a
  **capped group** with one spot left, the child shows one remaining but the folded
  booking consumes **two** group spots, so that candidate's cap is 0. With
  **multiple** children and no selection yet, cap by the **max** of those
  combined-demand caps across currently-selectable children (don't block a valid
  high-capacity sibling). Then **re-cap/validate against the *selected* child** (JS
  toggle as it's chosen; enforce at submit). For a single auto-selected child, cap
  directly by its combined-demand availability.
- **Child questions** must be merged into `questionListingMap` with the **correct
  shape**: it is `Map<questionId, listingId[]>` (`questions.ts:361`), read by
  `prepareOrder` as `ctx.questionListingMap.get(q.id)` — *keyed by question id*, not
  by listing id. So a child question's entry is `questionId → [...existing,
  childListingId]`. Keying by the child's listing id (the inverse) would fail to
  activate child-specific questions and silently skip required child answers and
  answer-triggered modifiers. The child's answer fields use the standard
  `question_<questionId>` name (see no-JS note below for rendering and which answers
  are read at submit). **Duplicate `question_<id>` controls must be avoided wherever
  they arise** — not only when the *same* child is chosen under two parents, but
  also across **sibling child options that share a question** (including
  `assign_all` questions): rendering each child's questions in its own block would
  emit the same `question_<id>` twice, and `form.get` reads one value, so a
  hidden/unselected sibling's blank copy could be parsed instead of the selected
  child's answer. Render each distinct question **once**, or namespace per
  child/parent and reconcile to the selected child's answer (the same rule as the
  pay-more price).

### Progressive enhancement

The form is server-rendered with light JS (the repo favours server HTML + small
client scripts). The child selector should:

- Be **fully functional without JS**: server-side validation is the source of
  truth. If a parent is in the cart and no child is chosen, the submit is rejected
  with a clear error via the existing PRG error-redirect
  (`ticketFormErrorResponse`, `ticket-form.ts:181-184`) and the form re-fills.
- **Child questions must be answerable without JS.** This is in tension with
  "show child questions only when the child is selected": on a server-rendered page
  the server doesn't know the buyer's child choice until submit, so hiding child
  questions behind a JS reveal would leave no-JS users unable to answer a required
  child question. Resolve it by **rendering every child's questions in the no-JS
  baseline** (always in the DOM, optionally hidden via a **CSS-only reveal** tied
  to the per-parent child selector), and at submit **reading answers only for the
  child that was actually chosen**. **Crucially, child questions must not carry the
  HTML `required` attribute.** The existing question renderer emits `required`
  controls for every question, and a **CSS-only reveal does not disable HTML
  constraint validation** — so a hidden-but-`required` question for an *unselected*
  child would block a no-JS buyer from submitting at all. Render child questions
  **non-required in markup** and enforce requiredness **server-side, only for the
  chosen child**. (JS enhancement may re-add `required` to the selected child's
  questions for inline feedback.)
- **The same no-`required` rule applies to the child pay-more price input.**
  `renderPayMoreInput` adds `required` whenever the minimum price is above zero
  (`reservations.tsx:150`). A `can_pay_more` child's price input rendered for an
  *unselected* child would block a no-JS submit, so it must be **non-required in
  markup**, with the price required **server-side only when that child is the
  chosen one**. (There is no child *date* control to worry about — children inherit
  the parent's date.)
- Be **enhanced with JS** to (a) reveal each parent's child block (selector + its
  date/questions/price) only when the parent quantity > 0, (b) re-add `required` to
  the selected child's fields, and (c) include selected children in the live
  `/calculate` quote. Add this to the client booking enhancement script (new or
  existing `src/ui/client/*`).

### Server-side validation (authoritative)

In `prepareOrder` (`ticket-submit.ts`), after `parseQuantities`:

1. Determine the set of in-cart listings with `qty > 0`.
2. **Resolve the order's `date`/`day_count` first.** Today `prepareOrder` doesn't
   validate date/day-count until later (`ticket-submit.ts:593-604`), but the child
   bookability filter below needs them — evaluating a daily/customisable child's
   availability against a null/default date would auto-select or reject against the
   wrong date. So move date/day-count resolution **ahead of** the child filter (or
   defer the filter until those values exist).
3. **Identify parents from the relationship edges, not from "has bookable
   children".** A listing is a parent if it has *any* child edge. *Then* filter that
   parent's children to the bookable ones (active, **not registration-closed**
   (`isRegistrationClosed`, since a child past its own `closes_at` may still have
   capacity but must not be selectable), not sold out, bookable on the resolved
   **parent date/duration**). If the bookable set is **empty**, the parent
   is **sold out** — reject the whole order (don't let it through just because no
   child is available). Otherwise apply the rule: **exactly one child selected,
   always required**. **Auto-select only covers the *no-choice* case:** when the
   buyer submitted no `child_<parentId>` value *and* there is exactly one bookable
   child, the server picks it. If the buyer **did** submit a child that is no longer
   bookable (it sold out/closed between render and submit), **reject with the normal
   sold-out/invalid-selection error** — do **not** silently swap in a different
   still-bookable sibling (that would change the price/questions/fulfilment from
   what the buyer chose).
4. Read each parent's **child selection** from a per-parent selector
   `child_<parentId>` (a radio — exactly one child id, since the rule is "one per
   parent"; auto-filled server-side when there's a single bookable child). The
   chosen child's **quantity is derived from the parent's quantity** (not
   submitted). **Date and duration inherit separately** (see Confirmed behaviour): a
   **daily** child takes the parent's date; a **standard** child folds with
   `date: null` (cumulative capacity — never write the parent's date onto it); and a
   **`customisable_days`** child inherits the parent's resolved day-count for its
   `day_prices`/`dayCount` **even when it is standard/dateless** (don't leave a
   dateless duration add-on at the default one-day span). A
   `can_pay_more` child also carries `child_price_<parentId>_<childId>`. **Only read
   `child_*` fields for parents that are actually in the cart** (`quantity_<parentId>
   > 0`); **silently ignore** the rest. The no-JS baseline renders every parent's
   child controls (with single-child selectors preselected and pay-more inputs
   pre-filled), so a buyer booking a *different* listing will submit `child_*`
   fields for parents at quantity 0 — these must be dropped, **not** rejected, or an
   honest order fails. **Within an in-cart parent, read only the *selected* child's
   fields**: the baseline renders a `child_price_<parentId>_<childId>` for every
   pay-more child option, so ignore the unchosen siblings' price inputs (a blank or
   out-of-range value on an *unselected* sibling must not fail the booking) and
   validate only the chosen child's price. *Do* reject genuinely invalid input tied
   to the **selected** child of an in-cart parent: a selector naming a listing that
   isn't its child, or a missing/out-of-range price for the selected pay-more child.
5. **Children are never standalone cart lines** (a booking can't start from a
   child — see Confirmed behaviour). The **enforcement mechanism** is that child
   slugs are **stripped/rejected from any ticket slug list** before building
   `ctx.listings`: `handleBySlugs` passes every active slug through
   `withActiveListings` into `ctx.listings` (`ticket-submit.ts:892-905`,
   `ticket-payment.ts:336-341`), so a URL like `/ticket/parent+child` or
   `/ticket/child+other` would otherwise render the child as an ordinary quantity
   line and let it be booked independently. A child slug in the URL must produce a
   **clear rejection / redirect to an available parent**, for **single and
   multi-slug** URLs alike — **not a silent drop**: silently removing the child from
   a mixed list (`/ticket/child+other` → a form for `other`, or `/ticket/parent+child`
   losing the explicit child context) changes what the buyer is booking with no
   signal. After that, the gate's *only* child input is the per-parent selector.
   *(Historical note: earlier drafts tried to reconcile a standalone
   `quantity_<childId>` line shared across parents; rejecting child slugs removes
   the case entirely.)*
6. **Shared child across two parents → sum the quantities.** If the same child is
   chosen (or auto-selected) under two in-cart parents, fold it into **one
   `(listing_id, date)` line whose quantity is the sum** (one per parent), since the
   booking shape can't hold duplicate slots. Two reconciliations:
   - **Capacity: reject, don't clamp.** If the summed quantity exceeds the child's
     available capacity / `max_quantity` (e.g. parents 2 + 2 but the child only has
     3 left), the cart must be **rejected** — clamping to 3 would reserve 4 parents
     against only 3 children and break the one-child-per-parent invariant.
   - **Pay-more price:** if the child is `can_pay_more`, the two parents'
     `child_price_*` values must be **equal** (same add-on) — reject a mismatch,
     since the merged line carries one price.

7. **Reject** if the rule isn't satisfied (a required child not chosen for an
   in-cart parent), with a message naming the parent. Use
   `REGISTRATION_CLOSED_SUBMIT_MESSAGE`'s sibling pattern for messaging.
8. On success, **fold the selected children into the order as real listings —
   lines *and* the listing set.** Adding them to `quantities` alone is **not**
   enough: `checkAvailability` (via `listingsWithQuantity`) and
   `buildRegistrationItems` both iterate the **`TicketListing[]` they are passed**,
   not the quantity map. A child is never a URL slug, so it is not in `ctx.listings`
   — without expanding the set the order could pass the gate yet **omit the child
   from capacity checks, pricing, and payment metadata**. The fold must therefore
   **expand the `TicketListing` set** with the selected child listings (loaded via
   the relationship accessor, with availability resolved for the parent's date)
   *before* calling those helpers. When the **same child** is chosen under
   multiple parents, **merge to a single
   `(listing_id, date)` line with summed quantity** — the booking shape can't store
   duplicate slots (see Shared-child edge case). After this expansion a child is a
   normal line through `buildRegistrationItems` → `CheckoutIntent.items` → pricing
   → payment metadata → webhook reconstruction.
   This is the key design property: **a child is a normal line once selected; only
   the gate and the line-set expansion are special.**

### The fold must feed *every* per-listing path, not just availability

"Expand the listing set" is load-bearing because `prepareOrder` runs several
per-listing computations off `ctx.listings` / the selected set. Folding a child
into `quantities` without expanding the listing set silently skips all of these.
The expanded set (parent page listings ∪ selected children) must drive **all** of:

- **Capacity & item building** — `checkAvailability` (via `listingsWithQuantity`)
  and `buildRegistrationItems` iterate the listing set (`ticket-payment.ts`).
- **Contact fields** — the form renders/validates contact fields from
  `getTicketFieldsSetting(ctx.listings)` (`ticket-submit.ts:126`). A child with
  stricter `fields` (e.g. requires phone/address) must contribute to the required
  set **when selected** — but rendering *every* possible child's fields would make
  unselected children's fields required. So `fields` needs the **same
  selected-child / no-JS rule as questions**: render all children's contact fields
  in the baseline, but only require/validate the chosen child's.
- **Paid-ness of the field set must include paid children.** Even a child with
  *empty* `fields` changes the field set: `getTicketFields(fieldsSetting, isPaid)`
  adds Square's required email when `isPaid` (`fields.ts:1045-1053`), and the
  renderer computes `anyPaid` from the page listings/add-ons **before** folded
  children exist (`reservations.tsx:707-710`). A **free parent with a paid child**
  under Square would then render no email input, yet post-fold paid validation
  would require one the buyer never saw. So render-time `anyPaid` must include
  **possible/selected paid children**, not just the page listings — the email field
  must be **present in the markup**. But it must follow the same **non-required**
  rule as other child-conditional fields: feeding *possible* paid children into
  `getTicketFields(..., true)` would otherwise mark email `required` and block a
  buyer who picks a *free* child or leaves that parent at quantity 0. So render the
  provider-imposed paid field **non-required (JS-toggled)** and enforce it
  **server-side only when the folded order is actually paid**.
- **Custom (pay-more) price** — ✅ supported (Open Question 15). A `can_pay_more`
  child renders a price input named by **both parent and child**,
  `child_price_<parentId>_<childId>` (a parent can have several pay-more children
  rendered in the no-JS baseline, so a parent-only name would collide and
  `form.get` would keep one value). The fold feeds that amount into the child line
  where the submit path would otherwise read `custom_price_<childId>`
  (`ticket-submit.ts:145`). For a **shared** child booked under two parents (Q8),
  the two `child_price_<parentId>_<childId>` values must be **equal** (same add-on)
  — reject a mismatch, since the merged line carries one price.
- **Optional add-ons** — `getOptionalAddOns(listingIds)` (`ticket-payment.ts:375`)
  is scoped to the listing ids. Add-ons scoped *only* to a child won't load if we
  pass just the parent page ids; loading add-ons for *every* possible child lets a
  no-JS user opt into an add-on for an unchosen child that pricing then drops.
  v1 chooses **not to support child-scoped add-ons** (Open Question 16). **But that
  default needs a guard:** the existing modifier-scoping UI/DB can already attach
  opt-in add-ons to a listing that *later* becomes a child, after which the parent
  flow silently won't load them (they're scoped to a listing that's never in the
  page id set). So while child-scoped add-ons are unsupported, admin must **hard
  block** the config — not merely warn — but **only when the add-on would be
  reachable *solely* through the suppressed child**. The test is reachability, not
  "the child appears anywhere in the scope": an add-on scoped to **both** the parent
  and the child, or to a **group that contains the rendered parent**, still loads via
  the parent's page ids (`getOptionalAddOns(pageListingIds)` intersects the expanded
  scope — `modifiers.ts:212-219`, `modifier-resolve.ts:376-387`) and must **not** be
  blocked. Block (and re-check on group-membership / modifier-scope changes) only the
  case where the add-on's entire reachable scope is child listings that the parent
  page suppresses. (Lift the block once the conditional child add-on render/parse
  path is implemented.)
- **Site-assignment validation** — `prepareOrder` calls
  `validateSiteAssignmentConfig(selected)` (`ticket-submit.ts:578`) before
  checkout. A child with `assign_built_site` set (parent without) must be in the
  **expanded** set passed to this check, or a misconfigured builder order can
  complete and then silently skip assignment post-booking.
- **Thank-you redirect (free *and* paid).** `handleFreePath` only honors a
  listing's `thank_you_url` when `ctx.listings.length === 1`
  (`ticket-submit.ts:427-429`), and the **paid** path has the same single-listing
  assumption: the webhook derives `thank_you_url` only when the completed booking
  has **one unique listing id** (`webhooks.ts:1193-1199`). Folding a child turns a
  single-parent booking into a **multi-listing** order, so both paths drop the
  operator's custom parent thank-you URL the moment a required child is selected.
  Define an explicit precedence — **keep the original (pre-fold) parent's
  redirect** when the order is a single parent + its folded children — and carry it
  through **every** entry point that folds children into a paid order: the web free
  path, the web payment callback/metadata, **and the QR single-child auto-checkout
  and API parent bookings** (both also fold children into `CheckoutIntent.items` and
  hit the same webhook success path that drops `thank_you_url` once there is >1
  unique listing id). Otherwise a parent booked via QR/API silently loses its
  configured thank-you URL.
- **Quantity caps after aggregation** — when the same child is summed across
  multiple parents, the aggregate line can exceed the child's `max_quantity` /
  `maxPurchasable` even though each per-parent input was individually clamped. The
  **folded** quantity must be re-validated against the child's max-purchasable
  limit and the cart **rejected** if it exceeds it — **never clamped**, since
  clamping would keep all parent rows while silently dropping required child rows
  (2 + 2 parents with only 3 child spots).
- **Questions & answer-triggered modifiers — child selection must move ahead of the
  question parse.** `prepareOrder` computes `activeQuestions` and calls
  `parseQuestionAnswers` using the **pre-fold** `selectedListingIds`, *then* prices
  answer modifiers via `answerModifierQuantities(computeListingAnswerMap(ctx, info),
  quantities)` (`ticket-submit.ts:633-634`). So expanding the selected ids with the
  chosen children must happen **before the question-parse block**, not just before
  modifier pricing — otherwise a selected child's required questions are excluded
  from parsing/validation entirely. The folded child must be in the **answer map,
  selected ids, *and* quantity map** before those calls, or a parent+child order
  records no child answer and skips its modifier's surcharge/stock.
- **Customisable-day children** — ✅ resolved by the "inherit duration" decision,
  but **derive the inherited duration from the parent line's *resolved* duration**,
  not from a submitted `day_count` that may not exist. The parent's duration is
  `day_count` when the parent is `customisable_days`, but **`duration_days`** when
  the parent is a *fixed*-duration daily listing (`customisable_days=false`,
  e.g. `duration_days=3`). The current day-count resolver returns `1` unless a
  *selected* listing is itself customisable, so a fixed-3-day parent with a
  customisable child would otherwise price/book the child as 1 day. The child takes
  the parent's resolved duration and its `day_prices` are validated/priced for
  **that** value; it is never fed into `sharedDayCounts`.
- **Force `dayCount` into the serialized intent when a folded child is
  customisable.** `checkoutIntentForSubmission` only writes `dayCount` into the
  provider metadata when `hasCustomisable` is true, and that flag is computed from
  the **pre-fold** selected listings. So a fixed-duration parent whose *only*
  customisable item is a folded child would set the child's inherited span locally
  but **omit `dayCount` from the metadata**, and the webhook would reconstruct the
  child at the default 1 day. The fold must **recompute/force `hasCustomisable`
  (and the serialized `dayCount`) from the folded children**, not just the page
  listings.

### Pricing & payment round-trip

- Because children become ordinary `items[]`, `priceCheckout`
  (`checkout-pricing.ts`) and the provider metadata packing handle the extra lines
  without structural change — they already price arbitrary multi-line orders.
- **Child dates ride the order date — with one duration caveat.** Because the child
  **inherits the parent's date/duration** (Open Question 14, resolved), it uses the
  same order-level `CheckoutIntent.date`/`dayCount`, so there's no per-child *date*
  to lose. **Duration is subtler:** `bookingDateFields` (`ticket-payment.ts:154`)
  only applies the order-level `dayCount` to items that are themselves
  `customisable_days`; otherwise daily items use their own `duration_days` and
  standard items get 1. So the round-trip is correct as long as a single order has
  **one shared day-count**. It breaks only in a multi-parent order where two parents
  have **different** durations and a customisable child must inherit each — the
  single `CheckoutIntent.dayCount` can't represent both, and the child would be
  priced/booked at the wrong duration. **Note this is *not* fully prevented by the
  shared selector:** fixed-duration daily listings don't use that selector, so two
  fixed-duration parents with **different** `duration_days` can already coexist in
  one cart, each folding a customisable child that would need a different inherited
  span. v1 must therefore **explicitly reject a cart/group that requires more than
  one distinct duration across *all* customisable order lines — original page
  listings *and* folded children**, not just folded-child-vs-folded-child. A buyer
  can select a 3-day customisable *page* listing alongside a fixed 1-day parent
  whose folded customisable child must inherit 1 day; the single
  `CheckoutIntent.dayCount` (applied to every customisable item by
  `bookingDateFields`/metadata) can't represent both, so the child would be
  priced/booked for 3 days. **This check belongs in the shared prepare/fold step so
  it covers *all* paths — free submit, `/calculate`, API, and QR — not just paid
  checkout**: the free reservation path also builds every customisable item from the
  single shared `dayCount`. Reject any distinct required durations among customisable
  lines; only add **per-line duration** to `BookingItem` + metadata + webhook
  reconstruction if mixed durations in one order ever become a real requirement.
  *(Historical note: an earlier draft proposed per-child date controls, creating an
  intersection + round-trip problem; the inherit decision removed the date half,
  leaving only this duration caveat.)*
- The `/calculate` quote must include selected children; it shares the
  `prepareOrder` path, so the fold + listing-set expansion there covers it.
- The **webhook** reconstructs the booking from `CheckoutIntent` metadata. Since
  children are already in `items[]` before the session is created, the webhook
  needs no parent-awareness. **Verify** the gate is *not* re-run in the webhook
  (the buyer already satisfied it at checkout; re-validating against live data
  could spuriously fail a paid order).

---

## Other entry points that must respect (or intentionally skip) the gate

The booking page is not the only way a `listing_attendees` row is created.
Enumerate each and decide:

- **A child's own page can't start a booking** (resolved). Visiting
  `/ticket/<childSlug>` must **not** offer a buy button for the child alone — show
  an "available with …" note instead. Children only ever enter an order through a
  parent's selector, so the gate has a single, well-defined input everywhere.
- **Public listing cards `/listings` (and the gallery).** A *visible* (non-hidden)
  child is still rendered as a card: `isPublicListing` filters only `active &&
  !hidden` (`pages.ts:37`) and the card links a Book/Buy button straight to
  `/ticket/<slug>` (`homepage.tsx:24-31`). That would advertise a child as
  standalone-bookable and send buyers to the dead-end child page. So for a child
  row, **suppress the buy link** (show "available with …" / link to a parent)
  rather than a direct booking CTA. (A common pattern will be to simply mark the
  child `hidden`, but visible children must be handled too.) **And the reverse for
  parents:** a parent whose required children are *all* unavailable
  (inactive/sold-out/closed) must render its card as **sold out** — the card state
  today comes from the parent's *own* capacity (`buildTicketListing`), so the
  child-derived "no bookable child ⇒ sold out" state must feed the parent's public
  card too, or the index advertises a Book button the gate will reject. **This is
  the *combined* parent+child demand check, not just "is any child available"**: when
  parent and child share a capped group, booking one parent auto-books one child and
  consumes **two** group spots, so a parent with one remaining group spot is already
  sold out for the minimum order even though a child looks individually available.
  The same combined-demand check used for the date filter must drive card/feed
  availability.
- **RSS/ICS feeds** (`src/features/feeds.ts`) — unlike a card there's **no button
  to suppress**: each feed item's `URL`/link points directly at `/ticket/<slug>`
  for every active visible listing. So a visible child would be **syndicated as a
  standalone ticket URL** — **omit child items from the feeds** (or point their link
  at the parent). And the same parent rule applies: `loadFeedData` syndicates active
  visible open listings without considering child availability, so a **parent whose
  required children are all unavailable must be omitted** too (it would otherwise
  publish a link to a booking the gate rejects as sold out).
- **Single-listing / group booking page** `/ticket/<slug>` — one route serves both:
  `slugHandler` tries listings by slug and, for a single slug that isn't a listing,
  **falls back to `handleGroupTicketBySlug`** (`ticket-routes.ts:46-52`). There is
  **no separate `/group/:slug` form route** — the group form is just
  `/ticket/<groupSlug>`. Both flows run `processSubmission`, so the gate applies
  automatically; render the parent's child selector here too.
- **Group bookings** — because a group form is the same `/ticket/<groupSlug>` flow,
  the gate and child-suppression must be wired into `handleGroupTicketBySlug`'s
  listing set, which **loads all active group listings**. This is **enforcement, not
  cosmetic**: a child that is also a group member is in that original listing set, so
  unless it is **explicitly suppressed** (removed from the independently-selectable
  set, offered only via its parent's selector) **or the parent/child-in-same-group
  edge is forbidden**, the group page would render the child as its own quantity
  line and let it be booked standalone — bypassing the per-parent selector. So apply
  the same child-suppression here as everywhere else. (Open Question 6 is only the
  cosmetic *follow-on*: whether to let an operator list a child as a group member at
  all.)
- **Order/gallery page** `/order` — `bookingUrlFor` (`order.ts:56-64`) turns the
  gallery selection into a `/ticket/<slugs>?q_<id>=1` redirect. Since children
  aren't standalone-bookable, the gallery must **not offer children as selectable
  items** at all, so the redirect can only ever contain parents (and ordinary
  listings) — no parent+child slug list arises. Cover in tests.
- **Admin multi-booking link builder.** The admin dashboard's `multiBookingSection`
  renders checkboxes for **all** `activeListings` and the client joins their slugs
  into `/ticket/<slug+...>`. If children stay selectable there, an operator can
  generate/share a child-containing URL — which the server slug-strip must then
  reject. Exclude children from this builder (or mark them "available with …"), the
  same suppression as the public gallery, so the link can't be built in the first
  place.
- **Public/JSON API booking** (`POST /api/listings/:slug/book`, `src/features/api`)
  — ✅ **IMPLEMENTED.** Parents are API-bookable with per-unit child selection,
  reusing the web fold so the API and web validate/price identically (Open Question
  9 resolved):
  - **Child slugs rejected as the entry point** (`anyChildListing` → 400) and the
    booking quantity + date resolved once for both the standalone and parent paths.
  - **Per-unit child selection** via a `children: [{ slug, quantity, customPrice? }]`
    array (an absent array auto-fills a sole child). Slugs resolve against the
    parent's actual children and map onto `foldSelectedChildren` through
    `child_qty_*` / `child_price_*`, so the chosen quantities must total the parent
    quantity, and a slug that isn't a child of the parent is rejected.
  - **Multi-item pricing/availability** from the folded order: free (or
    provider-less paid) orders create the parent + children atomically via
    `createFreeReservation` (`ensureAllBookings`, all-or-nothing); paid orders open a
    **multi-item checkout** whose webhook creates and pairs every row. Either way the
    parent/child link is recomputed at creation (`annotateOrderParents`).
  - **Contact fields validated *after* child expansion** against the merged
    parent+child requirements and the folded paid-ness, so a free parent with a paid
    child still demands the inputs that child (or Square) needs.
  - **Customisable parents stay rejected** (no `dayCount` input in the contract).
  - **Discovery + availability carry the relationship** (see below): the parent
    detail lists its required children (slugs/prices/inputs/dates) and the
    availability endpoint reports per-child availability for the date/quantity.
- **JSON API discovery + availability** — ✅ **IMPLEMENTED.** `GET /api/listings`
  omits children and projects a no-bookable-child parent to sold-out;
  `GET /api/listings/:slug` 404s a child, constrains a daily parent's
  `availableDates` to the child-union, and adds a `children` array (each required
  child's public shape — slug, price, pay-more range, customisable day prices,
  sold-out, and a daily child's own bookable dates);
  `GET /api/listings/:slug/availability` 404s a child, reports a no-bookable-child
  parent as unavailable, and adds a `children: [{ slug, available }]` array
  evaluating each child for the requested date/quantity.
- **QR direct-checkout link** (`src/features/public/qr-book.ts`) — ✅ parents are
  QR-bookable, but **a QR link for a *child* must be rejected/redirected to a
  parent**: the QR route also starts from a plain listing slug, so a signed
  `/ticket/<child>/qr-book` would otherwise render/skip checkout for the child alone
  — breaking no-standalone-child. `handleQrBookGet` → `skipToCheckout` →
  `buildCheckoutIntent` (`qr-book.ts:83-152`) builds a one-item session **without**
  `prepareOrder`, so it must become gate-aware. **Because it skips `prepareOrder`,
  the skip path must itself verify the auto-selected child is bookable for the QR
  payload's date and quantity — including the folded parent+child combined
  capacity — before building the session**, or a parent QR code whose only child is
  sold out/closed would still create a checkout and **charge the buyer** before the
  later all-or-nothing save fails/refunds. With the single-child auto-select, the
  common one-parent-one-child quick-buy **can still skip to checkout** — *but only
  when **both** the parent **and** the auto-selected child are
  direct-checkout-safe*. The parent must still satisfy the **existing**
  direct-checkout preconditions — including **provider-imposed** fields, not just its
  own configured ones: `getTicketFields(..., true)` adds a required email for Square
  when the order is **paid**, so a paid parent with empty `fields` (even with a free,
  safe child) still needs the form. (`skipToCheckout` bypasses `prepareOrder` and
  builds blank contact/answer metadata, so a parent with *any* required input —
  configured or provider-imposed — must use the form regardless of the child.) The
  child likewise must add no new requirement: no required contact
  fields/questions, not `can_pay_more`, **and has a resolved inherited duration that
  the QR intent can carry**. A `customisable_days` child does **not** force a
  fallback by itself: under a **fixed-duration parent** (standard = 1 day, fixed
  daily = `duration_days`) the inherited span is known, and the fold already forces
  `dayCount` into the metadata, so the primary base-unit-plus-customisable-add-on QR
  case can skip safely. Fall back to the form only when there is **no resolved
  duration** (a *customisable parent*, since the QR skip has no `day_count` input —
  see next), a **mixed-duration conflict**, or child inputs the skip can't collect.
  Likewise fall back **when a paid child introduces a provider-imposed contact
  requirement** — a *paid*
  child under Square makes `getTicketFields` require email (`fields.ts:1045`) even
  when the parent is free, but the QR skip builds the checkout with blank contact
  fields, so this case must also fall back to the form. **The *parent* being
  `customisable_days` also forces a form fallback**: the QR skip path has no form
  `day_count` (and the route rejects customisable route listings today), so a
  customisable parent — even with a single fixed child — would build a
  `CheckoutIntent` with no chosen duration and reconstruct at a default/one-day
  span. Otherwise, and whenever the parent has **more than one** child, **fall back
  to the form** so the buyer's child gets the right inputs/duration. **Also scope
  the QR price override:**
  `applyQrTokenOverride`
  verifies `ctx.slugs[0]` then applies the signed price to **every** fixed-price
  row in `ctx.listings` (`ticket-submit.ts:166-176`); once the fold adds children,
  the override must apply **only to the scanned parent**, never to folded children
  (else a fixed-price child is charged the parent's signed value). (Open Question
  10.)
- **Admin manual add / attendee edit** — ✅ **warn but don't block.** Admins build
  `AttendeeInput.bookings` directly (and can `allowOverbook`); the gate is a buyer
  UX constraint, so manual add shows a warning when a booking is inconsistent but
  lets the operator proceed. The check counts, **per parent line**, the matching
  child lines and warns unless they satisfy the invariant — covering: a **parent
  with no child**, a **parent with two or more of its children**, a **child line
  with none of its parents**, and a **quantity mismatch** (the folded child quantity
  must equal the **sum of the matching parent quantities** — e.g. parent qty 2 with
  child qty 1 is wrong even though one child line exists). For **daily** edges the
  match must also align on the **booking slot** (`start_at`/`end_at`), not just
  listing id — a parent booked Monday with its child on Tuesday is *not* a valid
  match, since the child must inherit the parent's date/duration. (Open Question 7.)
- **Attendee merge** also mutates booking lines directly: `bookingInsertStatement`
  (`src/shared/merge/attendee-merge.ts`) copies `listing_attendees` rows onto the
  target and deletes the source. A merge can produce any of those same states, so
  apply the identical per-parent check/warning in the merge diff/confirmation flow —
  and since the merge diff already keys bookings by `listingId:startAt`, match the
  parent and child on **`start_at`/`end_at` as well as listing id** (a child on a
  different slot than its parent is not a satisfying match).
- **Renewals** (`/renew/?t=…`, `actionUrl` override in `TicketCtx`) — **not safe
  to hand-wave once parent config is exposed.** `/renew/` renders the normal ticket
  flow with a `siteToken`, but `applyRenewalsForEntries` rejects the renewal unless
  *every* completed line is a qualifying hidden purchase-only renewal tier. So if a
  renewal tier is configured as a parent: enforcing the gate by folding in a normal
  child makes the paid renewal **complete without extending the site deadline**
  (the child line fails the renewal qualification); skipping the gate **bypasses
  the requirement**. ✅ Resolved: **renewal/subscription tiers can't be parents or
  children at all** (`months_per_unit > 0`) — block it in admin validation. (Open
  Question 18.)

---

## Edge cases

- **Child unbookable** (inactive / closed / sold out). The gate must only require
  selection from **currently bookable** children. Two flags that look like
  eligibility but are **not**, and must **not** be used to filter children:
  - **`hidden`** — the ticket flow still loads hidden listings by direct slug;
    only the public index/gallery excludes them. A child hidden from the index must
    still be selectable under its parent (matches the "Hidden children" note
    below).
  - **`purchase_only`** — this is the **"No Check-In"** flag (it changes labels and
    hides ticket artifacts — `homepage.tsx:28-30`, `tickets.tsx:72-80`), **not** a
    paid-only / "no free bookings" constraint. The free-vs-paid decision keys off
    `unit_price` / custom price (`booking.ts:47-49`), so a purchase-only child can be
    **free**. Do **not** filter children on `purchase_only` (a free No-Check-In
    add-on is valid), and **don't infer pricing from it** — a child's price comes
    only from its price fields. If some specific combination really is unsupported,
    define and enforce it explicitly rather than via a blanket filter.
   If a parent's *only* bookable child is sold out, the parent
  effectively cannot be booked — decide whether to (a) hide/disable the parent, or
  (b) show it with a "currently unavailable" note. Recommended: treat "no bookable
  children" the same as "parent sold out" and block, with a clear message. (Open
  Question 5.)
- **Quantity coupling.** ✅ Resolved: the child quantity **follows the parent** —
  the buyer picks the child *type*, and its quantity is set to the parent's
  quantity (3 base units ⇒ 3 add-ons). The child quantity is therefore **derived,
  not an independent input**; the gate computes it from the parent line. (Open
  Question 4.)
- **Shared child across multiple in-cart parents (allowed — book two).** If
  parents P1 and P2 are both in the cart and both have child C, the buyer books
  **one C per parent**. The downstream booking shape can't hold two lines for the
  same `(listing_id, date)` (`createAttendeeAtomicImpl` rejects duplicate slots and
  `parseQuantities` is listing-id-keyed), so the fold **merges them into one line
  with the summed quantity** (P1 + P2 ⇒ qty 2). The gate computes this *before*
  building `ListingBooking[]`, so it never "passes" then fails at save.
  - **Reconcile only the fields the child actually carries** (the merged line holds
    one of each). Do **not** reject merely because the two parents have different
    date contexts: a **standard/dateless** shared C folds `date: null` regardless, so
    a daily parent and a standard parent both selecting the same standard C is fine.
    Reconcile only what C stores: for a **daily** C the two parents' dates must
    match (it carries one date); for a **`customisable_days`** C the two inherited
    durations must match (one `dayCount`); for a `can_pay_more` C the two
    `child_price_*` values must be **equal**; and questions resolve to one answer
    set. Reject only a genuine mismatch on a field C carries.
- **Child is also a parent (nesting).** Forbidden in v1 (see Admin validation).
  If allowed later, selecting a child that is itself a parent recursively requires
  *its* children — the gate must loop until fixpoint, and cycle detection becomes
  load-bearing.
- **Hidden children.** A child may be marked `hidden` (excluded from the public
  index) yet still reachable/required via its parent. `hidden` does not suppress it
  on the parent's booking page (`hidden` governs the index, not direct/linked
  access). **But the noindex guard must be extended:** `handleTicket` currently
  applies `applyHiddenNoindex` based only on the route's *original*
  `listings.some((e) => e.listing.hidden)`, so a hidden child rendered on a
  *visible* parent page would not flip the page to noindex — exposing the hidden
  child's details to crawlers. The noindex decision must include **rendered hidden
  children**, not just the original page listings (or otherwise keep hidden
  children's details out of crawlable markup).
- **Capacity & groups.** Child capacity is its own `max_attendees`; selecting it
  consumes capacity normally. If parent and child share a group capacity pool,
  the existing group-remaining capping applies to both lines.
- **Parent + child in the same group.** The group form (`/ticket/<groupSlug>` →
  `handleGroupTicketBySlug`) loads **all** active group listings (`groups.ts:27-42`),
  so a child that is also a group member would otherwise appear as its own selectable
  row. **Resolved behaviour: suppress the child from the group's
  independently-selectable set** (it's offered only via its parent's selector) —
  the *same* child-suppression applied everywhere else — rather than hard-blocking
  the edge. So a same-group parent/child config is **allowed and handled at render**,
  not rejected at save. (Open Question 6 is now only the cosmetic choice of whether
  to let an operator add a child to a group at all; if we ever chose to forbid the
  edge instead, that check would also have to run on group-membership writes, not
  just edge-save — but suppression avoids needing it.)
- **Deleting/deactivating a parent or child mid-session.** The buyer's submitted
  selection is re-validated server-side at submit, so a stale page that lost a
  child fails cleanly rather than booking a dead listing.

---

## Testing plan (100% coverage, mutation-resistant per AGENTS.md)

- **DB layer**: insert/read/delete edges; `getChildrenOf` returns the
  **relationship only** (assert it returns *all* linked children regardless of
  date/availability — do **not** lock in "bookable-only" filtering here, which
  would re-introduce the wrong-date bug for daily children/group caps);
  `getParentsOf`; batch loader avoids N+1; `deleteListing` removes edges from both
  sides; cache invalidation on edge writes.
- **Availability**: bookability of a child is tested at render/submit against a
  given `date`/`durationDays` (daily child bookable on its own day even when a
  sibling child isn't), not on the relationship accessor.
- **Admin**: saving parents diffs correctly; self-edge rejected; cycle/nesting
  rule rejected; reverse view renders.
- **Gate (unit)**: rule satisfied / unsatisfied (none, too few, too many);
  unbookable children excluded; per-parent independence; children folded into
  booking lines with correct price/quantity.
- **Checkout (integration)**: parent + chosen child → free path creates both
  `listing_attendees` rows; paid path packs both into provider metadata; webhook
  reconstructs both **without** re-running the gate; `/calculate` quote includes
  the child.
- **Fold coverage (the checklist)**: a selected child contributes to capacity,
  contact-field requirements (`getTicketFieldsSetting`), custom pay-more price,
  site-assignment validation, and aggregated-quantity cap enforcement; unselected
  children contribute to **none** of these (their fields/questions aren't
  required). Add a regression test per item — each is a distinct way the fold can
  silently drop a child.
- **Fold serialization (date/duration)**: there are **no per-child date controls**
  in v1 — a daily child folds with the parent's date, a standard child folds
  `date: null`, and any customisable child inherits the parent's duration. Test the
  invariant that the fold serializes **only the fields the child carries** (daily →
  date; customisable → `dayCount`, with `hasCustomisable` forced from folded
  children; standard → neither), and that an order requiring two distinct
  customisable durations is rejected. (Do **not** test the abandoned per-child-date
  / per-line-date model.)
- **Negative paths**: parent without child rejected with the right message and
  form re-fill; capacity exceeded on child; child sold out blocks parent.
- **API / admin add**: enforce-or-skip behaviour matches the decisions taken.
- **QR direct-checkout**: a parent reached via `handleQrBookGet` → `skipToCheckout`
  exercises the chosen decision — either it falls back to the form (no
  single-item parent checkout is created) or the in-QR gate rejects a parent
  without a child. Add the test matching whichever decision ships, plus a test that
  the QR price override is **not** applied to folded children.
- **No-JS / hostile input**: a hidden unselected child's question does not block
  submit (no `required` in markup); a `child_<parentId>_*` field under a
  zero-quantity parent is **ignored** (not rejected — the no-JS baseline pre-fills
  those controls, so an honest buyer booking a different listing must not fail); a
  child slug in the URL is rejected/redirected (not silently dropped).
- Give every branch a direct in-process unit test (not just incidental e2e
  coverage), per the AGENTS.md note on deterministic coverage.

---

## Suggested implementation sequence (each step shippable & green)

| Step | Scope |
| --- | --- |
| 1 | Migration: `listing_parents` table + indexes (no per-parent rule columns — the rule is fixed at exactly one child). No behaviour yet. |
| 2 | DB layer: edge CRUD, `getChildrenOf` / `getParentsOf` / batch loader, dedicated edge cache, `deleteListing` cleanup. Unit-tested. |
| 3 | Admin edit UI + API: configure parents (+ reverse view) and diff-save, with **all** the admin-validation hard blocks — self/cycle/nesting **and** date/duration compatibility, renewal-tier ban, and unsupported child-scoped add-ons (not just self/cycle/nesting). **Ships behind a flag (UI *and* admin-API writes) until step 4–5 land** (see note). |
| 4 | Booking-page render: surface children under parents in `TicketCtx` (per-parent child selector + child questions/pay-more price; quantity follows the parent; date/duration inherited — no per-child date controls); no-JS baseline incl. CSS-only reveal. |
| 5 | Server-side gate in `prepareOrder`: validate (child required only for in-cart parents; `child_*` fields for zero-quantity parents are **ignored**, not rejected; invalid input rejected only for in-cart parents) + expand the listing set and fold children (feeding **every** per-listing path in the fold checklist). **Child slugs in any ticket URL are rejected** (a booking can't start from a child — Open Question 13 is resolved, so this is unconditional, not a count-the-in-cart-line option). **Plus the API + QR decisions (close those bypass paths).** Free + paid + webhook + `/calculate` all exercised. |
| 6 | Progressive-enhancement JS: reveal/require child blocks on parent qty > 0; include in live quote. |
| 6b | **Duplicate flows copy/remap edges** (`buildDuplicateListingInput` + group duplication clone only the listing row today, so a duplicated parent/child silently loses its gate). Must land **before the flag is lifted** — it's part of the gated set, not deferred. |
| 7 | Admin-manual-add / attendee-edit behaviour; docs + operator-facing help text. |

Steps 1–2 are behaviour-preserving. **Parent configuration must not be exposed to
operators until *every* booking path enforces the gate.** An admin UI that saves
required-child relationships while *any* checkout path ignores them lets an
operator configure a requirement that buyers silently bypass. That includes not
just the website form (steps 4–5) but the **single-listing API and the signed-QR
direct-checkout paths** — so the API/QR decisions move **into the enforcement step
(5)**, not a later step. Gate the relationship config behind a feature flag until
4–5 (website + API + QR) are all in, or merge 3–5 into a single shippable unit.
**The flag must cover the admin *API* relationship writes too** (`/api/admin/listings`
create/update), not only the admin UI — otherwise a scripted/bulk-import caller can
create required-child edges through the API while checkout still ignores them.
**And "every path" includes the discovery/share surfaces, not just the booking
gate:** because a *visible* child is supported, the moment relationship config is
exposed an operator can create one, and the public cards, RSS/ICS feeds, `/order`
gallery, admin multi-booking link builder, and per-listing share/QR generators all
currently publish `/ticket/<child>` URLs that the new child-slug rejection turns
into dead ends. Their child suppression/rewrite (and the parent child-derived
sold-out state) must therefore be **inside the release gate** too, landing before
the flag is lifted — not deferred past it. **Duplicate flows (step 6b) are part of
this gated set as well:** duplicating a configured parent/child must copy/remap the
`listing_parents` edges before the flag is lifted, or a duplicated parent ships
without its required-child gate.

---

## Open questions / decisions to settle (these drive the code)

1. **Edit direction & wording** — configure edges on the *parent* ("require a
   choice from these") or the *child* ("offered under these")? (Store identically;
   choose the UI.) *Recommended: edit on the parent.*
2. **Selection cardinality** — ✅ **RESOLVED (per-unit, updated 2026-06-23):** the
   buyer chooses children **totalling the parent's quantity Q, in any mix** (Q of
   one child, or 1 of A + 1 of B, …); the per-parent total must equal Q exactly.
   Always required; a sole bookable child auto-fills to Q (see Confirmed
   behaviour). The earlier "exactly one child per parent" is the special case "one
   child, qty = Q". No per-parent min/max config needed for v1.
3. **Nesting / cycles** — ✅ **RESOLVED:** no nesting — a child can't also be a
   parent (single-level graph). Enforced in admin validation.
4. **Quantity coupling** — ✅ **RESOLVED (per-unit, updated 2026-06-23):** the
   chosen children's quantities **total the parent's quantity** (2 base units ⇒ 2
   add-on units, in any mix across the children); each child is booked at the
   quantity the buyer entered for it. The old "child quantity follows the parent"
   is the single-child special case. See Confirmed behaviour.
5. **No bookable children** — ✅ **RESOLVED:** treat the parent as **sold out** when
   no child is bookable.
6. **Groups interaction** — ✅ **RESOLVED (by "no booking from a child"):** a child
   that is also a group member must be **suppressed from the group form's
   independently-selectable set** (the group page loads all active group listings,
   so this is enforcement, not cosmetic) and offered only via its parent. The only
   cosmetic follow-on is whether to let an operator list a child as a group member
   at all.
7. **Admin manual add / attendee edit** — ✅ **RESOLVED:** warn but don't block.
8. **Shared / multi-unit child** — ✅ **RESOLVED:** **allowed** — the same child
   chosen under two in-cart parents, or for multiple units within one parent, folds
   into a single `(listing_id, date)` line with the **summed quantity**,
   re-validated against `maxPurchasable` (reject, never clamp). (Pay-more prices
   for the shared child must reconcile — require equal, same add-on.)
9. **API bookings** — ✅ **RESOLVED:** parents are bookable via the API, so the
   API/`processBooking` contract is **extended to carry child selections** (not
   website-only). See Confirmed behaviour.
10. **QR direct-checkout** — ✅ **RESOLVED:** parents are bookable via QR.
    Skip-to-checkout is allowed only for a single auto-selected child that is
    **direct-checkout-safe** (no required questions, not `can_pay_more`, no
    provider-imposed contact field, and a resolved inherited duration the intent can
    carry); otherwise — multiple children, or any of those conditions — the QR path
    **falls back to the form**. (See the QR entry-point bullet for the full
    conditions.)
11. **Child pricing** — ✅ **RESOLVED:** children are charged at their own
    `unit_price` (the add-on's price); no "included/free with parent" notion in v1.
12. **Public discoverability** — ✅ **RESOLVED:** being a child does **not**
    auto-hide a listing; the operator uses the existing `hidden` flag. Hidden
    children stay pickable/auto-selectable, with a "hidden" badge in the admin
    table and a visibility info message on the product page (see Confirmed
    behaviour).
13. **Parent + child in the same URL/cart** — ✅ **RESOLVED (moot):** a booking
    can't start from a child, so children are never standalone cart lines. The
    gate's only input is the per-parent selector; the parent+child-URL / shared
    standalone-child ambiguities can't arise.
14. **Child dates & the paid round-trip** — ✅ **RESOLVED:** the child **inherits
    the parent's date and duration**, so there are no per-child date controls and
    nothing extra to carry through the payment round-trip. See Confirmed behaviour.
15. **Pay-more children** — ✅ **RESOLVED:** add-ons **can** be `can_pay_more`, so
    the child's custom-price input (`child_price_<parentId>_<childId>`) is rendered
    and collected. When a shared child is booked under two parents (Q8), their
    pay-more prices must reconcile (require equal — same add-on).
16. **Child-scoped add-ons** — ✅ **RESOLVED:** not supported in v1, and
    **hard-blocked**: an opt-in add-on reachable only through a (suppressed) child
    is rejected from both the edge save and the modifier save, and re-checked when
    a listing's `group_id` changes. Add-ons stay scoped to reachable parent pages.
17. **Customisable-days children** — ✅ **RESOLVED:** a customisable-days child
    **inherits the parent's day-count** (it doesn't get its own selector), per the
    "inherit date and duration" decision.
18. **Renewal tiers as parents** — ✅ **RESOLVED:** renewal/subscription tiers
    (`months_per_unit > 0`) can't be parents or children; enforced in admin
    validation.
19. **Duplication** — ✅ **RESOLVED:** duplicating a listing or group **copies/remaps
    the `listing_parents` edges** to the new ids.

---

## Distilled decisions — please comment

All of Part A and almost all of Part B are now **answered** (folded into Confirmed
behaviour and the resolved Open Questions above). The big simplifier was **"a
booking can never start from a child"** — children only enter an order via a
parent, which collapsed several ambiguities at once.

### ✅ Answered

- **Cardinality:** per-unit — the buyer chooses children totalling the parent's
  quantity Q, in any mix; always required; a sole bookable child auto-fills to Q.
  *(Q2.)*
- **Quantity:** the chosen children's quantities total the parent's — 2 base units
  ⇒ 2 add-on units, distributed in any mix. *(Q4.)*
- **Dates/duration:** child always inherits the base unit's. *(Q14 + Q17.)*
- **Pricing:** child charged at its own price; add-ons can be pay-what-you-want.
  *(Q11 + Q15.)*
- **Channels:** parents bookable every way (form, URL, gallery, API, QR); **no
  booking can start from a child**. *(Q9 + Q10 + Q13.)*
- **Nesting:** none — a child can't also be a parent. *(Q3.)*
- **No bookable child ⇒ parent is sold out.** *(Q5.)*
- **Shared / multi-unit child:** allowed — folds one line with the summed quantity
  (across parents and units), reject (don't clamp) over-capacity. *(Q8.)*
- **Admin manual add:** warn, don't block. *(Q7.)*
- **Renewal/subscription tiers:** never parents or children. *(Q18.)*
- **Duplication:** copies the parent–child links. *(Q19.)*
- **Discoverability/hidden:** operator-controlled `hidden` flag; hidden children
  stay pickable, with badge + info message. *(Q12.)*

### ✅ Resolved at implementation (were the last "open" items)

1. **Edit on the parent** ("require a choice from these listings"), in an Advanced
   settings section on the listing edit page. *(Q1.)*
2. **A child may be a group member**, but it is suppressed from the group form's
   selectable set (and all discovery surfaces) — bookable only via a parent.
   *(Q6 residual.)*
3. **No child-scoped add-ons in v1**, hard-blocked from both the edge save and the
   modifier save (and re-checked on `group_id` changes). A child can still itself
   be a paid add-on. *(Q16.)*

_Nothing remains open — see "Implementation status & nuances discovered" at the
top for the as-built record._
