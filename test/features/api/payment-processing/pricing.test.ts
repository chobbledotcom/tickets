import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { ValidatedItem } from "#routes/api/payment-processing/package-pricing.ts";
import {
  checkoutIntentForSession,
  orderLineTotal,
  paidByItem,
  paidPricingRefund,
} from "#routes/api/payment-processing/pricing.ts";
import type { BookingIntent } from "#shared/booking-intent.ts";
import type { PricedOrder } from "#shared/checkout-pricing.ts";
import type { CheckoutItem, ModifierSpec } from "#shared/payments.ts";
import { pricedOrder, testListingWithCount } from "#test-utils/factories.ts";

const checkoutItem = (overrides: Partial<CheckoutItem> = {}): CheckoutItem => ({
  listingId: 7,
  name: "Test Listing",
  quantity: 1,
  slug: "priced",
  unitPrice: 1000,
  ...overrides,
});

const validated = (overrides: Partial<ValidatedItem> = {}): ValidatedItem => ({
  expectedPrice: 1000,
  item: { e: 7, p: 1000, q: 1 },
  listing: testListingWithCount({
    can_pay_more: false,
    id: 7,
    max_price: 5000,
    slug: "priced",
    unit_price: 1000,
  }),
  ...overrides,
});

const bookingIntent = (
  overrides: Partial<BookingIntent> = {},
): BookingIntent => ({
  address: "Address",
  date: "2026-08-01",
  email: "buyer@example.com",
  items: [{ e: 7, p: 1000, q: 1 }],
  modifiers: [],
  name: "Buyer",
  phone: "01234",
  special_instructions: "Note",
  ...overrides,
});

const modifier: ModifierSpec = {
  id: 4,
  kind: "fixed",
  listingIds: [7],
  name: "Programme",
  quantity: 2,
  trigger: "optional",
  value: 250,
};

const standardOrder = (overrides: Partial<PricedOrder> = {}): PricedOrder =>
  pricedOrder({
    fullSubtotal: 1000,
    lines: [{ chargedUnitAmount: 1000, item: checkoutItem(), quantity: 1 }],
    total: 1000,
    ...overrides,
  });

const priceChanged = (detail: string) => ({
  code: "price_changed",
  detail,
  reason: "the listing price changed while they were paying",
});

const payMoreItem = (amount: number): ValidatedItem =>
  validated({
    expectedPrice: 2000,
    item: { e: 7, p: amount, q: 2 },
    listing: testListingWithCount({
      can_pay_more: true,
      id: 7,
      max_price: 2000,
      slug: "priced",
      unit_price: 1000,
    }),
  });

describe("checkoutIntentForSession", () => {
  test("copies every contact field and current signed pricing field", () => {
    const packageItem = { e: 7, k: "p", p: 3000, q: 3, r: 9 } as const;
    const value = checkoutIntentForSession(
      bookingIntent({
        dayCount: 3,
        items: [packageItem],
        reservationAmount: "500",
      }),
      [validated({ item: packageItem })],
      [modifier],
    );

    expect(value).toEqual({
      address: "Address",
      date: "2026-08-01",
      dayCount: 3,
      email: "buyer@example.com",
      items: [
        {
          listingId: 7,
          name: "Test Listing",
          packageGroupId: 9,
          quantity: 3,
          slug: "priced",
          unitPrice: 1000,
        },
      ],
      modifiers: [modifier],
      name: "Buyer",
      phone: "01234",
      reservationAmount: "500",
      special_instructions: "Note",
    });
  });

  test("omits deposit and day fields when the signed values are absent", () => {
    const value = checkoutIntentForSession(bookingIntent(), [validated()], []);

    expect(value.items).toEqual([checkoutItem()]);
    expect("dayCount" in value).toBe(false);
    expect("reservationAmount" in value).toBe(false);
  });

  test("does not turn a group edge into package membership", () => {
    const groupItem = { e: 7, k: "g", p: 1000, q: 1, r: 9 } as const;
    const value = checkoutIntentForSession(
      bookingIntent({ items: [groupItem] }),
      [validated({ item: groupItem })],
      [],
    );

    expect(value.items).toEqual([checkoutItem()]);
  });
});

