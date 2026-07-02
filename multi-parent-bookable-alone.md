# Multiple parents per child + "Can be booked by itself"

## The ask

Let a listing sit under **multiple parents** the way it already sits in
multiple groups — e.g. a "Pick any of these widgets" parent that a package
requires ×2, while the same widgets are also offered under another picker —
and add a per-child option, **"Can be booked by itself"**, so a widget can
also keep its own standalone booking page.

## Finding 1: multiple parents already work

The first half of the ask is already shipped, end to end:

- **Schema.** `listing_parents` is a bare many-to-many edge table — unique on
  the `(parent_listing_id, child_listing_id)` *pair*, with a reverse index on
  `child_listing_id`. Nothing constrains a child to one parent.
- **Admin.** The children picker's eligibility check
  (`childEdgeIneligibility`, `src/features/admin/listings-parents.ts`) blocks
  only *nesting* (a parent can't be a child, a child can't be a parent) and
  per-edge field incompatibilities (`edgeFieldError`: renewal tiers, daily
  child under non-daily parent, span mismatch). "Already someone else's
  child" is **not** a block — and the edit page already renders the plural
  `offeredUnder` list ("offered under: A, B").
- **Booking model.** The tree keys child nodes by the full path
  (`childNodeKey(parentNodeKey, childId)`), so the same widget under two
  parents is two distinct nodes; the form fields are parent-scoped
  (`child_qty_<parentId>_<childId>`); the fold sums a child's units across
  parents into one line while recording exact per-`(child, parent)`
  allocations; signed metadata revalidates each allocation under its own
  parent. Discovery's "available as an add-on" note already reasons over a
  child's *plural* bookable parents.

So "widgets under picker W1 (a package slot ×2) **and** under picker W2" is
buildable today. What is *not* solid is the corner where both parents land in
**one order** — see Finding 3.

## Finding 2: "Can be booked by itself" is the genuinely new piece

Today, being a child strips a listing's standalone existence unconditionally
(invariant I3): `/ticket/<child>` 404s (`anyChildListing` in
`withActiveListings`), the JSON API rejects it, catalogs drop it
(`getCatalogListings`, the `/listings` classification, `/order`, `/order.js`,
feeds, `/api/listings`), group pages strip its row (`dropChildListings`),
QR issuance/scan refuse it, the admin dashboard builder and share/QR
affordances exclude it, and its card shows only the "available as an add-on"
note.

The flag splits one conflated classification into two:

- **`isChild`** — has parent edges: renders under its parents' selectors,
  folds, carries allocations. Unchanged.
- **`standaloneBookable`** — may be sold via its own page/catalog entries.
  Today `= !isChild && !hiddenPackageMember`; the flag makes it
  `= (!isChild || bookable_alone) && !hiddenPackageMember`.

### What it requires

