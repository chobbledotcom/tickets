# Plan: Groups as Packages

## What we're building

Two new boolean+data fields on groups:
- **`is_package`** — marks a group as a bookable package
- **Package price overrides** — a per-listing price table stored separately, shown/hidden via the CSS input trick when `is_package` is checked on the edit form

Packages show above regular listings on the public group/listings page.

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

**Migration**: add a new named migration file (e.g. `src/shared/db/migrations/add-group-packages.ts`) with the `ALTER TABLE` and `CREATE TABLE` statements, import it into `src/shared/db/migrations.ts`, and update the schema version string in `src/shared/db/migrations/schema.ts`. A schema-hash change with no corresponding `MIGRATIONS` entry causes deployed instances to fail to boot.

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
- `setGroupPackagePrices(groupId: number, prices: Array<{listingId: number; price: number}>, tx: TxScope): Promise<void>` — deletes existing rows for this group and inserts the new set, batched inside the same transaction as the group row write

Updates:
- Group decode — add `is_package: row.is_package === 1`.

---

## 4. Admin form — CSS input trick (`src/ui/templates/admin/groups.tsx` + `fields.ts`)

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

**Restriction**: `is_package` is only permitted on groups whose listings are all fixed-price (not customisable-day). Groups already enforce that all listings share `customisable_days`; the admin POST handler should reject enabling `is_package` when that flag is set, since customisable-day pricing derives from `dayPriceFor()` rather than `unit_price` and a flat per-listing override cannot apply meaningfully.

---

## 5. Admin route handler (`src/features/admin/groups.ts`)

The current group admin routes go through `defineNamedResource(... table: groupsTable ...)` and `defineCrudApi(... table: groupsTable ...)`. These generic paths write only the `groups` row and know nothing about `group_package_prices`. Both the admin form POST and the JSON API PUT must be replaced or wrapped with custom handlers that:

1. Write the `groups` row and `group_package_prices` rows in a single `withTransaction`
2. Use `setGroupPackagePrices` inside that transaction

Edit handler parses:
- `is_package` checkbox (present = true, absent = false)
- `package_price_<listing_id>` inputs for each listing in the group

Validation:
- Each price input must be a non-negative integer when `is_package` is true
- Listings must all belong to this group (prevent form-forged listing IDs)
- Reject `is_package=true` when the group's listings have `customisable_days` set

---

## 6. Pricing integration

**Where**: `src/features/public/ticket-submit.ts` and `src/features/api/payment-processing.ts`.

**Item preparation** (`ticket-submit.ts`): When building `CheckoutItem`s for a package group, load `getGroupPackagePrices` and replace each `CheckoutItem.unitPrice` with the override value after day-count pricing would have applied — i.e. override the final `CheckoutItem.unitPrice` directly, not the source `listing.unit_price`. This means the substitution must happen on the assembled `CheckoutItem`, not on the listing record, so it naturally covers the payment path too.

**Payment revalidation** (`payment-processing.ts`): `validateAndPrice` and `paidPricingRefund` re-derive prices from listings to detect tampered metadata. If package overrides are applied only in `ticket-submit.ts` but not here, legitimate package sessions will be classified as price changes and refunded. To avoid this, the group's `is_package` flag and the applicable `group_package_prices` must be carried through the signed checkout metadata and re-applied during payment completion so revalidation sees the same prices as the original quote.

This keeps `priceCheckout` itself generic; the substitution layer wraps item assembly on both the booking and payment sides.

---

## 7. Public page — packages above regular listings

The current public homepage/listings renderer emits every group card before every listing card. Just re-ordering the groups SQL query is insufficient because `groups.name` is encrypted and cannot be sorted in SQL (ciphertext order is meaningless), and non-package groups would still appear above individual listings.

Changes:
- Load and decrypt all public groups in application code (already done via the entity cache)
- Partition the groups array into `packageGroups` and `regularGroups` in TypeScript after decryption
- Sort each partition by decrypted `name` in TypeScript
- Render `packageGroups` cards under a "Packages" heading, then `regularGroups` cards and individual listing cards together (or under their own heading) — so packages genuinely float above everything else
- The group public page for a package group shows per-item package prices in the quantity/price display (not listing base prices)

---

## 8. Bulk-duplicate path (`src/features/admin/bulk-actions.ts`)

The group duplicate action creates a new group and clones its listings outside the CRUD edit route. It must also:
- Copy `is_package` from the source group
- Load `getGroupPackagePrices` for the source group and insert remapped rows for the newly cloned listing IDs via `setGroupPackagePrices`

All in the same transaction as the duplicate write.

---

## 9. Tests

Each layer needs full coverage:
- **Migration**: new column/table existence, schema version string
- **DB layer**: `getGroupPackagePrices`, `setGroupPackagePrices` (create/update/replace), group encode/decode with `is_package`
- **Admin form GET**: custom loader passes listings + existing package prices to the template
- **Admin form POST**: `is_package=on` + price inputs saves correctly; POST without saves `is_package=false` and clears prices; invalid (non-integer) price input returns 400; customisable-day group rejects `is_package=true`
- **Pricing — item assembly**: package group substitutes override `unitPrice` on `CheckoutItem`; non-package group uses listing base prices
- **Pricing — payment revalidation**: revalidation re-derives the same override prices from signed metadata, does not misclassify as a price change
- **Public listing render**: package groups appear before non-package groups and individual listings; sorted by decrypted name within each partition
- **Bulk duplicate**: duplicated package group preserves `is_package` and remaps package prices to cloned listing IDs

---

## File change summary

| File | What changes |
|---|---|
| `src/shared/db/migrations/add-group-packages.ts` | New migration: `is_package` column, `group_package_prices` table |
| `src/shared/db/migrations.ts` | Import + register new migration |
| `src/shared/db/migrations/schema.ts` | Updated schema version string |
| `src/shared/types.ts` | `Group.is_package`, `GroupPackagePrice`, updated `GroupInput` |
| `src/shared/db/groups.ts` | `getGroupPackagePrices`, `setGroupPackagePrices`, decode update |
| `src/features/admin/groups.ts` | Replace generic CRUD handlers with custom GET loader + POST that writes both tables in one transaction; JSON API PUT likewise |
| `src/ui/templates/admin/groups.tsx` | `is_package` checkbox, CSS-trick price table, pre-filled overrides |
| `src/ui/templates/fields.ts` | New field definitions if needed |
| `src/ui/static/style.scss` | `:has()` rules for the package price section |
| `src/features/public/ticket-submit.ts` | Substitute package prices on assembled `CheckoutItem`s |
| `src/features/api/payment-processing.ts` | Re-apply package prices during revalidation from signed metadata |
| `src/features/public/groups.ts` | Partition + sort groups in application code; pass to template |
| `src/ui/templates/public/groups.tsx` or listings | "Packages" section above regular listings + individual listings |
| `src/features/admin/bulk-actions.ts` | Copy `is_package` + remap package prices when duplicating a group |
| `test/lib/groups.test.ts` | New DB-layer tests |
| `test/lib/admin-groups.test.ts` | New form/route + bulk-duplicate tests |
| `test/lib/checkout-pricing.test.ts` | Package price substitution + revalidation tests |
| `test/lib/public-listings.test.ts` | Partition/sort render tests |
