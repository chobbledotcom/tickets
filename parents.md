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
  `answer_<questionId>` / `text_<questionId>`, `addon_<modifierId>`, `promo_code`.
  Parsing: `parseQuantities` → `Map<listingId, qty>`, `listingsWithQuantity`,
  `parseAddOnSelections` (`src/features/public/ticket-form.ts:186-235`).
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
- Add the migration as a new entry in the `schema.ts` table map. New databases get
  it for free; existing databases get it via the additive-migration path the repo
  already uses for new tables (confirm the exact mechanism when implementing —
  schema.ts is declarative and a separate runner applies diffs).

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
  - `getChildrenOf(parentId): Promise<ListingWithCount[]>` — active, bookable
    children of a parent (the hot path).
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
  Edges carry no PII, so the cache holds plain integers.

### Deletion / integrity

- Add to `deleteListing`'s batch (`listings.ts:344-357`):
  `DELETE FROM listing_parents WHERE listing_id = ? OR parent_id = ?` — a deleted
  listing must vanish from **both** sides of every edge.
- Deactivating (`active = 0`) or hiding a listing does **not** delete edges; the
  gate must filter unbookable children at runtime (see Edge cases).

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
- The children are rendered as part of the same `<form>` using a distinct field
  namespace so parsing is unambiguous, e.g. a radio/checkbox group
  `child_of_<parentId>` whose values are child listing ids, plus the child's own
  `quantity_<childId>` (children are real listings, so they reuse the normal
  per-listing quantity/price/answer fields).
- Because children are real listings, they bring their own price, capacity, dates,
  and questions. Their questions must be merged into `questionListingMap` and
  shown only when the child is selected.

### Progressive enhancement

The form is server-rendered with light JS (the repo favours server HTML + small
client scripts). The child selector should:

- Be **fully functional without JS**: server-side validation is the source of
  truth. If a parent is in the cart and no child is chosen, the submit is rejected
  with a clear error via the existing PRG error-redirect
  (`ticketFormErrorResponse`, `ticket-form.ts:181-184`) and the form re-fills.
- Be **enhanced with JS** to (a) reveal each parent's child selector only when the
  parent quantity > 0, and (b) mark it required, and (c) include children in the
  live `/calculate` quote. Add this to the client booking enhancement script
  (new or existing `src/ui/client/*`).

### Server-side validation (authoritative)

In `prepareOrder` (`ticket-submit.ts`), after `parseQuantities`:

1. Determine the set of in-cart listings with `qty > 0`.
2. For each such listing that is a **parent** (has children), read its required
   child rule (default: exactly one child selected).
3. Read the buyer's child selections (`child_of_<parentId>` + the child's
   `quantity_<childId>`).
4. **Reject** if the rule isn't satisfied (none selected / too few / too many),
   with a message naming the parent. Use `REGISTRATION_CLOSED_SUBMIT_MESSAGE`'s
   sibling pattern for messaging.
5. On success, **fold the selected children into the booking lines** exactly like
   any other listing: add them to `quantities` / the `ListingBooking[]` so they
   flow through `buildRegistrationItems` → `CheckoutIntent.items` →
   capacity check → pricing → payment metadata → webhook reconstruction with no
   special-casing downstream. This is the key design property: **a child is a
   normal line once selected; only the gate is special.**

### Pricing & payment round-trip

- Because children become ordinary `items[]`, `priceCheckout`
  (`checkout-pricing.ts`) and the provider metadata packing need **no changes** —
  they already handle arbitrary multi-line orders.
- The `/calculate` quote must include selected children; it shares the
  `prepareOrder` path, so folding children into the lines there covers it.
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
  `processBooking`) — decide whether the API enforces the gate (recommended: yes,
  reject a parent booking that omits a required child) or treats it as a
  lower-level primitive. Document the choice.
- **Admin manual add / attendee edit** — admins build `AttendeeInput.bookings`
  directly and can `allowOverbook`. Recommendation: the gate is a *buyer* UX
  constraint, so admin manual add should **warn but not block** (operators
  legitimately fix up odd orders). Confirm (Open Question 7).
- **Renewals** (`/renew/?t=…`, `actionUrl` override in `TicketCtx`) — if a
  renewable listing is a parent, decide whether renewal re-triggers child
  selection. Likely out of scope for v1.

---

## Edge cases

- **Child unbookable** (inactive / closed / sold out / hidden / `purchase_only`
  mismatch). The gate must only require selection from **currently bookable**
  children. If a parent's *only* child is sold out, the parent effectively cannot
  be booked — decide whether to (a) hide/disable the parent, or (b) show it with a
  "currently unavailable" note. Recommended: treat "no bookable children" the same
  as "parent sold out" and block, with a clear message. (Open Question 5.)
