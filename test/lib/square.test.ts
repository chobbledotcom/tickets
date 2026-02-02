import { afterEach, beforeEach, describe, expect, jest, test, spyOn } from "#test-compat";
import {
  constructTestWebhookEvent,
  enforceMetadataLimits,
  getSquareClient,
  resetSquareClient,
  retrievePayment,
  squareApi,
  verifyWebhookSignature,
} from "#lib/square.ts";
import { squarePaymentProvider } from "#lib/square-provider.ts";
import type { WebhookEvent } from "#lib/payments.ts";
import {
  updateSquareAccessToken,
  updateSquareLocationId,
  updateSquareWebhookSignatureKey,
} from "#lib/db/settings.ts";
import { createTestDb, resetDb, testEvent, withMocks } from "#test-utils";

/** Create a mock Square SDK client with spyable methods */
const createMockClient = () => {
  const checkoutCreate = jest.fn();
  const ordersGet = jest.fn();
  const paymentsGet = jest.fn();
  const refundsRefundPayment = jest.fn();

  return {
    client: {
      checkout: { paymentLinks: { create: checkoutCreate } },
      orders: { get: ordersGet },
      payments: { get: paymentsGet },
      refunds: { refundPayment: refundsRefundPayment },
    },
    checkoutCreate,
    ordersGet,
    paymentsGet,
    refundsRefundPayment,
  };
};

