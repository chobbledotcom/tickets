// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { settings } from "#shared/db/settings.ts";
import { squareApi } from "#shared/square.ts";
import { squarePaymentProvider } from "#shared/square-provider.ts";
import { configureSquare } from "#test/test-utils/square/fixtures.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockWebhookRequest, withMocks } from "#test-utils/mocks.ts";

// jscpd:ignore-end

describeWithEnv("Square payment webhooks", { db: true }, () => {
  test("acknowledges an unrelated payment without Square API calls", async () => {
    await configureSquare();
    await settings.update.paymentProvider("square");
    await withMocks(
      () => ({
        order: stub(squareApi, "readOrder"),
        payment: stub(squareApi, "readPayment"),
        // Square turns an event about a payment we never issued into no
        // notice at all, so nothing is read back from its API.
        verify: stub(squarePaymentProvider, "verifyWebhookSignature", () =>
          Promise.resolve({ notice: null, valid: true as const }),
        ),
      }),
      async ({ order, payment }) => {
        const response = await handleRequest(
          mockWebhookRequest(
            {},
            { "x-square-hmacsha256-signature": "square-signature" },
          ),
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ received: true });
        expect(order.calls).toHaveLength(0);
        expect(payment.calls).toHaveLength(0);
      },
    );
  });
});