- **Quantity coupling.** If the buyer takes 3 of a parent, must they take 3
  children? Options: (i) child quantity independent (default), (ii) total child
  quantity must equal parent quantity, (iii) one child *type* but matching
  quantity. Recommended default: **independent** (simplest, and a "pick one of"
  rule reads as a type choice, not a quantity match). (Open Question 4.)
- **Shared child across multiple in-cart parents.** If parents P1 and P2 both have
  child C and both are in the cart, does one selection of C satisfy both, or does
  each parent need its own pick? Per-parent namespacing (`child_of_<parentId>`)
  makes each requirement independent by default. Recommended: **per-parent**.
  (Open Question 8.)
- **Child is also a parent (nesting).** Forbidden in v1 (see Admin validation).
  If allowed later, selecting a child that is itself a parent recursively requires
  *its* children — the gate must loop until fixpoint, and cycle detection becomes
  load-bearing.
- **Hidden children.** A child may be marked `hidden` (excluded from the public
  index) yet still reachable/required via its parent. Confirm `hidden` does not
  suppress it on the parent's booking page (it shouldn't — `hidden` governs the
  index, not direct/linked access).
- **Capacity & groups.** Child capacity is its own `max_attendees`; selecting it
  consumes capacity normally. If parent and child share a group capacity pool,
  the existing group-remaining capping applies to both lines.
- **Deleting/deactivating a parent or child mid-session.** The buyer's submitted
  selection is re-validated server-side at submit, so a stale page that lost a
  child fails cleanly rather than booking a dead listing.

---

## Testing plan (100% coverage, mutation-resistant per AGENTS.md)

- **DB layer**: insert/read/delete edges; `getChildrenOf` returns only bookable
  children; `getParentsOf`; batch loader avoids N+1; `deleteListing` removes edges
  from both sides; cache invalidation on edge writes.
- **Admin**: saving parents diffs correctly; self-edge rejected; cycle/nesting
  rule rejected; reverse view renders.
- **Gate (unit)**: rule satisfied / unsatisfied (none, too few, too many);
  unbookable children excluded; per-parent independence; children folded into
  booking lines with correct price/quantity.
- **Checkout (integration)**: parent + chosen child → free path creates both
  `listing_attendees` rows; paid path packs both into provider metadata; webhook
  reconstructs both **without** re-running the gate; `/calculate` quote includes
  the child.
- **Negative paths**: parent without child rejected with the right message and
  form re-fill; capacity exceeded on child; child sold out blocks parent.
- **API / admin add**: enforce-or-skip behaviour matches the decisions taken.
- Give every branch a direct in-process unit test (not just incidental e2e
  coverage), per the AGENTS.md note on deterministic coverage.

---

## Suggested implementation sequence (each step shippable & green)

| Step | Scope |
| --- | --- |
| 1 | Migration: `listing_parents` table + indexes; (if adopting config (a)) the two parent rule columns on `listings`. No behaviour yet. |
| 2 | DB layer: edge CRUD, `getChildrenOf` / `getParentsOf` / batch loader, dedicated edge cache, `deleteListing` cleanup. Unit-tested. |
| 3 | Admin edit UI: configure parents (+ reverse view), with self/cycle/nesting validation and diff-save. |
| 4 | Booking-page render: surface children under parents in `TicketCtx`; merge child questions; no-JS baseline. |
| 5 | Server-side gate in `prepareOrder`: validate + fold children into booking lines. Free + paid + webhook + `/calculate` all exercised. |
| 6 | Progressive-enhancement JS: reveal/require child selectors on parent qty > 0; include in live quote. |
| 7 | Decide & implement API / admin-manual-add behaviour. |
| 8 | Docs + any operator-facing help text. |

Steps 1–3 are behaviour-preserving for buyers (no gate until step 5), so they can
land independently.

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
6. **Groups interaction** — can a parent/child also be group members, and does the
   group page change how children are surfaced?
7. **Admin manual add / attendee edit** — warn-only (recommended) vs enforce the
   gate?
8. **Shared child across parents** — per-parent requirement (recommended) vs a
   single selection satisfying multiple parents?
9. **API bookings** — enforce the gate (recommended) vs treat API as a low-level
   primitive that bypasses it?
10. **Child pricing** — confirm children are charged at their own `unit_price` as
    ordinary lines (recommended) and there is no notion of "included/free with
    parent" in v1.
11. **Public discoverability** — should being a child auto-hide a listing from the
    public index, or is that left to the existing `hidden` flag?
