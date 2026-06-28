# Plan: Groups as Packages

## What we're building

Two new boolean+data fields on groups:
- **`is_package`** — marks a group as a bookable package
- **Package price overrides** — a per-listing price table stored separately, shown/hidden via the CSS input trick when `is_package` is checked on the edit form

Packages show above regular listings on the `/calculate` page and public group listings.

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

Migration goes in `src/shared/db/migrations/schema.ts` with a new schema version string.

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
- `setGroupPackagePrices(groupId: number, prices: Array<{listingId: number; price: number}>, tx: TxScope): Promise<void>` — deletes existing rows for this group and inserts the new set (batched inside the same transaction as the group update)

Updates:
- `createGroup` / `updateGroup` — accept and persist `is_package` and `packagePrices`. Price writes go in the same `withTransaction` as the group row, using `setGroupPackagePrices`.
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

Styles go in `src/ui/static/style.scss` alongside the existing embed-toggle block.

---

## 5. Admin route handler (`src/features/admin/groups.ts`)

Edit handler parses:
- `is_package` checkbox (present = true, absent = false)
- `package_price_<listing_id>` inputs for each listing in the group

Validation:
- Each price input must be a non-negative integer when `is_package` is true
- Listings must all belong to this group (prevent form-forged listing IDs)

---

## 6. Pricing integration

**Where**: `src/shared/checkout-pricing.ts` and the public ticket-submit handler.

**How**: When pricing a group booking, if the group `is_package`, load `getGroupPackagePrices` and substitute the override price for any listing that has one — replacing the listing's `unit_price` before it enters `priceCheckout`. No change to `priceCheckout` itself; the substitution happens at the item-preparation layer in `ticket-submit.ts`.

This keeps the pricing engine generic and the package logic localised to where items are assembled.

---

## 7. `/calculate` page — packages above regular listings

The calculate page currently shows a `POST /calculate/:slug` price quote. The "show packages above regular listings" request applies to wherever available groups/listings are listed publicly (the public listings or group index page).

Changes:
- In the public listings/groups query, fetch groups ordered by `is_package DESC, name ASC` so packages float to the top
- Render a "Packages" heading section above "Individual listings" when at least one package exists
- The group public page for a package group shows the per-item package prices (not listing base prices) in the quantity/price display

---

## 8. Tests

Each layer needs full coverage:
- **Migration**: schema version string change, new column/table existence
- **DB layer**: `getGroupPackagePrices`, `setGroupPackagePrices` (create/update/replace), group encode/decode with `is_package`
- **Admin form**: POST with `is_package=on` + price inputs saves correctly; POST without saves `is_package=false` and clears prices; invalid (non-integer) price input returns 400
- **Pricing**: booking a package group uses override prices; booking a non-package group uses listing base prices; missing override falls back to listing base price
- **Public listing order**: packages sort above non-packages

---

## File change summary

| File | What changes |
|---|---|
| `src/shared/db/migrations/schema.ts` | New schema version, `is_package` column, `group_package_prices` table |
| `src/shared/types.ts` | `Group.is_package`, `GroupPackagePrice`, updated `GroupInput` |
| `src/shared/db/groups.ts` | New price functions, encode/decode updates, create/update handlers |
| `src/features/admin/groups.ts` | Parse + validate new form fields |
| `src/ui/templates/admin/groups.tsx` | `is_package` checkbox, CSS-trick price table |
| `src/ui/templates/fields.ts` | New field definitions if needed |
| `src/ui/static/style.scss` | `:has()` rules for the package price section |
| `src/features/public/ticket-submit.ts` | Substitute package prices before `priceCheckout` |
| `src/features/public/groups.ts` | Order packages first in listing query |
| `src/ui/templates/public/groups.tsx` or listings | "Packages" section above regular listings |
| `test/lib/groups.test.ts` | New DB-layer tests |
| `test/lib/admin-groups.test.ts` | New form/route tests |
| `test/lib/checkout-pricing.test.ts` | Package price substitution tests |