1. **Schema:** one listing column, `bookable_alone` (boolean, default
   `false` — existing children keep today's behaviour). Dated migration +
   `LATEST_UPDATE`; the column rides `SELECT listing.*` caches and
   backup/restore automatically.
2. **One shared predicate, flipped at the same choke points the slots audit
   enumerated** (this is the same surface list, relaxing instead of
   blocking): `getChildListingIds` consumers that mean "not standalone" move
   to a narrowed `children WHERE NOT bookable_alone` query —
   `lacksStandalonePublicPage`, `withActiveListings`/`anyChildListing`,
   `findActiveListing` (API), the catalog/discovery filters, `/order` and
   `/order.js`, feeds, the dashboard multi-booking builder, QR issuance and
   the scan handler, and the admin `isChild` share-suppression flag.
   Consumers that mean "renders under a parent" keep the unfiltered set.
3. **Admin form/API:** a "Can be booked by itself" checkbox on the listing
   form (sensible to surface next to the `offeredUnder` list), plus the JSON
   API field.
4. **Discovery classification:** a `bookable_alone` child gets a normal card
   + CTA instead of (or alongside) the "available as an add-on" note — a
   copy decision more than a code one.
5. **A relaxation for free:** the "child-only opt-in add-on" hard block
   (`childOnlyAddOnName` — an add-on scoped to a suppressed child is a dead
   end) becomes unnecessary for a `bookable_alone` child, since its own page
   can sell the add-on.

### What stays the same

Pricing (a child charges its own price on both paths), capacity (demand is
summed per listing row regardless of provenance; the atomic write predicate
is path-blind), questions (listing-keyed), hidden-package concealment (that
arm of the gate is independent and still wins), and the package-member rules
(a package member still can't be a child; `bookable_alone` doesn't touch
membership).

## Finding 3: the same-order multi-parent corner must be fixed first

Two latent row-identity problems become mainstream the moment multi-parent
pickers and `bookable_alone` are used together. Both live in
`expandChildAllocations` (`src/shared/db/attendees/order-parents.ts`) and the
paid path (`src/features/api/payment-processing.ts`):

1. **Same child under two parents in one order.** The fold emits one summed
   line + two allocations; expansion emits one row per allocation; the unique
   `(listing_id, attendee_id, start_at)` row index collapses them to one row
   recording the *first* parent (documented as a "rare multi-parent corner"
   — rare because today only a multi-slug cart of two parents sharing a
   child can reach it). And `processPaidBooking` maps created attendees back
   to listings **positionally** (`validatedItems[i]!`), which mis-aligns
   whenever expansion changes the row count. "Pick any of these widgets"
   pickers make this an everyday configuration.
2. **Standalone + folded units of the same child in one order** — newly
   reachable via `bookable_alone` (e.g. `/ticket/<parent+widget>` with the
   widget both bought alone and chosen under the parent). Expansion
   currently emits rows **only** for allocations: the standalone remainder
   units (and their proportional `pricePaid` share) are silently dropped.
   Unreachable today, so not a live bug — but a hard prerequisite: the
   expansion must emit a remainder row (`qty = total − Σ allocations`, no
   parent) for the unallocated units.

The honest fix for both is the row-identity upgrade `booking-unification.md`
already flags for Phase 3, scoped down to just this table:

- widen the unique index to `(listing_id, attendee_id, start_at,
  parent_listing_id)` (dated migration) so per-parent rows coexist — ticket
  views then show one line per provenance, which is also the *right* display;
- key the paid path's attendee↔item mapping by listing id (grouping rows per
  signed line) instead of array position;
- emit the unallocated remainder row in `expandChildAllocations`;
- extend the row-consumer checks `booking-unification.md` lists (attendee
  merge conflict keys, check-in targeting) with `parent_listing_id`
  awareness, since duplicate `(listing, attendee, start_at)` rows become
  legal.

Until that lands, the cheap guard from the package-choice-slots audit
applies: reject the *configuration* that reaches the corner (the same
candidate under two members of one package; a `bookable_alone` child sold on
a page that also folds it), keeping the feature while fencing the bug.

## The combination the ask describes, end to end

With the above in place:

- "Pick any of these widgets" = a parent listing whose children are the
  widgets, added to a package as a member with `quantity: 2` (a pick-2 slot —
  works today).
- The same widgets under another picker = second parent edges (works today).
- Widgets sold on their own = `bookable_alone: true` (new flag).
- A widget in two pickers of the *same* package, or bought alone alongside a
  fold of itself = the row-identity fix (or the interim configuration guard).

## Suggested sequencing

1. **Row-identity fix** (index + mapping + remainder row + merge/check-in
   keys) — it hardens *today's* multi-parent carts too, and everything else
   stands on it.
2. **`bookable_alone` flag** — migration, predicate split across the known
   surface list, admin checkbox, discovery card copy, add-on-block
   relaxation.
3. Optional polish: per-child flag surfaced in the children picker (so an
   operator sees at a glance which candidates also sell alone), and the
   package-choice-slots follow-ups (chooser cap validation, `allocations`
   metadata limit) which share the same code paths.

## Test posture (the cases that matter)

- Same child chosen under two parents in one order books two rows with exact
  parents, correct split `pricePaid`, and a paid webhook that maps every
  attendee to the right listing (the positional-mapping regression).
- Standalone + folded units of one child in one order persist the remainder
  row (money and quantity both conserved).
- A `bookable_alone` child: books via `/ticket/<slug>` and the API; appears
  in catalogs/feeds/QR; still folds under every parent; its hidden-package
  arm still conceals it when applicable; flag OFF restores every 404/drop.
- Attendee merge and check-in on duplicate `(listing, attendee)` rows with
  different parents act on the intended row only.
- Capacity: mixed-provenance demand (alone + under P1 + under P2) sums
  against the child's own cap and its group pools exactly once per unit.
