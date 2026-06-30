# Booking unification — one booking interface for all three models

## Why this doc exists

We grew **three** booking models independently — a normal listing, parent/child
(required-child selection), and packages (`is_package` groups) — and they have
started to collide (packages ✕ parent/child, capped-group pools, hidden-member
privacy). Each new cross-feature edge case costs another special case. This doc
records the model that unifies them and the plan to build it.

The thesis, in the user's words:

> I don't see any reason why the package interface and the parent/child interface
> and the totally normal booking interface can't all be the same thing — there's
> required items, optional items, hidden items, for all three of those.

That thesis is **correct** and **achievable**. This doc lays out the target
model, the plan to get there, and the invariants the implementation must honor.

## Decision: build the real thing, skip the stop-gap

An earlier draft proposed an interim **"auto-include"** feature (a package member
that is a parent auto-including its single required child by reusing the existing
fold) as a first stepping-stone — "Stage 0". **We are not doing that.** It is the
wrong investment:

- **It's throwaway.** Auto-include was a relaxed admin invariant + wiring the
  existing fold into package expansion. Once the unified model lands, that
  scaffolding is deleted, not reused — a package member-parent just becomes an
  ordinary node with a child.
- **It carries almost the full complexity anyway.** Pressure-testing the
  auto-include plan surfaced that it must relax **five** edge-validator paths,
  feed two capacity arms (own-cap + group pool) plus active-gating and discovery
  parity, add a display-only projection across summary/provider/email/listings
  cards while keeping the signed items intact, re-walk edges at webhook time, and
  avoid a quantity double-multiply — i.e. nearly the entire surface the real
  unification touches, for a fraction of the payoff.

So we build the unified **booking-node** model directly. Auto-include (a package
member that is a parent) then falls out as one configuration of the model, with
no special-case code. Every invariant the auto-include analysis uncovered is
captured below as a requirement on the unified build.

## Branch & sequencing

