# Package choice slots — "pick N from these listings" inside a package

## The ask

A package where the buyer **must select**, for example:

- 1 item from an array of listings X
- 1 item from an array of listings Y
- 2 items from an array of listings Z

…slotting into the existing booking-node tree and playing well with
parent/child setups.

## Status: the recommended model SHIPPED with #1462 on main

This document was originally written as a plan against the groups-packages
feature branch. The squash-merge of #1462 (`d9e7770`) landed a later state of
that branch which **already implements the model this plan recommended** — a
choice slot is a package member that is a parent listing:

> The candidate array is the slot listing's `listing_parents` child edges.
> The pick count is the member's existing `group_listings.quantity`.

The example works on main today as one `is_package` group with three parent
members:

| Slot | Stored as | Pick count |
|---|---|---|
| "Choose your X" | parent listing, children = X | member `quantity` = 1 |
| "Choose your Y" | parent listing, children = Y | member `quantity` = 1 |
| "Choose your Z" | parent listing, children = Z | member `quantity` = 2 |

No new table, node kind, or subsystem — exactly the shape this plan argued
for. What follows is the audit of main against the plan: what shipped, where
main took a different (defensible) design stance, and what remains open.

## Shipped on main (verified against `d9e7770`)

- **Admin gate.** `isPackageableMember` now takes the member's edges and the
  group's hide flag: a parent member is accepted on a **visible** package and
  rejected on a hidden one (a hidden package collapses members to the package
  name, so a child selector would leak them); a member that is itself another
  listing's **child** stays rejected; pay-more members stay rejected.
  `packageChildEdgeConflict` blocks child edges only for **hidden** packages
  and still blocks a package member becoming someone's child. Un-packaging or
  deleting a **sold hidden** package is refused until the operator clears the
  hide flag (`soldHiddenPackageError`) — existing tickets would otherwise
  leak member names. This is the plan's section A + E, clause for clause.
- **Render + client JS.** `renderPackageRows` renders the shared child block
  under a slot member (`renderChildBlock(info, childCtx, fixedQty)`), and the
  client scripts derive a slot's in-cart units as
  `data-package-fixed-qty × package_quantity` (`parentUnits` in
  `child-selection.ts`) — precisely the explicit in-cart signal the plan's
  section B specified. Candidate-scoped questions ride the same `childCtx`.
- **Fold / pricing.** Unchanged and already sufficient:
  `resolveChildSelections` enforces the exact sum `pickCount × packageQty`;
  chosen candidates fold at their own price under the member's `OVERRIDE`
  line. Beyond the plan, packages gained **per-day member price overrides**
  (`group_day` rows in `listing_prices`, riding the `DAY_PRICE` rule), so
  customisable-day members price per-span per-package.
- **Capacity — one shared ceiling.** `packageBundleCap` is THE bundle cap
  used by the page selector, the submit clamp, the JSON API, and the
  `/listings` bookable gate. It combines `packageQuantityCap` (own caps ÷
  fixed qty, now min'd with each parent member's **children's combined
  capacity** via `packageChildUnitCaps`) with `crossParentChildDemandCap`
  (sole-child pools charged per booked parent unit, plus capped groups that
  ALL of a member's bookable children sit in charged as forced cross-member
  demand). The cap context loads the candidates' own pools
  (`loadPackageCapGroupMaps` spans members AND children). This covers the
  plan's mainline capacity cases — including "candidates' combined supply ÷
  pick count" and forced shared-pool demand.
- **Webhook revalidation, both directions.** A child edge **removed**
  mid-checkout refunds (`price_changed`), and — the hole the plan flagged —
  a child edge **added** mid-checkout also refunds instead of booking the
  member without its add-on (`signed-metadata.ts` now requires a parent line
  with current children to be covered by allocations). Both are tested.
- **Tests.** Dedicated suites landed: `server-package-children.test.ts`
  (render, cap clamp, crafted POST, gating, free + paid folds, both
  stale-edge refunds), `server-daily-packages.test.ts`,
  `server-api-packages.test.ts`, `package-privacy.test.ts`, and extended
  `payment-processing-packages` / `server-group-packages` coverage.

## Where main's design stance differs from the plan

