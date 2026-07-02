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

### 5. Webhook revalidation covers removed/swapped edges — two stale-session
gaps remain

`edgeDrifted` (`src/shared/booking/signed-metadata.ts`) already resolves each
allocation via `childNodeKey(packageMemberNodeKey(group, slot), candidate)`
against the freshly rebuilt tree — an operator who removes a candidate or the
slot mid-checkout already takes the `price_changed` refund path.

What it does **not** catch is edges *gained* mid-checkout; phase A closes two
stale-session holes in `validateAllItems`
(`src/features/api/payment-processing.ts`):

- **A package member gaining its first child edge.** With no `allocations`,
  `edgeDrifted` only verifies each signed package-member `nodeKey` still
  resolves — which it does after child edges are added — so the webhook would
  book the now-slot parent with **no chosen candidate**. Add a drift rule:
  every signed package-member line whose *current* node has children must be
  covered by allocations, else the session fails closed to `price_changed`.
- **A standalone session for a listing that becomes a slot.**
  `orderEdgeDrifted` returns early for intents with no allocations and no
  `packageGroupId`, and the only stale-config guard is `staleHiddenMember` —
  so a checkout opened just before the listing became a slot books it
  standalone after every new entry point 404s. Add a stale-slot guard exactly
  analogous to `staleHiddenMember` (fail closed after pricing, refund via
  `price_changed`).

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
  *buyer-choice*), **not `hidden`** (a hidden child node is `HIDDEN` in the
  tree and dropped from render, so it would either underfill an exact-sum
  slot or leak a listing the operator hid), not itself a package member
  (keep the `anyListingInPackageGroup` arm), and not itself a parent
  (parent/child is one level deep everywhere already).
- The candidate rules **compose with** the existing per-edge blockers in the
  parent/child save path, they do not replace them: `edgeFieldError` (no
  renewal-tier children, `months_per_unit > 0`, plus the daily-child field
  rules) and `childEdgeError`'s rejection of child-only opt-in add-ons
  (`getTicketContext` loads add-ons only for the page listing ids, so a
  slot page could never render them) both still apply to slot candidates.
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
- **Editing a candidate's own fields re-runs it too.** Candidate eligibility
  depends on the child listing's fields (`can_pay_more`, `listing_type`,
  `customisable_days`, `hidden`, renewal tier), and the listing-save edge
  revalidation
  (`validateListingEdges` → `edgeIncompatibilityAfterChange` →
  `edgeFieldError`) checks only the generic parent/child field rules — an
  existing valid candidate could be edited to pay-more/daily and stay under
  a slot the package page cannot price. The listing-save path must invoke
  the slot-candidate predicate for every edge touching the edited listing
  (whether it is the candidate or the slot).

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
- **Reserve deterministic demand, then check candidate supply against the
  residual pools — neither an independent minimum nor unconditional
  worst-case demand.** Candidate demand is buyer-mix-dependent, so both naive
  models fail in opposite directions. An *independent* candidate-only term
  misses shared pools: fixed member M and sole candidate C both in capped
  group G with 2 remaining — independent terms each allow 2 packages, but one
  package consumes 2 G-spots (1 for M, 1 for C), so only 1 fits. But
  *unconditionally* charging `pickCount` demand to every pool any candidate
  touches over-constrains slots with alternatives: same M and C in G, plus
  candidate D outside G — 2 packages are bookable by picking D twice, yet a
  worst-case demand map divides G by fixed+candidate demand and caps at 1.
  The correct walk: for a target package count `q`, subtract the
  deterministic per-package demand (fixed members and slot own lines,
  `× q`) from each capped pool, then check each slot's candidates can supply
  `pickCount × q` against those **residual** pools via the extracted cohort
  math; the cap is the largest feasible `q` (supply is monotone in `q`, so a
  closed-form/loop over the member-cap bound works). Two refinements the
  residual formulation forces on the extracted helper:
  - **Child-only cohort mode.** `childCombinedCap`'s shared-group term
    divides by `PARENT_CHILD_GROUP_UNITS` because it prices parent *and*
    child demand together. Once the slot's own demand is already reserved
    from the pool, reusing that term double-counts the slot: a slot and its
    sole candidate both in group G with 2 remaining should allow 1 package,
    but reserve-then-parent+child math leaves residual 1 and reports
    `⌊1/2⌋ = 0`. The extracted helper needs a child-only/residual mode for
    package slots (divide by candidate demand alone).
  - **Cross-slot feasibility is a joint assignment, not per-slot checks.**
    Checking each slot independently against the residual overstates capacity
    when slots' candidates draw on shared capped pools: two pick-1 slots with
    disjoint candidates C1 and C2 both only in group G with 1 spot left each
    pass alone at `q = 1`, but one package needs 2 G-spots. Nor is
    aggregating only each pool's *forced* demand (slots confined to the pool)
    enough — with three pick-1 slots whose candidates all draw from pools G
    or H at 1 spot each, no single pool is forced and every slot has supply,
    yet 3 units cannot fit a 2-seat union, so discovery would advertise a
    package every submitted mix fails (a dead CTA). And the feasibility
    variables must be **per-candidate, not per-pool**: booking one unit of a
    candidate consumes a seat in *every* capped group it belongs to (the
    write/read capacity path counts a listing against each group in its
    membership — `src/shared/db/attendees/capacity.ts`,
    `src/shared/db/capacity.ts`), so a sole candidate in pools G **and** H
    with 1 spot each supplies 1 unit, not 2 — a pool-level Hall/flow model
    would see two alternative seats. The check at count `q` is therefore a
    small feasibility system over per-candidate unit counts `x_c`, with
    THREE constraint families: per slot,
    `Σ x_c over its candidates = pickCount × q`; per capped pool,
    `Σ x_c over candidates in the pool ≤ residual`; and per candidate,
    `x_c ≤ its own remaining capacity` (the `childOwnRenderCap` bound —
    without it, pick-2 over two candidates with 1 remaining each and no
    capped pool would pass at `q = 2` by assigning 4 units the candidates
    cannot fulfil). Package configs are tiny (a handful of slots,
    candidates, and pools), so solving it exactly is cheap; the atomic batch
    write predicate remains the final authority for the buyer's actual mix
    (per-date dimensions and races it alone can see).
    `resolvePageQuantities` clamps the posted count with the same function,
    so the submit clamp comes along automatically.
  - **The render/submit cap context must include candidate pools.**
    `getTicketContext` builds `packageMemberGroupIds` /
    `packageGroupRemainingByGroupId` from **top-level member ids only**, so a
    capped group that only candidates sit in is invisible to
    `packageQuantityCap` on `/ticket/<package>` and to the
    `resolvePageQuantities` clamp — two candidates in a one-spot group would
    render/submit capacity for two packages even after discovery is fixed.
    Widen the package cap context to candidate listing ids and their capped
    groups' remaining on render and submit as well as discovery.

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

