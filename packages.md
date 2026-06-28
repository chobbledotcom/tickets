# Plan: Groups as Packages

## What we're building

Two new boolean+data fields on groups:
- **`is_package`** — marks a group as a bookable package
- **Package price overrides** — a per-listing price table stored separately, shown/hidden via the CSS input trick when `is_package` is checked on the edit form

Packages show above regular listings on the public `/listings` page.

---

## 1. Database — two changes

**a) New column on `groups`:**
```sql
ALTER TABLE groups ADD COLUMN is_package INTEGER NOT NULL DEFAULT 0;
```
Unencrypted (same pattern as `hidden`, `max_attendees`).

**b) New join table `group_package_prices`:**
```sql
CREATE TABLE group_package_prices (
  group_id   INTEGER NOT NULL,
  listing_id INTEGER NOT NULL,
  price      INTEGER NOT NULL,  -- minor units, unencrypted
  PRIMARY KEY (group_id, listing_id)
);
```
Prices here override the listing's own price when it is booked as part of this package. Minor units, unencrypted (like listing prices themselves).

**Migration**: add a new named migration file (e.g. `src/shared/db/migrations/add-group-packages.ts`) with the `ALTER TABLE` and `CREATE TABLE` statements, import it into `src/shared/db/migrations.ts`, and update the schema version string in `src/shared/db/migrations/schema.ts`. Additionally, add `is_package` to the `groups` column definitions and `group_package_prices` to the `SCHEMA` object and `SCHEMA_TABLE_NAMES` in `schema.ts` — `initializeFreshSchema` builds new databases directly from `SCHEMA`, so fresh installs and restores must include the new column/table.

---

## 2. Types (`src/shared/types.ts`)

Add to `Group`:
```typescript
is_package: boolean;
```

New type:
```typescript
export interface GroupPackagePrice {
  group_id: number;
  listing_id: number;
  price: number;
}
```

`GroupInput` gets `isPackage?: boolean` and `packagePrices?: Array<{ listingId: number; price: number }>`.

---

## 3. DB layer (`src/shared/db/groups.ts`)

New functions:
- `getGroupPackagePrices(groupId: number): Promise<GroupPackagePrice[]>`
- `setGroupPackagePrices(groupId: number, prices: Array<{listingId: number; price: number}>, tx: TxScope): Promise<void>` — issues a DELETE for the group then a **single multi-row INSERT** for all price rows (not one INSERT per row). Interactive transactions in this repo have a 31-statement round-trip guard; a delete + N individual inserts for a package with many listings would exceed it. One DELETE + one multi-value INSERT keeps the write to two statements regardless of package size.
- `deleteGroupPackagePricesForListing(listingId: number, tx: TxScope): Promise<void>` — removes price rows for a listing that is being deleted or removed from a package group

Updates:
- Group decode — add `is_package: row.is_package === 1`.

---

## 4. Package compatibility invariants

Packages must not contain listings that are incompatible with flat price overrides. The following restrictions apply and must be enforced in **every** path that can change group membership or listing properties, not just the group edit POST:

- **No `customisable_days` listings** — day-count pricing uses `dayPriceFor()`, not `unit_price`, so a flat override is meaningless
- **No `can_pay_more` listings** — the buyer enters a custom price; overwriting `CheckoutItem.unitPrice` with a package price would silently discard it

These checks must be added to:
- `validateListingTypesForGroup` (called by the add-listings path `/admin/groups/:id/add-listings`)
- `validateListingInput` / `validateListingGroup` (listing create/edit/API)
- The group create and edit POST handlers (when enabling `is_package`)

---

## 5. Admin form — CSS input trick (`src/ui/templates/admin/groups.tsx` + `fields.ts`)

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

The generic edit GET route (currently `createCrudHandlers`) must be replaced with a custom loader for groups that additionally calls `getListingsByGroupId` and `getGroupPackagePrices`, so the edit page can render the listings table and pre-fill any existing price overrides.

Styles go in `src/ui/static/style.scss` alongside the existing embed-toggle block.

---

## 6. Admin route handlers (`src/features/admin/groups.ts`)

The current group admin routes go through `defineNamedResource(... table: groupsTable ...)` and `defineCrudApi(... table: groupsTable ...)`. These generic paths write only the `groups` row and know nothing about `group_package_prices`. The following must all be replaced or wrapped with custom handlers:

- **Create POST** (`crudCreate.createPost` / `extractGroupCreateInput`) — must parse `is_package` and persist it; must enforce the compatibility invariants (§4)
- **Edit GET** — custom loader (see §5)
- **Edit POST** — writes both the `groups` row and `group_package_prices` in a single `withTransaction`
- **JSON API PUT** — likewise