describe("square", () => {
  beforeEach(async () => {
    resetSquareClient();
    await createTestDb();
  });

  afterEach(() => {
    resetSquareClient();
    resetDb();
  });

  describe("getSquareClient", () => {
    test("returns null when access token not set", async () => {
      const client = await getSquareClient();
      expect(client).toBeNull();
    });

    test("returns client when access token is set in database", async () => {
      await updateSquareAccessToken("EAAAl_test_123");
      const client = await getSquareClient();
      expect(client).not.toBeNull();
    });

    test("returns cached client on second call with same token", async () => {
      await updateSquareAccessToken("EAAAl_cache_test");
      const client1 = await getSquareClient();
      expect(client1).not.toBeNull();

      // Second call with same token should use cached path
      const client2 = await getSquareClient();
      expect(client2).not.toBeNull();
    });
  });

  describe("resetSquareClient", () => {
    test("resets client state after token removed from db", async () => {
      await updateSquareAccessToken("EAAAl_test_123");
      const client1 = await getSquareClient();
      expect(client1).not.toBeNull();

      resetSquareClient();
      resetDb();
      await createTestDb();

      const client2 = await getSquareClient();
      expect(client2).toBeNull();
    });
  });

  describe("enforceMetadataLimits", () => {
    test("returns metadata unchanged when all values within limit", () => {
      const metadata = { event_id: "1", name: "John", email: "john@example.com", quantity: "2" };
      expect(enforceMetadataLimits(metadata)).toEqual(metadata);
    });

    test("truncates name to 255 characters", () => {
      const longName = "A".repeat(300);
      const metadata = { event_id: "1", name: longName, email: "john@example.com", quantity: "1" };
      const result = enforceMetadataLimits(metadata);
      expect(result).not.toBeNull();
      expect(result!.name).toBe("A".repeat(255));
      expect(result!.name!.length).toBe(255);
      expect(result!.event_id).toBe("1");
    });

    test("returns null when non-truncatable value exceeds limit", () => {
      const longItems = "[" + "{e:1,q:1},".repeat(50) + "]";
      const metadata = { multi: "1", name: "John", email: "john@example.com", items: longItems };
      expect(enforceMetadataLimits(metadata)).toBeNull();
    });

    test("returns null when email exceeds limit", () => {
      const longEmail = "a".repeat(300) + "@example.com";
      const metadata = { event_id: "1", name: "John", email: longEmail, quantity: "1" };
      expect(enforceMetadataLimits(metadata)).toBeNull();
    });

    test("passes through metadata with exactly 255-char values", () => {
      const exactName = "A".repeat(255);
      const metadata = { event_id: "1", name: exactName, email: "john@example.com" };
      const result = enforceMetadataLimits(metadata);
      expect(result).toEqual(metadata);
    });
  });

  describe("createPaymentLink", () => {
    test("returns null when access token not set", async () => {
      const event = {
        id: 1,
        slug: "test-event",
        slug_index: "test-event-index",
        name: "Test Event",
        description: "Test Description",
        created: new Date().toISOString(),
        max_attendees: 50,
        thank_you_url: "https://example.com/thanks",
        unit_price: 1000,
        max_quantity: 1,
        webhook_url: null,
        active: 1,
        fields: "email" as const,
        closes_at: null,
      };
      const intent = {
        eventId: 1,
        name: "John Doe",
        email: "john@example.com",
        phone: "",
        quantity: 1,
      };
      const result = await squareApi.createPaymentLink(
        event,
        intent,
        "http://localhost",
      );
      expect(result).toBeNull();
    });

    test("returns null when unit_price is null", async () => {
      await updateSquareAccessToken("EAAAl_test_123");
      await updateSquareLocationId("L_test_123");
      const event = {
        id: 1,
        slug: "test-event",
        slug_index: "test-event-index",
        name: "Test",
        description: "Desc",
        created: new Date().toISOString(),
        max_attendees: 50,
        thank_you_url: "https://example.com",
        unit_price: null,
        max_quantity: 1,
        webhook_url: null,
        active: 1,
        fields: "email" as const,
        closes_at: null,
      };
      const intent = {
        eventId: 1,
        name: "John",
        email: "john@example.com",
        phone: "",
        quantity: 1,
      };
      const result = await squareApi.createPaymentLink(
        event,
        intent,
        "http://localhost",
      );
      expect(result).toBeNull();
    });

    test("returns null when location ID not configured", async () => {
      await updateSquareAccessToken("EAAAl_test_123");
      // No location ID set
      const event = {
        id: 1,
        slug: "test-event",
        slug_index: "test-event-index",
        name: "Test",
        description: "Desc",
        created: new Date().toISOString(),
        max_attendees: 50,
        thank_you_url: "https://example.com",
        unit_price: 1000,
        max_quantity: 1,
        webhook_url: null,
        active: 1,
        fields: "email" as const,
        closes_at: null,
      };
      const intent = {
        eventId: 1,
        name: "John",
        email: "john@example.com",
        phone: "",
        quantity: 1,
      };
      const result = await squareApi.createPaymentLink(
        event,
        intent,
        "http://localhost",
      );
      expect(result).toBeNull();
    });

    test("constructs correct SDK call for single-event checkout", async () => {
      await updateSquareAccessToken("EAAAl_test_123");
      await updateSquareLocationId("L_loc_456");
      const { client, checkoutCreate } = createMockClient();
      checkoutCreate.mockResolvedValue({
        paymentLink: { orderId: "order_abc", url: "https://square.link/abc" },
      });

      await withMocks(
        () => spyOn(squareApi, "getSquareClient").mockResolvedValue(client),
        async () => {
          const event = {
            id: 7,
            slug: "concert-2025",
            slug_index: "concert-2025-index",
            name: "Concert",
            description: "A concert",
            created: new Date().toISOString(),
            max_attendees: 100,
            thank_you_url: "https://example.com/thanks",
            unit_price: 2500,
            max_quantity: 4,
            webhook_url: null,
            active: 1,
            fields: "email" as const,
            closes_at: null,
          };
          const intent = {
            eventId: 7,
            name: "Jane Smith",
            email: "jane@example.com",
            phone: "555-9876",
            quantity: 3,
          };

          const result = await squareApi.createPaymentLink(
            event,
            intent,
            "https://tickets.example.com",
          );

          expect(result).not.toBeNull();
          expect(result!.orderId).toBe("order_abc");
          expect(result!.url).toBe("https://square.link/abc");

          // Verify SDK was called with correctly constructed order
          // deno-lint-ignore no-explicit-any
          const args = checkoutCreate.mock.calls[0]![0] as any;
          expect(args.order.locationId).toBe("L_loc_456");
          expect(args.order.lineItems).toHaveLength(1);
          expect(args.order.lineItems[0].name).toBe("Ticket: Concert");
          expect(args.order.lineItems[0].quantity).toBe("3");
          expect(args.order.lineItems[0].basePriceMoney.amount).toBe(BigInt(2500));
          expect(args.order.lineItems[0].note).toBe("3 Tickets");

          // Verify metadata includes intent fields
          expect(args.order.metadata.event_id).toBe("7");
          expect(args.order.metadata.name).toBe("Jane Smith");
          expect(args.order.metadata.email).toBe("jane@example.com");
          expect(args.order.metadata.phone).toBe("555-9876");
          expect(args.order.metadata.quantity).toBe("3");

          // Verify checkout options
          expect(args.checkoutOptions.redirectUrl).toBe(
            "https://tickets.example.com/payment/success?session_id={ORDER_ID}",
          );

          // Verify pre-populated data
          expect(args.prePopulatedData.buyerEmail).toBe("jane@example.com");
          expect(args.prePopulatedData.buyerPhoneNumber).toBe("555-9876");

          // Verify idempotency key is present
          expect(typeof args.idempotencyKey).toBe("string");
          expect(args.idempotencyKey.length).toBeGreaterThan(0);
        },
      );
    });

    test("omits phone from pre-populated data when empty", async () => {
      await updateSquareAccessToken("EAAAl_test_123");
      await updateSquareLocationId("L_loc_456");
      const { client, checkoutCreate } = createMockClient();
      checkoutCreate.mockResolvedValue({
        paymentLink: { orderId: "order_xyz", url: "https://square.link/xyz" },
      });

      await withMocks(
        () => spyOn(squareApi, "getSquareClient").mockResolvedValue(client),
        async () => {
          const event = {
            id: 1,
            slug: "test-event",
            slug_index: "test-event-index",
            name: "Test",
            description: "Desc",
            created: new Date().toISOString(),
            max_attendees: 50,
            thank_you_url: "https://example.com",
            unit_price: 1000,
            max_quantity: 1,
            webhook_url: null,
            active: 1,
            fields: "email" as const,
            closes_at: null,
          };
          const intent = {
            eventId: 1,
            name: "John",
            email: "john@example.com",
            phone: "",
            quantity: 1,
          };

          await squareApi.createPaymentLink(event, intent, "http://localhost");

          // deno-lint-ignore no-explicit-any
          const args = checkoutCreate.mock.calls[0]![0] as any;
          expect(args.prePopulatedData.buyerPhoneNumber).toBeUndefined();
          expect(args.order.metadata.phone).toBeUndefined();
          expect(args.order.lineItems[0].note).toBe("Ticket");
        },
      );
    });

    test("returns null when SDK response missing orderId", async () => {
      await updateSquareAccessToken("EAAAl_test_123");
      await updateSquareLocationId("L_loc_456");
      const { client, checkoutCreate } = createMockClient();
      checkoutCreate.mockResolvedValue({
        paymentLink: { url: "https://square.link/abc" },
      });

      await withMocks(
        () => spyOn(squareApi, "getSquareClient").mockResolvedValue(client),
        async () => {
          const event = {
            id: 1,
            slug: "test-event",
            slug_index: "test-event-index",
            name: "Test",
            description: "Desc",
            created: new Date().toISOString(),
            max_attendees: 50,
            thank_you_url: "https://example.com",
            unit_price: 1000,
            max_quantity: 1,
            webhook_url: null,
            active: 1,
            fields: "email" as const,
            closes_at: null,
          };
          const intent = {
            eventId: 1,
            name: "John",
            email: "john@example.com",
            phone: "",
            quantity: 1,
          };

          const result = await squareApi.createPaymentLink(
            event,
            intent,
            "http://localhost",
          );
          expect(result).toBeNull();
        },
      );
    });

    test("returns null when name exceeds metadata limit but truncates gracefully", async () => {
      await updateSquareAccessToken("EAAAl_test_123");
      await updateSquareLocationId("L_loc_456");
      const { client, checkoutCreate } = createMockClient();
      checkoutCreate.mockResolvedValue({
        paymentLink: { orderId: "order_long_name", url: "https://square.link/long" },
      });

      await withMocks(
        () => spyOn(squareApi, "getSquareClient").mockResolvedValue(client),
        async () => {
          const event = {
            id: 1,
            slug: "test-event",
            slug_index: "test-event-index",
            name: "Test",
            description: "Desc",
            created: new Date().toISOString(),
            max_attendees: 50,
            thank_you_url: "https://example.com",
            unit_price: 1000,
            max_quantity: 1,
            webhook_url: null,
            active: 1,
            fields: "email" as const,
            closes_at: null,
          };
          const intent = {
            eventId: 1,
            name: "A".repeat(300),
            email: "john@example.com",
            phone: "",
            quantity: 1,
          };

          const result = await squareApi.createPaymentLink(
            event,
            intent,
            "http://localhost",
          );
          expect(result).not.toBeNull();

          // Verify name was truncated in metadata
          // deno-lint-ignore no-explicit-any
          const args = checkoutCreate.mock.calls[0]![0] as any;
          expect(args.order.metadata.name.length).toBe(255);
        },
      );
    });

    test("returns null when non-truncatable metadata exceeds limit", async () => {
      await updateSquareAccessToken("EAAAl_test_123");
      await updateSquareLocationId("L_loc_456");
      const { client } = createMockClient();

      await withMocks(
        () => spyOn(squareApi, "getSquareClient").mockResolvedValue(client),
        async () => {
          const event = testEvent({
            unit_price: 1000,
            fields: "email" as const,
          });
          const intent = {
            eventId: 1,
            name: "John",
            email: "a".repeat(300) + "@example.com",
            phone: "",
            quantity: 1,
          };

          const result = await squareApi.createPaymentLink(
            event,
            intent,
            "http://localhost",
          );
          expect(result).toBeNull();
        },
      );
    });
  });

  describe("createMultiPaymentLink", () => {
    test("returns null when access token not set", async () => {
      const intent = {
        name: "John Doe",
        email: "john@example.com",
        phone: "",
        items: [
          { eventId: 1, quantity: 1, unitPrice: 1000, slug: "event-1", name: "Event 1" },
          { eventId: 2, quantity: 2, unitPrice: 500, slug: "event-2", name: "Event 2" },
        ],
      };
      const result = await squareApi.createMultiPaymentLink(
        intent,
        "http://localhost",
      );
      expect(result).toBeNull();
    });

    test("returns null when location ID not configured", async () => {
      await updateSquareAccessToken("EAAAl_test_123");
      const intent = {
        name: "John Doe",
        email: "john@example.com",
        phone: "",
        items: [
          { eventId: 1, quantity: 1, unitPrice: 1000, slug: "event-1", name: "Event 1" },
        ],
      };
      const result = await squareApi.createMultiPaymentLink(
        intent,
        "http://localhost",
      );
      expect(result).toBeNull();
    });

    test("returns null when SDK response missing orderId", async () => {
      await updateSquareAccessToken("EAAAl_test_123");
      await updateSquareLocationId("L_multi_loc");
      const { client, checkoutCreate } = createMockClient();
      checkoutCreate.mockResolvedValue({
        paymentLink: { url: "https://square.link/multi" },
      });

      await withMocks(
        () => spyOn(squareApi, "getSquareClient").mockResolvedValue(client),
        async () => {
          const intent = {
            name: "Bob Missing",
            email: "bob@example.com",
            phone: "",
            items: [
              { eventId: 1, quantity: 1, unitPrice: 1000, slug: "event-1", name: "Event 1" },
            ],
          };

          const result = await squareApi.createMultiPaymentLink(
            intent,
            "http://localhost",
          );
          expect(result).toBeNull();
        },
      );
    });

    test("constructs correct SDK call with multiple line items", async () => {
      await updateSquareAccessToken("EAAAl_test_123");
      await updateSquareLocationId("L_multi_loc");
      const { client, checkoutCreate } = createMockClient();
      checkoutCreate.mockResolvedValue({
        paymentLink: { orderId: "order_multi", url: "https://square.link/multi" },
      });

      await withMocks(
        () => spyOn(squareApi, "getSquareClient").mockResolvedValue(client),
        async () => {
          const intent = {
            name: "Alice Wonder",
            email: "alice@example.com",
            phone: "555-1111",
            items: [
              { eventId: 10, quantity: 2, unitPrice: 1500, slug: "workshop-a", name: "Workshop A" },
              { eventId: 20, quantity: 1, unitPrice: 3000, slug: "gala-dinner", name: "Gala Dinner" },
            ],
          };

          const result = await squareApi.createMultiPaymentLink(
            intent,
            "https://tickets.example.com",
          );

          expect(result).not.toBeNull();
          expect(result!.orderId).toBe("order_multi");
          expect(result!.url).toBe("https://square.link/multi");

          // deno-lint-ignore no-explicit-any
          const args = checkoutCreate.mock.calls[0]![0] as any;

          // Verify multiple line items
          expect(args.order.lineItems).toHaveLength(2);
          expect(args.order.lineItems[0].name).toBe("Ticket: Workshop A");
          expect(args.order.lineItems[0].quantity).toBe("2");
          expect(args.order.lineItems[0].basePriceMoney.amount).toBe(BigInt(1500));
          expect(args.order.lineItems[0].note).toBe("2 Tickets");

          expect(args.order.lineItems[1].name).toBe("Ticket: Gala Dinner");
          expect(args.order.lineItems[1].quantity).toBe("1");
          expect(args.order.lineItems[1].basePriceMoney.amount).toBe(BigInt(3000));
          expect(args.order.lineItems[1].note).toBe("Ticket");

          // Verify multi-intent metadata
          expect(args.order.metadata.multi).toBe("1");
          expect(args.order.metadata.name).toBe("Alice Wonder");
          expect(args.order.metadata.email).toBe("alice@example.com");
          expect(args.order.metadata.phone).toBe("555-1111");
          const items = JSON.parse(args.order.metadata.items);
          expect(items).toHaveLength(2);
          expect(items[0]).toEqual({ e: 10, q: 2 });
          expect(items[1]).toEqual({ e: 20, q: 1 });

          // Verify location and checkout options
          expect(args.order.locationId).toBe("L_multi_loc");
          expect(args.checkoutOptions.redirectUrl).toBe(
            "https://tickets.example.com/payment/success?session_id={ORDER_ID}",
          );
          expect(args.prePopulatedData.buyerEmail).toBe("alice@example.com");
          expect(args.prePopulatedData.buyerPhoneNumber).toBe("555-1111");
        },
      );
    });

    test("returns null when items metadata exceeds Square limit", async () => {
      await updateSquareAccessToken("EAAAl_test_123");
      await updateSquareLocationId("L_multi_loc");
      const { client, checkoutCreate } = createMockClient();

      await withMocks(
        () => spyOn(squareApi, "getSquareClient").mockResolvedValue(client),
        async () => {
          // Generate enough items to exceed 255-char serialized metadata
          const items = Array.from({ length: 30 }, (_, i) => ({
            eventId: i + 1,
            quantity: 1,
            unitPrice: 1000,
            slug: `event-${i + 1}`,
            name: `Event ${i + 1}`,
          }));

          const intent = {
            name: "Alice",
            email: "alice@example.com",
            phone: "",
            items,
          };

          const result = await squareApi.createMultiPaymentLink(
            intent,
            "https://tickets.example.com",
          );

          // Should return null because items JSON exceeds 255 chars
          expect(result).toBeNull();
          // SDK should never have been called
          expect(checkoutCreate).not.toHaveBeenCalled();
        },
      );
    });
  });

  describe("retrieveOrder", () => {
    test("returns null when access token not set", async () => {
      const result = await squareApi.retrieveOrder("order_123");
      expect(result).toBeNull();
    });

    test("returns null when SDK returns no order", async () => {
      const { client, ordersGet } = createMockClient();
      ordersGet.mockResolvedValue({ order: null });

      await withMocks(
        () => spyOn(squareApi, "getSquareClient").mockResolvedValue(client),
        async () => {
          const result = await squareApi.retrieveOrder("order_missing");
          expect(result).toBeNull();
          expect(ordersGet.mock.calls[0]![0]).toEqual({ orderId: "order_missing" });
        },
      );
    });

    test("maps tender paymentId correctly", async () => {
      const { client, ordersGet } = createMockClient();
      ordersGet.mockResolvedValue({
        order: {
          id: "order_tenders",
          metadata: { event_id: "1", name: "John", email: "john@example.com" },
          state: "COMPLETED",
          tenders: [
            { id: "tender_1", paymentId: "pay_abc" },
            { id: "tender_2", paymentId: null },
          ],
        },
      });

      await withMocks(
        () => spyOn(squareApi, "getSquareClient").mockResolvedValue(client),
        async () => {
          const result = await squareApi.retrieveOrder("order_tenders");
          expect(result).not.toBeNull();
          expect(result!.tenders).toHaveLength(2);
          expect(result!.tenders![0]!.paymentId).toBe("pay_abc");
          expect(result!.tenders![1]!.paymentId).toBeUndefined();
        },
      );
    });

    test("returns correct shape with state and id", async () => {
      const { client, ordersGet } = createMockClient();
      ordersGet.mockResolvedValue({
        order: {
          id: "order_shape",
          metadata: undefined,
          state: "OPEN",
          tenders: undefined,
        },
      });

      await withMocks(
        () => spyOn(squareApi, "getSquareClient").mockResolvedValue(client),
        async () => {
          const result = await squareApi.retrieveOrder("order_shape");
          expect(result).not.toBeNull();
          expect(result!.id).toBe("order_shape");
          expect(result!.state).toBe("OPEN");
          expect(result!.metadata).toBeUndefined();
          expect(result!.tenders).toBeUndefined();
        },
      );
    });
  });

  describe("retrievePayment", () => {
    test("returns null when access token not set", async () => {
      const result = await squareApi.retrievePayment("pay_123");
      expect(result).toBeNull();
    });

    test("returns null when SDK returns no payment", async () => {
      const { client, paymentsGet } = createMockClient();
      paymentsGet.mockResolvedValue({ payment: null });

      await withMocks(
        () => spyOn(squareApi, "getSquareClient").mockResolvedValue(client),
        async () => {
          const result = await squareApi.retrievePayment("pay_missing");
          expect(result).toBeNull();
          expect(paymentsGet.mock.calls[0]![0]).toEqual({ paymentId: "pay_missing" });
        },
      );
    });

    test("maps payment fields correctly from SDK response", async () => {
      const { client, paymentsGet } = createMockClient();
      paymentsGet.mockResolvedValue({
        payment: {
          id: "pay_full",
          status: "COMPLETED",
          orderId: "order_999",
          amountMoney: {
            amount: BigInt(5000),
            currency: "GBP",
          },
        },
      });

      await withMocks(
        () => spyOn(squareApi, "getSquareClient").mockResolvedValue(client),
        async () => {
          const result = await squareApi.retrievePayment("pay_full");
          expect(result).not.toBeNull();
          expect(result!.id).toBe("pay_full");
          expect(result!.status).toBe("COMPLETED");
          expect(result!.orderId).toBe("order_999");
          expect(result!.amountMoney!.amount).toBe(BigInt(5000));
          expect(result!.amountMoney!.currency).toBe("GBP");
        },
      );
    });

  });

  describe("retrievePayment wrapper export", () => {
    test("delegates to squareApi.retrievePayment", async () => {
      const { client, paymentsGet } = createMockClient();
      paymentsGet.mockResolvedValue({
        payment: {
          id: "pay_wrapper",
          status: "COMPLETED",
          orderId: "order_wrapper",
          amountMoney: { amount: BigInt(1000), currency: "USD" },
        },
      });

      await withMocks(
        () => spyOn(squareApi, "getSquareClient").mockResolvedValue(client),
        async () => {
          const result = await retrievePayment("pay_wrapper");
          expect(result).not.toBeNull();
          expect(result!.id).toBe("pay_wrapper");
          expect(result!.status).toBe("COMPLETED");
          expect(paymentsGet.mock.calls[0]![0]).toEqual({ paymentId: "pay_wrapper" });
        },
      );
    });
  });

  describe("refundPayment", () => {
    test("returns false when access token not set", async () => {
      const result = await squareApi.refundPayment("pay_123");
      expect(result).toBe(false);
    });

    test("returns false when payment retrieval returns null", async () => {
      await withMocks(
        () =>
          spyOn(squareApi, "retrievePayment")
            .mockResolvedValue(null),
        async () => {
          const result = await squareApi.refundPayment("pay_123");
          expect(result).toBe(false);
        },
      );
    });

    test("calls SDK refund with correct amount from payment", async () => {
      const { client, paymentsGet, refundsRefundPayment } = createMockClient();
      paymentsGet.mockResolvedValue({
        payment: {
          id: "pay_refund_me",
          status: "COMPLETED",
          orderId: "order_refund",
          amountMoney: { amount: BigInt(4200), currency: "USD" },
        },
      });
      refundsRefundPayment.mockResolvedValue({
        refund: { id: "refund_123", status: "PENDING" },
      });

      await withMocks(
        () => spyOn(squareApi, "getSquareClient").mockResolvedValue(client),
        async () => {
          const result = await squareApi.refundPayment("pay_refund_me");
          expect(result).toBe(true);

          // Verify payments.get was called to fetch amount
          expect(paymentsGet.mock.calls[0]![0]).toEqual({ paymentId: "pay_refund_me" });

          // Verify refund was called with correct amount and payment ID
          // deno-lint-ignore no-explicit-any
          const refundArgs = refundsRefundPayment.mock.calls[0]![0] as any;
          expect(refundArgs.paymentId).toBe("pay_refund_me");
          expect(refundArgs.amountMoney.amount).toBe(BigInt(4200));
          expect(refundArgs.amountMoney.currency).toBe("USD");
          expect(typeof refundArgs.idempotencyKey).toBe("string");
          expect(refundArgs.idempotencyKey.length).toBeGreaterThan(0);
        },
      );
    });

    test("returns false when refund SDK call throws", async () => {
      const { client, paymentsGet, refundsRefundPayment } = createMockClient();
      paymentsGet.mockResolvedValue({
        payment: {
          id: "pay_fail",
          status: "COMPLETED",
          orderId: "order_fail",
          amountMoney: { amount: BigInt(1000), currency: "GBP" },
        },
      });
      refundsRefundPayment.mockRejectedValue(new Error("Square API error"));

      await withMocks(
        () => spyOn(squareApi, "getSquareClient").mockResolvedValue(client),
        async () => {
          const result = await squareApi.refundPayment("pay_fail");
          expect(result).toBe(false);
        },
      );
    });
  });

  describe("verifyWebhookSignature", () => {
    const TEST_SECRET = "square_test_signature_key";
    const TEST_NOTIFICATION_URL = "https://example.com/payment/webhook";

    beforeEach(async () => {
      await updateSquareWebhookSignatureKey(TEST_SECRET);
    });

    test("returns error when webhook signature key not configured", async () => {
      await resetDb();
      await createTestDb();
      const result = await verifyWebhookSignature(
        '{"test": true}',
        "somesig",
        TEST_NOTIFICATION_URL,
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe("Webhook signature key not configured");
      }
    });

    test("returns error when notification URL not provided", async () => {
      const result = await verifyWebhookSignature(
        '{"test": true}',
        "somesig",
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe("Notification URL required for verification");
      }
    });

    test("returns error for invalid signature", async () => {
      const result = await verifyWebhookSignature(
        '{"test": true}',
        "invalidsignature",
        TEST_NOTIFICATION_URL,
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe("Signature verification failed");
      }
    });

    test("returns error for invalid JSON payload with valid signature", async () => {
      const payload = "not valid json {{{";
      const { signature } = await constructTestWebhookEvent(
        // We'll sign the raw payload by constructing manually
        { id: "dummy", type: "dummy", data: { object: {} } },
        TEST_SECRET,
        TEST_NOTIFICATION_URL,
      );

      // Generate correct signature for invalid JSON payload
      const signedPayload = TEST_NOTIFICATION_URL + payload;
      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(TEST_SECRET),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const sig = await crypto.subtle.sign(
        "HMAC",
        key,
        encoder.encode(signedPayload),
      );
      const sigBase64 = btoa(String.fromCharCode(...new Uint8Array(sig)));

      // Use the underscore prefix to suppress unused var lint
      void signature;

      const result = await verifyWebhookSignature(
        payload,
        sigBase64,
        TEST_NOTIFICATION_URL,
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe("Invalid JSON payload");
      }
    });

    test("verifies valid signature successfully", async () => {
      const event: WebhookEvent = {
        id: "evt_square_123",
        type: "payment.updated",
        data: {
          object: {
            id: "pay_123",
            status: "COMPLETED",
            order_id: "order_456",
          },
        },
      };

      const { payload, signature } = await constructTestWebhookEvent(
        event,
        TEST_SECRET,
        TEST_NOTIFICATION_URL,
      );

      const result = await verifyWebhookSignature(
        payload,
        signature,
        TEST_NOTIFICATION_URL,
      );
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.event.id).toBe("evt_square_123");
        expect(result.event.type).toBe("payment.updated");
      }
    });
  });

  describe("constructTestWebhookEvent", () => {
    test("creates valid payload and signature pair", async () => {
      const secret = "square_test_construction";
      const notificationUrl = "https://example.com/payment/webhook";
      const event: WebhookEvent = {
        id: "evt_constructed",
        type: "payment.updated",
        data: {
          object: {
            id: "pay_123",
            status: "COMPLETED",
          },
        },
      };

      const { payload, signature } = await constructTestWebhookEvent(
        event,
        secret,
        notificationUrl,
      );

      // Verify payload is valid JSON matching input
      const parsed = JSON.parse(payload);
      expect(parsed.id).toBe("evt_constructed");
      expect(parsed.type).toBe("payment.updated");

      // Signature should be base64-encoded
      expect(signature).toMatch(/^[A-Za-z0-9+/]+=*$/);

      // Signature should be verifiable with the same secret (stored in DB)
      await updateSquareWebhookSignatureKey(secret);
      const result = await verifyWebhookSignature(
        payload,
        signature,
        notificationUrl,
      );
      expect(result.valid).toBe(true);
    });
  });

  describe("squarePaymentProvider integration", () => {
    test("retrieveSession maps COMPLETED order to paid status", async () => {
      const { client, ordersGet } = createMockClient();
      ordersGet.mockResolvedValue({
        order: {
          id: "order_paid",
          metadata: {
            event_id: "1",
            name: "John Doe",
            email: "john@example.com",
            phone: "555-1234",
            quantity: "2",
          },
          tenders: [{ id: "tender_1", paymentId: "pay_abc" }],
          state: "COMPLETED",
        },
      });

      await withMocks(
        () => spyOn(squareApi, "getSquareClient").mockResolvedValue(client),
        async () => {
          const result = await squarePaymentProvider.retrieveSession("order_paid");
          expect(result).not.toBeNull();
          expect(result!.id).toBe("order_paid");
          expect(result!.paymentStatus).toBe("paid");
          expect(result!.paymentReference).toBe("pay_abc");
          expect(result!.metadata.event_id).toBe("1");
          expect(result!.metadata.name).toBe("John Doe");
          expect(result!.metadata.email).toBe("john@example.com");
          expect(result!.metadata.phone).toBe("555-1234");
          expect(result!.metadata.quantity).toBe("2");
        },
      );
    });

    test("retrieveSession maps OPEN order to unpaid status", async () => {
      const { client, ordersGet } = createMockClient();
      ordersGet.mockResolvedValue({
        order: {
          id: "order_open",
          metadata: {
            event_id: "1",
            name: "John",
            email: "john@example.com",
          },
          state: "OPEN",
        },
      });

      await withMocks(
        () => spyOn(squareApi, "getSquareClient").mockResolvedValue(client),
        async () => {
          const result = await squarePaymentProvider.retrieveSession("order_open");
          expect(result).not.toBeNull();
          expect(result!.paymentStatus).toBe("unpaid");
          expect(result!.paymentReference).toBeNull();
        },
      );
    });

    test("retrieveSession returns null for missing metadata", async () => {
      const { client, ordersGet } = createMockClient();
      ordersGet.mockResolvedValue({
        order: {
          id: "order_no_meta",
          state: "COMPLETED",
        },
      });

      await withMocks(
        () => spyOn(squareApi, "getSquareClient").mockResolvedValue(client),
        async () => {
          const result = await squarePaymentProvider.retrieveSession("order_no_meta");
          expect(result).toBeNull();
        },
      );
    });

    test("retrieveSession returns null for incomplete metadata", async () => {
      const { client, ordersGet } = createMockClient();
      ordersGet.mockResolvedValue({
        order: {
          id: "order_bad_meta",
          metadata: { email: "john@example.com" },
          state: "COMPLETED",
        },
      });

      await withMocks(
        () => spyOn(squareApi, "getSquareClient").mockResolvedValue(client),
        async () => {
          const result = await squarePaymentProvider.retrieveSession("order_bad_meta");
          expect(result).toBeNull();
        },
      );
    });

    test("retrieveSession returns null when order not found", async () => {
      const { client, ordersGet } = createMockClient();
      ordersGet.mockResolvedValue({ order: null });

      await withMocks(
        () => spyOn(squareApi, "getSquareClient").mockResolvedValue(client),
        async () => {
          const result = await squarePaymentProvider.retrieveSession("order_gone");
          expect(result).toBeNull();
        },
      );
    });

    test("retrieveSession handles multi-ticket order", async () => {
      const items = JSON.stringify([{ e: 1, q: 2 }, { e: 2, q: 1 }]);
      const { client, ordersGet } = createMockClient();
      ordersGet.mockResolvedValue({
        order: {
          id: "order_multi",
          metadata: {
            multi: "1",
            name: "John",
            email: "john@example.com",
            items,
          },
          tenders: [{ id: "tender_1", paymentId: "pay_multi" }],
          state: "COMPLETED",
        },
      });

      await withMocks(
        () => spyOn(squareApi, "getSquareClient").mockResolvedValue(client),
        async () => {
          const result = await squarePaymentProvider.retrieveSession("order_multi");
          expect(result).not.toBeNull();
          expect(result!.paymentStatus).toBe("paid");
          expect(result!.metadata.multi).toBe("1");
          expect(result!.metadata.items).toBe(items);
        },
      );
    });

    test("createCheckoutSession passes through SDK results", async () => {
      const { client, checkoutCreate } = createMockClient();
      checkoutCreate.mockResolvedValue({
        paymentLink: { orderId: "order_prov", url: "https://square.link/prov" },
      });

      await withMocks(
        () => spyOn(squareApi, "getSquareClient").mockResolvedValue(client),
        async () => {
          await updateSquareAccessToken("EAAAl_test_123");
          await updateSquareLocationId("L_loc_prov");
          const event = {
            id: 1,
            slug: "test-event",
            slug_index: "test-event-index",
            name: "Test",
            description: "Desc",
            created: new Date().toISOString(),
            max_attendees: 50,
            thank_you_url: "https://example.com",
            unit_price: 1000,
            max_quantity: 1,
            webhook_url: null,
            active: 1,
            fields: "email" as const,
            closes_at: null,
          };
          const intent = {
            eventId: 1,
            name: "John",
            email: "john@example.com",
            phone: "",
            quantity: 1,
          };

          const result = await squarePaymentProvider.createCheckoutSession(
            event,
            intent,
            "http://localhost",
          );
          expect(result).not.toBeNull();
          expect(result!.sessionId).toBe("order_prov");
          expect(result!.checkoutUrl).toBe("https://square.link/prov");
        },
      );
    });

    test("createMultiCheckoutSession passes through SDK results", async () => {
      const { client, checkoutCreate } = createMockClient();
      checkoutCreate.mockResolvedValue({
        paymentLink: { orderId: "order_mprov", url: "https://square.link/mprov" },
      });

      await withMocks(
        () => spyOn(squareApi, "getSquareClient").mockResolvedValue(client),
        async () => {
          await updateSquareAccessToken("EAAAl_test_123");
          await updateSquareLocationId("L_loc_prov");
          const intent = {
            name: "John",
            email: "john@example.com",
            phone: "",
            items: [
              { eventId: 1, quantity: 1, unitPrice: 1000, slug: "event-1", name: "Event 1" },
            ],
          };

          const result = await squarePaymentProvider.createMultiCheckoutSession(
            intent,
            "http://localhost",
          );
          expect(result).not.toBeNull();
          expect(result!.sessionId).toBe("order_mprov");
          expect(result!.checkoutUrl).toBe("https://square.link/mprov");
        },
      );
    });

    test("refundPayment delegates through SDK", async () => {
      const { client, paymentsGet, refundsRefundPayment } = createMockClient();
      paymentsGet.mockResolvedValue({
        payment: {
          id: "pay_prov_ref",
          status: "COMPLETED",
          orderId: "order_prov_ref",
          amountMoney: { amount: BigInt(2000), currency: "GBP" },
        },
      });
      refundsRefundPayment.mockResolvedValue({
        refund: { id: "refund_prov", status: "PENDING" },
      });

      await withMocks(
        () => spyOn(squareApi, "getSquareClient").mockResolvedValue(client),
        async () => {
          const result = await squarePaymentProvider.refundPayment("pay_prov_ref");
          expect(result).toBe(true);
        },
      );
    });

    test("verifyWebhookSignature delegates with notification URL", async () => {
      // Without a real key configured, verification should fail
      const result = await squarePaymentProvider.verifyWebhookSignature(
        '{"test": true}',
        "fakesig",
      );
      expect(result.valid).toBe(false);
    });
  });
});