### G. No standalone booking of a slot listing — every surface, one predicate

Marking a slot listing `hidden` only removes it from discovery — the
explicit-slug entry points still resolve active hidden listings: a parent is a
valid `/ticket/<slug>` entry that folds its children, `withActiveListings`
404s only children and hidden-package members, and the JSON API's
`findActiveListing` resolves it too. A £0 (or price-divided) chooser parent
could therefore be bought outside the package, bypassing the fixed members and
the package pricing.

The fix is to give a slot listing the same non-standalone treatment a child
gets, from **one** extended predicate — `lacksStandalonePublicPage`
(`src/features/public/ticket-payment.ts`) becomes child OR hidden-package
member OR **package member with child edges** — applied on every surface
where children are handled today. **Layering:** the new test itself must live
at the DB layer (a shared helper/SQL predicate alongside
`getHiddenPackageMemberIds`, e.g. `getSlotListingIds` in
`src/shared/db/groups.ts` joining `group_listings` × `listing_parents`),
because catalog consumers like `getCatalogListings` live in
`src/shared/db/listings.ts` and cannot import
`features/public/ticket-payment.ts` without a shared→feature cycle;
`lacksStandalonePublicPage` delegates to it. Enumerating the surfaces (each
is a real bypass otherwise):

- **Direct slug entries:** `withActiveListings` (web) and the JSON API's
  `findActiveListing`.
- **QR — issuance AND scan.** The scan handler
  (`src/features/public/qr-book.ts`) does not route through
  `withActiveListings`; it rejects only children and hidden-package members
  before dispatching to `handleTicket`. A QR minted just before a listing
  became a slot would keep booking it standalone for the token's lifetime, so
  the scan handler runs the same predicate.
- **Regular (non-package) group pages.** Membership is many-to-many, and
  `visibleGroupMembers` drops only hidden-package members for non-package
  groups — a slot listing that also joined a regular group would render there
  as an ordinary parent row with child selectors. Drop slot members from
  non-package group sets, mirroring how `dropChildListings` strips children
  from indirectly-loaded pages.
- **Public catalogs/discovery.** `getCatalogListings`
  (`src/shared/db/listings.ts`), the `/listings` page classification, the
  `/order` gallery, and the public API list endpoint (`handleListListings`,
  `src/features/api/index.ts`) exclude children and hidden-package members
  but would still advertise a slot card/entry pointing at the now-404
  `/ticket/<slot>` URL.
