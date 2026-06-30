# Booking unification — one booking interface for all three models

## Why this doc exists

We grew **three** booking models independently, and they have started to collide
(packages ✕ parent/child, capped-group pools, hidden-member privacy). Each new
cross-feature edge case costs another special case. This doc records the model
that unifies them, so that when we have the appetite to do the big refactor we
are not re-deriving it from scratch — and so that the **interim** feature we are
shipping now (auto-include, see "Stage 0") is built pointing *toward* the
unified model rather than away from it.

The thesis, in the user's words:

> I don't see any reason why the package interface and the parent/child interface
> and the totally normal booking interface can't all be the same thing — there's
> required items, optional items, hidden items, for all three of those.

This doc argues that thesis is **correct** and **achievable**, lays out the
target model, and stages the migration so each step ships green.

> **Branch context.** This doc is written against the **groups-as-packages
> branch** (#1462), not `main`. The "Package" model, its schema
> (`group_listings`, `is_package`, `package_price`, `hide_package_listings`,
> `package_group_id`) and the `groupPoolUnits` capacity leaf referenced below
> **exist on that branch**; on `main` they are still *proposed*. Read every
> "today"/"on this branch" claim as "as of #1462". When this doc lands on `main`
> it should land together with (or after) #1462.

---

## The three models today

| Aspect | Normal listing | Parent/child | Package (group `is_package`) |
|---|---|---|---|
| Shape | flat | tree (parent → chosen children) | flat (members) |
| Entry point | `/ticket/<slug>` | `/ticket/<parent-slug>` | `/ticket/<group-slug>` |
| Membership store | — | `listing_parents` edges | `group_listings` rows |
| Quantity | buyer-chosen | parent qty distributed across children | `fixedQty × packageQty` |
| Pricing | base / `can_pay_more` / day-price | child folds at own price | `package_price` override per member |
| Visibility | the listing itself | children surfaced under parent | members listed, or `hide_package_listings` |
| Capacity | own cap + group caps | each line's own cap + group caps | `packageQuantityCap` over members + shared group pools |
| Render | `ticketPage` | `ticketPage` + per-child selectors | `packagePageAvailability` |
| Fold | none | `foldSelectedChildren` | members expanded by `packageQty` |
| Ticket card | one card | one card per line | one **package** card (members folded) |

Read across the rows and the same primitives keep recurring: **a set of lines,
each with required/optional/fixed quantity, a visibility flag, a price (base or
overridden), and a capacity constraint (own + shared pools).** The three models
are three *configurations* of one structure, not three structures.

---

## The target model — a booking-node tree

A booking is a **tree of nodes**. Each node is one listing plus the facets that
every model already needs:

```
BookingNode {
  listingId
  quantityRule:  REQUIRED(qty) | FIXED(qty) | OPTIONAL(min,max) | BUYER_CHOICE
  priceRule:     BASE | OVERRIDE(amount) | PAY_MORE(min,max) | DAY_PRICE
  visibility:    SHOWN | HIDDEN          // hidden ⇒ never named on a buyer surface
  children:      BookingNode[]           // empty for a leaf
}
```

The three models map onto it directly:

- **Normal listing** = a single `BUYER_CHOICE / BASE / SHOWN` leaf. (The
  "single item is an array of one" principle from AGENTS.md: the normal booking
  is a one-node tree, not a special case.)
- **Parent/child** = a `BUYER_CHOICE` parent whose children are `BUYER_CHOICE`
  leaves that must total the parent's quantity. (Today's `foldSelectedChildren`.)
