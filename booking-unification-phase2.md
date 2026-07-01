# Phase 2 design — unify fold + price + capacity + revalidate onto the tree

Companion to `booking-unification.md`. This is the execution map for Phase 2,
compiled from a full read of the current fold/pricing/capacity/webhook code so
the build starts without re-discovery. **Phase 2 is the money path** (fold →
price → signed metadata → webhook refunds); land it in the sub-steps below, each
green on its own, behaviour-identical behind adapters, guarded by the existing
submit/webhook suites plus new per-node tests.

Phase 1 already shipped the substrate: `src/shared/booking/tree.ts`
(`BookingTree`/`BookingNode`, node identity, form-field-name SSOT + node→field
projections) and `build-tree.ts` (pure `buildBookingTree`). `ticketPage` builds
the tree and drives render field names through it. Phase 2 makes the **fold,
price, capacity, and webhook** walks consume that same tree.

---

## 2a — unified fold (keystone)

Collapse the two fold paths into one recursive walk over the `BookingTree` that
returns the **same shape** today's fold returns, so every downstream consumer
(pricing, contact fields, modifiers, ledger, webhook) is untouched.

**Replace / absorb:**
- `foldSelectedChildren` (`src/features/public/ticket-payment.ts:658`) — the
  parent-walk orchestrator → a recursive tree walk.
- `foldParent` (`ticket-payment.ts:614`), `foldChild` (`:568`),
  `resolveChildSelections` (`:465`, exported for tests), `childQtyField` (`:447`),
  `childCustomPrice` (`:525`), `childIsBookable`/`childSelectableForSpan`
  (`:386-407`) — become per-node visit logic.
- `resolvePageQuantities`/`parsePackageCount` (`ticket-submit.ts:578`/`:563`) —
  package expansion (`fixed × packageQty`) becomes the `FIXED` package-member
  node's resolved quantity in the walk.
- `parseQuantities` (`ticket-form.ts:188`), `parseCustomPrices`
  (`ticket-submit.ts:154`) — per-node quantity/price parse via the tree field-name
  SSOT (`nodeQuantityFieldName`/`nodePriceFieldName`).

**Per-node visit rules** (the walk):
- **quantityRule** → resolved qty: `FIXED`/`REQUIRED` emit as-is (package member =
  `fixed × packageQty`); `BUYER_CHOICE` reads the node's quantity field;
  `OPTIONAL` clamps to `[min,max]`.
- **priceRule** → unit price: `OVERRIDE` (amountMinor) > `PAY_MORE` (read price
  field, validate `[unit_price, max_price]`) > `DAY_PRICE` (`dayPriceFor(span)`) >
  `BASE`. Fold the `itemUnitPrice` (`ticket-payment.ts:215`) +
  `applyPackageOverrides` (`:266`) logic into this — override is now a *node
  facet*, so it is scoped correctly by construction (children keep base price)
  instead of by the `pageListingIds` gate.
- **dateSpan** → `INHERIT` resolves from the parent's chosen span; daily children
  must pass `childDateOk`; customisable children fold to one shared `dayCount`
  (reject mixed durations).
- **children** → sum each child's qty under its parent, emit one
  `ChildAllocation {parentId, childId, qty}` (`attendee-types.ts:16`) per
  selection; **sum by listing across paths** (the `state.quantities` += rule) only
  for capacity demand, never collapsing the per-node lines.
- **sole-child auto-fill** (deferred from Phase 1): a parent with exactly one
  *bookable* child (bookable set is runtime — daily needs holidays/date) auto-fills
  that child to the parent qty when no field was posted. Resolve it **here**,
  where the bookable set is known.
- **HIDDEN** nodes are still folded/priced (kept in the signed lines) but never
  named on a surface.

**Also in 2a — thread the non-package group id (Codex).** `getTicketContext`
today only carries `packageGroupId`. Add the real group id so `buildBookingTree`
builds `/ticket/<group-slug>` as a `{kind:"group"}` root with
`group:<id>/member:<id>` nodes (render output is unchanged — field names are
identical — but the fold/capacity/metadata now carry the group root identity, and
the group-root builder tests get exercised by the real page path).

**Keep unchanged (adapters feed them):** `buildRegistrationItems`
(`ticket-payment.ts:225`) receives the folded listing set once; `priceCheckout`
(`checkout-pricing.ts:333`); `toBookingItems` (`payment-helpers.ts:152`);
`signPriceSync` (`payment-signature.ts:85`); `expandChildAllocations`
(`payment-processing.ts:1129`).

Proposed entry: `foldBookingTree(tree, form, {holidays, date, dayCount}) →
{ listings, quantities, customPrices, allocations, dayCount, hasCustomisable,
selectedListingIds } | error` — same shape as `foldSelectedChildren`.

---

## 2b — unified price + non-line components

One `effectivePrice(node)` = the priceRule evaluation from 2a, applied in the
walk. Mind the **already-expanded quantity**: a package member is `fixed ×
packageQty` *before* children fold, and the sole-child fold fills the child to the
parent qty — a child contributes `childBase × (fixed × packageQty)` reached
**once** (double-`× packageQty` overbooks/overcharges for `packageQty > 1`).

