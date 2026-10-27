import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { extractSessionMetadata } from "#shared/payment-helpers.ts";
import type { CreatePaymentLinkInput } from "#shared/square/client.ts";
import { squarePaymentProvider } from "#shared/square-provider.ts";
import { checkoutIntent, checkoutItem } from "#test-utils/checkout-items.ts";
import { wireMetadata } from "#test-utils/payment-session.ts";
import { withSetting } from "#test-utils/settings.ts";
import {
  configureSquare,
  linkResult,
  withSquareClient,
} from "#test-utils/square/fixtures.ts";
import { describeSquare } from "#test-utils/square/harness.ts";

describeSquare(() => {
  for (const [mode, reservationAmount, expected] of [
    ["add_to_total", undefined, 2400],
    ["calculate_from_total", undefined, 2000],
    ["add_to_total", "10%", 240],
    ["add_to_total", "1x", 200],
    ["add_to_total", "0", 0],
  ] as const) {
    test(`Square ${mode} ${reservationAmount ?? "full payment"} charges the exact provider lines`, async () => {
      await configureSquare({ locationId: "VAT_LOCATION" });
      await withSetting({ booking_fee: "0", currency: "GBP" }, () =>
        withSquareClient(
          linkResult("order_vat", "https://square.link/vat"),
          async (mock) => {
            const policy = { mode, rateBasisPoints: 2000 };
            await squarePaymentProvider.createCheckoutSession(
              checkoutIntent({
                items: [checkoutItem({ quantity: 2, unitPrice: 1000 })],
                reservationAmount,
                taxPolicy: policy,
              }),
              "http://localhost",
            );
            const payload = mock.checkoutCreate.calls[0]!
              .args[0] as CreatePaymentLinkInput;
            const sum = payload.order.lineItems.reduce(
              (total, line) =>
                total +
                Number(line.basePriceMoney.amount) * Number(line.quantity),
              0,
            );
            expect(sum).toBe(expected);
            expect(
              Object.keys(payload.order.metadata).length,
            ).toBeLessThanOrEqual(10);
            const metadata = extractSessionMetadata(
              wireMetadata(payload.order.metadata),
            );
            expect(JSON.parse(metadata.tax_policy)).toEqual(policy);
            expect(metadata.price_proof.startsWith(`${expected}.`)).toBe(true);
          },
        ),
      );
    });
  }
});
