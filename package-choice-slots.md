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

### 4. Persistence and display already hold

The fold emits one `ChildAllocation` per (candidate, slot) and one persisted
row per allocation; the slot (parent) row is booked as its own row — exactly
the "keep parent rows" invariant. Every row carries `package_group_id`, so the
existing package ticket-card/email grouping applies unchanged.

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

Client JS: `src/ui/client/admin/child-selection.ts` already listens to
`package_quantity` changes; the per-slot required-total becomes
`pickCount × packageQty` and the running total (`src/ui/client/order.ts`)
prices chosen candidates — mostly parameterising existing child logic by the
package multiplier.

### C. Capacity + discovery parity

`packageQuantityCap` (`src/shared/booking/capacity-tree.ts`) walks only
top-level member nodes. For a slot member it must add a candidate term: the
most whole packages the slot's **bookable candidates can jointly supply**,
i.e. `floor(childCombinedCap(slot, candidates) / pickCount)` — reusing
`childCombinedCap` (`reservations.tsx`), which already handles the
separate-pool / shared-capped-group cohort math — alongside the slot's own-cap
and group-pool arms. Because `resolvePageQuantities` clamps the posted count
with the same function, the submit clamp comes along automatically; the atomic
write predicate remains the authoritative backstop.

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

Each pick adds a signed line + allocation. Per `booking-unification.md`, add
limit tests asserting a multi-slot, multi-pick package stays within Square's
entry-count/value-length caps.

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
   the parent listing + child edges in one step. Slot listings can be marked
   `hidden` to stay out of standalone discovery (children/parents already have
   standalone-page gating).

## Test matrix (beyond 100% coverage)

- **Admin:** the slot configuration accepted via *every* save path (group
  edit/add-listings, listing save, children form, JSON API, both duplicate
  paths); pay-more/daily/nested/package-member candidates rejected from each;
  hidden-package × slot rejected both directions.
- **Fold:** pick-counts enforced exactly at `packageQty ∈ {1, 2}` ×
  `pickCount ∈ {1, 2}` (regression on a doubled/missing multiplier); mixed
  picks across candidates; repeat picks; tampered candidate ids rejected.
- **Pricing:** slot `OVERRIDE` per pick + candidate supplement at own price;
  running total (`/calculate`) matches submit matches webhook re-price.
- **Capacity:** package cap clamped by `⌊candidate combined cap ÷ pickCount⌋`;
  shared capped pools between candidates and members; a sold-out candidate
  set ⇒ package sold out everywhere discovery looks (cards, `/order.js`,
  feeds, API, QR) in lockstep with the ticket page.
- **Webhook:** removing a candidate/slot edge mid-checkout ⇒ `price_changed`;
  allocations persist one row per (candidate, slot) with `package_group_id`.
- **Display/privacy:** package ticket card groups slot + chosen candidates;
  no surface names a candidate of a (rejected) hidden configuration.
- **Metadata budget:** a 3-slot, multi-pick package within provider caps.

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