- **Admin dashboard multi-booking builder.** Its checkboxes generate
  `/ticket/<slug+slug>` URLs and exclude only
  `childIds ∪ hiddenMemberIds` (`src/features/admin/dashboard.ts`) — an
  active non-hidden slot would stay selectable and emit a URL the direct-slug
  guard rejects.
- **Payment cancel/retry page.** `cancelPageResponse`/`retryHrefFor`
  (`src/features/api/payment-processing.ts`) build a non-package intent's
  retry URL from `intent.items[0]`, so a standalone session opened before
  the listing became a slot and then cancelled would render a retry link to
  the now-404 `/ticket/<slot>`. Run the same predicate there and suppress or
  redirect the retry CTA for stale-slot sessions.
- **Admin share affordances — explicitly, not "automatically".** The admin
  listing view computes `shareSuppressed = isChild || isHiddenPackageMember`
  from flags `listings-view.ts` passes into the template — it does **not**
  call `lacksStandalonePublicPage` — so the view must pass (or the template
  derive) the extended predicate, with a regression asserting an active
  non-hidden slot renders no public URL/QR/embed links.

Ordinary (childless) package members stay standalone-bookable at their own
price — existing, deliberate behaviour.

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
  renewal-tier (`months_per_unit > 0`), `hidden`, and child-only opt-in
  add-on candidates rejected (the existing edge blockers still apply);
  editing an existing candidate to pay-more/daily/hidden rejected at listing
  save; a listing
  that is itself a **child** under another parent rejected as a member; two
  slots of one package sharing a candidate rejected; hidden-package × slot
  rejected both directions.
- **Fold:** pick-counts enforced exactly at `packageQty ∈ {1, 2}` ×
  `pickCount ∈ {1, 2}` (regression on a doubled/missing multiplier); mixed
  picks across candidates; repeat picks; tampered candidate ids rejected.
- **Pricing:** slot `OVERRIDE` per pick + candidate supplement at own price;
  running total (`/calculate`) matches submit matches webhook re-price.
- **Capacity:** package cap clamped by `⌊candidate combined cap ÷ pickCount⌋`;
  a candidate and a fixed member sharing one capped pool cap at the *joint*
  per-package demand (the shared-pool example above yields 1, not 2); a slot
  with an alternative candidate outside the shared pool is NOT
  over-constrained (the M/C/D example yields 2, not 1); a slot and its sole
  candidate sharing one pool with 2 remaining yield 1, not 0 (child-only
  residual mode, no parent+child double-count); two slots whose candidate
  sets both sit inside one 1-spot pool yield 0, not 1; three pick-1 slots
  over two pools with 1 spot each yield 0, not 1 (joint assignment, not
  per-slot or forced-demand checks); a sole candidate in TWO 1-spot pools
  supplies 1 unit, not 2 (per-candidate variables, one unit charges every
  pool it sits in); pick-2 over two uncapped-pool candidates with 1
  remaining each yields 1 package, not 2 (per-candidate own-capacity
  bound); a candidate-only capped pool clamps the
  `/ticket/<package>` render and POST, not just discovery; a sold-out
  candidate set ⇒ package sold out everywhere discovery
  looks (cards, `/order.js`, feeds, API, QR) in lockstep with the ticket
  page.
- **Client enhancement:** with only `package_quantity` set (no
  `quantity_<id>` controls), a slot's candidate-scoped questions show/require
  and the required child total reads `pickCount × packageQty`.
- **Webhook:** removing a candidate/slot edge mid-checkout ⇒ `price_changed`;
  a package member gaining its FIRST child edge mid-checkout ⇒
  `price_changed` (never books the slot parent without a candidate); a
  standalone session whose listing became a slot mid-checkout ⇒
  `price_changed` (the stale-slot analogue of `staleHiddenMember`);
  allocations persist one row per (candidate, slot) with `package_group_id`.
- **Display/privacy:** package ticket card groups slot + chosen candidates;
  no surface names a candidate of a (rejected) hidden configuration.
- **Standalone bypass:** a slot listing 404s on direct `/ticket/<slug>`, the
  JSON API lookup, QR issuance, AND the QR **scan** path (a token minted
  before the listing became a slot) — even when active and non-hidden; it is
  dropped from a regular group's `/ticket/<group>` page it also belongs to;
  it appears on no catalog surface (`/listings`, `/order`, `/order.js`,
  feeds, `/api/listings`); the admin dashboard multi-booking builder does not
  offer it; a cancelled stale standalone session renders no `/ticket/<slot>`
  retry link; and admin URL/QR/embed affordances render no link for it.
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
