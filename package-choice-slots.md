# Package choice slots — "pick N from these listings" inside a package

## The ask

A package where the buyer **must select**, for example:

- 1 item from an array of listings X
- 1 item from an array of listings Y
- 2 items from an array of listings Z

…and the solution should slot into the existing booking-node tree and work well
with parent/child setups.

## Finding

**This feature is Phase 4 of `booking-unification.md` ("buyer-choice inside
packages"), and the unification that landed in #1482 already built most of it.**
We do not need a new "groups" subsystem, a new membership table, or a new node
kind. The recommended model is:

> **A choice slot is a package member that is a parent listing.**
> The candidate array is the slot listing's `listing_parents` child edges.
> The pick count is the member's existing `group_listings.quantity`.

The example maps directly:

| Slot | Stored as | Pick count |
|---|---|---|
| "Choose your X" | parent listing, children = X | member `quantity` = 1 |
| "Choose your Y" | parent listing, children = Y | member `quantity` = 1 |
| "Choose your Z" | parent listing, children = Z | member `quantity` = 2 |

All three slot listings are members of one `is_package` group. Nothing new is
persisted anywhere: the tree's two existing edge stores (`group_listings` for
package membership + per-package quantity, `listing_parents` for the candidate
sets) already encode the whole configuration, so Phase 3's one-way schema door
stays closed.

## Why this shape — the machinery already exists

Walking the five unified operations shows how little is genuinely missing:

### 1. The tree already represents it

`buildPackageMemberNode` (`src/shared/booking/build-tree.ts`) already calls
`buildChildren`, so a package member that is a parent builds as a
`FIXED(pickCount)` node with `BUYER_CHOICE` child nodes — "a package member
that is a parent is simply a node one level deeper — no special case"
(`src/shared/booking/tree.ts`). The node identity
`package:<g>/member:<slot>/child:<candidate>` is already defined and distinct
from the standalone and regular-group paths (`childNodeKey`).

### 2. The fold already enforces "pick exactly N"

The selection algebra the feature needs **is** the parent/child fold:

- `resolvePageQuantities` (`src/features/public/ticket-submit.ts`) expands each
  member to `fixedQty × packageQty`, so a pick-2 slot in a 3-package order
  requires 6 candidate units.
- `foldBookingTree` (`src/shared/booking/fold-tree.ts`) walks every in-cart
  top-level node with children — package member nodes included — and
  `resolveChildSelections` requires the submitted `child_qty_<slot>_<candidate>`
  quantities to **sum to exactly** the slot's quantity, with sole-candidate
  auto-fill, too-few/too-many errors, and rejection of quantities on
  non-bookable/stranger candidates.

Zero new fold code: "must select 2 from Z" is `resolveChildSelections` with
`parentQty = 2 × packageQty`.

### 3. Pricing composes correctly

`priceRuleByListingId` (`src/shared/booking/price-tree.ts`) gives the slot line
the package `OVERRIDE` (top-level wins) while each chosen candidate folds at its
**own** price. That means per-candidate supplements come free: a £0 slot with
£0 candidates is a pure chooser; a candidate with a positive `unit_price` is a
"+£5 supplement"; the slot's `package_price` charges per pick.

### 4. Persistence and display hold — for disjoint candidate sets

The fold emits one `ChildAllocation` per (candidate, slot) and one persisted
row per allocation; the slot (parent) row is booked as its own row — exactly
the "keep parent rows" invariant. Every row carries `package_group_id`, so the
existing package ticket-card/email grouping applies unchanged.

**Caveat: this holds only while each chosen candidate appears under one slot.**
A candidate shared by two slots folds to ONE summed child line but TWO
allocations; the paid webhook's `expandChildAllocations` then produces more
booking rows than `intent.items`, and `processPaidBooking` maps created
attendees back to listings **by index** (`validatedItems[i]!`,
`src/features/api/payment-processing.ts`) — a mismatch that can crash or
mis-label rows after payment. The unique `(listing_id, attendee_id, start_at)`
row index also folds multi-parent children into one row today, documented as a
"rare multi-parent corner" (`src/shared/db/attendees/order-parents.ts`) —
overlapping slots would make that corner mainstream. Phase A therefore
**requires a package's slot candidate sets to be pairwise disjoint** (enforced
by the shared predicate, section A); lifting that means fixing the paid-path
entry mapping first (phase B).

