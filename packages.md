# Plan: Groups as Packages + Multi-Group Membership

## What we're building

Three interrelated changes:

1. **Multi-group membership** — listings can belong to more than one group. A new `group_listings` join table replaces the current `listings.group_id` FK.
2. **`is_package` on groups** — marks a group as a bookable package.
3. **Package price overrides** — stored as `package_price` on `group_listings` (no separate table), shown/hidden via the CSS input trick when `is_package` is checked on the edit form.

Packages show above regular listings on the public `/listings` page. Availability checking must now consider all groups a listing belongs to.

---

## 1. Database — three changes

**a) New join table `group_listings`:**
```sql
CREATE TABLE group_listings (
  group_id    INTEGER NOT NULL,
  listing_id  INTEGER NOT NULL,
  package_price INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id, listing_id)
);
```
`package_price` is in minor units, unencrypted (same as listing prices). A value of `0` means "no override" — the listing's own base price applies. Missing rows and zero-price rows are treated identically throughout the system (see §10 on consistency).

**b) New column on `groups`:**
```sql
ALTER TABLE groups ADD COLUMN is_package INTEGER NOT NULL DEFAULT 0;
```
Unencrypted (same pattern as `hidden`, `max_attendees`).

**c) Remove `listings.group_id`:**

The `listings` table currently has a `group_id INTEGER NOT NULL DEFAULT 0` column. After the migration it is no longer used.
```sql
-- SQLite ≥ 3.35.0: ALTER TABLE listings DROP COLUMN group_id
-- Older: table-rename-recreate-copy migration
```

**Migration**: add a new named migration file `src/shared/db/migrations/add-group-packages.ts`:
1. `CREATE TABLE group_listings ...`
2. `ALTER TABLE groups ADD COLUMN is_package ...`
3. `INSERT INTO group_listings (group_id, listing_id) SELECT group_id, id FROM listings WHERE group_id > 0`
4. Remove `group_id` from `listings` (via DROP COLUMN or table recreation)

Import into `src/shared/db/migrations.ts` and update the schema version string in `src/shared/db/migrations/schema.ts`.

Additionally, update `schema.ts`:
- Remove `group_id` from the `listings` column definitions
- Add `is_package` to the `groups` column definitions
- Add `group_listings` to `SCHEMA` and `SCHEMA_TABLE_NAMES`
- `initializeFreshSchema` builds new databases directly from `SCHEMA`, so fresh installs and restores must reflect the final post-migration shape

---

## 2. Types (`src/shared/types.ts`)

Remove `group_id` from `Listing` (it was a FK, now the join table handles membership).

Add to `Group`:
```typescript
is_package: boolean;
```

New type:
```typescript
export interface GroupListing {
  group_id: number;
  listing_id: number;
  package_price: number; // 0 = no override; use listing base price
}
```

`GroupInput` gets `isPackage?: boolean` and `packagePrices?: Array<{ listingId: number; price: number }>`.

For the JSON API PUT, `packagePrices` being absent (not provided at all) means "do not touch existing price rows". An explicit `[]` or `is_package: false` clears them (see §7 on partial-update semantics).

---

## 3. DB layer — `group_listings` functions (`src/shared/db/groups.ts`)

Replace all code that reads/writes `listings.group_id` with join-table equivalents.

New/updated functions:
- `getGroupsByListingId(listingId: number): Promise<Group[]>` — all groups a listing belongs to
- `getListingsByGroupId(groupId: number): Promise<Listing[]>` — via `group_listings` join (replaces existing `WHERE listing.group_id = ?`)
- `assignListingsToGroup(groupId: number, listingIds: number[], tx: TxScope): Promise<void>` — inserts rows into `group_listings`; must check package compatibility invariants (§5) when the group `is_package`
- `removeListingsFromGroup(groupId: number, listingIds: number[], tx: TxScope): Promise<void>` — deletes rows from `group_listings`
- `getGroupPackagePrices(groupId: number): Promise<GroupListing[]>` — `SELECT * FROM group_listings WHERE group_id = ?`
- `setGroupPackagePrices(groupId: number, prices: Array<{listingId: number; price: number}>, tx: TxScope): Promise<void>` — issues a **single multi-row UPDATE** (or DELETE + INSERT) for all price rows. One or two statements regardless of package size (stays well within the 31-statement round-trip guard).
- `deleteListingFromAllGroups(listingId: number, tx: TxScope): Promise<void>` — called when a listing is deleted; removes all `group_listings` rows for that listing
- `deleteAllListingsFromGroup(groupId: number, tx: TxScope): Promise<void>` — called when a **group** is deleted; removes all `group_listings` rows for that group so no orphan rows remain in backups/restores