describe("payment item totals", () => {
  test("adds split deposit lines without including modifier extras", () => {
    const order = pricedOrder({
      extras: [{ amount: 300, key: "mod:4", name: "Programme", quantity: 2 }],
      lines: [
        { chargedUnitAmount: 400, item: checkoutItem(), quantity: 2 },
        { chargedUnitAmount: 125, item: checkoutItem(), quantity: 1 },
      ],
      total: 1525,
    });

    expect(orderLineTotal(order)).toBe(925);
  });

  test("adds every charged line for the same checkout item", () => {
    const item = checkoutItem({ quantity: 3 });
    const order = pricedOrder({
      lines: [
        { chargedUnitAmount: 400, item, quantity: 1 },
        { chargedUnitAmount: 250, item, quantity: 2 },
      ],
    });

    expect(paidByItem(order).get(item)).toBe(900);
  });

  test("keeps two booking paths for one listing as separate item totals", () => {
    const packagePath = checkoutItem({ packageGroupId: 9 });
    const standalonePath = checkoutItem();
    const totals = paidByItem(
      pricedOrder({
        lines: [
          { chargedUnitAmount: 600, item: packagePath, quantity: 2 },
          { chargedUnitAmount: 750, item: standalonePath, quantity: 1 },
        ],
      }),
    );

    expect(totals).toEqual(
      new Map([
        [packagePath, 1200],
        [standalonePath, 750],
      ]),
    );
  });
});

describe("paidPricingRefund", () => {
  test("accepts an unchanged fixed-price order", () => {
    expect(paidPricingRefund([validated()], standardOrder(), 1000)).toBeNull();
  });

  test("accepts a signed deposit while checking the full item price", () => {
    const depositOrder = standardOrder({
      fullSubtotal: 2000,
      lines: [
        {
          chargedUnitAmount: 250,
          item: checkoutItem({ quantity: 2 }),
          quantity: 2,
        },
      ],
      total: 500,
    });

    expect(
      paidPricingRefund(
        [validated({ expectedPrice: 2000, item: { e: 7, p: 2000, q: 2 } })],
        depositOrder,
        500,
      ),
    ).toBeNull();
  });

  test("accepts a modifier when its re-derived total matches the signed total", () => {
    const modifiedOrder = standardOrder({
      extras: [{ amount: 250, key: "mod:4", name: "Programme", quantity: 2 }],
      total: 1500,
    });

    expect(paidPricingRefund([validated()], modifiedOrder, 1500)).toBeNull();
  });

  test("rejects a package member that is no longer in its package", () => {
    expect(
      paidPricingRefund(
        [validated({ expectedPrice: null })],
        standardOrder(),
        1000,
      ),
    ).toEqual(
      priceChanged("Package member listing 7 is no longer part of its package"),
    );
  });

  for (const amount of [999, 1001]) {
    test(`rejects a fixed item total of ${amount} when 1000 is current`, () => {
      expect(
        paidPricingRefund(
          [validated({ item: { e: 7, p: amount, q: 1 } })],
          standardOrder(),
          1000,
        ),
      ).toEqual(
        priceChanged(
          `Per-item price mismatch for listing 7: metadata p=${amount} but expected 1000 (can_pay_more=false)`,
        ),
      );
    });
  }

  for (const amount of [2000, 4000]) {
    test(`accepts the pay-more boundary total ${amount}`, () => {
      expect(
        paidPricingRefund(
          [payMoreItem(amount)],
          standardOrder({ total: amount }),
          amount,
        ),
      ).toBeNull();
    });
  }

  for (const amount of [1999, 4001]) {
    test(`rejects the out-of-range pay-more total ${amount}`, () => {
      expect(
        paidPricingRefund(
          [payMoreItem(amount)],
          standardOrder({ total: amount }),
          amount,
        ),
      ).toEqual(
        priceChanged(
          `Per-item price mismatch for listing 7: metadata p=${amount} but expected 2000 (can_pay_more=true)`,
        ),
      );
    });
  }

  test("rejects a free item whose current price became positive", () => {
    expect(
      paidPricingRefund(
        [validated({ expectedPrice: 100, item: { e: 7, p: 0, q: 1 } })],
        standardOrder({ total: 500 }),
        500,
      ),
    ).toEqual(
      priceChanged(
        "Per-item price mismatch for listing 7: metadata p=0 but expected 100 (can_pay_more=false)",
      ),
    );
  });

  test("rejects a changed modifier total against the signed total", () => {
    expect(
      paidPricingRefund([validated()], standardOrder({ total: 1501 }), 1500),
    ).toEqual(
      priceChanged("Re-derived total 1501 differs from signed total 1500"),
    );
  });
});
