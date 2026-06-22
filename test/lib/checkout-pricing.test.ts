import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  allocateDiscount,
  applyModifiers,
  lineListPrice,
  type PricedLine,
  priceCheckout,
  ticketPaymentBreakdown,
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
    "splits flat reservation lines so 10 across 3 tickets charges exactly 1000",
    { booking_fee: "0", currency: "GBP" },
    () => {
      const order = priceCheckout(
        intentWith([item({ quantity: 3 })], { reservationAmount: "10" }),
      );
      expect(order.lines).toEqual([
        { chargedUnitAmount: 334, item: item({ quantity: 3 }), quantity: 1 },
        { chargedUnitAmount: 333, item: item({ quantity: 3 }), quantity: 2 },
      ]);
      expect(order.total).toBe(1000);
    },
  );

  testWithSetting(
    "splits flat reservation lines so 10.01 across 3 tickets charges exactly 1001",
    { booking_fee: "0", currency: "GBP" },
    () => {
      const order = priceCheckout(
        intentWith([item({ quantity: 3 })], { reservationAmount: "10.01" }),
      );
      expect(order.lines).toEqual([
        { chargedUnitAmount: 334, item: item({ quantity: 3 }), quantity: 2 },
        { chargedUnitAmount: 333, item: item({ quantity: 3 }), quantity: 1 },
      ]);
      expect(order.total).toBe(1001);
    },
  );

  testWithSetting(
    "clamps an oversized flat reservation deposit to the full order total",
    { booking_fee: "0", currency: "GBP" },
    () => {
      const order = priceCheckout(
        intentWith([item({ quantity: 2, unitPrice: 300 })], {
          reservationAmount: "100",
        }),
      );
      expect(order.lines).toEqual([
        {
          chargedUnitAmount: 300,
          item: item({ quantity: 2, unitPrice: 300 }),
          quantity: 2,
        },
      ]);
      expect(order.total).toBe(600);
    },
  );

  testWithSetting(
    "allocates mixed flat reservation items exactly without exceeding line prices",
    { booking_fee: "0", currency: "GBP" },
    () => {
      const general = item({ listingId: 1, quantity: 2, unitPrice: 1000 });
      const vip = item({
        listingId: 2,
        name: "VIP",
        quantity: 1,
        slug: "vip",
        unitPrice: 2500,
      });
      const cheap = item({
        listingId: 3,
        name: "Cheap",
        quantity: 3,
        slug: "cheap",
        unitPrice: 500,
      });
      const order = priceCheckout(
        intentWith([general, vip, cheap], { reservationAmount: "10" }),
      );
      expect(order.lines).toEqual([
        { chargedUnitAmount: 167, item: general, quantity: 2 },
        { chargedUnitAmount: 417, item: vip, quantity: 1 },
        { chargedUnitAmount: 83, item: cheap, quantity: 3 },
      ]);
      expect(order.total).toBe(1000);
      for (const line of order.lines) {
        expect(line.chargedUnitAmount).toBeLessThanOrEqual(line.item.unitPrice);
      }
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
    "records the full applied amount for a quantity-based add-on",
    { booking_fee: "0" },
    () => {
      const order = priceCheckout(
        intentWith([item()], {
          modifiers: [modifier({ kind: "fixed", quantity: 3, value: 500 })],
        }),
      );
      expect(order.extras).toEqual([
        { amount: 500, key: "mod:1", name: "Add-on", quantity: 3 },
      ]);
      expect(order.modifierApplications).toEqual([
        {
          amountApplied: 1500,
          delta: 1500,
          modifierId: 1,
          quantity: 3,
          scopedSubtotal: 1000,
        },
      ]);
      expect(order.total).toBe(2500);
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
    "takes the percentage deposit from the feeSubtotal override, not the items",
    { booking_fee: "5" },
    () => {
      // feeSubtotal override (£50) differs from the item subtotal (2 × £10 =
      // £20), so a 10% deposit is 10% of £50 = £5 (£2.50/unit), not 10% of £20.
      // The ?:-branch must keep the override path; collapsing it to the
      // "unmodified" path would deposit 10% of the items instead.
      const order = priceCheckout(
        intentWith([item({ quantity: 2 })], {
          feeSubtotal: 5000,
          reservationAmount: "10%",
        }),
      );
      expect(order.lines[0]!.chargedUnitAmount).toBe(250);
      expect(order.fullSubtotal).toBe(5000);
      // Deposit (2 × £2.50 = £5) + fee (5% of £50 = £2.50) = £7.50.
      expect(order.total).toBe(750);
    },
  );

  testWithSetting(
    "charges the fee on the full reservation order when no override is present",
    { booking_fee: "5" },
    () => {
      const order = priceCheckout(
        intentWith([item({ quantity: 3 })], { reservationAmount: "10" }),
      );
      expect(order.fullSubtotal).toBe(3000);
      expect(order.extras).toEqual([
        { amount: 150, key: "fee", name: "Booking fee", quantity: 1 },
      ]);
      expect(order.total).toBe(1150);
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

  testWithSetting(
    "computes reservation deposits and balances from modifier-adjusted ticket totals",
    { booking_fee: "10" },
    () => {
      const intent = intentWith([item()], {
        modifiers: [modifier({ kind: "fixed", value: -500 })],
        reservationAmount: "10%",
      });
      const order = priceCheckout(intent);

      // £10 ticket - £5 discount = £5 final ticket total. The reservation
      // deposit is 10% of that adjusted total, and the booking fee is charged on
      // the same adjusted subtotal.
      expect(order.lines).toEqual([
        { chargedUnitAmount: 50, item: item(), quantity: 1 },
      ]);
      expect(order.fullSubtotal).toBe(500);
      expect(order.extras).toEqual([
        { amount: 50, key: "fee", name: "Booking fee", quantity: 1 },
      ]);
      expect(order.total).toBe(100);

      const breakdown = ticketPaymentBreakdown(intent);
      expect(breakdown.paidByListingId).toEqual(new Map([[1, 50]]));
      expect(breakdown.remainingBalance).toBe(450);
    },
  );

  testWithSetting(
    "charges a reservation deposit against the modified full subtotal",
    { booking_fee: "10" },
    () => {
      const order = priceCheckout(
        intentWith([item()], {
          modifiers: [
            modifier({ kind: "fixed", name: "Programme", value: 500 }),
          ],
          reservationAmount: "10%",
        }),
      );
      // Full modified subtotal is £15.00; checkout charges a £1.50 deposit
      // plus a £1.50 booking fee, not the full £5.00 add-on.
      expect(order.fullSubtotal).toBe(1500);
      expect(order.lines).toEqual([
        { chargedUnitAmount: 150, item: item(), quantity: 1 },
      ]);
      expect(order.extras).toEqual([
        { amount: 150, key: "fee", name: "Booking fee", quantity: 1 },
      ]);
      expect(order.total).toBe(300);

      const breakdown = ticketPaymentBreakdown(
        intentWith([item()], {
          modifiers: [
            modifier({ kind: "fixed", name: "Programme", value: 500 }),
          ],
          reservationAmount: "10%",
        }),
      );
      expect(breakdown.paidByListingId).toEqual(new Map([[1, 150]]));
      expect(breakdown.remainingBalance).toBe(1350);
    },
  );

  testWithSetting(
    "reduces a reservation deposit when a modifier discounts the full subtotal",
    { booking_fee: "0" },
    () => {
      const order = priceCheckout(
        intentWith([item()], {
          modifiers: [modifier({ kind: "percent", value: -10 })],
          reservationAmount: "10%",
        }),
      );
      expect(order.fullSubtotal).toBe(900);
      expect(order.lines).toEqual([
        { chargedUnitAmount: 90, item: item(), quantity: 1 },
      ]);
      expect(order.total).toBe(90);
    },
  );

  testWithSetting(
    "allocates a modifier-funded reservation deposit for zero-price listings",
    { booking_fee: "0" },
    () => {
      const freeItem = item({ unitPrice: 0 });
      const order = priceCheckout(
        intentWith([freeItem], {
          modifiers: [
            modifier({ kind: "fixed", name: "Donation", value: 500 }),
          ],
          reservationAmount: "10%",
        }),
      );
      expect(order.fullSubtotal).toBe(500);
      expect(order.lines).toEqual([
        { chargedUnitAmount: 50, item: freeItem, quantity: 1 },
      ]);
      expect(order.total).toBe(50);
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
    expect(result.applications).toEqual([
      {
        amountApplied: 450,
        delta: 450,
        modifierId: 1,
        quantity: 1,
        scopedSubtotal: 4500,
      },
    ]);
    expect(result.modifierTotal).toBe(450);
  });

  test("scopes a percentage to only the listed items", () => {
    // 10% of listing 1's £20 only = £2.
    const result = applyModifiers(lines, [
      modifier({ kind: "percent", listingIds: [1], value: 10 }),
    ]);
    expect(result.extras[0]!.amount).toBe(200);
    expect(result.applications[0]).toEqual({
      amountApplied: 200,
      delta: 200,
      modifierId: 1,
      quantity: 1,
      scopedSubtotal: 2000,
    });
    expect(result.modifierTotal).toBe(200);
  });

  test("scopes a percentage across a group-sized listing set", () => {
    // 10% of listings 1 + 2 only = £4.50.
    const result = applyModifiers(lines, [
      modifier({ kind: "percent", listingIds: [1, 2], value: 10 }),
    ]);
    expect(result.applications[0]).toEqual({
      amountApplied: 450,
      delta: 450,
      modifierId: 1,
      quantity: 1,
      scopedSubtotal: 4500,
    });
    expect(result.modifierTotal).toBe(450);
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
    expect(result.applications).toEqual([
      {
        amountApplied: 1500,
        delta: 1500,
        modifierId: 1,
        quantity: 3,
        scopedSubtotal: 4500,
      },
    ]);
    expect(result.modifierTotal).toBe(1500);
  });

  test("treats a zero-delta modifier as a no-op", () => {
    const result = applyModifiers(lines, [
      modifier({ kind: "percent", value: 0 }),
    ]);
    expect(result.extras).toEqual([]);
    expect(result.lines).toEqual(lines);
    expect(result.applications).toEqual([
      {
        amountApplied: 0,
        delta: 0,
        modifierId: 1,
        quantity: 1,
        scopedSubtotal: 4500,
      },
    ]);
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
    expect(result.applications).toEqual([
      {
        amountApplied: 200,
        delta: -200,
        modifierId: 1,
        quantity: 1,
        scopedSubtotal: 2000,
      },
    ]);
    expect(result.modifierTotal).toBe(-200);
  });

  test("records only the clamped amount for an oversized discount", () => {
    const result = applyModifiers(
      [line({ quantity: 2 })],
      [modifier({ kind: "fixed", value: -5000 })],
    );
    expect(result.lines).toEqual([
      { chargedUnitAmount: 0, item: item(), quantity: 2 },
    ]);
    expect(result.applications).toEqual([
      {
        amountApplied: 2000,
        delta: -2000,
        modifierId: 1,
        quantity: 1,
        scopedSubtotal: 2000,
      },
    ]);
    expect(result.modifierTotal).toBe(-2000);
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

describe("lineListPrice", () => {
  test("is unit price multiplied by quantity (gross list price)", () => {
    expect(
      lineListPrice(line({ item: item({ unitPrice: 500 }), quantity: 4 })),
    ).toBe(2000);
  });
});
