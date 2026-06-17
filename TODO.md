# TODO: Make reservation deposits and modifiers compose correctly

## Problem

Reservation/deposit checkouts render add-on and promo-code controls on the public form, but `handlePaidPath` discards all modifiers whenever `reservationAmount` is present. Buyers can select add-ons or enter promo codes and have them silently ignored. Positive add-ons are not charged, discounts are not applied, and modifier stock is not consumed.

## Fix Shape

Either hide modifiers on reservation pages or fully support modifiers with reservations. The better fix is full support because the UI already exposes the controls and modifiers are part of the pricing model.

Modifiers should affect the full order total and the deposit/balance split consistently:

1. Positive add-ons and surcharges should be included in the amount charged now or clearly included in the remaining balance according to product rules.
2. Discounts should reduce the full order total before calculating the remaining balance.
3. Modifier usage should be recorded once the booking is successfully created.
4. The balance page should display a full order summary that matches what was charged and what remains.

## Implementation Steps

1. Decide and document the deposit rule for modifiers. Recommended rule: compute the final modified full order using `priceCheckout`, charge the reservation deposit against that modified full total, and store the remainder in `remaining_balance`.
2. Remove the `reservationAmount ? [] : await resolveModifiers(...)` branch in `src/features/public/ticket-submit.ts`.
3. Ensure `priceCheckout()` can price reservation deposits with modifiers exactly once and without double-counting booking fees.
4. Update webhook finalization in `src/features/api/webhooks.ts` so `remainingBalance` is based on the modified full total, not just the raw listing item sum.
5. Ensure `listing_attendees.price_paid` records the actual deposit allocated to each booking line, while extra modifier charges/discounts are represented in the order summary/balance model in a way that can be explained to users.
6. If the existing data model cannot represent modifier extras in `listing_attendees`, add a clear helper that computes remaining balance from the priced order rather than raw listing rows.
7. Ensure modifier stock/usage consumption runs for reservation checkouts after attendee creation and rolls back the attendee if stock is no longer available.
8. Update public templates only if product chooses to hide modifiers instead. If hiding, hide both `AddOnsFieldset` and `PromoCodeField` whenever the public default status is a reservation, and add tests proving the fields are absent.

## Tests

Required cases if supporting modifiers:

1. Reservation checkout with a positive optional add-on charges a deposit that includes the add-on according to the chosen rule.
2. Reservation checkout with a promo discount reduces the full order and remaining balance.
3. Reservation checkout with a stock-limited add-on consumes stock on completion.
4. Sold-out add-on during reservation finalization rolls back attendee creation and refunds/fails like paid full checkout.
5. Balance page displays full price, deposit paid, and remaining balance consistently after modifiers.

Run:

```bash
deno task test:files test/lib/server-reservation.test.ts test/lib/server-modifiers.test.ts test/lib/server-balance.test.ts test/lib/checkout-pricing.test.ts
deno task test:coverage
```

## Acceptance Criteria

Reservation form controls must match server behavior.

No selected add-on or promo code can be silently ignored.

Remaining balance must equal final full order total minus the amount actually charged up front.

# TODO: Use strict integer parsing for form and query values

## Problem

Several form/query helpers use `Number.parseInt` or `Number` directly, so values like `1abc` and `2x` can be accepted as IDs or quantities. The project already added a valibot-backed `parsePositiveIntId()` for strict decimal positive IDs, but newer shared helpers do not consistently use it.

## Fix Shape

Introduce shared strict parsers for the integer shapes the app needs, then replace lenient parsing at user-input boundaries. Do not blindly replace every `parseInt`, because some call sites parse hex, env vars, or trusted stored values.

## Implementation Steps

1. Extend `src/shared/validation/number.ts` with reusable schemas/helpers:
   - `parsePositiveIntId(value: string): number | null` for IDs, already present.
   - `parseNonNegativeInt(value: string): number | null` for quantities that allow zero.
   - `parsePositiveInt(value: string): number | null` for counts like day count or page numbers.
2. Decide whitespace behavior. Recommended: trim at the form helper layer, but schemas should validate the trimmed string as digits only.
3. Update `FormParams.getOptionalInt()` only if all callers are compatible with strict base-10 integer behavior. If not, add a new strict method and migrate call sites deliberately.
4. Update `FormParams.getNumberArray()` to drop only values that fail strict integer parsing, not values with trailing junk.
5. Update known user-input paths:
   - `src/shared/bulk-email-targets.ts` listing target parsing.
   - `src/features/admin/attendee-form-model.ts` quantity parsing.
   - Admin/public query params where IDs or quantities are currently parsed leniently.
6. Leave internal/trusted parse uses alone, such as hex parsing in IP validators, env parsing where loose defaults are intentional, and stored numeric strings where migration compatibility matters.
7. Add tests that encode the policy so future code does not regress to lenient parsing.

## Tests

Extend `test/lib/validation/number.test.ts`, `test/lib/form-data.test.ts`, and focused route/model tests.

Required cases:

1. `parsePositiveIntId("1abc")` rejects.
2. Form helpers reject or drop `1abc`, `2x`, `+1`, `1.5`, and exponent forms.
3. Valid `0` is accepted only by non-negative quantity parsers, not ID parsers.
4. Bulk email listing target rejects malformed IDs.
5. Attendee form quantity parsing rejects trailing junk.
6. Existing valid form submissions still pass.

Run:

```bash
deno task test:files test/lib/validation/number.test.ts test/lib/form-data.test.ts test/lib/attendee-form-model.test.ts test/lib/bulk-email.test.ts
deno task test:coverage
```

## Acceptance Criteria

User-controlled IDs and quantities must not accept trailing junk.

The app should use valibot-backed shared number validators instead of ad hoc parse-and-check logic at form/query boundaries.

The change must not break intentional non-decimal parsing or trusted stored-value parsing.
