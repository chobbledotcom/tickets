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
- **Deployment assumption:** the affected sites will be made inactive while this
  ships. We therefore do **not** need to preserve in-flight checkout sessions or
  byte-identical signed metadata for sessions created by the old code. Existing
  persisted bookings still must render and remain editable, but the paid checkout
  metadata can move to a clean v2 shape instead of carrying old wire compromises.
- **Phase 1 starts by enumerating, from the route table, every booking *entry*
  the tree must represent and every buyer *surface* the projection must reach** —
  the router is the source of truth, so a flow that isn't in the lists below is a
  gap to add, not an exception to special-case. Known entries: single listing;
  ad-hoc multi-slug cart (`/ticket/<slug+slug>`); regular (non-package) group;
  package; signed QR link with a `payload.v` price override; `/renew` tier picker
  with a `siteToken`; the JSON API booking path (`POST /api/listings/:slug/book`,
  which already runs the parent/child fold); the non-tree `/pay/:token`
  balance settlement; and the **admin attendee writers** that create/edit real
  `listing_attendees` rows from flat listing lines, bypassing the public
  render/fold path (`src/features/admin/attendees.ts`,
  `src/features/admin/attendee-form-routes.ts`) — these either join the unified
  fold's edge semantics or are explicitly scoped/exempt with a migration note, or
  an admin can hand-write a parent-only row that violates `childRule`. Known buyer
  surfaces: booking page; `/calculate` running total; Stripe/Square line items;
  confirmation email + ticket attachments; ticket cards; public `/listings`; the
  `/order` no-JS gallery (which runs its own listing/group discovery before
  redirecting to `/ticket/<slugs>`, `src/features/public/order.ts`) **and** the
  `/order.js` embed widget; the RSS/ICS feeds (`/feeds/listings.{rss,ics}`); the
  JSON API discovery routes; the share/QR affordances (`GET /ticket/:slug/qr`
  gated by `lacksStandalonePublicPage`/`groupBookable`, plus the admin
  dashboard/listing public-URL/QR/embed snippets); the Apple/Google **wallet**
  passes (`/wallet`, `/gwallet`, built from a single resolved token entry's
  name/qty/price, package bookings 404'd); and discovery
  (`packageGroupBookable`). The test matrix covers each relevant entry × surface.

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
  rootRef:  { kind: "listing", slugs } |          // standalone listing(s): /ticket/<slug[+slug…]>
            { kind: "group",   groupId } |        // regular (non-package) group page
            { kind: "package", groupId }          // package page
  entry:    { qrPrefill?,        // QR link's signed v/qty/date/name prefill + price override
              renewal?,          // /renew siteToken/actionUrl
              balanceAttendeeId?,// /pay balance settlement target
              parentThankYouUrl?,// parent's post-payment redirect, preserved through fold
              urlPrefill? }      // /order → /ticket?q_<id>=N render-time quantity prefill
              // signed/URL NON-line context, priced/revalidated alongside the tree
  nodes:    BookingNode[]                          // top-level nodes
}

