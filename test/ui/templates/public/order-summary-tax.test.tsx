import { expect } from "@std/expect";
import { describe } from "@std/testing/bdd";
import { priceCheckout } from "#shared/checkout-pricing.ts";
import { orderSummary } from "#templates/public/order-summary.tsx";
import { checkoutIntent, checkoutItem } from "#test-utils/checkout-items.ts";
import { testWithSetting } from "#test-utils/settings.ts";

describe("checkout VAT display", () => {
  testWithSetting(
    "shows added VAT as a charge and the tax-inclusive total",
    { booking_fee: "0", currency: "GBP" },
    () => {
      const order = priceCheckout(
        checkoutIntent({
          items: [checkoutItem({ unitPrice: 1000 })],
          taxPolicy: { mode: "add_to_total", rateBasisPoints: 2000 },
        }),
      );
      const html = orderSummary(order);
      expect(html).toContain("VAT");
      expect(html).toContain("£2");
      expect(html).toContain("£12");
    },
  );
  testWithSetting(
    "explains the VAT already included without adding it twice",
    { booking_fee: "0", currency: "GBP" },
    () => {
      const order = priceCheckout(
        checkoutIntent({
          items: [checkoutItem({ unitPrice: 1200 })],
          taxPolicy: { mode: "calculate_from_total", rateBasisPoints: 2000 },
        }),
      );
      const html = orderSummary(order);
      expect(html).toContain("Includes £2 VAT.");
      expect(html).toContain("£12");
      expect(html).not.toContain("£14");
    },
  );
  testWithSetting(
    "states full VAT and the later balance while charging only the deposit",
    { booking_fee: "0", currency: "GBP" },
    () => {
      const order = priceCheckout(
        checkoutIntent({
          items: [checkoutItem({ unitPrice: 1000 })],
          reservationAmount: "10%",
          taxPolicy: { mode: "add_to_total", rateBasisPoints: 2000 },
        }),
      );
      const html = orderSummary(order, true);
      expect(html).toContain("£1.20");
      expect(html).toContain(
        "Full booking total: £12, including £2 VAT. The balance is paid later.",
      );
    },
  );
});