All custom create/update handlers must preserve the existing `applyDemoOverrides(form, GROUP_DEMO_FIELDS)` call (currently provided by `wrapResourceForDemo`) so demo instances continue to substitute safe values for `name`/`description` instead of persisting operator-supplied text.

Edit handler parses:
- `is_package` checkbox (present = true, absent = false)
- `package_price_<listing_id>` inputs for each listing in the group

Validation:
- Each price input must be a non-negative integer when `is_package` is true
- Listings must all belong to this group (prevent form-forged listing IDs)
- Reject `is_package=true` when the group's listings include `customisable_days` or `can_pay_more` listings

---

## 7. Listing membership changes — maintain price rows

`group_package_prices` rows can become stale or missing through paths that don't go through the group edit form:

- **Listing deleted**: `deleteGroupPackagePricesForListing` must be called in the listing delete path, inside the same transaction
- **Listing removed from group** (reset/reassign): call `deleteGroupPackagePricesForListing` when a listing's `group_id` is cleared or changed away from a package group
- **Listing added to package group** (`assignListingsToGroup`): newly added listings have no price row yet; the plan treats missing rows as "no override" at pricing time (falls back to listing base price), so a missing row is not a crash — but the group edit page will show the listing with a blank price input, prompting the operator to fill it in on the next edit save

---

## 8. Ticket context — package identity through the pricing path

The current `renderTicketFlow` passes `options.group` into `getTicketContext`, but `TicketCtx` retains only `groupName`/`groupDescription`. Without `groupId` and `isPackage` (or the resolved package price map) in `TicketCtx`, the pricing layer in `ticket-submit.ts` cannot know it is building a package order.

`TicketCtx` must be extended with:
- `packagePrices: Map<number, number> | null` — listing ID → override price, loaded at context-build time when the group `is_package`; `null` for non-package groups

This map is built once in `getTicketContext` (loading `getGroupPackagePrices` when `group.is_package`) and is available to both the `/calculate` quote path and the full booking submit path without any extra DB call.

---

## 9. Pricing integration

**Where**: `src/features/public/ticket-submit.ts` and `src/features/api/payment-processing.ts`.

**Item assembly** (`ticket-submit.ts`): After `buildRegistrationItems` returns, walk the `CheckoutItem` list. For each item whose `listingId` appears in `TicketCtx.packagePrices`, replace its `unitPrice` with the map value. Scope to package member listing IDs only — folded child items added by `foldSelectedChildren` (for required child listings) are not in the package member map and must be left on their own pricing.

The existing signed `items` payload (`BookingItem.p`) already carries the agreed line total that the webhook uses to reconstruct the order. Package checkouts must populate `p` with the **package-overridden** line amount — this is the correct mechanism and is what survives the provider round-trip. What must NOT be stored is a separate snapshot of `group_package_prices` rows.

**Metadata plumbing** (`src/shared/payments.ts` and `src/shared/payment-helpers.ts`): `CheckoutIntent`/`SessionMetadata`, `buildMetadata`, and `extractSessionMetadata` whitelist the fields that survive the Stripe round-trip. Add `packageGroupId: number | null` to this schema so the group identity is available at revalidation time.

