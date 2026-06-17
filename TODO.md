# TODO: Allocate flat reservation deposits exactly across quantities

## Problem

Flat reservation deposits are divided into a per-unit amount with `Math.round(flat / totalQuantity)` and then multiplied back by quantity. For a `10` currency-unit deposit across 3 tickets, checkout charges 999 minor units, while the intended order-level deposit is 1000 minor units.

The mismatch affects the charged amount, webhook validation, and stored remaining balance.

## Fix Shape

Stop calculating flat order deposits as an independently rounded per-unit value. Instead, calculate the exact order-level deposit once, then allocate that total across checkout lines/units so the sum of charged line amounts equals the intended deposit exactly.

## Implementation Steps

1. Keep `computeReservationDeposit(raw, fullPriceMinor, totalQuantity)` as the source of truth for the order-level deposit.
2. Add an allocation helper in `src/shared/reservation-amount.ts` that distributes an order-level deposit across items or units.
3. The allocation should be deterministic and exact:
   - Total allocated amount must equal `computeReservationDeposit(...)`.
   - No unit or line allocation should exceed its full price.
   - Remainder cents should be assigned predictably, for example to earlier units/lines after proportional floor allocation.
4. Update `chargeUnitAmount()` only if per-unit provider lines can still represent the exact allocation. If exact allocation requires split lines, update `priceCheckout()` to produce line-level charged amounts rather than relying solely on one charged unit amount per original item.
5. Update webhook deposit recomputation to use the same allocation helper as checkout. Do not maintain separate math in checkout and webhook paths.
6. Preserve percent and per-item semantics while fixing flat order semantics.
7. Ensure booking fee behavior remains intentional. If booking fees are charged on the full order, tests should assert this.

## Tests

Add tests in `test/lib/reservation-amount.test.ts`, `test/lib/booking-fee.test.ts`, and `test/lib/checkout-pricing.test.ts`.

Required cases:

1. Flat `10` across 3 equal tickets charges exactly 1000 minor units total.
2. Flat `10.01` across 3 tickets charges exactly 1001 minor units total.
3. Flat deposit larger than full order clamps to the full order total.
4. Mixed quantities and mixed item prices allocate exactly and do not exceed line prices.
5. Webhook recomputation returns the same per-line deposit totals as checkout.
6. Percent and per-item reservation amounts preserve existing behavior.

Run:

```bash
deno task test:files test/lib/reservation-amount.test.ts test/lib/booking-fee.test.ts test/lib/checkout-pricing.test.ts test/lib/server-reservation.test.ts
deno task test:coverage
```

## Acceptance Criteria

For every reservation checkout, sum of charged line amounts must equal the intended deposit exactly.

Checkout and webhook must use the same allocation helper.

Remaining balance must equal full order amount minus actual amount paid.