- **Implementation lives on a new branch based off the groups-as-packages feature
  branch** (`claude/groups-packages-feature-jdh7vw`, PR #1462) — **not** `main`.
  The package model and its schema (`group_listings`, `is_package`,
  `package_price`, `hide_package_listings`, `package_group_id`) and the
  `groupPoolUnits` capacity leaf all exist on that branch; they are the substrate
  the unification builds on. (#1462 should merge to `main` first, or the new
  branch rebases onto `main` once it has.)
- **This doc** is the plan for that branch. Every "today"/"exists" claim below is
  relative to #1462's branch.
- Land in the shippable **phases** in "Implementation phases" — each is green on
  its own; the model arrives incrementally, not as one big-bang cutover.

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
| Capacity | own cap + group caps | each line's cap + group caps | `packageQuantityCap` over members + shared pools |
| Render | `ticketPage` | `ticketPage` + per-child selectors | `packagePageAvailability` |
| Fold | none | `foldSelectedChildren` | members expanded by `packageQty` |
| Ticket card | one card | one card per line | one **package** card (members folded) |

Read across the rows and the same primitives recur: **a set of lines, each with
a required/optional/fixed quantity, a visibility flag, a price (base or
overridden), a date/span, and a capacity constraint (own + shared pools).** The
three models are three *configurations* of one structure, not three structures.

---

## The target model — a booking-node tree

A booking is a **tree of nodes**. Each node is one listing plus the facets every
model already needs, and the tree may carry a root/group identity:

```
BookingTree {
  rootRef:  none | { kind: "package", groupId }   // the package/group identity
  nodes:    BookingNode[]                          // top-level nodes
}

BookingNode {
  listingId
  quantityRule:  REQUIRED(qty) | FIXED(qty) | OPTIONAL(min,max) | BUYER_CHOICE
  priceRule:     BASE | OVERRIDE(amount) | PAY_MORE(min,max) | DAY_PRICE
  visibility:    SHOWN | HIDDEN          // hidden ⇒ never named on a buyer surface
  dateSpan:      NONE | DATE(date) | SPAN(date,duration) | INHERIT(parent)
  children:      BookingNode[]           // empty for a leaf
}
```

Two facets beyond the obvious ones, both required so the model can actually
represent today's data (Codex review):

- **`rootRef` — explicit package/group identity.** Package flows must carry the
  group id through checkout (`packageGroupId`) and onto persisted rows
  (`package_group_id`) for hidden-member display and webhook revalidation. The
  tree needs somewhere to retain that identity, not just member `listingId`s.
- **`dateSpan` — date/duration facet.** `DAY_PRICE` alone is not enough: daily
  and `customisable_days` listings persist a selected date/duration
  (`bookingDateFields`), and a parent/child fold resolves the child's duration
  from the parent. Without a date/span facet (including `INHERIT(parent)`), the
  recursive walk can't represent daily/customisable listings or daily children
  accurately.

The three models map onto it directly:

- **Normal listing** = a single `BUYER_CHOICE / BASE / SHOWN` leaf with its own
  `dateSpan`. (The "single item is an array of one" principle from AGENTS.md: a
  normal booking is a one-node tree, not a special case.)
- **Parent/child** = a `BUYER_CHOICE` parent whose children are `BUYER_CHOICE`
  leaves that must total the parent's quantity, inheriting the parent's span.
  (Today's `foldSelectedChildren`.)
- **Package** = a `rootRef = {package, groupId}` tree whose top-level nodes are
  one `FIXED(packageQty × memberQty)` member per `group_listings` row;
  `OVERRIDE` price per member; `HIDDEN` members when `hide_package_listings`.
- **Package member that is a parent** (the old "auto-include") = a `FIXED` member
  node that itself has a child node — no new code path, just a tree one level
  deeper.

---

## The five operations, generalized

Everything the booking system does is one of five tree walks. Unification means
writing each **once**, recursively, instead of three times.

1. **Render** — walk the tree, emit a control per `SHOWN` node (`FIXED`/`REQUIRED`
   shown read-only, `BUYER_CHOICE` as an input, `OPTIONAL` as an optional input),
   omit `HIDDEN` nodes (drop them, never render-then-hide). Today: `ticketPage` +
   `packagePageAvailability` + per-child selectors → **one** recursive renderer.
2. **Fold** — walk the submitted form into priced **per-node line items**
   (not a flat `Map<listingId, qty>`), validating each node's `quantityRule`.
   The output must keep each node/edge as its own line so pricing, display, and
   signed metadata retain that node's `priceRule`, visibility, parent/package
   identity, and `BookingItem.p` — a listing reachable through two nodes
   (e.g. a package override on one path, a standalone or child allocation on
   another) must **not** be collapsed by `listingId` before those consumers run.
   Collapse by listing **only** when computing capacity demand. Today:
   `foldSelectedChildren` + package expansion → **one** recursive fold.
3. **Price** — each node contributes `effectivePrice(node) × resolvedQty` to its
   own line and to its signed `BookingItem.p`. `OVERRIDE` wins, then `PAY_MORE`,
   then `DAY_PRICE`, then `BASE`. Mind the **already-expanded quantity**: a
   package member's quantity is `fixed × packageQty` before children fold, and the
   sole-child fold fills the child to that parent quantity — so a child's
   contribution is `childBase × (fixed × packageQty)`, reached without a second
   `× packageQty` (double-multiplying overcharges/overbooks for `packageQty > 1`).
4. **Capacity** — **every booked node** consumes capacity, not only leaves: a
   parent line is itself sold, so it charges its own listing cap and group pools
   alongside its children. Aggregate demand **by (listing, group pool), summing**
   quantities across every path that books a listing (never dedupe — that would
   validate one unit while the order consumes several). Feed each node through
   **both** arms of the cap: its own `maxPurchasable` (own-cap term) *and* its
   group ids/demand (group-pool term) — a listing in no capped group is bounded
   only by the former. Also gate on **active/bookable** state, not just the cap.
   Today: `packageQuantityCap` + `childCombinedCap` + per-line availability, all
   already routing through the shared `groupPoolUnits` leaf — the seed of the
   unified capacity walk.
5. **Revalidate (webhook)** — re-walk the tree at payment time against **current**
   config and recompute price × qty for every node; re-check that each edge
   (parent→child, member→group) still holds and quantities still satisfy the
   rules; any drift → `price_changed` refund. Pricing alone is insufficient: a
   signed child line must not be trusted if the operator removed/swapped the edge
   mid-checkout. Today: package revalidation + child revalidation → **one** walk.

The fact that step 4 *already* funnels through one primitive (`groupPoolUnits`,
added on #1462's branch) is the proof of concept: when we found two capacity code
paths and asked "can these be one calculation?", the answer was yes.

---

## What's tractable, and what's hard

**Tractable, because the hard invariants are already centralized on #1462:**

- Hidden-member privacy is enforced by a single set of helpers
  (`getHiddenPackageMemberIds`, `isHiddenPackageMember`, `getVisibleGroupMembers`,
  `getPackageDisplaysByIds`) that a `visibility: HIDDEN` facet calls into.
- Capacity already has the shared `groupPoolUnits` leaf and shared SQL predicate.
- The fold already produces per-(child,parent) allocations and one
  `listing_attendees` row per allocation. Those allocation rows are the *child*
  leaves; the **parent line is persisted as its own booked row too**, so the
  stored order is the full set of booked nodes (parents + child allocations) —
  the persistence model must keep parent rows, not collapse to leaves.

**Hard, and the reason it's a real project, not a refactor:**

- **Cardinality ambiguity.** `BUYER_CHOICE` children (buyer picks the mix
  totalling the parent quantity) can't be expanded deterministically, yet a
  package needs every quantity known before render to price and cap the bundle.
  So buyer-choice inside a package is the last capability to land (Phase 4);
  until then the model permits only deterministic children inside packages.
- **Two membership tables.** `listing_parents` (edges) and `group_listings`
  (rows + price + qty) encode the tree's edges differently. The unified model
  wants one edge representation carrying per-edge `quantityRule`/`priceRule`/
  `visibility`/`dateSpan`; migrating both into it without breaking existing
  bookings is the bulk of the work.
- **Entry-point identity.** `/ticket/<group>` vs `/ticket/<parent>` resolve
  differently and stamp different ids (`package_group_id`). The unified entry
  point resolves any slug to its root; existing rows must keep resolving.

---

## Implementation phases (all on the one branch)

Each phase is independently shippable and green. No "Stage 0".

**Phase 1 — unify render.** One recursive renderer behind `ticketPage` and
`packagePageAvailability`, emitting the controls both produce today, driven by a
`BookingTree` built from the existing `listing_parents` + `group_listings` tables
(no schema change). Behaviour-identical; golden-test the HTML.

**Phase 2 — unify fold + price + capacity + revalidate.** Collapse
`foldSelectedChildren` + package expansion into one recursive fold producing
per-node line items; one `effectivePrice(node)`; one capacity walk seeded by
`groupPoolUnits`; one revalidation walk. Still no schema change — the tree is
built from the existing tables each request. This is where a package member that
is a parent (the old "auto-include") starts working, as a plain tree, with the
invariants below.

**Phase 3 — unify the edge store.** One edge representation carrying
`quantityRule`/`priceRule`/`visibility`/`dateSpan` per edge; migrate
`listing_parents` and `group_listings` into it (or make one a view of the other).
The only schema-touching phase: gate behind a dated migration + `LATEST_UPDATE`
and a backfill that preserves every existing booking's resolution
(`package_group_id`, per-allocation rows, `getPackageDisplaysByIds`).

**Phase 4 — buyer-choice inside packages.** Once render can present a sub-selector
inside a package page, lift the deterministic-children restriction: a package
member-parent may then offer `BUYER_CHOICE` children, priced and capped at submit.
The last special case to fall.

---

## Invariants the unified build must honor

These came out of pressure-testing (Codex). They apply wherever the relevant
phase touches them; collected here so none is lost.

### Admin / configuration — one shared edge predicate, every path

Today the parent-in-package state is blocked in **five** save paths. The unified
model permits a parent member (with deterministic children) and a member that is
not itself a child; **all five** must move to one shared predicate together, or
the accepted configuration fails from whichever path wasn't updated:

- `isPackageableMember` (`src/features/admin/groups.ts`) — group create/edit, add-listings;
- `packageMembershipError` (`src/shared/listings-actions.ts:87-90`) — listing save;
- `packageChildEdgeConflict` (`src/features/admin/listings-parents.ts:404-410`) — children form;
- the same `packageChildEdgeConflict` in the **JSON API** (`src/features/admin/api.ts:464-471`);
- `copyEdgesFromDuplicateSource` (`src/features/admin/listings-edit.ts:160-166`) —
  the **duplicate/create** path, which currently *drops* copied child edges when
  the new listing joins a package group (would silently produce a member without
  its child).
- A parent member must itself satisfy the packageable rules (standard, not
  `customisable_days`/`can_pay_more`) — the deterministic-child rule is *added on
  top*, not a replacement.
- **Questions:** a member-parent's child with required custom questions makes an
  unanswerable package form (the package page renders no child block). Reject such
  children — and reject required questions *attached later* via the
  question-assignment routes (`POST /admin/questions/:id/listings`,
  `POST /admin/listing/:id/questions` in `src/features/admin/questions.ts`) — or
  render the child's questions under the parent.

### Capacity — every booked node, summed, both arms, active-gated, everywhere

- Charge every booked node (parents too), sum per (listing, group pool), feed both
  the own-cap and group-demand arms, and gate on active/bookable state (an
  inactive node with spare capacity must not advertise) — as in operation 4.
- **Discovery parity:** `packageGroupBookable` (`src/features/public/discovery.ts:369-397`)
  must run the same walk as the ticket page, or `/order`/listings advertise (and
  issue QRs for) a bundle the ticket page caps at 0.

### Buyer-facing display — a projection, never a mutation of signed items

The parent-only/hidden visibility contract must hold on **every** buyer surface:
the booking-page render, the running total (`orderSummary`), the Stripe/Square
line items, the confirmation email/ticket attachments (`buildTemplateData`), the
ticket cards, **and** the public `/listings` cards (which today keep child
listings in the card list and only swap the CTA; an auto-included child has no
`group_listings` row, so it needs a dedicated suppression path).

**Crucially this is display-only.** The provider line items *and* the signed
booking metadata derive from the **same** `CheckoutIntent.items`
(`priceCheckout(intent)` and `toBookingItems(intent.items)`). Folding a child into
its parent must be a **projection over the items for display**, never a removal
from the signed list — the webhook needs every node as its own signed item to
persist and revalidate (operation 5).

### Privacy

Route every render/discovery/checkout/email/wallet surface through the
hidden-member helpers; `HIDDEN` nodes are **dropped**, not rendered-then-hidden.

### Persistence

Keep parent rows as their own booked rows; the tree is not only its leaves. Any
edge-store migration must keep pre-migration bookings resolving
(`package_group_id`, allocations, `getPackageDisplaysByIds`).

### Signed-price round-trip

The unified price walk must produce byte-identical `BookingItem.p` to today's
per-model pricing, or in-flight checkouts at deploy time refund spuriously.

---

## Test posture (100% line + branch, mutation-resistant)

The unified walks need coverage at each phase; the cross-cutting cases the
invariants above demand:

- **Admin:** the accepted parent-member-with-child configuration succeeds via
  **every** save path (group edit/add-listings, listing save, children form, JSON
  API, duplicate); incompatible parent/child/cardinality rejected from each;
  required-question children rejected including via the later assignment routes.
- **Fold/pricing:** with `packageQty > 1` **and** `memberQty > 1`, parent and
  child quantities/prices are each `fixed × packageQty` exactly once (a regression
  that fails on a doubled or missing scale factor); per-node lines preserved when
  a listing is reachable two ways.
- **Capacity:** bounded by a node's own cap even when it is in no capped group;
  by group pools; an inactive node drops the bundle; discovery hides/re-shows in
  lockstep with `/ticket/<group>`.
- **Display:** visible-package child folded into its parent on summary, provider
  lines, email, ticket card, and `/listings` — while the **signed items still
  carry the child separately** (assert the webhook receives/persists it).
- **Webhook:** price drift *and* a removed/swapped edge mid-checkout both take
  `price_changed`.
- **Privacy:** `hide_package_listings` conceals members on every surface.

---

## Risks / watch-items

- **Existing bookings must keep resolving** across the Phase 3 migration.
- **Privacy regressions** — every new surface routes through the hidden-member
  helpers; default `HIDDEN` to dropped.
- **Signed-price round-trip** — byte-identical `p`, or deploy-time refunds.
- **Capacity double-counting / under-counting** — sum per (listing, pool), charge
  every booked node, both arms.