All queries in `capacity.ts` and `attendees/capacity.ts` that join on `listing.group_id` must be rewritten to join through `group_listings` (see §4 below).

---

## 4. Availability — multi-group capacity

**This is the most significant change.** Every part of the capacity system that currently treats a listing as belonging to exactly one group (via `listing.group_id`) must be updated to handle membership in zero-or-many groups.

### Current model
- `listing.group_id = 0` → no group constraint
- `listing.group_id > 0` → check this one group's cap

### New model
- A listing may appear in 0, 1, or many rows of `group_listings`
- When booking listing X, the booking must satisfy the cap of **every** group X belongs to
- Available quantity for X = min(X's own remaining cap, remaining cap of group 1, remaining cap of group 2, …)

### Files to update

**`src/shared/db/capacity.ts`** (`buildCapacityCondition`, `buildDayCapacitySql`):
- The SQL WHERE clause that currently does `LEFT JOIN groups g ON g.id = listing.group_id AND ...` must be rewritten as a subquery over `group_listings` — for each group the listing belongs to, the group's current count + requested qty must be ≤ the group's `max_attendees`.
- Pattern: `NOT EXISTS (SELECT 1 FROM group_listings gl JOIN groups g ON g.id = gl.group_id WHERE gl.listing_id = listing.id AND g.max_attendees > 0 AND <group_current_count> + qty > g.max_attendees)`

**`src/shared/db/attendees/capacity.ts`**:
- `getGroupRemainingByListingId(listingIds)` — currently fetches remaining for a single group per listing. Must now fetch remaining for ALL groups each listing belongs to and return the **minimum** across all groups (the tightest constraint).
- `getGroupRemainingByGroupId(groupIds)` — used for discovery page; fine as-is since it works from group IDs. Update the query that populates per-group booked counts to use `group_listings` instead of `listing.group_id`.
- `getGroupStaticCapByListingId` — fetch caps across all groups, return minimum.
- `getSharedGroupCapacities` — combines remaining + static; same multi-group treatment.
- `groupPerDayRemainingByGroup` — the per-day group count query joins `listing_attendees` to `listings` via `WHERE listing.group_id IN (...)`. Rewrite to join through `group_listings`.
- `checkBatchAvailabilityImpl` — the JS preflight accumulates per-group demand. Must now accumulate demand across all groups each listing belongs to, looking up group membership from the join table.

**`src/shared/db/groups.ts`** (`queryGroupListings`, `queryListingsWithCounts`):
- All `WHERE listing.group_id = ?` queries become `JOIN group_listings gl ON gl.listing_id = listing.id WHERE gl.group_id = ?`.

---

## 5. Package compatibility invariants

Packages must not contain listings that are incompatible with flat price overrides:

- **No `customisable_days` listings** — day-count pricing uses `dayPriceFor()`, not `unit_price`, so a flat override is meaningless
- **No `can_pay_more` listings** — the buyer enters a custom price; overwriting `CheckoutItem.unitPrice` with a package price would silently discard it

These checks must be enforced in **every** path that can change group membership or listing properties:
- `validateListingTypesForGroup` (called by the add-listings path `/admin/groups/:id/add-listings`)
- `validateListingInput` / `validateListingGroup` (listing create/edit/API)
- The group create and edit POST handlers (when enabling `is_package`)

---

## 6. Admin form — CSS input trick (`src/ui/templates/admin/groups.tsx` + `fields.ts`)

On the **edit form** (after listings have been assigned):

```
[ ] Is a package
     ↓ revealed by :has(:checked)
  ┌─────────────────────────────────────────┐
  │ Override prices                         │
  │ Listing A   [___ pence/cents input ___] │
  │ Listing B   [___ pence/cents input ___] │
  │ …                                       │
  └─────────────────────────────────────────┘
```

Implementation:
- Visually-hidden checkbox `id="package-toggle"` inside a `<label>` — same pattern as the embed toggle in `listings.tsx`
- The override-prices section sits inside the same form container; a CSS `:has(#package-toggle:checked)` rule on the container shows it (default `display: none`)
- If the group currently has no listings, the section shows a note: "Assign listings to this group first"
- On the **create form**, `is_package` checkbox is shown but the price table is not (no listings yet — they can only be assigned after creation)

Price inputs: a blank input means `package_price = 0` (no override; listing base price is used). Blank inputs do not fail validation when `is_package=true` — missing/zero rows are a valid "use base price" state.

The generic edit GET route (currently `createCrudHandlers`) must be replaced with a custom loader that additionally calls `getListingsByGroupId` and `getGroupPackagePrices`, so the edit page can render the listings table and pre-fill any existing price overrides.

Styles go in `src/ui/static/style.scss` alongside the existing embed-toggle block.

---

## 7. Admin route handlers (`src/features/admin/groups.ts` + `src/features/admin/api-groups.ts`)

The current group admin routes go through `defineNamedResource(... table: groupsTable ...)` and `defineCrudApi(... table: groupsTable ...)`. These generic paths write only the `groups` row and know nothing about `group_listings`. The following must all be replaced or wrapped with custom handlers:

- **HTML create POST** (`crudCreate.createPost` / `extractGroupCreateInput`) — must parse `is_package` and persist it; must enforce the compatibility invariants (§5)
- **Edit GET** — custom loader (see §6)
- **HTML edit POST** — writes the `groups` row and `group_listings.package_price` values in a single `withTransaction`
- **JSON API POST** (`POST /api/admin/groups` in `api-groups.ts`) — must parse and persist `is_package`; same compatibility checks
- **JSON API PUT** (`PUT /api/admin/groups/:groupId` in `api-groups.ts`) — writes `groups` row + price rows in a single `withTransaction`

**Partial-update semantics for the JSON API PUT**: `packagePrices` absent in the request body → leave existing `group_listings.package_price` values unchanged. `packagePrices: []` or `is_package: false` → clear all price overrides for this group. This prevents a name-only API update from silently wiping package prices.

All custom create/update handlers must preserve the existing `applyDemoOverrides(form, GROUP_DEMO_FIELDS)` call (currently provided by `wrapResourceForDemo`) so demo instances continue to substitute safe values for `name`/`description` instead of persisting operator-supplied text.

HTML edit POST parses:
- `is_package` checkbox (present = true, absent = false)
- `package_price_<listing_id>` inputs for each listing in the group (blank = 0 = no override)

Validation:
- Each non-blank price input must be a non-negative integer when `is_package` is true; blank is accepted (treated as 0)
- Listing IDs in price inputs must all belong to this group (prevent form-forged listing IDs)
- Reject `is_package=true` when the group's listings include `customisable_days` or `can_pay_more` listings

**Group delete**: the `deleteGroup` path must call `deleteAllListingsFromGroup` in the same transaction to remove all `group_listings` rows for the deleted group, preventing orphan rows.

---

## 8. Listing membership changes — maintain price rows

`group_listings` rows can become stale or missing through paths that don't go through the group edit form:

- **Listing deleted**: `deleteListingFromAllGroups` must be called in the listing delete path, inside the same transaction
- **Listing removed from group** (reset/reassign): remove the `group_listings` row (price goes with it)
- **Listing added to package group** (`assignListingsToGroup`): newly added listings get a `group_listings` row with `package_price = 0`. This is treated as "use listing base price" at pricing time — not a crash — but the group edit page will show the listing with a blank price input, prompting the operator to fill it in on the next edit save

---

## 9. Ticket context — package identity through the pricing path

The current `renderTicketFlow` passes `options.group` into `getTicketContext`, but `TicketCtx` retains only `groupName`/`groupDescription`. Without `groupId` and `isPackage` (or the resolved package price map) in `TicketCtx`, the pricing layer in `ticket-submit.ts` cannot know it is building a package order.

`TicketCtx` must be extended with:
- `packagePrices: Map<number, number> | null` — listing ID → override price (only entries where `package_price > 0`), loaded at context-build time when the group `is_package`; `null` for non-package groups

This map is built once in `getTicketContext` (loading `getGroupPackagePrices` when `group.is_package`) and is available to both the `/calculate` quote path and the full booking submit path without any extra DB call.

---

## 10. Pricing integration

### Item assembly (`ticket-submit.ts`)

After `buildRegistrationItems` returns, walk the `CheckoutItem` list. Build the **effective override set** as the intersection of `TicketCtx.packagePrices` keys and the **post-`dropChildListings` page listing IDs** — i.e., only the top-level listings explicitly shown on the group booking page. This excludes:
- Child listings folded in by `foldSelectedChildren` (even if those children happen to be in the same package group and appear in `group_listings`)
- Any item not in the page-level listing set

For each item in the effective override set with a non-zero override price, replace its `unitPrice` with the map value. Items outside the effective override set (folded children, base-priced package members with `package_price = 0`) keep their existing pricing untouched.

**"Paid" detection**: `isPaidListing(listing)` checks `unit_price > 0`, but a package override can make a zero-base-price listing effectively paid. `ticketPage` / `buildContactFields` must consider a listing "paid in context" if `isPaidListing(listing)` OR the listing's entry in `TicketCtx.packagePrices` is > 0. `validateTicketFields` must receive the same context-aware paidness so that provider-required fields (e.g. email on Square) are shown and validated when package pricing makes a listing paid.

### `BookingItem.p` — signed line total

The existing signed `items` payload (`BookingItem.p`) carries the agreed line total that the webhook uses to reconstruct the order. Package checkouts must populate `p` with `overriddenUnitPrice * quantity` — the package-overridden line amount. For members with `package_price = 0` (base price), `p` carries `baseUnitPrice * quantity` as normal. What must NOT be stored separately is a snapshot of `group_package_prices` values.

### Metadata plumbing (`src/shared/payments.ts` and `src/shared/payment-helpers.ts`)

`CheckoutIntent`/`SessionMetadata`, `buildMetadata`, and `extractSessionMetadata` whitelist the fields that survive the Stripe round-trip. Add `packageGroupId: number | null` to this schema.

### Payment revalidation (`payment-processing.ts`)

At webhook time, extract `packageGroupId` from session metadata. If set:

1. Verify the package group still exists and still has `is_package = true`
2. For each `BookingItem` that received package pricing (identified by whether its listing ID appears in `group_listings` for this group), verify the listing is still a member of that group
   - Folded child items that were NOT in the effective override set (see item assembly above) are **not checked against package membership** — they go through the normal listing-price revalidation path
3. Fetch current `group_listings` rows for this group; for each package-priced item, compare `current_package_price * item.q` against the signed `item.p`. For items with `current_package_price = 0` (no override), compare `current_listing_unit_price * item.q` against `item.p`

If any check fails (group deleted, `is_package` cleared, listing removed from group, price × qty mismatch), take the existing `price_changed` refund path.

---

## 11. `/listings` page — packages above regular listings

The public `/listings` page is assembled by `handlePublicListings` in `src/features/public/pages.ts` and rendered with the `homepagePage` template.

Changes to `pages.ts` and `homepagePage`:
- After loading and decrypting all public groups via the entity cache, partition them into `packageGroups` and `regularGroups` in TypeScript (sort each by decrypted `name`)
- Render `packageGroups` under a "Packages" heading first, then `regularGroups` and individual listing cards together
- The group public page for a package group shows per-item package prices in the quantity/price display (not listing base prices)

---

## 12. Bulk-duplicate path (`src/features/admin/bulk-actions.ts`)

The group duplicate action creates a new group and clones its listings outside the CRUD edit route. It must also:
- Copy `is_package` from the source group
- Load `getGroupPackagePrices` for the source group and insert remapped rows for the newly cloned listing IDs in `group_listings` via `setGroupPackagePrices`

All in the same transaction as the duplicate write.

---

## 13. Tests

Each layer needs full coverage:

**Migration**
- `group_listings` and `is_package` present in both upgraded and fresh-install schema
- `SCHEMA_TABLE_NAMES` includes `group_listings`
- Existing `listings.group_id` data correctly migrated to `group_listings`
- `group_id` absent from `listings` post-migration

**DB layer**
- `getGroupsByListingId`, `getListingsByGroupId` (via join)
- `assignListingsToGroup`, `removeListingsFromGroup`
- `getGroupPackagePrices`, `setGroupPackagePrices` (multi-row write)
- `deleteListingFromAllGroups`, `deleteAllListingsFromGroup`
- Group encode/decode with `is_package`; listing decode without `group_id`
- JSON API PUT with `packagePrices` absent → prices preserved; with `packagePrices: []` → prices cleared

**Availability — multi-group**
- Listing in two groups, both uncapped → available
- Listing in two groups, one at cap → unavailable
- Listing in two groups, one at cap (daily) → correct per-day behaviour
- `buildCapacityCondition` SQL rejects insert when any group at cap
- Atomic insert race condition test

**Compatibility enforcement**
- `validateListingTypesForGroup` rejects `customisable_days` and `can_pay_more` listings for package groups
- Same rejection in listing create/edit paths

**Admin create POST**
- `is_package=on` is persisted; demo overrides are applied

**Admin form GET**
- Custom loader passes listings + existing package prices to the template

**Admin edit POST**
- `is_package=on` + price inputs saves correctly
- Blank price input saved as `package_price = 0` (no error)
- POST without `is_package` saves `is_package=false` and clears prices
- Invalid (non-integer) price input returns 400
- Incompatible listing types reject `is_package=true`
- Demo overrides are applied

**Membership change**
- Listing delete removes all `group_listings` rows
- Group delete removes all `group_listings` rows (no orphans)
- Listing group reassignment removes `group_listings` row
- Add-listings to package group creates row with `package_price=0` (no crash, blank on next edit)

**Paid detection with package prices**
- Listing with `unit_price=0` but `package_price > 0`: booking page renders email/paid fields; `validateTicketFields` enforces them

**TicketCtx**
- `packagePrices` map populated for package groups (non-zero prices only)
- `null` for non-package groups
- Map excludes child listing IDs that are in the group but dropped by `dropChildListings`

**Pricing — item assembly**
- Package group substitutes override `unitPrice` on top-level member `CheckoutItem`s
- `BookingItem.p` carries `overriddenUnitPrice * quantity`
- Folded child items (not in effective override set) are NOT overridden, even if the child is in the same package group
- Package member with `package_price = 0` uses listing base price; `p` carries `baseUnitPrice * quantity`
- Non-package group uses listing base prices

**Metadata plumbing**
- `packageGroupId` survives `buildMetadata`/`extractSessionMetadata` round-trip

**Payment revalidation**
- Package group still exists + membership intact + `current_package_price * qty == p` → completes
- Group deleted → `price_changed` refund
- `is_package` cleared → `price_changed` refund
- Listing removed from group → `price_changed` refund
- Package price changed → `current_price * qty != p` → `price_changed` refund
- Quantity > 1: revalidation compares `price * qty` (not `price`) against `p`
- Item with `package_price=0`: compared against base listing price × qty
- Folded child item not in effective override set → validated via normal listing-price path, not package membership check

**Public listing render**
- Package groups appear before non-package groups and individual listings
- Each partition sorted by decrypted name

**Bulk duplicate**
- Duplicated package group preserves `is_package`
- Remaps package prices to cloned listing IDs

---

## File change summary

| File | What changes |
|---|---|
| `src/shared/db/migrations/add-group-packages.ts` | New migration: `group_listings` table, `is_package` column, copy `listings.group_id` data, remove `group_id` from `listings` |
| `src/shared/db/migrations.ts` | Import + register new migration |
| `src/shared/db/migrations/schema.ts` | Updated schema version; `group_listings` in SCHEMA + SCHEMA_TABLE_NAMES; `is_package` in groups; `group_id` removed from listings |
| `src/shared/types.ts` | `Group.is_package`, `GroupListing`, updated `GroupInput`; `group_id` removed from `Listing` |
| `src/shared/db/groups.ts` | `getGroupsByListingId`, `getListingsByGroupId` (join table), `assignListingsToGroup`, `removeListingsFromGroup`, `getGroupPackagePrices`, `setGroupPackagePrices`, `deleteListingFromAllGroups`, `deleteAllListingsFromGroup`; all `listing.group_id` queries replaced; decode update |
| `src/shared/db/capacity.ts` | `buildCapacityCondition`, `buildDayCapacitySql` — rewrite group-cap SQL to use `group_listings` join; NOT EXISTS across all groups |
| `src/shared/db/attendees/capacity.ts` | `getGroupRemainingByListingId`, `getGroupStaticCapByListingId`, `getSharedGroupCapacities`, `groupPerDayRemainingByGroup`, `checkBatchAvailabilityImpl` — all multi-group aware |
| `src/shared/payments.ts` | Add `packageGroupId` to `CheckoutIntent`/`SessionMetadata` and `buildMetadata` |
| `src/shared/payment-helpers.ts` | Add `packageGroupId` to `extractSessionMetadata` |
| `src/shared/db/listings.ts` | Remove `group_id` column writes; `validateListingTypesForGroup` extended for package compatibility |
| `src/features/admin/groups.ts` | Custom HTML create POST, edit GET loader, edit POST — all preserving demo overrides; group delete calls `deleteAllListingsFromGroup` |
| `src/features/admin/api-groups.ts` | Custom JSON API POST and PUT — `is_package` + package price rows; partial-update semantics on PUT (absent `packagePrices` → preserve existing) |
| `src/features/admin/listings.ts` | Listing delete calls `deleteListingFromAllGroups`; reassign removes `group_listings` row |
| `src/ui/templates/admin/groups.tsx` | `is_package` checkbox (create + edit), CSS-trick price table on edit, pre-filled overrides |
| `src/ui/templates/fields.ts` | New field definitions if needed |
| `src/ui/static/style.scss` | `:has()` rules for the package price section |
| `src/features/public/ticket-submit.ts` | Extend `TicketCtx` with `packagePrices`; effective override set scoped to post-`dropChildListings` IDs; substitute override `unitPrice`; context-aware paid detection for `buildContactFields` / `validateTicketFields` |
| `src/features/api/payment-processing.ts` | At revalidation: verify group + membership (package-priced items only) + `price * qty` vs `p`; folded children through normal path; `price_changed` on mismatch |
| `src/features/public/pages.ts` | Partition groups into packages/regular; pass both to homepagePage |
| `src/ui/templates/public/homepage.tsx` (or equivalent) | "Packages" section above regular listings + individual listings |
| `src/features/admin/bulk-actions.ts` | Copy `is_package` + remap package prices when duplicating a group |
| `test/lib/groups.test.ts` | DB-layer tests, multi-group membership, compatibility enforcement |
| `test/lib/availability.test.ts` | Multi-group capacity tests, atomic SQL tests |
| `test/lib/admin-groups.test.ts` | Create/edit form/route tests, API POST/PUT tests, partial-update semantics, membership change tests, group delete cleanup, bulk-duplicate, demo-override |
| `test/lib/checkout-pricing.test.ts` | Package price substitution, child-item scoping, paid detection, TicketCtx map, metadata round-trip, revalidation tests incl. qty scaling and base-price fallback |
| `test/lib/public-listings.test.ts` | Partition/sort render tests |
