import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { squarePaymentProvider } from "#shared/square-provider.ts";
import {
  configureSquare,
  linkResult,
  withSquareClient,
} from "#test/lib/square/fixtures.ts";
import { describeSquare } from "#test/lib/square/harness.ts";
import { checkoutIntent, checkoutItem } from "#test-utils/checkout.ts";

describeSquare(() => {
  describe("squarePaymentProvider integration", () => {
    test("retrieveSession maps COMPLETED order to paid status", async () => {
      await withSquareClient(
        {
          ordersGet: () =>
            Promise.resolve({
              order: {
                id: "order_paid",
                metadata: {
                  email: "john@example.com",
                  items: '[{"e":1,"q":2,"p":0}]',
                  name: "John Doe",
                  phone: "555-1234",
                },
                state: "COMPLETED",
                tenders: [{ id: "tender_1", paymentId: "pay_abc" }],
                totalMoney: { amount: BigInt(5000), currency: "USD" },
              },
            }),
          paymentsGet: () =>
            Promise.resolve({
              payment: { id: "pay_abc", status: "COMPLETED" },
            }),
        },
        async () => {
          const result =
            await squarePaymentProvider.retrieveSession("order_paid");
          expect(result).not.toBeNull();
          expect(result!.id).toBe("order_paid");
          expect(result!.paymentStatus).toBe("paid");
          expect(result!.paymentReference).toBe("pay_abc");
          expect(result!.metadata.name).toBe("John Doe");
          expect(result!.metadata.email).toBe("john@example.com");
          expect(result!.metadata.phone).toBe("555-1234");
          expect(result!.metadata.items).toBe('[{"e":1,"q":2,"p":0}]');
        },
      );
    });

    test("retrieveSession maps OPEN order to unpaid status", async () => {
      await withSquareClient(
        {
          ordersGet: () =>
            Promise.resolve({
              order: {
                id: "order_open",
                metadata: {
                  email: "john@example.com",
                  items: '[{"e":1,"q":1,"p":0}]',
                  name: "John",
                },
                state: "OPEN",
                totalMoney: { amount: BigInt(1000), currency: "USD" },
              },
            }),
        },
        async () => {
          const result =
            await squarePaymentProvider.retrieveSession("order_open");
          expect(result).not.toBeNull();
          expect(result!.paymentStatus).toBe("unpaid");
          expect(result!.paymentReference).toBe("");
        },
      );
    });

    test("retrieveSession returns null for missing metadata", async () => {
      await withSquareClient(
        {
          ordersGet: () =>
            Promise.resolve({
              order: {
                id: "order_no_meta",
                state: "COMPLETED",
              },
            }),
        },
        async () => {
          const result =
            await squarePaymentProvider.retrieveSession("order_no_meta");
          expect(result).toBeNull();
        },
      );
    });

    test("retrieveSession returns null for incomplete metadata", async () => {
      await withSquareClient(
        {
          ordersGet: () =>
            Promise.resolve({
              order: {
                id: "order_bad_meta",
                metadata: { email: "john@example.com" },
                state: "COMPLETED",
              },
            }),
        },
        async () => {
          const result =
            await squarePaymentProvider.retrieveSession("order_bad_meta");
          expect(result).toBeNull();
        },
      );
    });

    test("retrieveSession returns null when order not found", async () => {
      await withSquareClient(
        { ordersGet: () => Promise.resolve({ order: null }) },
        async () => {
          const result =
            await squarePaymentProvider.retrieveSession("order_gone");
          expect(result).toBeNull();
        },
      );
    });

    test("retrieveSession returns amountTotal from order totalMoney", async () => {
      await withSquareClient(
        {
          ordersGet: () =>
            Promise.resolve({
              order: {
                id: "order_with_amount",
                metadata: {
                  email: "total@example.com",
                  items: '[{"e":5,"q":2,"p":0}]',
                  name: "Total User",
                },
                state: "COMPLETED",
                tenders: [{ id: "tender_1", paymentId: "pay_total_123" }],
                totalMoney: { amount: BigInt(6000), currency: "GBP" },
              },
            }),
          paymentsGet: () =>
            Promise.resolve({
              payment: { id: "pay_total_123", status: "COMPLETED" },
            }),
        },
        async () => {
          const result =
            await squarePaymentProvider.retrieveSession("order_with_amount");
          expect(result).not.toBeNull();
          expect(result!.amountTotal).toBe(6000);
          expect(result!.paymentStatus).toBe("paid");
          expect(result!.paymentReference).toBe("pay_total_123");
        },
      );
    });

    test("retrieveSession handles multi-ticket order", async () => {
      const items = JSON.stringify([
        { e: 1, q: 2 },
        { e: 2, q: 1 },
      ]);
      await withSquareClient(
        {
          ordersGet: () =>
            Promise.resolve({
              order: {
                id: "order_multi",
                metadata: {
                  email: "john@example.com",
                  items,
                  name: "John",
                },
                state: "COMPLETED",
                tenders: [{ id: "tender_1", paymentId: "pay_multi" }],
                totalMoney: { amount: BigInt(3000), currency: "USD" },
              },
            }),
          paymentsGet: () =>
            Promise.resolve({
              payment: { id: "pay_multi", status: "COMPLETED" },
            }),
        },
        async () => {
          const result =
            await squarePaymentProvider.retrieveSession("order_multi");
          expect(result).not.toBeNull();
          expect(result!.paymentStatus).toBe("paid");
          expect(result!.metadata.items).toBe(items);
        },
      );
    });

    /** The provider result should be a successful checkout with these values. */
    const expectCheckout = (
      result: unknown,
      sessionId: string,
      checkoutUrl: string,
    ) => {
      expect(result).not.toBeNull();
      expect(result).toHaveProperty("sessionId");
      const success = result as { sessionId: string; checkoutUrl: string };
      expect(success.sessionId).toBe(sessionId);
      expect(success.checkoutUrl).toBe(checkoutUrl);
    };

    test("createCheckoutSession passes through SDK results", async () => {
      await withSquareClient(
        linkResult("order_prov", "https://square.link/prov"),
        async () => {
          await configureSquare({ locationId: "L_loc_prov" });
          const result = await squarePaymentProvider.createCheckoutSession(
            checkoutIntent(),
            "http://localhost",
          );
          expectCheckout(result, "order_prov", "https://square.link/prov");
        },
      );
    });

    test("createCheckoutSession passes through SDK results (variant)", async () => {
      await withSquareClient(
        linkResult("order_mprov", "https://square.link/mprov"),
        async () => {
          await configureSquare({ locationId: "L_loc_prov" });
          const result = await squarePaymentProvider.createCheckoutSession(
            checkoutIntent({
              items: [checkoutItem({ name: "Listing 1", slug: "listing-1" })],
            }),
            "http://localhost",
          );
          expectCheckout(result, "order_mprov", "https://square.link/mprov");
        },
      );
    });

    test("refundPayment delegates through SDK", async () => {
      await withSquareClient(
        {
          paymentsGet: () =>
            Promise.resolve({
              payment: {
                amountMoney: { amount: BigInt(2000), currency: "GBP" },
                id: "pay_prov_ref",
                orderId: "order_prov_ref",
                status: "COMPLETED",
              },
            }),
          refundsRefundPayment: () =>
            Promise.resolve({
              refund: {
                amount_money: { amount: 2000, currency: "GBP" },
                id: "refund_prov",
                payment_id: "pay_prov_ref",
                status: "COMPLETED",
              },
            }),
        },
        async () => {
          const result =
            await squarePaymentProvider.refundPayment("pay_prov_ref");
          expect(result).toBe(true);
        },
      );
    });

    test("verifyWebhookSignature reports failure when no signature key configured", async () => {
      // With no webhook signature key stored, verification fails up front.
      const body = '{"test": true}';
      const result = await squarePaymentProvider.verifyWebhookSignature(
        body,
        "fakesig",
        "https://example.com/payment/webhook",
        new TextEncoder().encode(body),
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe("Webhook signature key not configured");
      }
    });
  });
});
