# Listing "Parents" — required-child selection

## Summary

Add an optional **parent/child relationship between listings**. Any listing may
declare one or more **parents**, where a parent is just another listing. The
relationship is read in reverse at the till: when a listing that is *a parent of
something* is added to an order, the buyer **must also pick at least one of that
parent's children** before they can check out.

Nothing here invents a new kind of entity. A "child" is an ordinary listing with
its own price, capacity, dates, questions and booking row; the parent system is
purely a **link table + a checkout-time gate + admin/edit UI + booking-page UI**.

This document is a plan, not an implementation. It deliberately ends with an
**Open questions / decisions** section because, as flagged, there are several
behavioural choices we have to settle before writing code. Each section states a
**recommended default** so we can converge quickly, but the defaults are not yet
agreed.

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
  listing_id  INTEGER NOT NULL,   -- the CHILD
  parent_id   INTEGER NOT NULL,   -- the PARENT (another listing)
)
  UNIQUE INDEX idx_listing_parents_pair   (listing_id, parent_id)
  INDEX        idx_listing_parents_parent (parent_id)   -- parent → children (hot path)
  INDEX        idx_listing_parents_child  (listing_id)  -- child  → parents  (edit page)
```

- No FKs, matching house style (`schema.ts` note on `listing_attendees`).
- The `parent_id` index is the one the checkout gate hits most (given a listing in
  the cart, find its children).
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

### Optional per-edge configuration (defer unless needed)

The minimal table above encodes only "C is a child of P." If we want
per-parent rules (how many children must be picked, min/max), the natural home is
extra columns on the **parent side**. Two options:

- **(a) Columns on `listings`** for the parent's own rule, e.g.
  `child_selection_min INTEGER NOT NULL DEFAULT 1`,
  `child_selection_max INTEGER NOT NULL DEFAULT 1` (0 = unlimited). Simple, one
  rule per parent regardless of which children. **Recommended default.**
- **(b) Columns on `listing_parents`** if the rule should vary per edge. More
  flexible, more UI. Defer.

Recommendation: ship with **(a)** defaulting to "exactly one child" and treat
richer rules as a later iteration. See Open Question 2.

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

### Deletion / integrity

- Add to `deleteListing`'s batch (`listings.ts:344-357`):
  `DELETE FROM listing_parents WHERE listing_id = ? OR parent_id = ?` — a deleted
  listing must vanish from **both** sides of every edge.
- Deactivating (`active = 0`) or hiding a listing does **not** delete edges; the
  gate must filter unbookable children at runtime (see Edge cases).

### Duplication / integrity

- **Duplicate flows must decide what happens to edges.** `buildDuplicateListingInput`
  (`src/shared/listings-actions.ts:148`) copies only the listing **row**, and group
  duplication clones listings from that row input — neither carries
  `listing_parents` rows. So duplicating a configured parent or child (or a whole
  group for a new date) would **silently drop the required-child gate** on the copy.
  Pick one and implement it in the duplicate paths: **copy/remap the edges** onto
  the new listing ids (the right default for "duplicate this configured listing"),
  or **intentionally clear them with a UI notice** so the operator knows the copy
  starts unlinked. Whole-group duplication especially needs the edges **remapped to
  the cloned ids**, not the originals.

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

### Admin validation

- **No self-edge** (`listing_id != parent_id`).
- **Cycle prevention** if nesting is allowed (Open Question 3). If we forbid
  nesting (recommended for v1), enforce that **a child cannot itself be a
  parent** and **a parent cannot itself be a child** — i.e. the graph is a single
  level, bipartite into "parents" and "children." This sidesteps recursion in the
  checkout gate entirely. If we later allow nesting, add a DFS cycle check at save
  time.
- Validate that referenced listing ids exist and are not soft-deleted.
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
- **Field shape — one field carries both choice and quantity, namespaced per
  parent.** Use `child_<parentId>_<childId>` whose *value is the quantity* (blank
  or `0` = not chosen). Do **not** use a separate `child_of_<parentId>` selector
  plus a shared `quantity_<childId>`: that split is ambiguous when two parents pick
  the same child (you can't tell whether `quantity_C=1` means one total or one per
  parent) and lets a buyer "select" a child while leaving its quantity zero. With
  one per-parent quantity field, the per-parent requirement and the fold are both
  computed from the same numbers.
- **Child dates must be per-child, not the shared selector.** The page's shared
  date control feeds `computeSharedDates`, which **intersects** the bookable dates
  of *every* daily listing it receives. If we drop all of a parent's daily
  children into that set, their date ranges intersect *before* the buyer picks one,
  so a parent can look like it has no available dates even though each child is
  bookable on its own day. So daily children need their **own** per-child date
  control (`child_date_<parentId>_<childId>`) evaluated independently — do not feed
  unselected children into `computeSharedDates`.
- **Child questions** must be merged into `questionListingMap` with the **correct
  shape**: it is `Map<questionId, listingId[]>` (`questions.ts:361`), read by
  `prepareOrder` as `ctx.questionListingMap.get(q.id)` — *keyed by question id*, not
  by listing id. So a child question's entry is `questionId → [...existing,
  childListingId]`. Keying by the child's listing id (the inverse) would fail to
  activate child-specific questions and silently skip required child answers and
  answer-triggered modifiers. The child's answer fields use the standard
  `question_<questionId>` name (see no-JS note below for rendering and which answers
  are read at submit).

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
- **The same no-`required` rule applies to *all* child controls, not just
  questions.** The existing renderers emit HTML `required`: `renderDateSelector`
  produces a required `<select name="date">`, and `renderPayMoreInput` adds
  `required` whenever the minimum price is above zero
  (`reservations.tsx:71,150`). If every possible child's date / pay-more-price
  controls are rendered in the no-JS baseline, an *unselected* child's
  hidden-but-required input blocks the browser from submitting. So
  `child_date_<parentId>_<childId>` and the child pay-more price input must also be
  **non-required in markup**, with requiredness enforced **server-side for the
  selected child only**.
- Be **enhanced with JS** to (a) reveal each parent's child block (selector + its
  date/questions/price) only when the parent quantity > 0, (b) re-add `required` to
  the selected child's fields, and (c) include selected children in the live
  `/calculate` quote. Add this to the client booking enhancement script (new or
  existing `src/ui/client/*`).

### Server-side validation (authoritative)

In `prepareOrder` (`ticket-submit.ts`), after `parseQuantities`:

1. Determine the set of in-cart listings with `qty > 0`.
2. For each such listing that is a **parent** (has children), read its required
   child rule (default: exactly one child selected).
3. Read the buyer's per-parent child quantities from `child_<parentId>_<childId>`
   (and `child_date_<parentId>_<childId>` for daily children). **Only a positive
   quantity counts as a selection** — a child named with a blank/zero quantity is
   *not* selected, so it can never satisfy the rule while contributing no line.
   **Ignore (or reject with a clear error) any `child_<parentId>_*` field whose
   parent is not itself in the cart** (`quantity_<parentId>` is 0). A stale or
   hand-crafted submit can post a child quantity under a zero-quantity parent;
   without this guard the fold would either silently drop it or, worse, book a
   child with no parent. Child subfields are only meaningful for parents already in
   the cart from step 1.
4. **Also count any child the buyer already has as a normal in-cart line.** The
   booking page accepts multi-listing URLs (`/ticket/<parent>+<child>`) and
   order-prefill quantities, so a buyer can arrive with a parent *and* one of its
   children already selected as ordinary rows. A standalone in-cart line for an
   eligible child **satisfies** that parent's requirement. **But a single standalone
   child line cannot satisfy *two* parents.** A `quantity_<childId>` row has no
   parent-scoped assignment, so on `/ticket/P1+P2+C` (where C is a child of both)
   counting it for both P1 and P2 lets one line satisfy two independent
   requirements, while folding it into both aggregates would double-charge. So we
   need an explicit rule, decided up front: either (i) a standalone child line
   satisfies **at most one** parent (assign it deterministically, e.g. first parent
   by id, and require a per-parent `child_*` selection for the rest), or (ii)
   **forbid a standalone child row when more than one in-cart parent claims it**
   (force the per-parent selectors instead). The simplest overall is (iii)
   **explicitly forbid parent+child in the same URL**, which removes the standalone
   case entirely. Decide — Open Question 13.
5. **Reject** if the rule isn't satisfied (none selected / too few / too many),
   with a message naming the parent. Use `REGISTRATION_CLOSED_SUBMIT_MESSAGE`'s
   sibling pattern for messaging.
6. On success, **fold the selected children into the order as real listings —
   lines *and* the listing set.** Adding them to `quantities` alone is **not**
   enough: `checkAvailability` (via `listingsWithQuantity`) and
   `buildRegistrationItems` both iterate the **`TicketListing[]` they are passed**,
   not the quantity map. An implicit child that isn't one of the URL slugs is not
   in `ctx.listings`, so a parent+child submission could pass the gate yet **omit
   the child from capacity checks, pricing, and payment metadata**. The fold must
   therefore **expand the `TicketListing` set** with the selected child listings
   (loaded via the relationship accessor, with per-child date/availability
   resolved) *before* calling those helpers. When the **same child** is chosen by
   multiple parents (or also present as a URL line), **merge to a single
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
- **Custom (pay-more) price** — for a `can_pay_more` child the submit path expects
  `custom_price_<childId>` (`ticket-submit.ts:145`). The child controls must
  include the custom-price input, or we **explicitly disallow pay-more children**
  in v1. Otherwise a pay-more child fails with a missing price (or is silently
  charged its base price). **If the same pay-more child is selectable under two
  parents**, the shared `custom_price_<childId>` name would render *twice* (one
  duplicate input per parent) for a single folded line, and the parser's
  `form.get(...)` keeps only one value — so either render a **single shared price
  input per folded child**, or **namespace the price per parent**
  (`custom_price_<parentId>_<childId>`) and define how the two prices merge before
  aggregation (e.g. take the max, or reject a mismatch). (Open Question 15.)
- **Optional add-ons** — `getOptionalAddOns(listingIds)` (`ticket-payment.ts:375`)
  is scoped to the listing ids. Add-ons scoped *only* to a child won't load if we
  pass just the parent page ids; loading add-ons for *every* possible child lets a
  no-JS user opt into an add-on for an unchosen child that pricing then drops.
  Either render/parse child-scoped add-ons **conditionally on the selected child**,
  or **explicitly not support child-scoped add-ons** in v1. (Open Question 16.)
- **Site-assignment validation** — `prepareOrder` calls
  `validateSiteAssignmentConfig(selected)` (`ticket-submit.ts:578`) before
  checkout. A child with `assign_built_site` set (parent without) must be in the
  **expanded** set passed to this check, or a misconfigured builder order can
  complete and then silently skip assignment post-booking.
- **Thank-you redirect** — `handleFreePath` only honors a listing's
  `thank_you_url` when `ctx.listings.length === 1` (`ticket-submit.ts:427-429`).
  Folding a child turns a single-parent booking into a **multi-listing** order, so
  the length check fails and an operator's custom parent thank-you URL is silently
  lost the moment a required child is selected. Define an explicit precedence:
  recommended is to **keep using the original (pre-fold) parent page's redirect**
  when the page started as a single parent — base the redirect decision on the
  original page listings, not the post-fold set.
- **Quantity caps after aggregation** — when the same child is summed across
  multiple parents, the aggregate line can exceed the child's `max_quantity` /
  `maxPurchasable` even though each per-parent input was individually clamped. The
  **folded** quantity must be re-validated against the child's max-purchasable
  limit (clamp or reject) before building items.
- **Answer-triggered modifiers** — `prepareOrder` computes
  `answerModifierQuantities(computeListingAnswerMap(ctx, info), quantities)`
  (`ticket-submit.ts:633-634`), so a child answer whose `answers.modifier_id`
  carries a surcharge/discount or stock cap only affects pricing/stock if the
  folded child is in the **answer map, selected ids, *and* quantity map** before
  that call. Fold children into all three (not just `quantities`), or a parent+child
  order records the child's answer while skipping its modifier's surcharge/stock.
- **Customisable-day children** — the page renders a single `day_count` selector
  from `sharedDayCounts(ctx.listings)` and submit rejects a selected
  customisable-days listing that lacks it via `resolveDayCount(selected, form,
  date)` (`ticket-submit.ts:602`, `ticket-payment.ts:234`). An implicit child kept
  out of the listing set has no selector; feeding *all* children into
  `sharedDayCounts` intersects unselected children's day-count options (the same
  failure mode as dates). So a customisable-days child needs a **child-scoped
  day-count input** (`child_days_<parentId>_<childId>`), or we **explicitly
  disallow customisable-days children** in v1. (Open Question 17.)

### Pricing & payment round-trip

- Because children become ordinary `items[]`, `priceCheckout`
  (`checkout-pricing.ts`) and the provider metadata packing handle the extra lines
  without structural change — they already price arbitrary multi-line orders.
- **Per-child dates do not survive the paid round-trip as-is.** This is the one
  place the "child is just a normal line" framing breaks: `CheckoutIntent` carries
  a **single order-level `date`/`dayCount`**, the compact `BookingItem`s store only
  listing id / quantity / price, and the webhook calls
  `bookingDateFields(listing, intent.date, intent.dayCount)` **per item**
  (`src/features/api/webhooks.ts:783`). So a paid parent order whose child sits on
  a *different* day than the order-level date would book the child on the wrong
  day. Two resolutions (Open Question 14):
  - **Restrict child dates to the order/shared date** in v1 (simplest — a daily
    child must be booked on the same date as the rest of the order), or
  - **Add per-line date/duration** to `BookingItem`, the metadata packing, and
    webhook reconstruction (larger change; needed only if independent child dates
    are a real requirement).
  - **The "restrict to shared date" option has a sharp corner: a *standard*
    (non-daily) parent produces no shared date at all** — the page's date list is
    computed from the parent listings, so an undated parent leaves
    `CheckoutIntent.date` null while the webhook applies that single (null) date to
    every item. A daily child under such a parent then has nowhere to carry its
    date. So v1 must **also forbid daily children under parents that don't already
    produce a shared date** (i.e. only allow a daily child when the parent is itself
    daily / contributes to the shared date), unless we take the per-line-date route.
    (Open Question 14.)
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

- **Single-listing public page** `/ticket/<slug>` — same `processSubmission`
  path, so the gate applies automatically once implemented there. A parent booked
  alone still requires its child; render the child selector on the single page
  too.
- **Group page** `/group/:slug` — group members render together. A parent inside a
  group still needs its gate. Children of a group member may or may not be group
  members themselves — confirm interaction (Open Question 6).
- **Public/JSON API booking** (`src/features/api`, `src/shared/booking.ts`
  `processBooking`) — decide whether the API enforces the gate. **Caveat:**
  `processBooking(listing, contact, quantity, date, baseUrl, customUnitPrice?)`
  (`src/shared/booking.ts:37-43`) accepts exactly **one** listing, and its
  `CheckoutIntent` carries only that listing. So "reject a parent that omits a
  child" is not enough on its own — there is currently **no payload shape** for an
  API client to *supply* the required child. Two real options: (i) extend the API
  request + `processBooking` contract to carry child selections (so parents are
  bookable via API), or (ii) explicitly make **parent listings website-only** for
  the API and return a clear error. Pick one and document it (Open Question 9).
- **QR direct-checkout link** (`src/features/public/qr-book.ts`) — a signed QR
  link can **skip the form entirely**: `handleQrBookGet` → `skipToCheckout` →
  `buildCheckoutIntent` (`qr-book.ts:83-152`) creates a payment session with only
  the scanned listing in `items`, **without** going through `prepareOrder`. A
  parent booked this way would **bypass the gate entirely**. Decide explicitly:
  (a) disable the direct-skip for listings that are parents (fall back to the
  normal form so the child can be chosen), or (b) run equivalent gate logic in the
  QR path before building the intent. Recommended: **(a)** — a parent inherently
  needs a buyer choice, which is exactly what "skip the form" removes. **Also scope
  the QR price override:** even under option (a) the signed `qr_token` rides along
  on the parent form, and `applyQrTokenOverride` verifies `ctx.slugs[0]` then
  applies the signed price to **every** fixed-price row in `ctx.listings`
  (`ticket-submit.ts:166-176`). Once the fold expands `ctx.listings` with children,
  a fixed-price child would be charged the **parent's** signed QR value instead of
  its own `unit_price`. So the override must apply **only to the scanned/original
  listing**, never to folded children.
- **Admin manual add / attendee edit** — admins build `AttendeeInput.bookings`
  directly and can `allowOverbook`. Recommendation: the gate is a *buyer* UX
  constraint, so admin manual add should **warn but not block** (operators
  legitimately fix up odd orders). Confirm (Open Question 7).
- **Renewals** (`/renew/?t=…`, `actionUrl` override in `TicketCtx`) — **not safe
  to hand-wave once parent config is exposed.** `/renew/` renders the normal ticket
  flow with a `siteToken`, but `applyRenewalsForEntries` rejects the renewal unless
  *every* completed line is a qualifying hidden purchase-only renewal tier. So if a
  renewal tier is configured as a parent: enforcing the gate by folding in a normal
  child makes the paid renewal **complete without extending the site deadline**
  (the child line fails the renewal qualification); skipping the gate **bypasses
  the requirement**. For v1, **explicitly forbid parent relationships on renewal
  tiers** (`months_per_unit > 0`) — block it in admin validation — or design
  renewal-specific gate handling before shipping the admin config. (Open Question
  18.)

---

## Edge cases

- **Child unbookable** (inactive / closed / sold out). The gate must only require
  selection from **currently bookable** children. Two flags that look like
  eligibility but are **not**, and must **not** be used to filter children:
  - **`hidden`** — the ticket flow still loads hidden listings by direct slug;
    only the public index/gallery excludes them. A child hidden from the index must
    still be selectable under its parent (matches the "Hidden children" note
    below).
  - **`purchase_only`** — this is a *pricing* constraint (no free bookings), not a
    booking-eligibility check; purchase-only listings still render a normal buy
    button and create normal booking rows. A regular parent must be able to require
    a valid purchase-only child (merch, an add-on-style ticket). Do **not** filter
    on a parent/child `purchase_only` mismatch. If some specific combination really
    is unsupported, define and enforce it explicitly rather than via a blanket
    filter.
   If a parent's *only* bookable child is sold out, the parent
  effectively cannot be booked — decide whether to (a) hide/disable the parent, or
  (b) show it with a "currently unavailable" note. Recommended: treat "no bookable
  children" the same as "parent sold out" and block, with a clear message. (Open
  Question 5.)
- **Quantity coupling.** If the buyer takes 3 of a parent, must they take 3
  children? Options: (i) child quantity independent (default), (ii) total child
  quantity must equal parent quantity, (iii) one child *type* but matching
  quantity. Recommended default: **independent** (simplest, and a "pick one of"
  rule reads as a type choice, not a quantity match). (Open Question 4.)
- **Shared child across multiple in-cart parents.** If parents P1 and P2 both have
  child C and both are in the cart, the per-parent field shape
  (`child_<parentId>_<childId>`) keeps each requirement independent by default
  (recommended) and records *how many* of C each parent wants — so the ambiguity a
  single shared `quantity_C` would create does not arise. **But the downstream
  booking shape still cannot represent two separate lines for the same
  listing+date:** `parseQuantities` is keyed by listing id
  (`ticket-form.ts:187-204`) and `createAttendeeAtomicImpl` rejects a duplicate
  `(listing_id, date)` booking slot. So when both parents pick the *same* child,
  the fold step **must apply an explicit aggregate-or-disallow rule**, decided up
  front:
  - **Aggregate (recommended):** sum the per-parent child quantities into a single
    `(listing_id, date)` line. Each parent's requirement is still satisfied; only
    the persisted line is merged.
  - **Disallow:** reject choosing the same child for more than one parent in one
    order, with a clear message.
  Whichever we pick, the gate must enforce it *before* building `ListingBooking[]`,
  so validation never "passes" only to fail at save with a duplicate-slot error.
  (Open Question 8.)
  - **Aggregation collapses *all* of the child's per-instance inputs, not just
    quantity.** A shared child rendered under two parents repeats every one of its
    listing-id-keyed fields — `custom_price_<childId>`, `question_<childId/id>`,
    `child_date_*`, `child_days_*`. But the form reader takes only the **first**
    value (`FormParams.getString` → `URLSearchParams.get`, `form-data.ts:14`) and
    the answer maps are keyed by listing id, while the folded line has a single
    quantity, **one** unit price, **one** date, **one** day-count, and **one**
    answer set. So two parents submitting *different* prices / answers / durations
    for the same child would silently collapse (or mis-price) before required-answer
    handling and answer-triggered modifiers run. Therefore, if we aggregate, we must
    **either** render a **single shared child block** per folded child (one price /
    date / day-count / question set shared across the parents that chose it),
    **or** namespace each per parent and define an explicit **merge/reject rule**
    per field (e.g. reject mismatched durations/answers, take max price). The
    simplest v1 is to **disallow aggregating a shared child that carries any
    per-instance input beyond quantity** (pay-more, customisable-days, or its own
    questions) — fall back to the "disallow" branch for those. (Open Question 8.)
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
- **Parent + child in the same group.** The `/group/:slug` page passes **all**
  active group listings as original page listings (`groups.ts:27-42`), so the
  recommended "forbid `/ticket/P+C` URLs" rule does **not** remove the standalone
  child row here — a group containing both a parent and its child reintroduces the
  shared-standalone ambiguity (the child row can satisfy the gate or be aggregated
  outside the per-parent selector). Resolve by **forbidding parent/child edges
  *within the same group* in admin validation** (recommended, simplest) or defining
  group-specific assignment, before the group path enforces the gate. (Open Question
  6.)
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
- **Round-trip dates**: per the v1 decision, either a child date that differs from
  the order date is rejected (restricted model) or survives reconstruction
  (per-line model) — test whichever we ship.
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
  zero-quantity parent is ignored/rejected; a shared standalone child line cannot
  satisfy two parents or double-charge.
- Give every branch a direct in-process unit test (not just incidental e2e
  coverage), per the AGENTS.md note on deterministic coverage.

---

## Suggested implementation sequence (each step shippable & green)

| Step | Scope |
| --- | --- |
| 1 | Migration: `listing_parents` table + indexes; (if adopting config (a)) the two parent rule columns on `listings`. No behaviour yet. |
| 2 | DB layer: edge CRUD, `getChildrenOf` / `getParentsOf` / batch loader, dedicated edge cache, `deleteListing` cleanup. Unit-tested. |
| 3 | Admin edit UI: configure parents (+ reverse view), with self/cycle/nesting validation and diff-save. **Ships behind a flag / hidden until step 4–5 land** (see note). |
| 4 | Booking-page render: surface children under parents in `TicketCtx` (per-parent quantity fields, per-child dates, child questions); no-JS baseline incl. CSS-only reveal. |
| 5 | Server-side gate in `prepareOrder`: validate (positive child qty; orphan child fields rejected) + expand the listing set and fold children (feeding **every** per-listing path in the fold checklist). Counting in-cart child lines is **conditional on the Open Question 13 decision** — if we forbid parent+child URLs (the recommendation), this step instead **rejects** such URL lines rather than counting them. **Plus the API + QR decisions (close those bypass paths).** Free + paid + webhook + `/calculate` all exercised. |
| 6 | Progressive-enhancement JS: reveal/require child blocks on parent qty > 0; include in live quote. |
| 7 | Admin-manual-add / attendee-edit behaviour; docs + operator-facing help text. |

Steps 1–2 are behaviour-preserving. **Parent configuration must not be exposed to
operators until *every* booking path enforces the gate.** An admin UI that saves
required-child relationships while *any* checkout path ignores them lets an
operator configure a requirement that buyers silently bypass. That includes not
just the website form (steps 4–5) but the **single-listing API and the signed-QR
direct-checkout paths** — so the API/QR decisions move **into the enforcement step
(5)**, not a later step. Gate the admin UI behind a feature flag until 4–5
(website + API + QR) are all in, or merge 3–5 into a single shippable unit.

---

## Open questions / decisions to settle (these drive the code)

1. **Edit direction & wording** — configure edges on the *parent* ("require a
   choice from these") or the *child* ("offered under these")? (Store identically;
   choose the UI.) *Recommended: edit on the parent.*
2. **Selection cardinality & config location** — exactly one child? at least one?
   min/max? Per-parent columns on `listings` (recommended) vs per-edge columns on
   `listing_parents`? *Recommended: per-parent, default exactly one.*
3. **Nesting / cycles** — single-level bipartite only (recommended, no recursion)
   or allow children that are themselves parents (needs cycle detection + fixpoint
   gate)?
4. **Quantity coupling** — child quantity independent of parent quantity
   (recommended) vs must-match?
5. **No bookable children** — block the parent (recommended) vs show parent with
   an unavailable note?
6. **Groups interaction** — can a parent/child also be group members? The group
   page renders all group listings together, reintroducing the standalone-child
   ambiguity. *Recommended: forbid parent/child edges within the same group in
   admin validation.*
7. **Admin manual add / attendee edit** — warn-only (recommended) vs enforce the
   gate?
8. **Shared child across parents** — per-parent requirement (recommended), and if
   the *same* child is chosen for multiple parents, **aggregate into one line**
   (recommended) vs **disallow** the duplicate? (Must be settled because the
   booking shape can't store duplicate `(listing_id, date)` lines.) If aggregating,
   also decide how the child's **per-instance inputs** (price, date, day-count,
   answers) merge — or disallow aggregating a child that carries any.
9. **API bookings** — `processBooking` is single-listing today, so enforcing the
   gate requires either **extending the API/`processBooking` contract to carry
   child selections** (parents bookable via API) or **making parent listings
   website-only for the API** with a clear error. Which?
10. **QR direct-checkout** — for a parent reached via a signed QR link, **disable
    the form-skip and fall back to the form** (recommended) vs **run the gate in
    the QR path** before creating the session?
11. **Child pricing** — confirm children are charged at their own `unit_price` as
    ordinary lines (recommended) and there is no notion of "included/free with
    parent" in v1.
12. **Public discoverability** — should being a child auto-hide a listing from the
    public index, or is that left to the existing `hidden` flag? (Note: `hidden`
    must *not* make a child unselectable under its parent — see Edge cases.)
13. **Parent + child in the same URL/cart** — let an existing in-cart child line
    satisfy the parent's requirement, vs forbid parent+child URLs (recommended,
    keeps the gate's input single-sourced)? If we allow it, we must also resolve
    the **shared standalone child** case: on `/ticket/P1+P2+C` a single `C` line
    has no parent assignment, so define whether it satisfies at most one parent
    (deterministic assignment) or is forbidden when multiple in-cart parents claim
    it — otherwise one line can satisfy two requirements or be double-charged.
14. **Child dates & the paid round-trip** — daily children need per-child date
    controls (not the shared `computeSharedDates` selector, which intersects all
    children's ranges). But `CheckoutIntent` carries a single order-level date and
    the webhook applies it per item, so independent child dates don't survive a
    paid order. Resolve by either **restricting a child's date to the order/shared
    date** (recommended for v1) or **adding per-line date/duration** to
    `BookingItem` + metadata + webhook reconstruction. If we restrict, we must
    **also forbid daily children under parents that produce no shared date** (e.g. a
    standard, undated parent) — there'd be nowhere to carry the child's date.
15. **Pay-more children** — include a `custom_price_<childId>` input so
    `can_pay_more` children work (recommended) vs **disallow pay-more children** in
    v1? If included, also decide the **shared-child price**: one shared input per
    folded child, or per-parent `custom_price_<parentId>_<childId>` with a defined
    merge rule.
16. **Child-scoped add-ons** — render/parse add-ons conditionally on the selected
    child vs **not support child-scoped add-ons** in v1 (recommended; add-ons stay
    scoped to the page's parent listings)?
17. **Customisable-days children** — add a child-scoped `day_count` input
    (`child_days_<parentId>_<childId>`) vs **disallow customisable-days children**
    in v1 (recommended)?
18. **Renewal tiers as parents** — **forbid** parent relationships on renewal tiers
    (`months_per_unit > 0`) in v1 (recommended) vs design renewal-specific gate
    handling? (A folded normal child breaks `applyRenewalsForEntries`'
    all-lines-must-be-a-renewal-tier rule.)
19. **Duplication** — when duplicating a listing or a group, **copy/remap
    `listing_parents` edges** to the new ids (recommended) vs **clear them with a
    UI notice**? (`buildDuplicateListingInput` copies only the listing row today.)
