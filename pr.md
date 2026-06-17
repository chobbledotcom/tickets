## Summary

Fix modifier usage reporting so `modifier_usages.amount_applied` records the actual amount the checkout pricing engine applied, instead of recomputing modifier impact from the whole order subtotal during webhook finalization.

## Changes

- Adds per-modifier application details to checkout pricing, including:
  - modifier id
  - quantity
  - absolute amount applied
  - signed checkout delta
  - scoped subtotal
- Uses `priceCheckout()` as the single source of truth for webhook modifier ledger entries.
- Updates promo-code activity logging to use the same signed applied delta that affected the provider charge.
- Correctly records scoped modifier amounts for listing- and group-scoped modifiers.
- Correctly records multi-quantity fixed add-ons as `delta * quantity`.
- Keeps existing positive `amount_applied` ledger semantics for aggregate/reporting compatibility.
- Adds coverage for scoped modifiers, quantity-based add-ons, promo-code logging, stock consumption, and modifier aggregate trigger behavior.

## Testing

- `nix develop -c deno task test:files test/lib/checkout-pricing.test.ts test/lib/db/modifier-usage.test.ts test/lib/db/modifier-aggregates.test.ts test/lib/server-webhooks.test.ts`