- **Package** = a synthetic root node (the group) with one `FIXED(packageQty ×
  memberQty)` child per member; `OVERRIDE` price per member; `HIDDEN` children
  when `hide_package_listings`. (Today's package expansion.)

And the cross-products that are *currently impossible* fall out for free:

- **Package member that is a parent** = a `FIXED` package member node that itself
  has children. (This is exactly the interim "auto-include" feature — Stage 0.)
- **Hidden optional add-on**, **required-but-free child**, etc. — all just facet
  combinations, no new code path.

### The five operations, generalized

Everything the booking system does is one of five tree walks. Unification means
writing each **once**, recursively, instead of three times:

1. **Render** — walk the tree, emit a control per `SHOWN` node (`FIXED`/`REQUIRED`
   shown read-only, `BUYER_CHOICE` as an input, `OPTIONAL` as an optional input),
   omit `HIDDEN` nodes. Today: `ticketPage` + `packagePageAvailability` +
   per-child selectors → **one** recursive renderer.
2. **Fold** — walk the submitted form into a flat `Map<listingId, qty>` +
   `customPrices` + `allocations`, validating each node's `quantityRule`. Today:
   `foldSelectedChildren` (parent/child) + package expansion → **one** recursive
   fold. The current `FoldState`/`ChildAllocation` already has the right shape;
   it just needs a package-member level above the parent level.
3. **Price** — each node contributes `effectivePrice(node) × qty` to its line and
   to the signed `BookingItem.p`. `OVERRIDE` wins, then `PAY_MORE`, then
   `DAY_PRICE`, then `BASE`. Today: `loadPackagePricing` + `expectedItemPrice` +
   child fold price → **one** `effectivePrice(node)`.
4. **Capacity** — **every booked node** consumes capacity, not only the leaves: a
   parent line is itself sold, so it charges its own listing cap and group pools
   alongside its chosen child. Demand for a listing reachable by more than one
   path in the same booking is **summed**, not deduped — the walk aggregates
   quantities per (listing, group pool), so an order consuming two units is never
   validated as one. A parent/package then bounds its quantity by the tightest
   child/member pool. Today: `packageQuantityCap` + `childCombinedCap` + per-line
   availability, all already routing through the shared `groupPoolUnits` leaf —
   that leaf is the seed of the unified capacity walk.
5. **Revalidate (webhook)** — re-walk the tree at payment time and recompute
   price × qty for every node against current config; any drift → `price_changed`
   refund. Today: package revalidation + child revalidation → **one** walk.

The fact that step 4 *already* funnels through one primitive (`groupPoolUnits`,
added on the groups-as-packages branch #1462) is the proof of concept: when we
found two capacity code paths and asked "can these be one calculation?", the
answer was yes. The same is true of the other four operations.

---

## What makes it tractable (and what doesn't)

**Tractable, because the hard invariants are already centralized on this branch:**

- Hidden-member privacy is enforced by a single set of helpers
  (`getHiddenPackageMemberIds`, `isHiddenPackageMember`, `getVisibleGroupMembers`,
  `getPackageDisplaysByIds`) that a `visibility: HIDDEN` facet would call into.
- Capacity already has the shared `groupPoolUnits` leaf and shared SQL predicate.
- The fold already produces per-(child,parent) allocations and one
  `listing_attendees` row per allocation. Those allocation rows are the *child*
  leaves — but the **parent line is persisted as its own booked row too**, so the
  stored order is the full set of booked nodes (parents *and* child allocations),
  carrying each node's sold quantity and pricing context. Stage 2/3 must preserve
  parent rows, not collapse the tree down to leaves.

**Not tractable as a big-bang rewrite, because:**

- **Cardinality ambiguity.** `BUYER_CHOICE` children (multiple children totalling
  the parent quantity, buyer picks the mix) cannot be expanded deterministically.
  A package needs every quantity known before render (to price the bundle and cap
  it). So a package member-parent can only auto-include **deterministic** children
  (`FIXED`/sole-`REQUIRED`), never `BUYER_CHOICE`. This is the central scoping line
  for Stage 0 and must stay a rejected-at-save invariant until the unified render
  can present a buyer-choice sub-selector *inside* a package page (a later stage).
- **Two membership tables.** `listing_parents` (edges) and `group_listings`
  (rows + price + qty) encode the tree's edges differently. The unified model
  wants one edge representation with per-edge `quantityRule`/`priceRule`. Migrating
  both into it is the bulk of the work and must be done without breaking existing
  bookings' stored `package_group_id` / allocations.
- **Entry-point identity.** `/ticket/<group>` vs `/ticket/<parent>` resolve
  differently and stamp different ids on rows (`package_group_id`). The unified
  entry point resolves *any* slug to its root node; existing rows must keep
  resolving.

---

## Staging (each stage ships green and independently useful)

### Stage 0 — auto-include (this branch, interim)

Let a **package member be a parent** whose children are auto-included at fixed
quantities. This is the smallest cross-product that delivers user value *and*
proves the booking-node tree one level deep (a `FIXED` package member with a
`FIXED`/sole-`REQUIRED` child). Full design below. It deliberately reuses the
existing fold rather than introducing the tree type, so it is shippable now and
does not block the bigger refactor.

### Stage 1 — unify render

One recursive renderer behind `ticketPage` and `packagePageAvailability`, emitting
the same controls both produce today, driven by a `BookingNode[]` built from the
existing tables (no schema change). Pure refactor, behaviour-identical, golden-test
the HTML.

### Stage 2 — unify fold + price + capacity + revalidate

Collapse `foldSelectedChildren` + package expansion into one recursive fold over
`BookingNode`; `effectivePrice(node)`; one capacity walk seeded by `groupPoolUnits`;
one revalidation walk. Still no schema change — the tree is built from
`listing_parents` + `group_listings` each request.

### Stage 3 — unify the edge store

Introduce one edge representation carrying `quantityRule`/`priceRule`/`visibility`
per edge; migrate `listing_parents` and `group_listings` into it (or make one a
view of the other). This is the only stage that touches the schema and existing
rows; gate it behind a migration with the usual three-edit dance (SCHEMA +
dated migration + `LATEST_UPDATE`) and a backfill that preserves every existing
booking's resolution.

### Stage 4 — buyer-choice inside packages

Once render can present a sub-selector inside a package page, lift the Stage 0
"deterministic children only" restriction: a package member-parent may then offer
`BUYER_CHOICE` children, priced and capped at submit. This is the last special
case to fall.

---

## Risks / watch-items for the full refactor

- **Existing bookings must keep resolving.** `package_group_id` on
  `listing_attendees` and the per-allocation rows are the historical record; any
  edge-store migration must keep `getPackageDisplaysByIds` and the ticket-card
  fold working for rows written before the migration.
- **Privacy regressions.** Every new render/discovery surface must route through
  the hidden-member helpers; the unified renderer must default `HIDDEN` nodes to
  *dropped*, not *rendered-then-hidden*.
- **Signed-price round-trip.** The webhook trusts `BookingItem.p`. The unified
  price walk must produce byte-identical `p` to today's per-model pricing, or
  in-flight checkouts at deploy time refund spuriously.
- **Capacity double-counting.** A listing reachable as both a package member and a
  standalone line must consume its pool the right number of times: the walk
  **sums** that listing's quantities across every path that books it (aggregating
  per listing + group pool), rather than deduping to a single contribution.
  Deduping would validate one unit while the order actually consumes several.

---

## Stage 0 — auto-include design (build now)

### Goal

An operator can put a **parent listing** into a package. Its **required child**
is then **auto-included** in the bundle at a fixed quantity, with no buyer
selection — the package books the parent *and* its child as one unit.

### Scope (the deterministic-children line)

A package member may be a **parent** iff the parent itself still satisfies the
existing packageable-member rules **and** every child folds **deterministically**.
The relaxation *adds* the deterministic-child requirement on top of today's check —
it does not replace it:

- the **parent itself is packageable** (`isPackageable`: standard, not
  `customisable_days`, not `can_pay_more`) — the flat package page must still
  price and book the parent member, so a customisable-days or pay-what-you-want
  parent is rejected exactly as it is today, **and**
- the parent has **exactly one** child edge (sole child ⇒ auto-fills to the
  parent's quantity, no buyer choice — `resolveChildSelections`'s sole-child
  branch), **and**
- that child is itself **packageable** (`isPackageable`: standard, not
  `customisable_days`, not `can_pay_more`) so it has no date/duration/pay-more
  ambiguity inside the flat package page, **and**
- neither parent nor child is a renewal tier (already barred from edges).

A package member may **not** be a **child** (a child can only be booked under its
parent; a package page books members directly — invariant I3 stands).

Multiple children, `BUYER_CHOICE` children, or non-packageable children are
**rejected at save** with a clear message; they wait for Stage 4.

### Pricing

The auto-included child folds at its **own base price**, exactly as the existing
parent/child fold does everywhere else. The package's `package_price` override
applies to the **parent** member and — like every package member — is scaled by
the parent's fixed per-package quantity *and* the package quantity:
`parentOverride × parentMemberQty × packageQty`. The child contributes
`child.unit_price × childQty × packageQty`. (The bare-`override` shorthand earlier
drafts used undercharged multi-quantity parents — both sides scale by the package
quantity.) This reuses the existing fold/price path unchanged and keeps the
operator in control (set the child's base price to set its bundle contribution).
No new price rule, no `group_listings` row for the child (it is pulled in via the
edge, not group membership).

### Capacity

The auto-included child consumes its **own** cap and the caps of **every group it
belongs to**, like any folded child. `packageQuantityCap` must therefore bound
the package by the child's pools too, not just the members'. Because the fold
already turns the child into an ordinary line and the cap already routes through
`groupPoolUnits`, this is: include the auto-included children's demand in the
package cap's per-group demand accumulation.

### The five touch-points

1. **Admin validation** (`src/features/admin/groups.ts`): relax
   `isPackageableMember` — a parent whose sole child is packageable is now a valid
   member. Add the rejection messages for the non-deterministic cases. Re-validate
   on listing save and on group save (a later edit that adds a second child, or
   makes the child non-packageable, must block while the parent is a package
   member).
2. **Render** (`packagePageAvailability` / `ticketPage`): a package member-parent
   renders as one member row. Its auto-included child is **never a member row of
   its own** — on visible *and* hidden packages alike it is folded into the parent
   member, contributing price and capacity but surfaced only through the parent.
   This is the single visible-row invariant for auto-included children (the
   tickets section below follows it); `hide_package_listings` then governs only
   whether the parent member rows themselves show, exactly as for a plain package.
3. **Fold** (`ticket-payment.ts`): the package expansion must run the existing
   `foldSelectedChildren` over its member-parents so the child becomes an ordinary
   line at `parentQty × packageQty`. The sole-child auto-fill branch already does
   the right thing.
4. **Capacity** (`reservations.tsx`): include auto-included children in
   `packageQuantityCap`'s demand maps.
5. **Webhook revalidation** (`payment-processing.ts`): the auto-included child is
   revalidated via the **normal listing-price path** (it is a base-priced folded
   child, not a package-override member) — the same carve-out packages.md §10
   already documents for folded children.

### Tickets / discovery

- The ticket card already folds a whole package into one card; the auto-included
  child is folded into that package card the same way — it is **never** its own
  member line or ticket card, matching the single render invariant above. So a
  hidden package conceals it and a visible package shows only the parent member.
  No new card path.
- Discovery / `/order` / `/order.js`: the package surfaces as today; the
  auto-included child is never independently surfaced (it has no standalone entry
  point — it is a child).

### Tests (100% line + branch, mutation-resistant)

- Admin: parent-with-sole-packageable-child accepted as member; parent-with-two-
  children rejected; parent-with-`customisable_days`-child rejected; child-as-
  member rejected; later edit that breaks the invariant blocked on listing save
  and on group save.
- Fold: booking a package whose member is such a parent produces the parent line
  **and** the child line at `parentQty × packageQty`; allocation rows correct.
- Pricing: bundle total = `parentOverride × parentMemberQty × packageQty` +
  `childBase × childQty × packageQty`; signed `p` per line correct (parent and
  child each scaled by the package quantity — assert with `packageQty > 1` and a
  parent `memberQty > 1` so a missing scale factor fails).
- Capacity: package availability bounded by the child's own cap and the child's
  group pools.
- Webhook: child revalidated via the listing-price path; price drift on the child
  triggers `price_changed`.
- Privacy: `hide_package_listings` hides the auto-included child everywhere.

### Why this is the right interim step

It is the one cross-product that (a) operators actually want now, (b) is fully
deterministic so it needs **no** new render/price/cap machinery — only a relaxed
invariant and the existing fold wired into package expansion, and (c) is a literal
one-level instance of the booking-node tree, so it validates the target model
without committing to the schema migration. When Stage 3 lands, a Stage-0 package
member-parent becomes a `FIXED` node with a `FIXED` child — no behaviour change.