`priceCheckout` (`checkout-pricing.ts:333`) already layers the **non-line**
components over the item lines and stays as-is: modifiers (`applyModifiers` `:308`,
read pre-modifier subtotal, no stacking), reservation deposit (`reservationLines`
`:196`), booking fee (`feeExtras` `:100`). The `/pay` balance is a synthetic line
via `CheckoutMetaFields.balanceAttendeeId` (`payments.ts:74`). The canonical
priced order must include these so a node-only walk can't sign one total and
persist another. `CheckoutIntent` shape: `payments.ts:97-130`.

---

## 2c — unified capacity walk (every booked node, per (listing,pool,day), both arms)

Seed: `groupPoolUnits` (`floor(remaining/demand)`), already the shared leaf.

**Aggregate demand** across the folded nodes (parents **and** children — a parent
line is itself sold) into the existing buckets and predicates:
- Per-day expansion for daily/customisable via `expandDailyRange`
  (`db/attendees/capacity.ts:301`) → `CapacityBucket {perDay, total}` (`:300`);
  `aggregateDemand` (`:422`) / `addDemandToBucket` (`:401`).
- Both arms: own-cap (`getListingRemainingForRange` `:643` /
  `getListingRemainingMapForRange` `:596`, tightened per group via
  `minByListingOverGroups` `:120`) **and** group-pool
  (`groupPerDayRemainingByGroup` `:529`, `getGroupRemainingByGroupId` `:63`,
  `getSharedGroupCapacities` `:196`).
- Atomic write-time gate stays: `buildCapacityCondition` (`db/capacity.ts:272`),
  `buildBatchCapacitySql` (`:358`), `buildCapacityCheckedInsert`
  (`db/attendees/capacity.ts:253`), `createBookingAtomic`
  (`db/attendees.ts:114`). Sum per (listing, pool, day); collapse by listing
  **only** for demand; gate on active/bookable, not just the cap.
- `packageQuantityCap` / `childCombinedCap` / `childOrderCap` become the same walk
  over the tree instead of two bespoke calcs.

---

## 2d — v2 signed metadata + webhook revalidation + v1 drain bridge

**Metadata budget is hard** (`payment-helpers.ts`): Square 10 entries / 255 chars
(`:407-411`), Stripe 50 / 500 (`:401-404`). `packMetadata` (`:445`) collapses
small fields into a `b` JSON blob; integrity-critical fields stay top-level
(`_origin, name, email, items, answer_ids, text_answer_ids, modifiers,
price_proof, thank_you_url, …`). Signing is over the **pre-pack logical shape**
(`buildItemsMetadata` `:257`, `signPriceSync`), verified post-unpack. The v2
per-node line shape (`nodeKey`/edge provenance beyond `BookingItem {e,q,p}`
`payments.ts:53`) MUST fit this budget — add a compact wire shape + entry-count /
value-length limit tests, or nested packages fail hosted checkout. `thankYouUrl`
is dropped *pre-sign* if it doesn't fit (`thankYouUrlFits` `:244`) — keep that
discipline.

**One revalidation walk** re-prices every node against current config and
re-checks each signed `nodeKey` still resolves to the same edge:
- Entry: `validateAllItems` (`payment-processing.ts:690`), `validatePaidSession`
  (`:195`), `classifySession` (`verifyPrice`).
- Price/bundle drift: `expectedItemPrice` (`:647`), `packageBundleMismatch`
  (`:672`), `PackagePricing`/`loadPackagePricing` (`:617`/`:625`) → `price_changed`
  refund. Fold these into the tree re-walk (recompute price×qty per node; a signed
  child line must not be trusted if the operator removed/swapped the edge
  mid-checkout).
- Persist: `createAttendeeForSession` (`:1109`) expands allocations, stamps
  `package_group_id` on every row (`:1162`); refund path `storeRefundedBooking`
  (`:1332`). Rows: `listing_attendees` (`schema.ts:313`), unique
  `(listing_id, attendee_id, start_at, parent_listing_id)` — parent rows persist
  as their own booked rows.

**Drain bridge:** sites are inactive at deploy, but provider sessions created
*before* the cutover can still pay through the webhook with **old** `items`
metadata. Keep a **read-only v1 metadata bridge** (parse + fulfil old sessions,
never emit v1) for a bounded drain window, retired once no open pre-cutover
session can remain. Regression-test an old-shape session paid during the window.

**Row-level admin (before duplicate listing ids across paths, i.e. Phase 3):**
attendee-merge `bookingKey` (`merge/attendee-merge.ts:71`) and check-in target by
`(listing_id, attendee_id, start_at, parent_listing_id)` — both must learn
`package_group_id`/`nodeKey` or two distinct edge rows for one listing collapse.

---

## Test posture (per sub-step; 100% line+branch, mutation-resistant)

- **Fold:** sole-child auto-fill (multi vs sole, daily bookable set); child qty sums
  to parent; same child under two parents sums for demand but stays two allocations;
  `packageQty>1 ∧ memberQty>1` scales exactly once; package override scopes to the
  member node, child keeps base.
- **Price:** OVERRIDE>PAY_MORE>DAY_PRICE>BASE; non-line components (modifiers,
  reservation, fee, `/pay` balance) in the signed total.
- **Capacity:** own-cap when in no capped group; group pool; per-day for daily (2-day
  span vs 1-day on a shared day); inactive node drops the bundle.
- **Metadata/webhook:** v2 lines fit Square's caps; price drift *and* a
  removed/swapped edge both take `price_changed`; the v1 bridge fulfils an
  old-shape session during the drain window.
