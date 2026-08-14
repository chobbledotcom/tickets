/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { squarePaymentProvider } from "#shared/square-provider.ts";
import { setupSquareProviderSuite } from "#test/test-utils/square/fixtures.ts";

/* jscpd:ignore-end */

describe("square-provider payment webhook fields", () => {
  setupSquareProviderSuite();

  const resolvePayment = (payment: Record<string, unknown>) =>
    squarePaymentProvider.resolveWebhookSession({
      data: { object: { payment } },
      id: "evt_payment_fields",
      type: "payment.updated",
    });

  test("rejects a payment event that omits status and order id", async () => {
    await expect(resolvePayment({ id: "pay_missing_fields" })).rejects.toThrow(
      "Square payment webhook is missing status",
    );
  });

  test("rejects a payment event whose status is not text", async () => {
    await expect(
      resolvePayment({
        id: "pay_invalid_status",
        order_id: "order_invalid_status",
        status: 1,
      }),
    ).rejects.toThrow("Square payment webhook is missing status");
  });

  test("rejects an empty payment status", async () => {
    await expect(
      resolvePayment({
        id: "pay_empty_status",
        order_id: "order_empty_status",
        status: "",
      }),
    ).rejects.toThrow("Square payment webhook is missing status");
  });
});
