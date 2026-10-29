import { expect } from "@std/expect";
import { describe } from "@std/testing/bdd";
import {
  bookingFactsFromOrder,
  owedOrderForLedger,
} from "#shared/checkout-ledger.ts";
import {
  type PricedOrder,
  priceCheckout,
  ticketPaymentBreakdown,
} from "#shared/checkout-pricing.ts";
import type { CheckoutIntent } from "#shared/payments.ts";
import { NO_TAX } from "#shared/tax/types.ts";
import { testWithSetting } from "#test-utils/settings.ts";

const intent = (overrides: Partial<CheckoutIntent> = {}): CheckoutIntent => ({
  address: "",
  date: null,
  email: "buyer@example.com",
  items: [
    {
      listingId: 1,
      name: "Ticket",
      quantity: 2,
      slug: "ticket",
      unitPrice: 1000,
    },
  ],
  name: "Buyer",
  phone: "",
  special_instructions: "",
  taxPolicy: { mode: "add_to_total", rateBasisPoints: 2000 },
  ...overrides,
});

const providerSum = (order: PricedOrder): number =>
  order.lines.reduce(
    (total, line) => total + line.quantity * line.chargedUnitAmount,
    0,
  ) +
  order.extras.reduce((total, line) => total + line.quantity * line.amount, 0);

describe("VAT checkout contract", () => {
  testWithSetting(
    "new bookings use current settings but a frozen policy wins",
    {
      booking_fee: "0",
      tax: JSON.stringify({ mode: "add_to_total", rateBasisPoints: 1725 }),
    },
    () => {
      expect(priceCheckout(intent({ taxPolicy: undefined })).total).toBe(2345);
      expect(priceCheckout(intent({ taxPolicy: NO_TAX })).total).toBe(2000);
      expect(priceCheckout(intent()).total).toBe(2400);
    },
  );
  testWithSetting(
    "zero percent is an explicit taxed policy with no added charge",
    { booking_fee: "0" },
    () => {
      const order = priceCheckout(
        intent({ taxPolicy: { mode: "add_to_total", rateBasisPoints: 0 } }),
      );
      expect(order.tax.policy).toEqual({
        mode: "add_to_total",
        rateBasisPoints: 0,
      });
      expect(order.tax.taxAmount).toBe(0);
      expect(order.total).toBe(2000);
    },
  );
  testWithSetting(
    "adds VAT once and keeps the booking fee outside VAT",
    { booking_fee: "5" },
    () => {
      const order = priceCheckout(intent());
      expect(order.tax).toMatchObject({
        taxAmount: 400,
        taxableTotal: 2000,
        total: 2400,
      });
      expect(order.total).toBe(2500);
      expect(providerSum(order)).toBe(order.total);
      expect(order.extras.find((line) => line.key === "fee")?.amount).toBe(100);
      expect(
        bookingFactsFromOrder(order, {
          attendeeId: 1,
          eventId: "session",
          occurredAt: "2026-01-01T00:00:00.000Z",
        }).vat,
      ).toEqual(order.tax.policy);
      expect(owedOrderForLedger(order).tax).toEqual(order.tax);
    },
  );
  testWithSetting(
    "included VAT preserves the full charge",
    { booking_fee: "0" },
    () => {
      const order = priceCheckout(
        intent({
          taxPolicy: { mode: "calculate_from_total", rateBasisPoints: 2000 },
        }),
      );
      expect(order.total).toBe(2000);
      expect(order.tax.taxAmount).toBe(333);
      expect(providerSum(order)).toBe(order.total);
    },
  );
  for (const [reservationAmount, deposit] of [
    ["10%", 240],
    ["1", 100],
    ["1x", 200],
    ["0", 0],
  ] as const) {
    testWithSetting(
      `charges only the ${reservationAmount} deposit with VAT still owed`,
      { booking_fee: "0", currency: "GBP" },
      () => {
        const booking = intent({ reservationAmount });
        const order = priceCheckout(booking);
        expect(order.total).toBe(deposit);
        expect(order.tax.total).toBe(2400);
        expect(providerSum(order)).toBe(deposit);
        expect(ticketPaymentBreakdown(booking).remainingBalance).toBe(
          2400 - deposit,
        );
      },
    );
  }
  testWithSetting(
    "settles saved debt without taxing it again",
    { booking_fee: "0" },
    () => {
      const order = priceCheckout(
        intent({ balanceAttendeeId: 1, feeSubtotal: 0, taxPolicy: NO_TAX }),
      );
      expect(order.total).toBe(2000);
      expect(order.tax.taxAmount).toBe(0);
    },
  );
  testWithSetting(
    "assesses signed modifier deltas before applying VAT",
    { booking_fee: "0" },
    () => {
      const order = priceCheckout(
        intent({
          modifiers: [
            {
              id: 1,
              kind: "fixed",
              listingIds: null,
              name: "Discount",
              quantity: 1,
              trigger: "automatic",
              value: -500,
            },
            {
              id: 2,
              kind: "fixed",
              listingIds: null,
              name: "Add-on",
              quantity: 1,
              trigger: "automatic",
              value: 100,
            },
          ],
        }),
      );
      expect(order.tax.taxAmount).toBe(320);
      expect(order.total).toBe(1920);
      expect(providerSum(order)).toBe(1920);
    },
  );
});