The plan proposed making slot listings **non-standalone** (an extended
`lacksStandalonePublicPage`: child OR hidden-package member OR package member
with child edges), which drove a long surface list — direct slugs, QR
issuance and scan, catalogs, `/api/listings`, admin share links, the
dashboard multi-booking builder, cancel-page retry links, regular-group
pages, admin flat-booking writers, and stale-standalone-session refunds.

Main takes the opposite, simpler stance: **a member-parent is an ordinary
listing that happens to be in a package.** It remains standalone-bookable at
its own price with its own child selector, exactly like any (childless)
package member remains standalone-bookable today. Under that stance the
entire surface list dissolves — those paths are legitimate sales, not
bypasses, and none of the guards are needed. `lacksStandalonePublicPage` is
unchanged (child OR hidden-package member only).

The residual concern is an **operator footgun, not a correctness hole**: a
purpose-built £0 "chooser" listing is buyable standalone for free at
`/ticket/<chooser>` (and appears in catalogs unless marked `hidden`, which
hides it from discovery but not from a direct URL). Operators using
dedicated chooser listings should price them meaningfully or accept the
exposure. If real operators hit this, the plan's DB-level slot predicate
(`group_listings × listing_parents`, placed below the `listings.ts` ↔
`groups.ts` import edge to avoid a DB-layer cycle) remains the design to
reach for.

## Still open — the deltas worth tracking

1. **Chooser own-cap footgun.** The slot listing's own `max_quantity` feeds
   the bundle cap (`min(own, childUnits) ÷ fixedQty`), so a chooser left at
   the default `max_quantity: 1` under a pick-2 slot silently caps the whole
   package at 0. No save-time validation warns about it. Cheap fix: reject
   (or warn on) a parent member whose per-order cap is below its member
   quantity.
2. **Overlapping candidate sets across slots.** The schema half of the
   multi-parent story shipped — the `listing_attendees` unique index already
   includes `parent_listing_id`, so per-parent rows coexist faithfully — but
   the paid path still maps created attendees to listings **by index**
   (`validatedItems[i]!` in `payment-processing.ts`) while
   `expandChildAllocations` emits one row per allocation: a candidate chosen
   under two member-parents of one package (one summed line, two allocation
   rows) mis-aligns that pairing. Packages with several parent members make
   this easier to reach than a multi-slug cart ever did. Fix the paid-path
   entry mapping — planned as workstream 1 in
   `multi-parent-bookable-alone.md`.
3. **`allocations` metadata length limit.** `enforceMetadataLimits` still
   length-checks `items`, answers, `modifiers`, entry count, and the packed
   field but not `allocations` — the fastest-growing field once every pick
   adds an allocation. A large multi-slot checkout can fail with a raw
   provider error instead of the app's "book in smaller batches" message.
4. **Capacity edge cases beyond the shipped terms.** The shipped model
   (per-member child caps + sole-child pools + all-children forced demand)
   covers the common configurations but is not the plan's full
   per-candidate feasibility system: partial-overlap cases remain
   approximate — e.g. pool-subset unions (three pick-1 slots over two 1-spot
   pools), a multi-pool candidate counted as alternative supply, and
   jointly-infeasible cross-slot mixes under residual per-candidate select
   ceilings. All of these fail safe (the atomic batch write predicate
   rejects at submit; reject-never-clamp), so the cost is a rare dead-end
   submit or an over-advertised bundle, not overbooking. Worth revisiting
   only if real configurations hit it.
5. **Deferred semantics** (unchanged from the plan): optional slots via the
   declared-but-unused `OPTIONAL(min,max)` quantity rule; a per-slot
   "distinct picks" flag; per-package-unit mixes (today 2 packages × pick-2 =
   4 picks in any mix, matching parent-quantity distribution); and a
   group-edit "add choice slot" affordance that mints the chooser listing +
   child edges in one step with sensible caps.

## What to tell an operator today

To build "1 from X, 1 from Y, 2 from Z": create three listings ("Choose your
X/Y/Z"), give each its candidate child edges on the listing's children form,
add all three to a visible package group with quantities 1 / 1 / 2, and set
`package_price` overrides as desired (the member price charges per pick;
candidates charge their own price as supplements — per-day overrides
available for customisable members). Mind the two footguns above: give each
chooser a generous `max_quantity`, and don't reuse one candidate under two
choosers of the same package.
