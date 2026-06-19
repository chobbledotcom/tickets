import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  allocateDiscount,
  applyModifiers,
  type PricedLine,
  priceCheckout,
} from "#shared/checkout-pricing.ts";
import type {
  CheckoutIntent,
  CheckoutItem,
  ModifierSpec,
} from "#shared/payments.ts";
import { testWithSetting } from "#test-utils";

const modifier = (overrides: Partial<ModifierSpec> = {}): ModifierSpec => ({
  id: 1,
  kind: "fixed",
  listingIds: null,
  name: "Add-on",
  quantity: 1,
  trigger: "automatic",
  value: 500,
  ...overrides,
});

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

const line = (overrides: Partial<PricedLine> = {}): PricedLine => ({
  chargedUnitAmount: 1000,
  item: item(),
  quantity: 1,
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

  testWithSetting(
    "adds an additive modifier as an extra line before the fee",
    { booking_fee: "10" },
    () => {
      const order = priceCheckout(
        intentWith([item({ quantity: 2 })], {
          modifiers: [modifier({ kind: "fixed", name: "Parking", value: 500 })],
        }),
      );
      // Tickets 2 × £10 = £20; +£5 parking; fee is 10% of (£20 + £5) = £2.50.
      expect(order.extras).toEqual([
        { amount: 500, key: "mod:1", name: "Parking", quantity: 1 },
        { amount: 250, key: "fee", name: "Booking fee", quantity: 1 },
      ]);
      expect(order.fullSubtotal).toBe(2500);
      expect(order.total).toBe(2750);
    },
  );

  testWithSetting(
    "applies a discount and charges the fee on the reduced subtotal",
    { booking_fee: "10" },
    () => {
      // £20 order, 10% discount → £18; fee is 10% of £18 = £1.80.
      const order = priceCheckout(
        intentWith([item({ quantity: 2 })], {
          modifiers: [modifier({ kind: "percent", value: -10 })],
        }),
      );
      expect(order.lines).toEqual([
        { chargedUnitAmount: 900, item: item({ quantity: 2 }), quantity: 2 },
      ]);
      expect(order.fullSubtotal).toBe(1800);
      expect(order.extras).toEqual([
        { amount: 180, key: "fee", name: "Booking fee", quantity: 1 },
      ]);
      expect(order.total).toBe(1980);
    },
  );

  testWithSetting(
    "splits a line when a discount lands unevenly across its units",
    { booking_fee: "0" },
    () => {
      // £5 off £30 (3 × £10): 100 minor units over 3 units → 34/33/33.
      const order = priceCheckout(
        intentWith([item({ quantity: 3 })], {
          modifiers: [modifier({ kind: "fixed", value: -100 })],
        }),
      );
      expect(order.lines).toEqual([
        { chargedUnitAmount: 967, item: item({ quantity: 3 }), quantity: 2 },
        { chargedUnitAmount: 966, item: item({ quantity: 3 }), quantity: 1 },
      ]);
      // No pennies lost: 967×2 + 966 = 2900 = 3000 − 100.
      expect(order.total).toBe(2900);
    },
  );
});