### 5. Webhook revalidation already covers it

`edgeDrifted` (`src/shared/booking/signed-metadata.ts`) already resolves each
allocation via `childNodeKey(packageMemberNodeKey(group, slot), candidate)`
against the freshly rebuilt tree — an operator who removes a candidate or the
slot mid-checkout already takes the `price_changed` refund path.

## The actual gaps — the work

### A. The admin gate (six save paths, one shared predicate)

Today every save path bans parent/child edges anywhere near a package
(`isPackageableMember` → `hasParentChildEdge` in `src/features/admin/groups.ts`;
`packageMembershipError` in `src/shared/listings-actions.ts`;
`packageChildEdgeConflict` in `src/features/admin/listings-parents.ts` and the
JSON API; the single-listing duplicate and group bulk-duplicate paths).
`booking-unification.md` already enumerates all six and requires they move
**together** onto one shared predicate. The new rule:

- A package member **may** be a parent iff every child is a valid
  **candidate**: standard, fixed-price (`!can_pay_more`), not
  daily/`customisable_days` (phase A — the doc's "fixed-price, date-less
  deterministic" child rule, now relaxed from *deterministic* to
  *buyer-choice*), not itself a package member (keep the
  `anyListingInPackageGroup` arm), and not itself a parent (parent/child is
  one level deep everywhere already).
- Only the **parent direction** of today's `hasParentChildEdge` guard is
  relaxed. A member that is itself a **child** under another parent stays
  rejected (`edgeIdsTouching(...).parentIds` non-empty): a child-only add-on
  listing is non-standalone precisely because it is sold under its parent, so
  admitting it as a package member would sell it directly and bypass that
  gate.
- **Candidate sets of a package's slot members must be pairwise disjoint**
  (phase A): a candidate under two slots folds to one summed line with two
  allocations, which the paid path's index-based attendee↔listing mapping and
  the unique row index cannot represent (see the caveat under "Persistence").
- Removing/adding a child edge on a listing that is a package member re-runs
  the same predicate (the children form and API already call
  `packageChildEdgeConflict`; it becomes this predicate).

### B. Package-page render

`renderPackageRows` (`src/ui/templates/public/reservations.tsx`) currently
emits read-only member rows only. A slot member row additionally renders the
**existing** per-parent child block (`child_qty_<slotId>_<candidateId>` selects
— same field names, same `childCtx` machinery the multi-listing page uses), so
render/submit keep sharing the tree's field-name single source of truth. The
page must start passing `childCtx`/`childrenByParentId` through the package
branch of `buildPageListingRows` (the tree already builds the child nodes; the
render just drops them today).

Client JS: listening to `package_quantity` is necessary but **not
sufficient**. The child enhancement scripts (`child-selection.ts`,
`child-required.ts`, `child-compat.ts`) decide "parent in cart" and the
required child total via `parentInCart()`/`quantityValue()`, which read the
`quantity_<parentId>` control — and a package member deliberately renders no
such control, so a slot's candidate-scoped questions and required totals
would read as inactive even though the server fold requires them. Each slot
therefore needs an explicit in-cart signal: carry the member's fixed
per-package quantity on the slot's child fieldset (e.g.
`data-package-member-qty`), and extend `parentInCart`/the required-total
derivation to compute a slot's active quantity as
`package_quantity × fixedQty` when that attribute is present (falling back to
`quantity_<id>` on ordinary pages). The running total
(`src/ui/client/order.ts`) prices chosen candidates off the same derived
quantity.

### C. Capacity + discovery parity

`packageQuantityCap` (`src/shared/booking/capacity-tree.ts`) walks only
top-level member nodes. Two pieces of work:

- **Extract the cohort math first.** `childCombinedCap` is a *private*
  render helper in `src/ui/templates/public/reservations.tsx`, and that
  module already imports `packageQuantityCap` from `capacity-tree.ts` — so
  the capacity walk cannot reuse it in place without a shared→UI circular
  dependency. Move the separate-pool / shared-capped-group cohort math into a
  shared booking module (e.g. `src/shared/booking/child-capacity.ts`)
  consumed by both the render clamp and the package cap.
