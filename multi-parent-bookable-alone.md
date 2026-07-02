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

## Finding 3: the row-identity work is half done on main

The schema half already landed with #1462: the `listing_attendees` unique
index is `(listing_id, attendee_id, start_at, parent_listing_id)` — its
comment says outright that "the SAME child chosen under two parents is two
distinct booking rows (one per parent, faithful provenance)". Inserts are
plain capacity-gated `INSERT … SELECT`s (no `OR IGNORE`), so per-parent rows
insert cleanly and a true duplicate fails loudly. Attendee-merge conflict
keys already include `parentListingId`.

Three residuals did not follow the index:

1. **The paid path still maps positionally.** `processPaidBooking` pairs
   `created.attendees[i]` with `validatedItems[i]!.listing`
   (`src/features/api/payment-processing.ts`), but
   `expandChildAllocations` can emit MORE booking rows than signed items (a
   child under two parents = one summed line, two allocation rows), so the
   pairing mis-aligns or crashes exactly when the widened index does its
   job. The free path already pairs by `attendee.listing_id`
   (`ticket-payment.ts`) — the paid path must do the same.
2. **The expansion drops unallocated units.** For a booking whose listing
   has allocations, `expandChildAllocations` emits one row **per
   allocation** and nothing else: units of that child bought WITHOUT a
   parent in the same order (impossible today, routine under
   `bookable_alone`) would vanish, along with their proportional
   `pricePaid` share. A remainder row (`qty = total − Σ allocations`, no
   parent, `pricePaid = total − Σ emitted shares` so rounding conserves
   money exactly) must be emitted.
3. **The `order-parents.ts` module doc is stale.** Its header still
   describes the old three-column index "folding a child chosen under two
   parents into one row" — the exact behaviour the schema comment says was
   deliberately removed. Update it with the fix so the file stops
   contradicting the schema.

