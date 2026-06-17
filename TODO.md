# TODO: Record actual charged modifier amounts in usage ledger

## Problem

Modifier usage records currently store `amountApplied` as `Math.abs(modifierDelta(fullTotal, ...))`. That is wrong for scoped modifiers because checkout pricing applies the modifier to the in-scope subtotal, not the full order. It is also wrong for multi-quantity positive add-ons because checkout charges `delta * quantity` while the ledger records only one `delta`.

Admin `total_revenue` is maintained from `modifier_usages.amount_applied`, so reporting is incorrect.

## Fix Shape

The usage ledger should store the actual amount each modifier changed the checkout by, using the same pricing engine result that produced provider charges.

## Implementation Steps

1. Extend `applyModifiers()` or `priceCheckout()` to return per-modifier application details in addition to aggregate totals.
2. Each detail should include:
   - `modifierId`
   - `quantity`
   - signed or absolute applied amount, with a clear convention
   - scoped subtotal used for calculation if useful for debugging
3. Prefer storing a positive absolute amount in `modifier_usages.amount_applied` only if the admin UI labels it as revenue/impact correctly. If discounts should not count as revenue, rename the displayed concept or store signed amounts with a migration.
4. Update `createAttendeeForSession()` in `src/features/api/webhooks.ts` to call `consumeModifierStock()` with the actual applied amount for each modifier, not a recomputed whole-order delta.
5. Update promo-code activity logging to use the same actual applied amount and scope-aware calculation.
6. Ensure the data model remains compatible with existing rows. If changing sign semantics, add a migration/backfill and update trigger comments/tests.
7. Avoid duplicating modifier math in webhook code. The pricing engine should be the single source of truth.

## Tests

Add tests in `test/lib/checkout-pricing.test.ts`, `test/lib/db/modifier-usage.test.ts`, `test/lib/db/modifier-aggregates.test.ts`, and `test/lib/server-webhooks.test.ts`.

Required cases:

1. Listing-scoped 10 percent modifier on a mixed cart records the in-scope amount, not the full cart amount.
2. Group-scoped modifier records only the amount applied to listings in that group.
3. Quantity 3 fixed add-on records three times the fixed amount.
4. Promo-code activity log reports the same amount that was charged or discounted.
5. Aggregate trigger totals match the ledger after insert, update, and delete.

Run:

```bash
deno task test:files test/lib/checkout-pricing.test.ts test/lib/db/modifier-usage.test.ts test/lib/db/modifier-aggregates.test.ts test/lib/server-webhooks.test.ts
deno task test:coverage
```

## Acceptance Criteria

Modifier reporting must match provider charge math exactly.

There should be no separate whole-order recomputation in webhook finalization.

Scoped and quantity-based modifiers must be accurately represented in `modifier_usages` and admin aggregate columns.