- **Fold candidate demand into the same per-group demand walk — not an
  independent minimum term.** A slot contributes two constraints: its
  candidates' combined supply (`⌊combined candidate cap ÷ pickCount⌋`, via
  the extracted cohort math) **and** `pickCount` units of per-package demand
  against every capped group its candidates draw from — aggregated into the
  *same* `demandByGroup` map as the fixed members, because a candidate and a
  fixed member can share a capped pool. Example: fixed member M and candidate
  C both in capped group G with 2 remaining; independent terms each allow 2
  packages, but one package consumes 2 G-spots (1 for M, 1 for C), so only 1
  fits. Candidate demand is buyer-mix-dependent, so bucket it the way the
  cohort math already does (conservative on shared pools); the atomic batch
  write predicate remains the authoritative backstop for whatever the clamp
  cannot see. `resolvePageQuantities` clamps the posted count with the same
  function, so the submit clamp comes along automatically.

Discovery: `packageGroupBookable` (`src/features/public/discovery.ts`) builds
its tree without `childrenByParentId`; it must load candidates so `/listings`,
`/order`, `/order.js`, feeds, the API, and QR gating hide/re-show in lockstep
with the ticket page (a slot whose candidates are all sold out caps the
package at 0 — all-or-nothing holds).

### D. Questions

`splitChildQuestions` already dedupes and fans child-assigned questions; the
package branch just doesn't pass `childCtx` today. Wiring B fixes this: a
question assigned to a candidate renders once and fans back onto every
relevant row via the existing listing-keyed answer flow.

### E. Hidden packages — one design decision

`hide_package_listings` conceals members, and `buildChildNode` inherits
`HIDDEN` down the subtree — but a buyer cannot choose from candidates they
cannot see. The combination is contradictory. **Recommendation: the shared
predicate rejects parent members in a hidden package** (and rejects hiding a
package that has one). Revisit only if a real operator needs a "mystery slot".

### F. Metadata budget

Each pick adds a signed line **and** an `allocations` entry, and
`enforceMetadataLimits` (`src/shared/payment-helpers.ts`) currently
length-checks `items`, answer ids, `modifiers`, the packed field, and the
entry count — but **not** `allocations`. Choice slots make `allocations` the
fastest-growing field, so it must join the per-value length check (with an
over-cap regression test), or a large multi-slot checkout fails with a raw
provider error instead of the app's user-facing "book in smaller batches"
message. Per `booking-unification.md`, also add limit tests asserting a
multi-slot, multi-pick package stays within Square's entry-count/value-length
caps.

### G. No standalone booking of a slot listing

