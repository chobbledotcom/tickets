import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { extractSessionMetadata } from "#shared/payment-helpers.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import { checkoutIntent, checkoutItem } from "#test-utils/checkout-items.ts";
import { wireMetadata } from "#test-utils/payment-session.ts";
import { withSetting } from "#test-utils/settings.ts";
import {
  stripeCheckoutSession,
  stripeClient,
} from "#test-utils/stripe/fixtures.ts";
import { describeStripe } from "#test-utils/stripe/harness.ts";

describeStripe("Stripe VAT charges", () => {
  for (const [mode, reservationAmount, expected] of [
    ["add_to_total", undefined, 2400],
    ["calculate_from_total", undefined, 2000],
    ["add_to_total", "10%", 240],
    ["add_to_total", "1", 100],
  ] as const) {
    test(`${mode} ${reservationAmount ?? "full payment"} sends exact charged lines and frozen policy`, async () => {
      await withSetting({ booking_fee: "0", currency: "GBP" }, async () => {
        const client = await stripeClient();
        const create = stub(client.checkout.sessions, "create", () =>
          Promise.resolve(stripeCheckoutSession()),
        );
        try {
          const policy = { mode, rateBasisPoints: 2000 };
          await stripePaymentProvider.createCheckoutSession(
            checkoutIntent({
              items: [checkoutItem({ quantity: 2, unitPrice: 1000 })],
              reservationAmount,
              taxPolicy: policy,
            }),
            "http://localhost",
          );
          const payload = create.calls[0]!.args[0];
          const sum = payload.line_items!.reduce(
            (total, line) =>
              total + line.price_data!.unit_amount! * line.quantity!,
            0,
          );
          expect(sum).toBe(expected);
          const metadata = extractSessionMetadata(
            wireMetadata(payload.metadata as Record<string, string>),
          );
          expect(JSON.parse(metadata.tax_policy)).toEqual(policy);
          expect(metadata.price_proof.startsWith(`${expected}.`)).toBe(true);
        } finally {
          create.restore();
        }
      });
    });
  }
});