**Payment revalidation** (`payment-processing.ts`): At webhook time, extract `packageGroupId` from session metadata. If set:
1. Verify the package group still exists and still has `is_package = true`
2. Verify each purchased listing is still a member of that group (it hasn't been removed)
3. Fetch current `group_package_prices` for that group and compare against the signed `p` values

If any of these checks fail (group deleted, listing removed from package, prices changed), take the existing `price_changed` refund path — the same behaviour as a listing price edit detected mid-payment. This means package price edits between quote and payment are detected correctly.

---

## 10. `/listings` page — packages above regular listings

The public `/listings` page is assembled by `handlePublicListings` in `src/features/public/pages.ts` and rendered with the `homepagePage` template. The file `src/features/public/groups.ts` handles group booking pages (different concern).

Changes to `pages.ts` and `homepagePage`:
- After loading and decrypting all public groups via the entity cache, partition them into `packageGroups` and `regularGroups` in TypeScript (sort each by decrypted `name`)
- Render `packageGroups` under a "Packages" heading first, then `regularGroups` and individual listing cards together
- The group public page for a package group shows per-item package prices in the quantity/price display (not listing base prices)

---

## 11. Bulk-duplicate path (`src/features/admin/bulk-actions.ts`)

The group duplicate action creates a new group and clones its listings outside the CRUD edit route. It must also:
- Copy `is_package` from the source group
- Load `getGroupPackagePrices` for the source group and insert remapped rows for the newly cloned listing IDs via `setGroupPackagePrices`

All in the same transaction as the duplicate write.

---

## 12. Tests

Each layer needs full coverage:
- **Migration**: new column/table existence in both upgraded and fresh-install schema; `SCHEMA_TABLE_NAMES` includes `group_package_prices`
- **DB layer**: `getGroupPackagePrices`, `setGroupPackagePrices` (create/update/replace with multi-row INSERT), `deleteGroupPackagePricesForListing`; group encode/decode with `is_package`
- **Compatibility enforcement**: `validateListingTypesForGroup` rejects customisable-day and can-pay-more listings for package groups; same rejection in listing create/edit paths
- **Admin create POST**: `is_package=on` is persisted; demo overrides are applied
- **Admin form GET**: custom loader passes listings + existing package prices to the template
- **Admin edit POST**: `is_package=on` + price inputs saves correctly; POST without saves `is_package=false` and clears prices; invalid price input returns 400; incompatible listing types reject `is_package=true`; demo overrides are applied
- **Membership change**: listing delete removes price rows; listing group reassignment removes price rows; add-listings to package group leaves missing rows (no crash, blank on next edit)
- **TicketCtx**: `packagePrices` map populated for package groups; `null` for non-package groups
- **Pricing — item assembly**: package group substitutes override `unitPrice` on member `CheckoutItem`s; `BookingItem.p` carries the overridden line total; folded child items are NOT overridden; non-package group uses listing base prices
- **Metadata plumbing**: `packageGroupId` survives the `buildMetadata`/`extractSessionMetadata` round-trip
- **Payment revalidation**: package group still exists + membership intact + prices unchanged → completes; group deleted/listing removed/price changed → `price_changed` refund path
- **Public listing render**: package groups appear before non-package groups and individual listings; each partition sorted by decrypted name
- **Bulk duplicate**: duplicated package group preserves `is_package` and remaps package prices to cloned listing IDs

---

## File change summary

| File | What changes |
|---|---|
| `src/shared/db/migrations/add-group-packages.ts` | New migration: `is_package` column, `group_package_prices` table |
| `src/shared/db/migrations.ts` | Import + register new migration |
| `src/shared/db/migrations/schema.ts` | Updated schema version string; `is_package` in groups schema; `group_package_prices` in SCHEMA + SCHEMA_TABLE_NAMES |
| `src/shared/types.ts` | `Group.is_package`, `GroupPackagePrice`, updated `GroupInput` |
| `src/shared/db/groups.ts` | `getGroupPackagePrices`, `setGroupPackagePrices` (multi-row INSERT), `deleteGroupPackagePricesForListing`, decode update |
| `src/shared/payments.ts` | Add `packageGroupId` to `CheckoutIntent`/`SessionMetadata` and `buildMetadata` |
| `src/shared/payment-helpers.ts` | Add `packageGroupId` to `extractSessionMetadata` |
| `src/shared/db/listings.ts` or groups | `validateListingTypesForGroup` extended to check customisable_days + can_pay_more for package groups |
| `src/features/admin/groups.ts` | Replace generic CRUD handlers with custom create POST, edit GET loader, edit POST, and JSON API PUT — all preserving demo overrides |
| `src/features/admin/listings.ts` | Listing delete/reassign path calls `deleteGroupPackagePricesForListing` |
| `src/ui/templates/admin/groups.tsx` | `is_package` checkbox (create + edit), CSS-trick price table on edit, pre-filled overrides |
| `src/ui/templates/fields.ts` | New field definitions if needed |
| `src/ui/static/style.scss` | `:has()` rules for the package price section |
| `src/features/public/ticket-submit.ts` | Extend `TicketCtx` with `packagePrices`; substitute override `unitPrice` on member `CheckoutItem`s after `buildRegistrationItems` |
| `src/features/api/payment-processing.ts` | At revalidation: verify group still exists + membership + re-fetch current package prices; `price_changed` path on any mismatch |
| `src/features/public/pages.ts` | Partition groups into packages/regular; pass both to homepagePage |
| `src/ui/templates/public/homepage.tsx` (or equivalent) | "Packages" section above regular listings + individual listings |
| `src/features/admin/bulk-actions.ts` | Copy `is_package` + remap package prices when duplicating a group |
| `test/lib/groups.test.ts` | New DB-layer tests, compatibility enforcement tests |
| `test/lib/admin-groups.test.ts` | Create/edit form/route tests, membership change tests, bulk-duplicate tests, demo-override tests |
| `test/lib/checkout-pricing.test.ts` | Package price substitution, child-item scoping, TicketCtx map, metadata round-trip, revalidation tests |
| `test/lib/public-listings.test.ts` | Partition/sort render tests |