Marking a slot listing `hidden` only removes it from discovery — the
explicit-slug entry points still resolve active hidden listings: a parent is a
valid `/ticket/<slug>` entry that folds its children, `withActiveListings`
404s only children and hidden-package members, and the JSON API's
`findActiveListing` resolves it too. A £0 (or price-divided) chooser parent
could therefore be bought outside the package, bypassing the fixed members and
the package pricing. Fix at the shared gate: extend
`lacksStandalonePublicPage` (`src/features/public/ticket-payment.ts`) — child
OR hidden-package member OR **package member with child edges** — and apply
the same predicate in `withActiveListings`, the JSON API lookup, and QR
issuance. Admin public-URL/QR/embed affordances already route through
`lacksStandalonePublicPage`, so they gate automatically ("never render a dead
or forbidden link"). Ordinary (childless) package members stay
standalone-bookable at their own price — existing, deliberate behaviour.

## Semantics (accepted, to document)

- **Exact-sum.** "Must select N" — matches the ask. Optional slots ("up to N")
  map onto the already-declared-but-unused `OPTIONAL(min,max)` quantity rule;
  defer until wanted.
- **Cross-package mixing.** 2 packages × pick-2 = 4 picks in any mix, not
  "2 per package unit" — identical to how a parent quantity distributes across
  children today. Per-unit mixes would need node-instance identity (a much
  bigger change); not recommended.
- **Repeats allowed.** Pick-2 may choose the same candidate twice (again
  matching parent/child). A per-slot "distinct" flag is a possible later
  refinement.
- **Per-pick pricing.** The slot's price (own or `package_price` override)
  charges per pick, because pick count *is* the member quantity. A flat
  bundle price lives on a separate fixed member or on the slot at
  price ÷ picks.

## Alternatives considered and rejected

1. **A `package_slots` table (slot rows + `slot_id` on `group_listings`).**
   Introduces a *third* edge encoding next to `listing_parents` and
   `group_listings` — the exact proliferation `booking-unification.md` Phase 3
   warns about — and a slot is not a listing, so it cannot be a `BookingNode`:
   every walk (render, fold, price, capacity, metadata, revalidation,
   persistence) would need a parallel virtual-node arm. Contradicts the
   "unify systems" rule for strictly less capability (no slot name/price/row
   without re-adding columns the parent listing already has).
2. **Choice rules directly on member rows (`min`/`max` columns on
   `group_listings`, members as candidates).** Avoids the slot listing but
   rebuilds `resolveChildSelections` as a parallel "slot-sum" constraint with
   new field names, new signed-metadata provenance, and still needs somewhere
   to hang the slot's name and price. Rebuilding parent/child without listings.
3. **Admin-UX-only objection to the chosen model** — "operators must create a
   fake listing per slot" — is real but belongs in the UI layer, not storage:
   a follow-up "add choice slot" affordance on the group edit page can mint
   the parent listing + child edges in one step. Slot listings are kept off
   every standalone surface by the extended `lacksStandalonePublicPage` gate
   (section G) — `hidden` alone is not enough, since direct `/ticket/<slug>`
   and the JSON API resolve active hidden listings.

## Test matrix (beyond 100% coverage)

- **Admin:** the slot configuration accepted via *every* save path (group
  edit/add-listings, listing save, children form, JSON API, both duplicate
  paths); pay-more/daily/nested/package-member candidates rejected from each;
  a listing that is itself a **child** under another parent rejected as a
  member; two slots of one package sharing a candidate rejected;
  hidden-package × slot rejected both directions.
- **Fold:** pick-counts enforced exactly at `packageQty ∈ {1, 2}` ×
  `pickCount ∈ {1, 2}` (regression on a doubled/missing multiplier); mixed
  picks across candidates; repeat picks; tampered candidate ids rejected.
- **Pricing:** slot `OVERRIDE` per pick + candidate supplement at own price;
  running total (`/calculate`) matches submit matches webhook re-price.
- **Capacity:** package cap clamped by `⌊candidate combined cap ÷ pickCount⌋`;
  a candidate and a fixed member sharing one capped pool cap at the *joint*
  per-package demand (the 2-remaining example above yields 1, not 2); a
  sold-out candidate set ⇒ package sold out everywhere discovery looks
  (cards, `/order.js`, feeds, API, QR) in lockstep with the ticket page.
- **Client enhancement:** with only `package_quantity` set (no
  `quantity_<id>` controls), a slot's candidate-scoped questions show/require
  and the required child total reads `pickCount × packageQty`.
- **Webhook:** removing a candidate/slot edge mid-checkout ⇒ `price_changed`;
  allocations persist one row per (candidate, slot) with `package_group_id`.
- **Display/privacy:** package ticket card groups slot + chosen candidates;
  no surface names a candidate of a (rejected) hidden configuration.
- **Standalone bypass:** a slot listing 404s on direct `/ticket/<slug>`, the
  JSON API lookup, and QR issuance — even when active and non-hidden — and
  admin URL/QR/embed affordances render no link for it.
- **Metadata budget:** a 3-slot, multi-pick package within provider caps; an
  over-cap `allocations` blob surfaces the batching `PaymentUserError`, not a
  provider rejection.

## Phasing

- **Phase A (this feature):** shared admin predicate + package-page child
  block + capacity/discovery extension + client JS + the matrix above.
  Candidates restricted to standard fixed-price listings; shown packages only.
- **Phase B (only on real demand):** optional slots via `OPTIONAL(min,max)`,
  pay-more/daily candidates (needs per-slot price/date inputs on the package
  page), per-slot distinct flag, group-edit slot-builder UX.

The heavy lifting — fold, pricing, signed metadata, revalidation, persistence
— shipped with #1482. The remaining work concentrates in the admin predicate
(six paths), the package render + client JS, the capacity walk + discovery
parity, and the test matrix.
