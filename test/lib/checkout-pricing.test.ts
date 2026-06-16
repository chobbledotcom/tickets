import { expect } from "@std/expect";
import { describe } from "@std/testing/bdd";
import { priceCheckout } from "#shared/checkout-pricing.ts";
import type { CheckoutIntent, CheckoutItem } from "#shared/payments.ts";
import { testWithSetting } from "#test-utils";

/** Build a CheckoutIntent around the given items (and optional overrides). */
const intentWith = (
  items: CheckoutItem[],
  overrides: Partial<CheckoutIntent> = {},
): CheckoutIntent => ({
  address: "",
  date: null,
  email: "buyer@example.com",
  items,
  name: "Buyer",
  phone: "",
  special_instructions: "",
  ...overrides,
});

const item = (overrides: Partial<CheckoutItem> = {}): CheckoutItem => ({
  listingId: 1,
  name: "General",
  quantity: 1,
  slug: "general",
  unitPrice: 1000,
  ...overrides,
});

describe("priceCheckout", () => {
  testWithSetting(
    "prices ticket lines at the full unit price",
    { booking_fee: "0" },
    () => {
      const order = priceCheckout(intentWith([item({ quantity: 2 })]));
      expect(order.lines).toHaveLength(1);
      expect(order.lines[0]!.chargedUnitAmount).toBe(1000);
      expect(order.extras).toEqual([]);
      expect(order.fullSubtotal).toBe(2000);
      expect(order.total).toBe(2000);
    },
  );

  testWithSetting(
    "charges the per-unit deposit for a reservation",
    { booking_fee: "0" },
    () => {
      // 10% of a £10 ticket = £1 charged per unit; total is the deposit only.
      const order = priceCheckout(
        intentWith([item({ quantity: 2 })], { reservationAmount: "10%" }),
      );
      expect(order.lines[0]!.chargedUnitAmount).toBe(100);
      expect(order.total).toBe(200);
    },
  );

  testWithSetting(
    "adds a booking-fee extra line on top of the ticket total",
    { booking_fee: "5" },
    () => {
      const order = priceCheckout(intentWith([item({ quantity: 2 })]));
      // 5% of the £20 subtotal = £1 fee, as a single extra line.
      expect(order.extras).toEqual([
        { amount: 100, key: "fee", name: "Booking fee", quantity: 1 },
      ]);
      expect(order.total).toBe(2100);
    },
  );

  testWithSetting(
    "omits the fee extra when the booking fee is zero",
    { booking_fee: "0" },
    () => {
      const order = priceCheckout(intentWith([item()]));
      expect(order.extras).toEqual([]);
      expect(order.total).toBe(1000);
    },
  );

  testWithSetting(
    "charges the fee on the feeSubtotal override, not the deposit",
    { booking_fee: "5" },
    () => {
      // A reservation pays a deposit but the fee is charged on the full order
      // (feeSubtotal override), so the fee line stays at 5% of £20 = £1.
      const order = priceCheckout(
        intentWith([item({ quantity: 2 })], {
          feeSubtotal: 2000,
          reservationAmount: "10%",
        }),
      );
      expect(order.lines[0]!.chargedUnitAmount).toBe(100);
      expect(order.fullSubtotal).toBe(2000);
      expect(order.extras[0]!.amount).toBe(100);
      // Deposit (2 × £1) + fee (£1) = £3.
      expect(order.total).toBe(300);
    },
  );

  testWithSetting(
    "sums charges across multiple ticket lines",
    { booking_fee: "0" },
    () => {
      const order = priceCheckout(
        intentWith([
          item({ listingId: 1, quantity: 2, unitPrice: 1000 }),
          item({ listingId: 2, quantity: 1, slug: "vip", unitPrice: 2500 }),
        ]),
      );
      expect(order.total).toBe(4500);
    },
  );
});