BookingNode {
  nodeKey       // stable path/edge identity used by render, fold, metadata, rows
  listingId
  edgeRef:       none | { kind: "group_member", groupId } |
                       { kind: "parent_child", parentId }
  quantityRule:  REQUIRED(qty) | FIXED(qty) | OPTIONAL(min,max) | BUYER_CHOICE
  priceRule:     BASE | OVERRIDE(amount) | PAY_MORE(min,max) | DAY_PRICE
  visibility:    SHOWN | HIDDEN          // hidden ⇒ never named on a buyer surface
  dateSpan:      NONE | DATE(date) | SPAN(date,duration) | INHERIT(parent)
  children:      BookingNode[]           // empty for a leaf
}
```

Three facets beyond the obvious ones, all required so the model can actually
represent today's data (Codex review):

- **`rootRef` / `entry` — explicit page + non-line identity.** `/ticket/<…>`
  serves a standalone listing, an ad-hoc **multi-slug cart** (`/ticket/<slug+slug>`,
  so the `listing` root carries a slug *list*), a **regular (non-package) group**
  (name/description/terms/action slug + buyer-chosen member quantities), or a
  **package**. Package flows must also carry the group id through checkout
  (`packageGroupId`) and onto persisted rows (`package_group_id`) for
  hidden-member display and revalidation. Beyond the line nodes, an `entry` holds
  signed/URL **non-line** context — which is priced, prefilled, and revalidated
  alongside the tree, never as node prices, or a unified builder would
  charge/revalidate at base price and lose the renewal/balance/prefill/redirect:
  - a QR link's full signed prefill, not just `payload.v` price override but the
    quantity/date/name it carries (`src/shared/qr-token.ts`, consumed by
    `src/features/public/qr-book.ts`) — drop these and a direct-checkout QR opens
    an empty form or at base price;
  - the `/renew` `siteToken`/`actionUrl`;
  - the `/pay` `balanceAttendeeId`;
  - the explicit parent `thankYouUrl` carried through paid metadata
    (`src/shared/payments.ts`, set in `src/features/public/ticket-submit.ts`) so
    folding child lines under a parent doesn't lose the parent's post-payment
    redirect;
  - the `/order → /ticket/<slugs>?q_<id>=N` URL quantity prefill: `handleBySlugs`
    runs `parseQuantityPrefill` so the multi-slug form opens with chosen
    quantities. The `listing` root carries slugs only, so this render-time query
    state must live on `entry` (or be explicitly kept outside the tree) or a
    Phase 1 builder turns an order-cart selection into an empty/default form.
- **`nodeKey` / `edgeRef` — explicit node identity.** A listing can be reached by
  more than one path (standalone, package member, required child under a package
  member, the same child under two parents). The signed checkout payload and the
  fold output must identify the **node/path**, not only the `listingId`, so price,
  visibility, parent/package provenance, and row expansion cannot collapse
  accidentally. Until the unified edge table exists, `nodeKey` can be derived
  from the current path (`group:<id>/member:<listingId>`,
  `parent:<id>/child:<listingId>`, etc.); after Phase 3 it should point at the
  persisted edge identity.
- **`dateSpan` — date/duration facet.** `DAY_PRICE` alone is not enough: daily
  and `customisable_days` listings persist a selected date/duration
  (`bookingDateFields`), and a parent/child fold resolves the child's duration
  from the parent. Without a date/span facet (including `INHERIT(parent)`), the
  recursive walk can't represent daily/customisable listings or daily children
  accurately.

The three models map onto it directly:

- **Normal listing** = a single `BUYER_CHOICE / SHOWN` leaf whose `priceRule`/
  `dateSpan` come from the listing's own fields (`BASE`, `PAY_MORE` for
  `can_pay_more`, or `DAY_PRICE`/`SPAN` for daily/`customisable_days`). (The
  "single item is an array of one" principle from AGENTS.md: a normal booking is a
  one-node tree, not a special case.) A multi-slug cart is the same with several
  top-level nodes.
- **Regular group** = `rootRef = {group, groupId}` with `SHOWN / BUYER_CHOICE`
  member nodes (each priced from its own fields), carrying the group's
  name/description/terms.
- **Parent/child** = a `BUYER_CHOICE` parent whose children are `BUYER_CHOICE`
  leaves that must total the parent's quantity (the fold enforces the sum; a sole
  child auto-fills), inheriting the parent's span. (Today's `foldSelectedChildren`.)
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
   keyed by `nodeKey`, and omit `HIDDEN` nodes (drop them, never render-then-hide).
   Questions are rendered in one separate order-level pass (see "Questions" below),
   not once per node. Today: `ticketPage` + `packagePageAvailability` +
   per-child selectors → **one** recursive renderer.
2. **Fold** — walk the submitted form into priced **per-node line items**
   (not a flat `Map<listingId, qty>`), validating each node's `quantityRule`.
   The output must keep each node/edge as its own line so pricing, display, and
   signed metadata retain that node's `priceRule`, visibility, parent/package
   identity, and signed line price — a listing reachable through two nodes
   (e.g. a package override on one path, a standalone or child allocation on
   another) must **not** be collapsed by `listingId` before those consumers run.
   Collapse by listing **only** when computing capacity demand. Today:
   `foldSelectedChildren` + package expansion → **one** recursive fold. The v2
   signed line shape should therefore carry `nodeKey`/edge provenance in addition
   to listing id, quantity, and price — but within a **provider metadata budget**:
   today's checkout metadata is deliberately compact because Square caps entries
   (≈10) and value lengths and already throws batching errors for oversized
   `items`/answers/modifiers/packed fields (`src/shared/payment-helpers.ts`).
   Adding edge/date/display context to every line must use an explicit compact
   wire shape with limit tests, or sufficiently nested packages/folded children
   fail hosted checkout even though the tree validates.
3. **Price** — each node contributes `effectivePrice(node) × resolvedQty` to its
   own canonical signed line. `OVERRIDE` wins, then `PAY_MORE`,
   then `DAY_PRICE`, then `BASE`. Mind the **already-expanded quantity**: a
   package member's quantity is `fixed × packageQty` before children fold, and the
   sole-child fold fills the child to that parent quantity — so a child's
   contribution is `childBase × (fixed × packageQty)`, reached without a second
   `× packageQty` (double-multiplying overcharges/overbooks for `packageQty > 1`).
   **Node prices are not the whole order:** opt-in add-ons, promo/answer
   modifiers, the reservation amount and booking fees flow through `CheckoutIntent`
   outside the node tree, and the `/pay` balance flow is a synthetic "Remaining
   balance" line settling an existing attendee with no booking nodes at all. The
   canonical priced order must include these non-line components so a node-only
   walk can't sign one total and persist/revalidate another.
4. **Capacity** — **every booked node** consumes capacity, not only leaves: a
   parent line is itself sold, so it charges its own listing cap and group pools
   alongside its children. Aggregate demand **by (listing, group pool, day),
   summing** quantities across every path that books a listing (never dedupe —
   that would validate one unit while the order consumes several). The key is
   **per-day, not per-span**: a dated daily/`customisable_days` node expands into
   its individual days and each day is checked independently, so a 2-day span from
   Monday contributes demand to Monday *and* Tuesday and conflicts with a 1-day
   Tuesday booking on the shared day (a whole-`(date,duration)` key would let
   overlapping-but-not-identical spans bypass the cap on shared days). Feed each
   node through **both** arms of the cap: its own `maxPurchasable` (own-cap term)
   *and* its group ids/demand (group-pool term) — a listing in no capped group is
   bounded only by the former. Also gate on **active/bookable** state, not just
   the cap. Today: `packageQuantityCap` + `childCombinedCap` + per-line
   availability, all already routing through the shared `groupPoolUnits` leaf —
   the seed of the unified capacity walk.
5. **Revalidate (webhook)** — re-walk the tree at payment time against **current**
   config and recompute price × qty for every node; re-check that each signed
   `nodeKey` still resolves to the same edge path (parent→child, member→group) and
   that quantities still satisfy the rules; any drift → `price_changed` refund.
   Pricing alone is insufficient: a signed child line must not be trusted if the
   operator removed/swapped the edge mid-checkout. Today: package revalidation +
   child revalidation → **one** walk. Because sites are inactive during deploy,
   this can be a clean v2 metadata path rather than a byte-compatible old/new
   bridge for already-open checkout sessions.

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
- **Metadata and row identity.** Current checkout metadata is listing-id keyed
  (`BookingItem` is only id/quantity/price) and current rows only carry
  `parent_listing_id` plus order-level `package_group_id`. The unified fold needs
  a v2 signed line shape and, by Phase 3, a storage identity that can distinguish
  arbitrary tree paths without relying on listing id alone.

---

## Implementation phases (all on the one branch)

Each phase is independently shippable and green. No "Stage 0".

**Phase 1 — canonical tree builder + render.** Build a `BookingTree` from the
existing `listing_parents` + `group_listings` tables (no schema change), including
`nodeKey`/`edgeRef`, root identity, visibility, price, quantity, and date facets.
Keep compatibility adapters for the current submit paths while putting one
recursive renderer behind `ticketPage` and `packagePageAvailability`. Behaviour
identical; golden-test the HTML and assert stable `nodeKey` form field names.

**Phase 2 — unify fold + price + capacity + revalidate.** Collapse
`foldSelectedChildren` + package expansion into one recursive fold producing
per-node line items; introduce v2 checkout metadata carrying `nodeKey`/edge
provenance within the provider metadata budget (compact wire shape + Square
entry-count/value-length limit tests); one `effectivePrice(node)`; one aggregate
capacity walk seeded by
`groupPoolUnits`; one revalidation walk. Still no edge-store schema change — the
tree is built from the existing tables each request, and persisted rows continue
to use `parent_listing_id`/`package_group_id` where those are expressive enough.
This is where a package member that is a parent (the old "auto-include") starts
working, as a plain tree, with the invariants below.

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

## Scope honesty — which doors are one-way, and kill-criteria

The abstraction is clean; the **blast radius is not**. Every review pass found
another surface (wallet, `/order`, QR/share, admin attendee writers, the provider
metadata budget). That is the real risk of this project — not the model, but the
long tail of surfaces — so future-us should go in with eyes open and not
sleepwalk into the expensive parts. Read this before starting each phase.

- **Phases 1, 2, 4 are reversible.** They sit behind compatibility adapters and
  build the tree from the existing tables each request. If a phase misbehaves in
  production, revert the branch — no data has changed shape. Phases 1–2 are the
  high-value, low-regret core: they deliver the unified render/fold/price/capacity
  and make "package member that is a parent" fall out for free.
- **Phase 3 is the one-way door.** It is the *only* schema-touching phase: it
  migrates two live membership tables (`listing_parents`, `group_listings`) under
  existing bookings. A bad backfill is not a `git revert`. **Earn it:** do not
  start Phase 3 until Phases 1–2 have proven the model in production for real
  bookings. Before committing to a full migration, seriously weigh making one
  table a **view/projection** of the other (or keeping both and unifying only at
  read time) against physically migrating — the cheaper option may be permanent,
  not interim. Phase 3's payoff is storage elegance, not user-visible capability;
  price that honestly.
- **Phase 4 is optional, not deferred.** "Buyer-choice children inside a package"
  is the most speculative capability in the doc. If no real operator needs it,
  the deterministic-children-only rule is a perfectly good **permanent** boundary,
  not a temporary restriction. Do not build Phase 4 on spec — build it when a
  concrete booking a customer wants requires it.
- **Kill / pause criteria.** Stop and reassess rather than pressing on if: a phase
  can't hold "behaviour identical" behind its adapter without touching the signed
  wire shape earlier than planned; the surface enumeration keeps growing after
  Phase 1 ships (a sign the tree isn't actually the seam); or Phase 3's backfill
  can't be shown to preserve every pre-migration booking's resolution on real
  data. Shipping Phases 1–2 and stopping is a **successful** outcome, not a
  failure — most of the compounding special-case cost lives there.

---

## Invariants the unified build must honor

These came out of pressure-testing (Codex). They apply wherever the relevant
phase touches them; collected here so none is lost.

### Admin / configuration — one shared edge predicate, every path

Today the parent-in-package state is blocked in **six** save paths. The unified
model permits a parent member (with deterministic children) and a member that is
not itself a child; **all six** must move to one shared predicate together, or
the accepted configuration fails from whichever path wasn't updated:

- `isPackageableMember` (`src/features/admin/groups.ts`) — group create/edit, add-listings;
- `packageMembershipError` (`src/shared/listings-actions.ts:87-90`) — listing save;
- `packageChildEdgeConflict` (`src/features/admin/listings-parents.ts:404-410`) — children form;
- the same `packageChildEdgeConflict` in the **JSON API** (`src/features/admin/api.ts:464-471`);
- `copyEdgesFromDuplicateSource` (`src/features/admin/listings-edit.ts:160-166`) —
  the single-listing **duplicate/create** path, which currently *drops* copied
  child edges when the new listing joins a package group (would silently produce a
  member without its child);
- `remapDuplicatedGroupEdges` (via `handleDuplicateGroupPost`) — the **group bulk
  duplication** path, which clones package memberships and remaps parent/child
  edges; once packages may hold deterministic parent members it must run the same
  predicate, or duplicating a valid package bypasses the checks or clones a bundle
  whose edges differ from the source.
- A parent member must itself satisfy the packageable rules (standard, not
  `customisable_days`/`can_pay_more`) — the deterministic-child rule is *added on
  top*, not a replacement.
- **Questions:** answers are **not** product-instance/node scoped. A buyer should
  answer each relevant question once per order, even when several selected nodes
  require it. Relevance is the union of the selected tree's listings (including
  folded/hidden nodes) against the existing question assignments; render each
  matching question once by question id, validate it once, and persist it through
  the existing attendee/order answer flow. Do not duplicate prompts per node, and
  do not introduce node-keyed answer storage. Hidden nodes must not cause the
  system to print hidden listing names; operators remain responsible for writing
  question copy that collects the information they need without relying on repeated
  per-product prompts.

### Capacity — every booked node, summed, both arms, active-gated, everywhere

- Charge every booked node (parents too), sum per (listing, group pool, **day** —
  dated daily/customisable nodes expand to per-day demand, not a whole-span key),
  feed both the own-cap and group-demand arms, and gate on active/bookable state
  (an inactive node with spare capacity must not advertise) — as in operation 4.
- **Discovery parity:** `packageGroupBookable` (`src/features/public/discovery.ts:369-397`)
  must run the same walk as the ticket page, or the `/order` gallery, `/listings`,
  the `/order.js` widget, the RSS/ICS feeds, the JSON API discovery routes, and
  the share/QR affordances advertise (and issue QRs for) a bundle the ticket page
  caps at 0.

### Buyer-facing display — a projection, never a mutation of signed items

The parent-only/hidden visibility contract must hold on **every** buyer surface:
the booking-page render, the running total (`orderSummary`), the Stripe/Square
line items, the confirmation email/ticket attachments (`buildTemplateData`), the
ticket cards, the public `/listings` cards (which today keep child listings in the
card list and only swap the CTA; an auto-included child has no `group_listings`
row, so it needs a dedicated suppression path), the `/order` gallery and the
`/order.js` embed widget, the RSS/ICS feeds, the share/QR affordances
(`/ticket/:slug/qr` and the admin public-URL/QR/embed snippets — an unbookable
folded child or hidden member must not get published share links), and the
Apple/Google **wallet** passes. Wallet data is built from a single resolved
token entry's `listing.name`/qty/price (`lookupSingleTokenPassData` →
`buildWalletPassData`, with package bookings 404'd today); once folded child rows
are signed/persisted separately, `/wallet`/`/gwallet` need an explicit
projection/suppression rule or a direct request exposes the child as the pass's
listing (or regresses by disappearing only on that surface).

**Crucially this is display-only.** The provider line items *and* the signed
booking metadata must no longer be the same mutable array once display folding is
needed. The v2 checkout intent should carry canonical signed booking lines
(`nodeKey`, listing id, quantity, unit/line price, provenance) and derive provider
display lines from a **projection** over those lines. Folding a child into its
parent for Stripe/Square/email/card display must never remove it from the
canonical signed booking lines — the webhook needs every booked node as its own
signed item to persist and revalidate (operation 5).

### Privacy

Route every render/discovery/checkout/email/wallet surface through the
hidden-member helpers; `HIDDEN` nodes are **dropped**, not rendered-then-hidden.

### Persistence

Keep parent rows as their own booked rows; the tree is not only its leaves. Any
edge-store migration must keep pre-migration bookings resolving
(`package_group_id`, allocations, `getPackageDisplaysByIds`).

### Metadata v2 consistency

No byte-identical old/new metadata guarantee is required for in-flight checkouts:
sites are inactive during deployment. The requirement is instead that the v2
metadata is internally consistent — the amount sent to the provider, the signed
proof, the webhook re-price, and the ledger booking all derive from the same
canonical per-node lines (plus the non-line components: modifiers, fees,
reservation, and the `/pay` balance settlement).

---

## Test posture (100% line + branch, mutation-resistant)

The unified walks need coverage at each phase; the cross-cutting cases the
invariants above demand:

- **Admin:** the accepted parent-member-with-child configuration succeeds via
  **every** save path (group edit/add-listings, listing save, children form, JSON
  API, single-listing duplicate, group bulk duplicate); incompatible
  parent/child/cardinality rejected from each. The admin attendee add/edit writers
  either produce edge-consistent rows or reject a parent-only row that violates
  `childRule` (no flat-line bypass of the fold's child semantics).
- **Questions:** a question assigned to several selected listings is rendered and
  validated once; a required question on a folded/hidden child is still collected
  once without printing the hidden listing's name.
- **Fold/pricing:** with `packageQty > 1` **and** `memberQty > 1`, parent and
  child quantities/prices are each `fixed × packageQty` exactly once (a regression
  that fails on a doubled or missing scale factor); v2 signed per-node lines are
  preserved when a listing is reachable two ways.
- **Capacity:** bounded by a node's own cap even when it is in no capped group;
  by group pools; per-day for daily nodes (a 2-day span conflicts with a 1-day
  booking on a shared day); an inactive node drops the bundle; discovery
  (cards, `/order.js`, feeds, API) hides/re-shows in lockstep with `/ticket/<group>`.
- **Display:** visible-package child folded into its parent on summary, provider
  lines, email, ticket card, `/listings`, `/order`, and `/order.js` — while the
  **canonical signed lines still carry the child separately** (assert the webhook
  receives/persists it). A folded child / hidden member is not exposed via
  `/wallet`/`/gwallet` or via share/QR (`/ticket/:slug/qr`, admin embed snippets),
  and a visible package's wallet pass projects the parent, not the child.
- **Metadata budget:** a deeply nested package / many folded children stays within
  Square's entry-count and value-length limits (compact v2 wire shape), asserting
  hosted checkout doesn't throw on a tree the validator accepts.
- **Entry round-trips:** a signed QR link's qty/date/name/price prefill and a
  parent `thankYouUrl` survive a fold that adds child lines; an
  `/order → /ticket/<slugs>?q_<id>=N` cart opens the form with those quantities.
- **Webhook:** price drift *and* a removed/swapped edge mid-checkout both take
  `price_changed`; the `/pay` balance and renewal entries settle/extend correctly.
- **Privacy:** `hide_package_listings` conceals members on every surface.

---

## Risks / watch-items

- **Existing bookings must keep resolving** across the Phase 3 migration.
- **Privacy regressions** — every new surface routes through the hidden-member
  helpers; default `HIDDEN` to dropped.
- **Metadata v2 consistency** — provider total, signed proof, webhook re-price,
  ledger legs, and persisted rows all derive from the same canonical per-node
  lines (plus the non-line components).
- **Capacity double-counting / under-counting** — sum per (listing, pool, day),
  charge every booked node, both arms.
