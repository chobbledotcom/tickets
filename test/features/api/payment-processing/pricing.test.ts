import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { ValidatedItem } from "#routes/api/payment-processing/package-pricing.ts";
import {
  checkoutIntentForSession,
  paidByItem,
  paidPricingRefund,
} from "#routes/api/payment-processing/pricing.ts";
import type { PricedOrder } from "#shared/checkout-pricing.ts";
import { testListingWithCount } from "#test-utils/factories.ts";

const validated = (overrides: Partial<ValidatedItem> = {}): ValidatedItem => {
  const listing = testListingWithCount({
    can_pay_more: false,
    id: 7,
    max_price: 5000,
    slug: "priced",
    unit_price: 1000,
  });
  return {
    expectedPrice: 1000,
    item: { e: 7, p: 1000, q: 1 },
    listing,
    ...overrides,
  };
};

const order = (
  item = {
    listingId: 7,
    name: "Listing",
    quantity: 1,
    slug: "priced",
    unitPrice: 1000,
  },
): PricedOrder => ({
  extras: [],
  fullSubtotal: 1000,
  lines: [{ chargedUnitAmount: 1000, item, quantity: 1 }],
  modifierApplications: [],
  total: 1000,
});

describe("payment pricing", () => {
  test("builds all signed checkout fields, including package and reservation data", () => {
    const value = checkoutIntentForSession(
      {
        address: "Address",
        date: "2026-08-01",
        dayCount: 3,
        email: "a@example.com",
        items: [{ e: 7, k: "p", p: 3000, q: 3, r: 9 }],
        modifiers: [],
        name: "Buyer",
        phone: "1",
        reservationAmount: "500",
        special_instructions: "Note",
      },
      [validated({ item: { e: 7, k: "p", p: 3000, q: 3, r: 9 } })],
      [{ id: 4 } as never],
    );
    expect(value).toMatchObject({
      date: "2026-08-01",
      dayCount: 3,
      items: [
        { listingId: 7, packageGroupId: 9, quantity: 3, unitPrice: 1000 },
      ],
      modifiers: [{ id: 4 }],
      reservationAmount: "500",
    });
  });

  test("omits package, day, and reservation fields when absent", () => {
    const value = checkoutIntentForSession(
      {
        address: "",
        date: null,
        email: "a@example.com",
        items: [{ e: 7, p: 1000, q: 1 }],
        modifiers: [],
        name: "Buyer",
        phone: "",
        special_instructions: "",
      },
      [validated()],
      [],
    );
    expect(value.items[0]).toEqual({
      listingId: 7,
      name: "Test Listing",
      quantity: 1,
      slug: "priced",
      unitPrice: 1000,
    });
    expect("dayCount" in value).toBe(false);
    expect("reservationAmount" in value).toBe(false);
  });

  test("adds every charged line for the same item object", () => {
    const item = {
      listingId: 7,
      name: "Listing",
      quantity: 2,
      slug: "priced",
      unitPrice: 1000,
    };
    const priced = order(item);
    priced.lines.push({ chargedUnitAmount: 250, item, quantity: 2 });
    expect(paidByItem(priced).get(item)).toBe(1500);
  });

  test("accepts matching fixed and pay-more prices", () => {
    expect(paidPricingRefund([validated()], order(), 1000)).toBeNull();
    const payMore = validated({
      expectedPrice: 1000,
      item: { e: 7, p: 4000, q: 2 },
      listing: testListingWithCount({
        can_pay_more: true,
        id: 7,
        max_price: 2500,
      }),
    });
    expect(
      paidPricingRefund([payMore], { ...order(), total: 4000 }, 4000),
    ).toBeNull();
  });

  test("rejects removed package membership", () => {
    expect(
      paidPricingRefund([validated({ expectedPrice: null })], order(), 1000),
    ).toMatchObject({ code: "price_changed" });
  });

  for (const item of [
    { e: 7, p: 999, q: 1 },
    { e: 7, p: 999, q: 2 },
  ]) {
    test(`rejects a fixed price mismatch for quantity ${item.q}`, () => {
      expect(
        paidPricingRefund([validated({ item })], order(), 1000)?.detail,
      ).toContain("Per-item price mismatch");
    });
  }

  test("rejects pay-more totals below the minimum or above the quantity cap", () => {
    const listing = testListingWithCount({
      can_pay_more: true,
      id: 7,
      max_price: 2000,
    });
    expect(
      paidPricingRefund(
        [validated({ item: { e: 7, p: 999, q: 2 }, listing })],
        order(),
        1000,
      ),
    ).not.toBeNull();
    expect(
      paidPricingRefund(
        [validated({ item: { e: 7, p: 4001, q: 2 }, listing })],
        order(),
        1000,
      ),
    ).not.toBeNull();
  });

  test("rejects a re-derived total mismatch", () => {
    expect(paidPricingRefund([validated()], order(), 999)?.detail).toBe(
      "Re-derived total 1000 differs from signed total 999",
    );
  });
});