describe("applyModifiers", () => {
  const lines: PricedLine[] = [
    line({
      chargedUnitAmount: 1000,
      item: item({ listingId: 1 }),
      quantity: 2,
    }),
    line({
      chargedUnitAmount: 2500,
      item: item({ listingId: 2, slug: "vip" }),
      quantity: 1,
    }),
  ];

  test("charges a percentage on the whole-order subtotal", () => {
    // 10% of (£20 + £25) = £4.50.
    const result = applyModifiers(lines, [
      modifier({ kind: "percent", listingIds: null, value: 10 }),
    ]);
    expect(result.extras).toEqual([
      { amount: 450, key: "mod:1", name: "Add-on", quantity: 1 },
    ]);
    expect(result.modifierTotal).toBe(450);
  });

  test("scopes a percentage to only the listed items", () => {
    // 10% of listing 1's £20 only = £2.
    const result = applyModifiers(lines, [
      modifier({ kind: "percent", listingIds: [1], value: 10 }),
    ]);
    expect(result.extras[0]!.amount).toBe(200);
    expect(result.modifierTotal).toBe(200);
  });

  test("multiplies a fixed add-on by its quantity in the total", () => {
    const result = applyModifiers(lines, [
      modifier({ kind: "fixed", quantity: 3, value: 500 }),
    ]);
    // Line shows £5 × 3; the contributed total is £15.
    expect(result.extras[0]).toEqual({
      amount: 500,
      key: "mod:1",
      name: "Add-on",
      quantity: 3,
    });
    expect(result.modifierTotal).toBe(1500);
  });

  test("multiplies a fixed discount by its quantity", () => {
    const result = applyModifiers(lines, [
      modifier({ kind: "fixed", quantity: 3, value: -500 }),
    ]);

    expect(result.lines).toEqual([
      { chargedUnitAmount: 667, item: item({ listingId: 1 }), quantity: 2 },
      {
        chargedUnitAmount: 1666,
        item: item({ listingId: 2, slug: "vip" }),
        quantity: 1,
      },
    ]);
    expect(result.modifierTotal).toBe(-1500);
  });

  test("multiplies a percent discount by its quantity", () => {
    const result = applyModifiers(lines, [
      modifier({ kind: "percent", quantity: 3, value: -10 }),
    ]);

    // Quantity 3 of a 10% discount applies 30% of the original subtotal.
    expect(result.modifierTotal).toBe(-1350);
    expect(result.lines).toEqual([
      { chargedUnitAmount: 700, item: item({ listingId: 1 }), quantity: 2 },
      {
        chargedUnitAmount: 1750,
        item: item({ listingId: 2, slug: "vip" }),
        quantity: 1,
      },
    ]);
  });

  test("clamps multiplied discounts so no charged unit goes negative", () => {
    const result = applyModifiers(lines, [
      modifier({ kind: "percent", quantity: 3, value: -50 }),
    ]);

    expect(result.lines).toEqual([
      { chargedUnitAmount: 0, item: item({ listingId: 1 }), quantity: 2 },
      {
        chargedUnitAmount: 0,
        item: item({ listingId: 2, slug: "vip" }),
        quantity: 1,
      },
    ]);
    expect(result.modifierTotal).toBe(-4500);
  });

  test("treats a zero-delta modifier as a no-op", () => {
    const result = applyModifiers(lines, [
      modifier({ kind: "percent", value: 0 }),
    ]);
    expect(result.extras).toEqual([]);
    expect(result.lines).toEqual(lines);
    expect(result.modifierTotal).toBe(0);
  });

  test("reduces only the in-scope lines for a scoped discount", () => {
    const result = applyModifiers(lines, [
      modifier({ kind: "percent", listingIds: [1], value: -10 }),
    ]);
    // £2 off listing 1's two units (£20) → £9 each; listing 2 untouched.
    expect(result.lines).toEqual([
      { chargedUnitAmount: 900, item: item({ listingId: 1 }), quantity: 2 },
      {
        chargedUnitAmount: 2500,
        item: item({ listingId: 2, slug: "vip" }),
        quantity: 1,
      },
    ]);
    expect(result.modifierTotal).toBe(-200);
  });
});

describe("allocateDiscount", () => {
  test("is a no-op for a zero amount", () => {
    expect(allocateDiscount([100, 200], 0)).toEqual([100, 200]);
  });

  test("is a no-op when there is nothing to discount", () => {
    expect(allocateDiscount([0, 0], 50)).toEqual([0, 0]);
  });

  test("removes exactly the discount, proportionally", () => {
    expect(allocateDiscount([1000, 1000, 2500], 450)).toEqual([900, 900, 2250]);
  });

  test("hands leftover minor units to the largest remainders", () => {
    // 100 over three equal units: 34/33/33, the extra penny to the first.
    expect(allocateDiscount([1000, 1000, 1000], 100)).toEqual([966, 967, 967]);
  });

  test("clamps a discount larger than the total to zero", () => {
    expect(allocateDiscount([100, 100], 500)).toEqual([0, 0]);
  });
});
