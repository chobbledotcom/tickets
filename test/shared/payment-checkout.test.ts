import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import * as v from "valibot";
import {
  checkoutDisplayOrder,
  PaymentCheckoutCreateSnapshotSchema,
} from "#shared/payment-checkout.ts";
import { PAYMENT_CHECKOUT_CREATE } from "#test/shared/db/payments/fixtures.ts";

test("accepts only the exact repeatable checkout creation shape", () => {
  expect(
    v.parse(PaymentCheckoutCreateSnapshotSchema, PAYMENT_CHECKOUT_CREATE),
  ).toEqual(PAYMENT_CHECKOUT_CREATE);
  expect(
    v.safeParse(PaymentCheckoutCreateSnapshotSchema, {
      ...PAYMENT_CHECKOUT_CREATE,
      siteToken: "must-not-be-stored",
    }).success,
  ).toBe(false);
  expect(
    v.safeParse(PaymentCheckoutCreateSnapshotSchema, {
      ...PAYMENT_CHECKOUT_CREATE,
      baseUrl: "https://tickets.example/path",
    }).success,
  ).toBe(false);
});

test("binds metadata and display total to the local payment", () => {
  expect(
    v.safeParse(PaymentCheckoutCreateSnapshotSchema, {
      ...PAYMENT_CHECKOUT_CREATE,
      metadata: {
        ...PAYMENT_CHECKOUT_CREATE.metadata,
        payment_id: "another-payment",
      },
    }).success,
  ).toBe(false);
  expect(
    v.safeParse(PaymentCheckoutCreateSnapshotSchema, {
      ...PAYMENT_CHECKOUT_CREATE,
      expected: { amount: 999, currency: "GBP" },
    }).success,
  ).toBe(false);
});

test("keeps priced display lines without booking path data", () => {
  const order = checkoutDisplayOrder({
    extras: [{ amount: 50, key: "fee", name: "Booking fee", quantity: 1 }],
    fullSubtotal: 1_000,
    lines: [
      {
        chargedUnitAmount: 500,
        item: {
          listingId: 7,
          name: "General",
          packageGroupId: 4,
          quantity: 2,
          slug: "general",
          unitPrice: 500,
        },
        quantity: 2,
      },
    ],
    modifierApplications: [],
    total: 1_050,
  });

  expect(order).toEqual({
    extras: [{ amount: 50, name: "Booking fee", quantity: 1 }],
    lines: [{ amount: 500, name: "General", quantity: 2 }],
  });
});
