import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { settings } from "#shared/db/settings.ts";
import { squareApi } from "#shared/square.ts";
import { squarePaymentProvider } from "#shared/square-provider.ts";
import { withMocks } from "#test-utils";
import { createMockClient, describeSquare } from "./harness.ts";

describeSquare(() => {
  describe("squarePaymentProvider integration", () => {
    test("retrieveSession maps COMPLETED order to paid status", async () => {
      const { client } = createMockClient({
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
      });

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => Promise.resolve(client)),
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
      const { client } = createMockClient({
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
      });

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => Promise.resolve(client)),
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
      const { client } = createMockClient({
        ordersGet: () =>
          Promise.resolve({
            order: {
              id: "order_no_meta",
              state: "COMPLETED",
            },
          }),
      });

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => Promise.resolve(client)),
        async () => {
          const result =
            await squarePaymentProvider.retrieveSession("order_no_meta");
          expect(result).toBeNull();
        },
      );
    });

    test("retrieveSession returns null for incomplete metadata", async () => {
      const { client } = createMockClient({
        ordersGet: () =>
          Promise.resolve({
            order: {
              id: "order_bad_meta",
              metadata: { email: "john@example.com" },
              state: "COMPLETED",
            },
          }),
      });

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => Promise.resolve(client)),
        async () => {
          const result =
            await squarePaymentProvider.retrieveSession("order_bad_meta");
          expect(result).toBeNull();
        },
      );
    });

    test("retrieveSession returns null when order not found", async () => {
      const { client } = createMockClient({
        ordersGet: () => Promise.resolve({ order: null }),
      });

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => Promise.resolve(client)),
        async () => {
          const result =
            await squarePaymentProvider.retrieveSession("order_gone");
          expect(result).toBeNull();
        },
      );
    });

    test("retrieveSession returns amountTotal from order totalMoney", async () => {
      const { client } = createMockClient({
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
      });

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => Promise.resolve(client)),
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
      const { client } = createMockClient({
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
      });

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => Promise.resolve(client)),
        async () => {
          const result =
            await squarePaymentProvider.retrieveSession("order_multi");
          expect(result).not.toBeNull();
          expect(result!.paymentStatus).toBe("paid");
          expect(result!.metadata.items).toBe(items);
        },
      );
    });

    test("createCheckoutSession passes through SDK results", async () => {
      const { client } = createMockClient({
        checkoutCreate: () =>
          Promise.resolve({
            paymentLink: {
              orderId: "order_prov",
              url: "https://square.link/prov",
            },
          }),
      });

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => Promise.resolve(client)),
        async () => {
          await settings.update.square.accessToken("EAAAl_test_123");
          await settings.update.square.locationId("L_loc_prov");
          const intent = {
            address: "",
            date: null,
            email: "john@example.com",
            items: [
              {
                listingId: 1,
                name: "Test",
                quantity: 1,
                slug: "test-listing",
                unitPrice: 1000,
              },
            ],
            name: "John",
            phone: "",
            special_instructions: "",
          };

          const result = await squarePaymentProvider.createCheckoutSession(
            intent,
            "http://localhost",
          );
          expect(result).not.toBeNull();
          expect(result).toHaveProperty("sessionId");
          const success = result as { sessionId: string; checkoutUrl: string };
          expect(success.sessionId).toBe("order_prov");
          expect(success.checkoutUrl).toBe("https://square.link/prov");
        },
      );
    });

    test("createCheckoutSession passes through SDK results", async () => {
      const { client } = createMockClient({
        checkoutCreate: () =>
          Promise.resolve({
            paymentLink: {
              orderId: "order_mprov",
              url: "https://square.link/mprov",
            },
          }),
      });

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => Promise.resolve(client)),
        async () => {
          await settings.update.square.accessToken("EAAAl_test_123");
          await settings.update.square.locationId("L_loc_prov");
          const intent = {
            address: "",
            date: null,
            email: "john@example.com",
            items: [
              {
                listingId: 1,
                name: "Listing 1",
                quantity: 1,
                slug: "listing-1",
                unitPrice: 1000,
              },
            ],
            name: "John",
            phone: "",
            special_instructions: "",
          };

          const result = await squarePaymentProvider.createCheckoutSession(
            intent,
            "http://localhost",
          );
          expect(result).not.toBeNull();
          expect(result).toHaveProperty("sessionId");
          const success = result as { sessionId: string; checkoutUrl: string };
          expect(success.sessionId).toBe("order_mprov");
          expect(success.checkoutUrl).toBe("https://square.link/mprov");
        },
      );
    });

    test("refundPayment delegates through SDK", async () => {
      const { client } = createMockClient({
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
            refund: { id: "refund_prov", status: "PENDING" },
          }),
      });

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => Promise.resolve(client)),
        async () => {
          const result =
            await squarePaymentProvider.refundPayment("pay_prov_ref");
          expect(result).toBe(true);
        },
      );
    });

    test("verifyWebhookSignature delegates with notification URL", async () => {
      // Without a real key configured, verification should fail
      const body = '{"test": true}';
      const result = await squarePaymentProvider.verifyWebhookSignature(
        body,
        "fakesig",
        "https://example.com/payment/webhook",
        new TextEncoder().encode(body),
      );
      expect(result.valid).toBe(false);
    });
  });
});
