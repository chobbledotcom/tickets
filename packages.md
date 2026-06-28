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
- The group edit POST handler (when enabling `is_package`)

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
- On the **create form** there is no override-prices section (no listings yet); `is_package` checkbox is shown but the price table is only available after creation

The generic edit GET route (currently `createCrudHandlers`) must be replaced with a custom loader for groups that additionally calls `getListingsByGroupId` and `getGroupPackagePrices`, so the edit page can render the listings table and pre-fill any existing price overrides.

Styles go in `src/ui/static/style.scss` alongside the existing embed-toggle block.

---

## 6. Admin route handler (`src/features/admin/groups.ts`)

The current group admin routes go through `defineNamedResource(... table: groupsTable ...)` and `defineCrudApi(... table: groupsTable ...)`. These generic paths write only the `groups` row and know nothing about `group_package_prices`. Both the admin form POST and the JSON API PUT must be replaced or wrapped with custom handlers that:

1. Write the `groups` row and `group_package_prices` rows in a single `withTransaction` using `setGroupPackagePrices`
2. Enforce the package compatibility checks (§4) when `is_package` is true

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

## 8. Pricing integration

**Where**: `src/features/public/ticket-submit.ts` and `src/features/api/payment-processing.ts`.

**Item assembly** (`ticket-submit.ts`): When building `CheckoutItem`s for a package group, load `getGroupPackagePrices` and replace the `unitPrice` on each assembled `CheckoutItem` whose `listingId` is in the package price map. The override is applied **after** `buildRegistrationItems` returns — scoped to the package group's member listing IDs only, so folded child add-ons (added by `foldSelectedChildren` for required child listings) are left on their own pricing and not overwritten.

**Payment revalidation** (`payment-processing.ts`): Carry the `groupId` in the signed checkout metadata. During revalidation (`validateAndPrice`, `paidPricingRefund`), fetch current `group_package_prices` for that group from the database and re-apply them the same way as the original quote. This means if an operator edits package prices while a customer is paying, revalidation detects the change and triggers the existing `price_changed` refund path — the same behaviour as a listing price edit. Do not embed the price values themselves in metadata; always re-fetch from the DB at revalidation time.

---

## 9. `/listings` page — packages above regular listings

The public `/listings` page is assembled by `handlePublicListings` in `src/features/public/pages.ts` and rendered with the `homepagePage` template. The file `src/features/public/groups.ts` handles group booking pages (different concern).

Changes to `pages.ts` and `homepagePage`:
- After loading and decrypting all public groups via the entity cache, partition them into `packageGroups` and `regularGroups` in TypeScript (sort each by decrypted `name`)
- Render `packageGroups` under a "Packages" heading first, then `regularGroups` and individual listing cards together
- The group public page for a package group shows per-item package prices in the quantity/price display (not listing base prices)

---

## 10. Bulk-duplicate path (`src/features/admin/bulk-actions.ts`)

The group duplicate action creates a new group and clones its listings outside the CRUD edit route. It must also:
- Copy `is_package` from the source group
- Load `getGroupPackagePrices` for the source group and insert remapped rows for the newly cloned listing IDs via `setGroupPackagePrices`

All in the same transaction as the duplicate write.

---

## 11. Tests

Each layer needs full coverage:
- **Migration**: new column/table existence in both upgraded and fresh-install schema; `SCHEMA_TABLE_NAMES` includes `group_package_prices`
- **DB layer**: `getGroupPackagePrices`, `setGroupPackagePrices` (create/update/replace with multi-row INSERT), `deleteGroupPackagePricesForListing`; group encode/decode with `is_package`
- **Compatibility enforcement**: `validateListingTypesForGroup` rejects customisable-day and can-pay-more listings for package groups; same rejection in listing create/edit paths
- **Admin form GET**: custom loader passes listings + existing package prices to the template
- **Admin form POST**: `is_package=on` + price inputs saves correctly; POST without saves `is_package=false` and clears prices; invalid price input returns 400; incompatible listing types reject `is_package=true`
- **Membership change**: listing delete removes price rows; listing group reassignment removes price rows; add-listings to package group leaves missing rows (no crash, blank on next edit)
- **Pricing — item assembly**: package group substitutes override `unitPrice` on member `CheckoutItem`s; folded child items are NOT overridden; non-package group uses listing base prices
- **Pricing — payment revalidation**: revalidation re-fetches current package prices via group ID in metadata; a package price edit between quote and payment triggers `price_changed` refund
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
| `src/shared/db/listings.ts` or groups | `validateListingTypesForGroup` extended to check customisable_days + can_pay_more for package groups |
| `src/features/admin/groups.ts` | Replace generic CRUD handlers with custom GET loader + POST that writes both tables in one transaction; JSON API PUT likewise |
| `src/features/admin/listings.ts` | Listing delete/reassign path calls `deleteGroupPackagePricesForListing` |
| `src/ui/templates/admin/groups.tsx` | `is_package` checkbox, CSS-trick price table, pre-filled overrides |
| `src/ui/templates/fields.ts` | New field definitions if needed |
| `src/ui/static/style.scss` | `:has()` rules for the package price section |
| `src/features/public/ticket-submit.ts` | Substitute package prices on member `CheckoutItem`s after `buildRegistrationItems`; carry groupId in signed metadata |
| `src/features/api/payment-processing.ts` | Re-fetch current package prices via groupId in metadata during revalidation |
| `src/features/public/pages.ts` | Partition groups into packages/regular; pass both to homepagePage |
| `src/ui/templates/public/homepage.tsx` (or equivalent) | "Packages" section above regular listings + individual listings |
| `src/features/admin/bulk-actions.ts` | Copy `is_package` + remap package prices when duplicating a group |
| `test/lib/groups.test.ts` | New DB-layer tests, compatibility enforcement tests |
| `test/lib/admin-groups.test.ts` | Form/route tests, membership change tests, bulk-duplicate tests |
| `test/lib/checkout-pricing.test.ts` | Package price substitution, child-item scoping, revalidation tests |
| `test/lib/public-listings.test.ts` | Partition/sort render tests |