One consumer needs a *decision*, not a fix: check-in
(`src/shared/db/attendees/update.ts`) flips `checked_in` per
`(attendee_id, listing_id)`, so both per-parent rows of one widget check in
together. That matches the existing semantic — a single row with
`quantity: 3` already checks in wholesale — so treating "all units of this
listing for this person" as one check-in unit is consistent; it just needs a
test locking it in. The admin atomic-update path (`atomic-update.ts`, the
attendee edit form's desired-lines diff) should get the same audit: assert
its keying behaves sanely when two rows share `(listing, attendee,
start_at)` and differ only by parent.

## The combination the ask describes, end to end

- "Pick any of these widgets" = a parent listing whose children are the
  widgets, added to a package as a member with `quantity: 2` (a pick-2 slot
  — works today).
- The same widgets under another picker = second parent edges (works today).
- Widgets sold on their own = `bookable_alone: true` (new flag).
- A widget in two pickers of the *same* package, or bought alone alongside a
  fold of itself = workstream 1 below.

---

# Implementation plan

## Workstream 1 — finish the row-identity fix

No schema change (the index is already right). Small, self-contained, and it
hardens *today's* multi-slug carts; everything in workstream 2 stands on it.

1. **Paid-path mapping by listing, not position**
   (`src/features/api/payment-processing.ts`). Replace
   `created.attendees.map((attendee, i) => ({ attendee, listing:
   validatedItems[i]!.listing }))` with a lookup by `attendee.listing_id`
   against the validated items (mirroring the free path in
   `ticket-payment.ts`). Regression test first: a paid order booking one
   child under two parents (multi-slug cart of both parents, or a package
   with two slots sharing the candidate) currently mis-pairs; after the fix
   every entry's `attendee.listing_id === entry.listing.id`. This also
   retires the "pairwise disjoint candidate sets" guard proposed in
   `package-choice-slots.md` item 2.
2. **Remainder row in `expandChildAllocations`**
   (`src/shared/db/attendees/order-parents.ts`). After emitting the
   per-allocation rows for a booking, if `total − Σ alloc.qty > 0`, emit one
   more row with that quantity, no `parentListingId`, and
   `pricePaid = booking.pricePaid − Σ emitted shares` (subtraction, not
   another rounded share, so money is conserved to the cent). The module is
   pure — direct unit tests, no harness: remainder emitted; zero remainder ⇒
   no extra row; rounding conservation property across odd splits.
3. **Fix the stale module doc** in the same file (it still describes the
   pre-widening index collapse).
4. **Semantics tests, no code change:** check-in flips all of one listing's
   per-parent rows for an attendee together (locking the wholesale
   semantic); attendee merge keeps two per-parent rows distinct in its
   conflict keys; the admin attendee-edit desired-lines diff behaves with
   duplicate `(listing, attendee, start_at)` rows differing only by parent.
5. **End-to-end regression:** free + paid bookings of "child under P1 and
   P2 in one order" persist two rows with faithful parents and split
   `pricePaid`; the ticket page/email show both lines; capacity charged
   once per unit.

Per house rules: regression tests written first and failing for the right
reason; `deno task precommit` green including the changed-file mutation gate.

## Workstream 2 — `bookable_alone`

**Migration.** `2026-07-xx_bookable_alone`: `ALTER TABLE listings ADD COLUMN
bookable_alone INTEGER NOT NULL DEFAULT 0` (+ `verify()` column assertion,
`LATEST_UPDATE` bump). Default false ⇒ every existing child keeps today's
behaviour; the column rides the wide listings cache reads and
backup/restore automatically.

**Model + admin.** `col.boolean(false)` on the listings table def;
`ListingInput.bookableAlone`; the create/update form field and JSON API
field; an admin checkbox on the listing form next to the `offeredUnder`
list ("Can be booked by itself — keep this listing's own booking page while
it is offered under other listings"); i18n keys
(`fields.listing.bookable_alone` + hint). Duplication paths copy it like any
listing column (nothing bespoke).

**The predicate split.** Today "is a child" implies "no standalone page".
Introduce the narrowed DB read once —
`getNonStandaloneChildIds(ids)` / `anyNonStandaloneChild(ids)` in
`src/shared/db/listing-parents.ts` (children joined to
`listings.bookable_alone = 0`) — and move the GATE consumers onto it, while
STRUCTURAL consumers keep the unfiltered child set. **Codex review sharpened
this table: several "one obvious call site" gates turned out to have a
second, separate guard that also had to switch, and one "keep structural"
decision was wrong.**

| Call site | Meaning | Action |
|---|---|---|
| `lacksStandalonePublicPage` (`ticket-payment.ts`) | gate | switch |
| `withActiveListings` child-slug rejection | gate | switch |
| **`renderTicketFlow`'s `dropChildListings(listings)`** (`ticket-submit.ts:1181`) | gate | **split, not keep** — see below |
| QR scan guard (`qr-book.ts`) + QR issuance gating | gate | switch |
| JSON API `findActiveListing` / list filter (`api/index.ts`) | gate | switch |
| **`handleBook`'s own `anyChildListing([listing.id])`** (`api/index.ts:988`) | gate | **switch** — a second guard after `findActiveListing`, else book still 400s |
| `getCatalogListings` child-exclusion SQL (`db/listings.ts`) | gate | add `AND NOT bookable_alone` |
| `classifyForDiscovery` `childIds` (`discovery.ts:261`) | gate | **do NOT blanket-switch** — it feeds both card state AND group liveness; see below |
| **`childCardState` add-on precedence** (`homepage.tsx:31`) | gate | **also filter `addOnChildIds`** — it returns `"addon"` before consulting `childIds`, so a flagged child with a live parent still shows the add-on note unless removed from `addOnChildIds` (or the precedence flips) |
| `/order` gallery, `/order.js`, feeds | gate | switch (via the shared catalog/discovery reads) |
| Admin dashboard builder `unbookableIds` (`dashboard.ts`) | gate | switch |
| Admin share/QR flags `isChild` (`listings-view.ts`) | gate | switch |
| Fold/render `childrenByParentId`, tree building | structural | keep |
| `signed-metadata`, `order-parents` | structural | keep |
| Children editor nesting blocks (`listings-parents.ts`) | structural | keep |
| Package-member blocks (`anyListingInPackageGroup`) | structural | keep |
| Child-only add-on block (`childOnlyAddOnName` edge save) | gate | **relax** for flagged children (its own page sells the add-on) — but two-sided, see below |

**The three subtleties Codex surfaced (each a real breakage otherwise):**

1. **`dropChildListings` must split by page kind, not stay structural.**
   `handleBySlugs → handleTicket → renderTicketFlow` calls
   `dropChildListings(listings)` unconditionally, so even after the slug guard
   lets `/ticket/<flagged-child>` through, this shared drop removes the only
   row and 404s — and `/ticket/<parent+child>` can't mix standalone + folded
   units either. Split it: a **direct-slug** entry keeps `bookable_alone`
   children as top-level rows (drop only non-standalone children); an
   **indirect group/order** page keeps dropping ALL children (a standalone row
   beside its own fold selector on the same page is confusing). Thread a
   "direct vs indirect" flag, or give `renderTicketFlow` the entry kind.

2. **`classifyForDiscovery.childIds` feeds two consumers that must diverge.**
   It drives both the `/listings` card state AND group liveness
   (`groupHasBookableMember` at `discovery.ts:353`, and the public nav at
   `site-nav.ts:91`). If a flagged child leaves `childIds`, its card correctly
   gains a CTA — but a regular group whose ONLY members are flagged children
   would then be advertised as live while `/ticket/<group>` still calls
   `dropChildListings` (indirect ⇒ drops them) and 404s. So the group-liveness
   read must stay structural (unfiltered `childIds`), OR indirect group pages
   must render flagged children too. Recommendation: keep group liveness on
   the unfiltered set (a flagged child's *own* page and catalog card are its
   surfaces, not the group page), and expose card state via a separate
   `standaloneBookableChildIds` set rather than by mutating `childIds`.

3. **Add-on reachability is two-sided — relaxing the edge block isn't enough.**
   A `bookable_alone` child's page rescues a child-scoped opt-in add-on, so
   the edge-save block (`childOnlyAddOnName`) skips flagged children. But the
   guard is symmetric: modifier saves compute reachable pages from active
   non-child listings (`childUnreachableAddOnError`, `modifiers.ts:172`), and
   listing edits/deactivation re-run `firstChildUnreachableAddOnForListings`
   (`listings-actions.ts`). Two holes if only the edge side relaxes: (a) the
   modifier-side reachable-page set must count a `bookable_alone` child as a
   live page; and (b) **clearing** the flag later (true→false) must re-run the
   same unreachable-add-on check as deactivation, or an add-on the flag rescued
   silently becomes a dead end. Fold `bookable_alone` into the shared
   "reachable page" predicate both sides consume, and add the false-transition
   check to listing save.

**Plus a stale-session guard (mirror `staleHiddenMember`).** A paid session
opened while a child was `bookable_alone=true` can complete after the flag is
cleared. `validateAllItems` (`payment-processing.ts:784`) has a stale guard
only for hidden-package members, and `orderEdgeDrifted` checks parent/child
structure, not standalone-eligibility — so the in-flight session would book a
now-non-standalone child after every new entry point 404s. Add a
stale-non-standalone-child guard beside `staleHiddenMember` (fail closed →
`price_changed`), and suppress the cancel-page retry link for the same stale
intent.

**One decision that stands:** mixing standalone + folded units of one child in
one order is **allowed** (`/ticket/<parent+child>`), because workstream 1's
remainder row now persists it faithfully. No extra guard.

**Interactions needing no code:** pricing (own price on both paths),
capacity (per-listing rows, path-blind atomic predicate), questions
(listing-keyed), hidden-package concealment (independent arm of the gate,
still wins over the flag), package membership rules (untouched).

**Tests.**
- Flag ON: `/ticket/<child>` 200 + books (the `dropChildListings` split);
  API lookup AND book succeed (both `findActiveListing` and `handleBook`'s
  guard); appears in catalog, `/listings` card with a **CTA not the add-on
  note** (`childCardState`/`addOnChildIds`), `/order`, `/order.js`, feeds,
  `/api/listings`; QR issuance + scan work; dashboard builder offers it;
  admin share links render; still folds under every parent on parent/package
  pages; child-scoped add-on accepted at edge save AND at modifier save, and
  sellable on its page.
- Flag OFF (regression floor): every existing 404/drop/suppression test
  keeps passing untouched.
- Flag ON + hidden-package member: still concealed everywhere (the
  hidden-member arm outranks the flag).
- **Group liveness:** a regular group whose only members are flagged children
  is NOT advertised as live (group read stays structural); its members' own
  cards still show CTAs.
- **Clearing the flag (true→false):** rejected at listing save when it would
  orphan a child-scoped add-on (the false-transition check); a stale paid
  session for the just-cleared child takes `price_changed`, and its
  cancel/retry link is suppressed.
- One order mixing standalone + folded units: rows, parents, and money
  conserved (workstream 1's remainder row exercised through the real flow).
- Mutation gate: the new predicate's `bookable_alone = 0` arm, the
  add-on-block relaxation, the `dropChildListings` direct/indirect split, and
  the stale-session guard are prime operator-flip mutants — assert both
  polarities explicitly.

## Sequencing

1. **Workstream 1 — DONE** (this branch): pure fixes + tests, no schema, no
   behaviour change for existing configurations beyond correcting the
   multi-parent corner. Shipped `pairEntriesByListing` (paid mapping by
   listing id), the `expandChildAllocations` remainder row + to-the-cent price
   conservation, and the multi-parent persistence / wholesale-check-in tests.
2. Workstream 2 (one PR): migration + flag + the predicate split above,
   including the three Codex subtleties (`dropChildListings` direct/indirect
   split, `classifyForDiscovery`/group-liveness divergence, two-sided add-on
   reachability) and the stale-session guard.
3. Follow-ups that share these code paths, from `package-choice-slots.md`:
   chooser-cap save validation and the `allocations` metadata length limit.
