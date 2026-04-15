import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";
import { settings } from "#lib/db/settings.ts";
import { PaymentUserError } from "#lib/payment-helpers.ts";
import type { WebhookEvent } from "#lib/payments.ts";
import {
  type CreatePaymentLinkInput,
  constructTestWebhookEvent,
  getSquareClient,
  type RefundPaymentInput,
  resetSquareClient,
  retrievePayment,
  type SquareClient,
  squareApi,
  testSquareConnection,
  verifyWebhookSignature,
} from "#lib/square.ts";
import { squarePaymentProvider } from "#lib/square-provider.ts";
import { createTestDb, resetDb, testEvent, withMocks } from "#test-utils";

/** Mock implementation function type (accepts unknown args, returns unknown) */
type MockFn = (...args: unknown[]) => unknown;

/** Create a mock Square SDK client with spyable methods */
const createMockClient = (
  impls: {
    checkoutCreate?: MockFn;
    ordersGet?: MockFn;
    paymentsGet?: MockFn;
    refundsRefundPayment?: MockFn;
    locationsList?: MockFn;
  } = {},
) => {
  const noop: MockFn = () => undefined;
  const checkoutCreate = spy(impls.checkoutCreate ?? noop);
  const ordersGet = spy(impls.ordersGet ?? noop);
  const paymentsGet = spy(impls.paymentsGet ?? noop);
  const refundsRefundPayment = spy(impls.refundsRefundPayment ?? noop);
  const locationsList = spy(impls.locationsList ?? noop);

  return {
    checkoutCreate,
    client: {
      checkout: { paymentLinks: { create: checkoutCreate } },
      locations: { list: locationsList },
      orders: { get: ordersGet },
      payments: { get: paymentsGet },
      refunds: { refundPayment: refundsRefundPayment },
    } as unknown as SquareClient,
    locationsList,
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
      await settings.update.square.accessToken("EAAAl_test_123");
      const client = await getSquareClient();
      expect(client).not.toBeNull();
    });

    test("returns cached client on second call with same token", async () => {
      await settings.update.square.accessToken("EAAAl_cache_test");
      const client1 = await getSquareClient();
      expect(client1).not.toBeNull();

      // Second call with same token should use cached path
      const client2 = await getSquareClient();
      expect(client2).not.toBeNull();
    });

    test("returns client in sandbox mode when sandbox setting enabled", async () => {
      await settings.update.square.accessToken("EAAAl_sandbox_123");
      await settings.update.square.sandbox(true);
      const client = await getSquareClient();
      expect(client).not.toBeNull();
    });

    test("recreates client when sandbox setting changes", async () => {
      await settings.update.square.accessToken("EAAAl_sandbox_toggle");
      await settings.update.square.sandbox(false);
      const client1 = await getSquareClient();
      expect(client1).not.toBeNull();

      // Toggle sandbox mode - should create new client
      await settings.update.square.sandbox(true);
      const client2 = await getSquareClient();
      expect(client2).not.toBeNull();
    });
  });

  describe("resetSquareClient", () => {
    test("resets client state after token removed from db", async () => {
      await settings.update.square.accessToken("EAAAl_test_123");
      const client1 = await getSquareClient();
      expect(client1).not.toBeNull();

      resetSquareClient();
      resetDb();
      await createTestDb();

      const client2 = await getSquareClient();
      expect(client2).toBeNull();
    });
  });

  describe("testSquareConnection", () => {
    test("returns error when no access token configured", async () => {
      const result = await testSquareConnection();
      expect(result.ok).toBe(false);
      expect(result.accessToken.valid).toBe(false);
      expect(result.accessToken.error).toContain(
        "No Square access token configured",
      );
    });

    test("returns error when locations list fails", async () => {
      await settings.update.square.accessToken("EAAAl_test_123");
      const mock = createMockClient({
        locationsList: () => Promise.reject(new Error("Invalid access token")),
      });

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => mock.client),
        async () => {
          const result = await testSquareConnection();
          expect(result.ok).toBe(false);
          expect(result.accessToken.valid).toBe(false);
          expect(result.accessToken.error).toContain("Invalid access token");
        },
      );
    });

    test("returns sandbox mode with valid token and all checks pass", async () => {
      await settings.update.square.accessToken("EAAAl_test_123");
      await settings.update.square.sandbox(true);
      await settings.update.square.locationId("L_test_123");
      await settings.update.square.webhookSignatureKey("sig_key_test");
      const mock = createMockClient({
        locationsList: () =>
          Promise.resolve({
            locations: [
              { id: "L_test_123", name: "Test Store", status: "ACTIVE" },
            ],
          }),
      });

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => mock.client),
        async () => {
          const result = await testSquareConnection();
          expect(result.ok).toBe(true);
          expect(result.accessToken.valid).toBe(true);
          expect(result.accessToken.mode).toBe("sandbox");
          expect(result.location.configured).toBe(true);
          expect(result.location.name).toBe("Test Store");
          expect(result.location.status).toBe("ACTIVE");
          expect(result.webhook.configured).toBe(true);
        },
      );
    });

    test("returns production mode when sandbox disabled", async () => {
      await settings.update.square.accessToken("EAAAl_live_123");
      await settings.update.square.sandbox(false);
      await settings.update.square.locationId("L_live_123");
      await settings.update.square.webhookSignatureKey("sig_key_live");
      const mock = createMockClient({
        locationsList: () =>
          Promise.resolve({
            locations: [
              { id: "L_live_123", name: "Live Store", status: "ACTIVE" },
            ],
          }),
      });

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => mock.client),
        async () => {
          const result = await testSquareConnection();
          expect(result.ok).toBe(true);
          expect(result.accessToken.valid).toBe(true);
          expect(result.accessToken.mode).toBe("production");
        },
      );
    });

    test("returns location error when location ID not found", async () => {
      await settings.update.square.accessToken("EAAAl_test_123");
      await settings.update.square.locationId("L_wrong");
      await settings.update.square.webhookSignatureKey("sig_key_test");
      const mock = createMockClient({
        locationsList: () =>
          Promise.resolve({
            locations: [
              { id: "L_test_123", name: "Test Store", status: "ACTIVE" },
            ],
          }),
      });

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => mock.client),
        async () => {
          const result = await testSquareConnection();
          expect(result.ok).toBe(false);
          expect(result.accessToken.valid).toBe(true);
          expect(result.location.configured).toBe(false);
          expect(result.location.error).toContain(
            "Location ID not found in account",
          );
        },
      );
    });

    test("returns location error when no location ID configured", async () => {
      await settings.update.square.accessToken("EAAAl_test_123");
      await settings.update.square.webhookSignatureKey("sig_key_test");
      const mock = createMockClient({
        locationsList: () =>
          Promise.resolve({ locations: [{ id: "L_test_123" }] }),
      });

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => mock.client),
        async () => {
          const result = await testSquareConnection();
          expect(result.ok).toBe(false);
          expect(result.location.configured).toBe(false);
          expect(result.location.error).toContain("No location ID configured");
        },
      );
    });

    test("handles empty locations response", async () => {
      await settings.update.square.accessToken("EAAAl_test_123");
      await settings.update.square.sandbox(true);
      await settings.update.square.locationId("L_test_123");
      await settings.update.square.webhookSignatureKey("sig_key_test");
      const mock = createMockClient({
        locationsList: () => Promise.resolve({}),
      });

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => mock.client),
        async () => {
          const result = await testSquareConnection();
          expect(result.accessToken.valid).toBe(true);
          expect(result.location.configured).toBe(false);
          expect(result.location.error).toContain(
            "Location ID not found in account",
          );
        },
      );
    });

    test("returns webhook error when no signature key configured", async () => {
      await settings.update.square.accessToken("EAAAl_test_123");
      await settings.update.square.locationId("L_test_123");
      const mock = createMockClient({
        locationsList: () =>
          Promise.resolve({
            locations: [
              { id: "L_test_123", name: "Test Store", status: "ACTIVE" },
            ],
          }),
      });

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => mock.client),
        async () => {
          const result = await testSquareConnection();
          expect(result.ok).toBe(false);
          expect(result.accessToken.valid).toBe(true);
          expect(result.location.configured).toBe(true);
          expect(result.webhook.configured).toBe(false);
          expect(result.webhook.error).toContain(
            "No webhook signature key configured",
          );
        },
      );
    });
  });

  describe("createPaymentLink", () => {
    test("returns null when access token not set", async () => {
      const intent = {
        address: "",
        date: null,
        email: "john@example.com",
        items: [
          {
            eventId: 1,
            name: "Test Event",
            quantity: 1,
            slug: "test-event",
            unitPrice: 1000,
          },
        ],
        name: "John Doe",
        phone: "",
        special_instructions: "",
      };
      const result = await squareApi.createPaymentLink(
        intent,
        "http://localhost",
      );
      expect(result).toBeNull();
    });

    test("returns null when location ID not configured", async () => {
      await settings.update.square.accessToken("EAAAl_test_123");
      // No location ID set
      const intent = {
        address: "",
        date: null,
        email: "john@example.com",
        items: [
          {
            eventId: 1,
            name: "Test",
            quantity: 1,
            slug: "test-event",
            unitPrice: 1000,
          },
        ],
        name: "John",
        phone: "",
        special_instructions: "",
      };
      const result = await squareApi.createPaymentLink(
        intent,
        "http://localhost",
      );
      expect(result).toBeNull();
    });

    test("constructs correct SDK call for single-event checkout", async () => {
      await settings.update.square.accessToken("EAAAl_test_123");
      await settings.update.square.locationId("L_loc_456");
      const { client, checkoutCreate } = createMockClient({
        checkoutCreate: () =>
          Promise.resolve({
            paymentLink: {
              orderId: "order_abc",
              url: "https://square.link/abc",
            },
          }),
      });

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => client),
        async () => {
          const intent = {
            address: "",
            date: null,
            email: "jane@example.com",
            items: [
              {
                eventId: 7,
                name: "Concert",
                quantity: 3,
                slug: "concert-2025",
                unitPrice: 2500,
              },
            ],
            name: "Jane Smith",
            phone: "555-9876",
            special_instructions: "",
          };

          const result = await squareApi.createPaymentLink(
            intent,
            "https://tickets.example.com",
          );

          expect(result).not.toBeNull();
          expect(result!.orderId).toBe("order_abc");
          expect(result!.url).toBe("https://square.link/abc");

          // Verify SDK was called with correctly constructed order
          const args = checkoutCreate.calls[0]
            ?.args[0] as CreatePaymentLinkInput;
          expect(args.order.locationId).toBe("L_loc_456");
          expect(args.order.lineItems).toHaveLength(1);
          expect(args.order.lineItems[0]!.name).toBe("Ticket: Concert");
          expect(args.order.lineItems[0]!.quantity).toBe("3");
          expect(args.order.lineItems[0]!.basePriceMoney.amount).toBe(
            BigInt(2500),
          );
          expect(args.order.lineItems[0]!.note).toBe("3 Tickets");

          // Verify metadata includes intent fields
          expect(args.order.metadata.name).toBe("Jane Smith");
          expect(args.order.metadata.email).toBe("jane@example.com");
          expect(args.order.metadata.phone).toBe("555-9876");
          const items = JSON.parse(args.order.metadata.items!);
          expect(items).toEqual([{ e: 7, p: 7500, q: 3 }]);

          // Verify checkout options
          expect(args.checkoutOptions.redirectUrl).toBe(
            "https://tickets.example.com/payment/success",
          );

          // Verify pre-populated data (phone is normalized: stripped + prefixed)
          expect(args.prePopulatedData.buyerEmail).toBe("jane@example.com");
          expect(args.prePopulatedData.buyerPhoneNumber).toBe("+5559876");

          // Verify idempotency key is present
          expect(typeof args.idempotencyKey).toBe("string");
          expect(args.idempotencyKey.length).toBeGreaterThan(0);
        },
      );
    });

    test("includes booking fee line item when fee is set", async () => {
      const { settings: s } = await import("#lib/db/settings.ts");
      await s.update.bookingFee("2.5");
      await settings.update.square.accessToken("EAAAl_test_123");
      await settings.update.square.locationId("L_loc_456");
      const { client, checkoutCreate } = createMockClient({
        checkoutCreate: () =>
          Promise.resolve({
            paymentLink: {
              orderId: "order_fee",
              url: "https://square.link/fee",
            },
          }),
      });

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => client),
        async () => {
          const event = testEvent({ unit_price: 1000 });
          const intent = {
            address: "",
            date: null,
            email: "jane@example.com",
            items: [
              {
                eventId: event.id,
                name: event.name,
                quantity: 2,
                slug: event.slug,
                unitPrice: event.unit_price,
              },
            ],
            name: "Jane",
            phone: "",
            special_instructions: "",
          };

          await squareApi.createPaymentLink(
            intent,
            "https://tickets.example.com",
          );

          const args = checkoutCreate.calls[0]
            ?.args[0] as CreatePaymentLinkInput;
          expect(args.order.lineItems).toHaveLength(2);
          const feeItem = args.order.lineItems[1]!;
          expect(feeItem.name).toBe("Booking fee");
          // 2.5% of 2000 (2 × 1000) = 50
          expect(feeItem.basePriceMoney.amount).toBe(BigInt(50));
        },
      );
    });

    test("omits phone from pre-populated data when empty", async () => {
      await settings.update.square.accessToken("EAAAl_test_123");
      await settings.update.square.locationId("L_loc_456");
      const { client, checkoutCreate } = createMockClient({
        checkoutCreate: () =>
          Promise.resolve({
            paymentLink: {
              orderId: "order_xyz",
              url: "https://square.link/xyz",
            },
          }),
      });

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => client),
        async () => {
          const intent = {
            address: "",
            date: null,
            email: "john@example.com",
            items: [
              {
                eventId: 1,
                name: "Test",
                quantity: 1,
                slug: "test-event",
                unitPrice: 1000,
              },
            ],
            name: "John",
            phone: "",
            special_instructions: "",
          };

          await squareApi.createPaymentLink(intent, "http://localhost");

          const args = checkoutCreate.calls[0]
            ?.args[0] as CreatePaymentLinkInput;
          expect(args.prePopulatedData.buyerPhoneNumber).toBeUndefined();
          expect(args.order.metadata.phone).toBeUndefined();
          expect(args.order.lineItems[0]!.note).toBe("Ticket");
        },
      );
    });

    test("returns null when SDK response missing orderId", async () => {
      await settings.update.square.accessToken("EAAAl_test_123");
      await settings.update.square.locationId("L_loc_456");
      const { client } = createMockClient({
        checkoutCreate: () =>
          Promise.resolve({
            paymentLink: { url: "https://square.link/abc" },
          }),
      });

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => client),
        async () => {
          const intent = {
            address: "",
            date: null,
            email: "john@example.com",
            items: [
              {
                eventId: 1,
                name: "Test",
                quantity: 1,
                slug: "test-event",
                unitPrice: 1000,
              },
            ],
            name: "John",
            phone: "",
            special_instructions: "",
          };

          const result = await squareApi.createPaymentLink(
            intent,
            "http://localhost",
          );
          expect(result).toBeNull();
        },
      );
    });
  });

  describe("createPaymentLink", () => {
    test("returns null when access token not set", async () => {
      const intent = {
        address: "",
        date: null,
        email: "john@example.com",
        items: [
          {
            eventId: 1,
            name: "Event 1",
            quantity: 1,
            slug: "event-1",
            unitPrice: 1000,
          },
          {
            eventId: 2,
            name: "Event 2",
            quantity: 2,
            slug: "event-2",
            unitPrice: 500,
          },
        ],
        name: "John Doe",
        phone: "",
        special_instructions: "",
      };
      const result = await squareApi.createPaymentLink(
        intent,
        "http://localhost",
      );
      expect(result).toBeNull();
    });

    test("returns null when location ID not configured", async () => {
      await settings.update.square.accessToken("EAAAl_test_123");
      const intent = {
        address: "",
        date: null,
        email: "john@example.com",
        items: [
          {
            eventId: 1,
            name: "Event 1",
            quantity: 1,
            slug: "event-1",
            unitPrice: 1000,
          },
        ],
        name: "John Doe",
        phone: "",
        special_instructions: "",
      };
      const result = await squareApi.createPaymentLink(
        intent,
        "http://localhost",
      );
      expect(result).toBeNull();
    });

    test("returns null when SDK response missing orderId", async () => {
      await settings.update.square.accessToken("EAAAl_test_123");
      await settings.update.square.locationId("L_multi_loc");
      const { client } = createMockClient({
        checkoutCreate: () =>
          Promise.resolve({
            paymentLink: { url: "https://square.link/multi" },
          }),
      });

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => client),
        async () => {
          const intent = {
            address: "",
            date: null,
            email: "bob@example.com",
            items: [
              {
                eventId: 1,
                name: "Event 1",
                quantity: 1,
                slug: "event-1",
                unitPrice: 1000,
              },
            ],
            name: "Bob Missing",
            phone: "",
            special_instructions: "",
          };

          const result = await squareApi.createPaymentLink(
            intent,
            "http://localhost",
          );
          expect(result).toBeNull();
        },
      );
    });

    test("constructs correct SDK call with multiple line items", async () => {
      await settings.update.square.accessToken("EAAAl_test_123");
      await settings.update.square.locationId("L_multi_loc");
      const { client, checkoutCreate } = createMockClient({
        checkoutCreate: () =>
          Promise.resolve({
            paymentLink: {
              orderId: "order_multi",
              url: "https://square.link/multi",
            },
          }),
      });

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => client),
        async () => {
          const intent = {
            address: "",
            date: null,
            email: "alice@example.com",
            items: [
              {
                eventId: 10,
                name: "Workshop A",
                quantity: 2,
                slug: "workshop-a",
                unitPrice: 1500,
              },
              {
                eventId: 20,
                name: "Gala Dinner",
                quantity: 1,
                slug: "gala-dinner",
                unitPrice: 3000,
              },
            ],
            name: "Alice Wonder",
            phone: "555-1111",
            special_instructions: "",
          };

          const result = await squareApi.createPaymentLink(
            intent,
            "https://tickets.example.com",
          );

          expect(result).not.toBeNull();
          expect(result!.orderId).toBe("order_multi");
          expect(result!.url).toBe("https://square.link/multi");

          const args = checkoutCreate.calls[0]
            ?.args[0] as CreatePaymentLinkInput;

          // Verify multiple line items
          expect(args.order.lineItems).toHaveLength(2);
          expect(args.order.lineItems[0]!.name).toBe("Ticket: Workshop A");
          expect(args.order.lineItems[0]!.quantity).toBe("2");
          expect(args.order.lineItems[0]!.basePriceMoney.amount).toBe(
            BigInt(1500),
          );
          expect(args.order.lineItems[0]!.note).toBe("2 Tickets");

          expect(args.order.lineItems[1]!.name).toBe("Ticket: Gala Dinner");
          expect(args.order.lineItems[1]!.quantity).toBe("1");
          expect(args.order.lineItems[1]!.basePriceMoney.amount).toBe(
            BigInt(3000),
          );
          expect(args.order.lineItems[1]!.note).toBe("Ticket");

          // Verify multi-intent metadata
          expect(args.order.metadata.name).toBe("Alice Wonder");
          expect(args.order.metadata.email).toBe("alice@example.com");
          expect(args.order.metadata.phone).toBe("555-1111");
          const items = JSON.parse(args.order.metadata.items!);
          expect(items).toHaveLength(2);
          expect(items[0]).toEqual({ e: 10, p: 3000, q: 2 });
          expect(items[1]).toEqual({ e: 20, p: 3000, q: 1 });

          // Verify location and checkout options
          expect(args.order.locationId).toBe("L_multi_loc");
          expect(args.checkoutOptions.redirectUrl).toBe(
            "https://tickets.example.com/payment/success",
          );
          expect(args.prePopulatedData.buyerEmail).toBe("alice@example.com");
          expect(args.prePopulatedData.buyerPhoneNumber).toBe("+5551111");
        },
      );
    });

    test("throws PaymentUserError when items metadata exceeds Square limit", async () => {
      await settings.update.square.accessToken("EAAAl_test_123");
      await settings.update.square.locationId("L_multi_loc");
      const { client, checkoutCreate } = createMockClient();

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => client),
        async () => {
          // Generate enough items to exceed 255-char serialized metadata
          const items = Array.from({ length: 30 }, (_, i) => ({
            eventId: i + 1,
            name: `Event ${i + 1}`,
            quantity: 1,
            slug: `event-${i + 1}`,
            unitPrice: 1000,
          }));

          const intent = {
            address: "",
            date: null,
            email: "alice@example.com",
            items,
            name: "Alice",
            phone: "",
            special_instructions: "",
          };

          await expect(
            squareApi.createPaymentLink(intent, "https://tickets.example.com"),
          ).rejects.toThrow(PaymentUserError);

          // SDK should never have been called
          expect(checkoutCreate.calls.length).toBe(0);
        },
      );
    });
  });

  describe("createPaymentLink with validation errors", () => {
    const validationIntent = {
      address: "",
      date: null,
      email: "john@example.com",
      items: [
        {
          eventId: 1,
          name: "Test Event",
          quantity: 1,
          slug: "test-event",
          unitPrice: 1000,
        },
      ],
      name: "John",
      phone: "bad-phone",
      special_instructions: "",
    };

    /** Set up Square credentials and a mock client with a failing checkout */
    const setupFailingCheckout = async (sdkError: Error) => {
      await settings.update.square.accessToken("EAAAl_test_123");
      await settings.update.square.locationId("L_loc_456");
      const { client } = createMockClient({
        checkoutCreate: () => Promise.reject(sdkError),
      });
      return client;
    };

    const squareError = (errors: string) =>
      new Error(`Status code: 400 Body: { "errors": [ ${errors} ] }`);

    test("throws PaymentUserError for invalid phone number", async () => {
      const client = await setupFailingCheckout(
        squareError(
          '{ "category": "INVALID_REQUEST_ERROR", "code": "INVALID_PHONE_NUMBER", "detail": "Invalid phone number.", "field": "pre_populated_data.buyer_phone_number" }',
        ),
      );

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => client),
        async () => {
          try {
            await squareApi.createPaymentLink(
              validationIntent,
              "http://localhost",
            );
            expect(true).toBe(false); // should not reach here
          } catch (err) {
            expect(err instanceof PaymentUserError).toBe(true);
            expect((err as PaymentUserError).message).toContain("phone number");
          }
        },
      );
    });

    test("throws PaymentUserError for invalid email address", async () => {
      const client = await setupFailingCheckout(
        squareError(
          '{ "category": "INVALID_REQUEST_ERROR", "code": "INVALID_EMAIL_ADDRESS", "detail": "Invalid email.", "field": "pre_populated_data.buyer_email" }',
        ),
      );

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => client),
        async () => {
          try {
            await squareApi.createPaymentLink(
              validationIntent,
              "http://localhost",
            );
            expect(true).toBe(false);
          } catch (err) {
            expect(err instanceof PaymentUserError).toBe(true);
            expect((err as PaymentUserError).message).toContain(
              "email address",
            );
          }
        },
      );
    });

    test("returns null for non-user-facing API errors", async () => {
      const client = await setupFailingCheckout(
        squareError(
          '{ "category": "API_ERROR", "code": "INTERNAL_SERVER_ERROR" }',
        ),
      );

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => client),
        async () => {
          const result = await squareApi.createPaymentLink(
            validationIntent,
            "http://localhost",
          );
          expect(result).toBeNull();
        },
      );
    });

    test("returns null for validation error on unknown field", async () => {
      const client = await setupFailingCheckout(
        squareError(
          '{ "category": "INVALID_REQUEST_ERROR", "code": "MISSING_REQUIRED_PARAMETER", "field": "order.location_id" }',
        ),
      );

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => client),
        async () => {
          const result = await squareApi.createPaymentLink(
            validationIntent,
            "http://localhost",
          );
          expect(result).toBeNull();
        },
      );
    });

    test("returns null for non-Body error messages", async () => {
      const client = await setupFailingCheckout(new Error("Network timeout"));

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => client),
        async () => {
          const result = await squareApi.createPaymentLink(
            validationIntent,
            "http://localhost",
          );
          expect(result).toBeNull();
        },
      );
    });

    test("returns null for malformed JSON in error body", async () => {
      const client = await setupFailingCheckout(
        new Error("Status code: 400 Body: { invalid json content }"),
      );

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => client),
        async () => {
          const result = await squareApi.createPaymentLink(
            validationIntent,
            "http://localhost",
          );
          expect(result).toBeNull();
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
      const { client, ordersGet } = createMockClient({
        ordersGet: () => Promise.resolve({ order: null }),
      });

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => client),
        async () => {
          const result = await squareApi.retrieveOrder("order_missing");
          expect(result).toBeNull();
          expect(ordersGet.calls[0]!.args[0]).toEqual({
            orderId: "order_missing",
          });
        },
      );
    });

    test("maps tender paymentId correctly", async () => {
      const { client } = createMockClient({
        ordersGet: () =>
          Promise.resolve({
            order: {
              id: "order_tenders",
              metadata: {
                email: "john@example.com",
                items: '[{"e":1,"q":1,"p":0}]',
                name: "John",
              },
              state: "COMPLETED",
              tenders: [
                { id: "tender_1", paymentId: "pay_abc" },
                { id: "tender_2", paymentId: null },
              ],
              totalMoney: { amount: BigInt(2000), currency: "USD" },
            },
          }),
      });

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => client),
        async () => {
          const result = await squareApi.retrieveOrder("order_tenders");
          expect(result).not.toBeNull();
          expect(result!.tenders).toHaveLength(2);
          expect(result?.tenders?.[0]?.paymentId).toBe("pay_abc");
          expect(result?.tenders?.[1]?.paymentId).toBeUndefined();
        },
      );
    });

    test("returns correct shape with state and id", async () => {
      const { client } = createMockClient({
        ordersGet: () =>
          Promise.resolve({
            order: {
              id: "order_shape",
              metadata: undefined,
              state: "OPEN",
              tenders: undefined,
              totalMoney: { amount: BigInt(0), currency: "USD" },
            },
          }),
      });

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => client),
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

    test("maps totalMoney from order response", async () => {
      const { client } = createMockClient({
        ordersGet: () =>
          Promise.resolve({
            order: {
              id: "order_with_total",
              metadata: {
                email: "john@example.com",
                items: '[{"e":1,"q":1,"p":0}]',
                name: "John",
              },
              state: "COMPLETED",
              tenders: [{ id: "tender_1", paymentId: "pay_total" }],
              totalMoney: { amount: BigInt(7500), currency: "GBP" },
            },
          }),
      });

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => client),
        async () => {
          const result = await squareApi.retrieveOrder("order_with_total");
          expect(result).not.toBeNull();
          expect(result!.totalMoney.amount).toBe(BigInt(7500));
          expect(result!.totalMoney.currency).toBe("GBP");
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
      const { client, paymentsGet } = createMockClient({
        paymentsGet: () => Promise.resolve({ payment: null }),
      });

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => client),
        async () => {
          const result = await squareApi.retrievePayment("pay_missing");
          expect(result).toBeNull();
          expect(paymentsGet.calls[0]!.args[0]).toEqual({
            paymentId: "pay_missing",
          });
        },
      );
    });

    test("maps payment fields correctly from SDK response", async () => {
      const { client } = createMockClient({
        paymentsGet: () =>
          Promise.resolve({
            payment: {
              amountMoney: {
                amount: BigInt(5000),
                currency: "GBP",
              },
              id: "pay_full",
              orderId: "order_999",
              refundedMoney: {
                amount: BigInt(5000),
                currency: "GBP",
              },
              status: "COMPLETED",
            },
          }),
      });

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => client),
        async () => {
          const result = await squareApi.retrievePayment("pay_full");
          expect(result).not.toBeNull();
          expect(result!.id).toBe("pay_full");
          expect(result!.status).toBe("COMPLETED");
          expect(result!.orderId).toBe("order_999");
          expect(result!.amountMoney!.amount).toBe(BigInt(5000));
          expect(result!.amountMoney!.currency).toBe("GBP");
          expect(result!.refundedMoney!.amount).toBe(BigInt(5000));
          expect(result!.refundedMoney!.currency).toBe("GBP");
        },
      );
    });
  });

  describe("retrievePayment wrapper export", () => {
    test("delegates to squareApi.retrievePayment", async () => {
      const { client, paymentsGet } = createMockClient({
        paymentsGet: () =>
          Promise.resolve({
            payment: {
              amountMoney: { amount: BigInt(1000), currency: "USD" },
              id: "pay_wrapper",
              orderId: "order_wrapper",
              status: "COMPLETED",
            },
          }),
      });

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => client),
        async () => {
          const result = await retrievePayment("pay_wrapper");
          expect(result).not.toBeNull();
          expect(result!.id).toBe("pay_wrapper");
          expect(result!.status).toBe("COMPLETED");
          expect(paymentsGet.calls[0]!.args[0]).toEqual({
            paymentId: "pay_wrapper",
          });
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
        () => stub(squareApi, "retrievePayment", () => Promise.resolve(null)),
        async () => {
          const result = await squareApi.refundPayment("pay_123");
          expect(result).toBe(false);
        },
      );
    });

    test("calls SDK refund with correct amount from payment", async () => {
      const { client, paymentsGet, refundsRefundPayment } = createMockClient({
        paymentsGet: () =>
          Promise.resolve({
            payment: {
              amountMoney: { amount: BigInt(4200), currency: "USD" },
              id: "pay_refund_me",
              orderId: "order_refund",
              status: "COMPLETED",
            },
          }),
        refundsRefundPayment: () =>
          Promise.resolve({
            refund: { id: "refund_123", status: "PENDING" },
          }),
      });

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => client),
        async () => {
          const result = await squareApi.refundPayment("pay_refund_me");
          expect(result).toBe(true);

          // Verify payments.get was called to fetch amount
          expect(paymentsGet.calls[0]!.args[0]).toEqual({
            paymentId: "pay_refund_me",
          });

          // Verify refund was called with correct amount and payment ID
          const refundArgs = refundsRefundPayment.calls[0]
            ?.args[0] as RefundPaymentInput;
          expect(refundArgs.paymentId).toBe("pay_refund_me");
          expect(refundArgs.amountMoney.amount).toBe(BigInt(4200));
          expect(refundArgs.amountMoney.currency).toBe("USD");
          expect(typeof refundArgs.idempotencyKey).toBe("string");
          expect(refundArgs.idempotencyKey.length).toBeGreaterThan(0);
        },
      );
    });

    test("returns false when refund SDK call throws", async () => {
      const { client } = createMockClient({
        paymentsGet: () =>
          Promise.resolve({
            payment: {
              amountMoney: { amount: BigInt(1000), currency: "GBP" },
              id: "pay_fail",
              orderId: "order_fail",
              status: "COMPLETED",
            },
          }),
        refundsRefundPayment: () =>
          Promise.reject(new Error("Square API error")),
      });

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => client),
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
    const toBytes = (s: string) => new TextEncoder().encode(s);

    beforeEach(async () => {
      await settings.update.square.webhookSignatureKey(TEST_SECRET);
    });

    test("returns error when webhook signature key not configured", async () => {
      await resetDb();
      await createTestDb();
      const payload = '{"test": true}';
      const result = await verifyWebhookSignature(
        payload,
        "somesig",
        TEST_NOTIFICATION_URL,
        toBytes(payload),
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe("Webhook signature key not configured");
      }
    });

    test("returns error for invalid signature", async () => {
      const payload = '{"test": true}';
      const result = await verifyWebhookSignature(
        payload,
        "invalidsignature",
        TEST_NOTIFICATION_URL,
        toBytes(payload),
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe("Signature verification failed");
      }
    });

    test("returns error for invalid JSON payload with valid signature", async () => {
      const payload = "not valid json {{{";
      // Generate correct signature for invalid JSON payload
      const encoder = new TextEncoder();
      const urlBytes = encoder.encode(TEST_NOTIFICATION_URL);
      const bodyBytes = encoder.encode(payload);
      const combined = new Uint8Array(urlBytes.length + bodyBytes.length);
      combined.set(urlBytes);
      combined.set(bodyBytes, urlBytes.length);

      const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(TEST_SECRET),
        { hash: "SHA-256", name: "HMAC" },
        false,
        ["sign"],
      );
      const sig = await crypto.subtle.sign("HMAC", key, combined);
      const sigBase64 = btoa(String.fromCharCode(...new Uint8Array(sig)));

      const result = await verifyWebhookSignature(
        payload,
        sigBase64,
        TEST_NOTIFICATION_URL,
        toBytes(payload),
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe("Invalid JSON payload");
      }
    });

    test("verifies valid signature successfully", async () => {
      const event: WebhookEvent = {
        data: {
          object: {
            id: "pay_123",
            order_id: "order_456",
            status: "COMPLETED",
          },
        },
        id: "evt_square_123",
        type: "payment.updated",
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
        toBytes(payload),
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
        data: {
          object: {
            id: "pay_123",
            status: "COMPLETED",
          },
        },
        id: "evt_constructed",
        type: "payment.updated",
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
      await settings.update.square.webhookSignatureKey(secret);
      const result = await verifyWebhookSignature(
        payload,
        signature,
        notificationUrl,
        new TextEncoder().encode(payload),
      );
      expect(result.valid).toBe(true);
    });
  });

  describe("Square REST client transport", () => {
    let originalFetch: typeof globalThis.fetch;
    type FetchHeaders = Record<string, string>;
    type FetchCall = {
      args: [
        string,
        { method?: string; headers?: FetchHeaders; body?: string },
      ];
    };
    let mockFetch: { calls: FetchCall[] };

    /** Build a mock Response with the body already available as text() */
    const jsonResponse = (data: unknown) => ({
      ok: true,
      text: () => Promise.resolve(JSON.stringify(data)),
    });

    /** Create a mock fetch with the given implementation and assign to globalThis */
    const installMockFetch = (impl: (...args: unknown[]) => unknown) => {
      mockFetch = spy(impl) as unknown as typeof mockFetch;
      globalThis.fetch = mockFetch as unknown as typeof fetch;
    };

    beforeEach(async () => {
      originalFetch = globalThis.fetch;
      await settings.update.square.accessToken("EAAAl_rest_test");
      await settings.update.square.sandbox(true);
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    test("sends correct headers and snake_case body for payment link creation", async () => {
      installMockFetch(() =>
        Promise.resolve(
          jsonResponse({
            payment_link: {
              long_url: "https://checkout.square.site/rest",
              order_id: "ord_rest",
              url: "https://square.link/rest",
            },
          }),
        ),
      );

      const client = await getSquareClient();
      const result = await client!.checkout.paymentLinks.create({
        checkoutOptions: { redirectUrl: "https://example.com/success" },
        idempotencyKey: "idem-rest",
        order: {
          lineItems: [
            {
              basePriceMoney: { amount: BigInt(2500), currency: "GBP" },
              name: "Ticket: Show",
              note: "2 Tickets",
              quantity: "2",
            },
          ],
          locationId: "L_rest",
          metadata: { items: '[{"e":1,"q":2,"p":0}]', name: "Test" },
        },
        prePopulatedData: {
          buyerEmail: "test@test.com",
          buyerPhoneNumber: "+44123",
        },
      });

      // Response prefers long_url (checkout.square.site) over short url (square.link)
      expect(result.paymentLink!.orderId).toBe("ord_rest");
      expect(result.paymentLink!.url).toBe("https://checkout.square.site/rest");

      // Request verification
      const [url, opts] = mockFetch.calls[0]!.args;
      expect(url).toBe(
        "https://connect.squareupsandbox.com/v2/online-checkout/payment-links",
      );
      expect(opts.method).toBe("POST");
      expect(opts.headers!.Authorization).toBe("Bearer EAAAl_rest_test");
      expect(opts.headers?.["Square-Version"]).toBe("2025-01-23");

      const body = JSON.parse(opts.body!);
      expect(body.idempotency_key).toBe("idem-rest");
      expect(body.order.location_id).toBe("L_rest");
      expect(body.order.line_items[0].base_price_money.amount).toBe(2500);
      expect(body.order.line_items[0].base_price_money.currency).toBe("GBP");
      expect(body.order.metadata.items).toBe('[{"e":1,"q":2,"p":0}]');
      expect(body.checkout_options.redirect_url).toBe(
        "https://example.com/success",
      );
      expect(body.pre_populated_data.buyer_email).toBe("test@test.com");
      expect(body.pre_populated_data.buyer_phone_number).toBe("+44123");
    });

    test("falls back to short url when long_url is absent", async () => {
      installMockFetch(() =>
        Promise.resolve(
          jsonResponse({
            payment_link: {
              order_id: "ord_short",
              url: "https://square.link/short",
            },
          }),
        ),
      );

      const client = await getSquareClient();
      const result = await client!.checkout.paymentLinks.create({
        checkoutOptions: { redirectUrl: "https://example.com" },
        idempotencyKey: "idem-short",
        order: {
          lineItems: [
            {
              basePriceMoney: { amount: BigInt(100), currency: "USD" },
              name: "T",
              note: "T",
              quantity: "1",
            },
          ],
          locationId: "L_rest",
          metadata: {},
        },
        prePopulatedData: { buyerEmail: "a@b.com" },
      });

      expect(result.paymentLink!.orderId).toBe("ord_short");
      expect(result.paymentLink!.url).toBe("https://square.link/short");
    });

    test("omits buyer_phone_number from request when not provided", async () => {
      installMockFetch(() =>
        Promise.resolve(
          jsonResponse({
            payment_link: { order_id: "ord_2", url: "https://square.link/2" },
          }),
        ),
      );

      const client = await getSquareClient();
      await client!.checkout.paymentLinks.create({
        checkoutOptions: { redirectUrl: "https://example.com" },
        idempotencyKey: "idem-2",
        order: {
          lineItems: [
            {
              basePriceMoney: { amount: BigInt(100), currency: "USD" },
              name: "T",
              note: "T",
              quantity: "1",
            },
          ],
          locationId: "L_test",
          metadata: {},
        },
        prePopulatedData: { buyerEmail: "a@b.com" },
      });

      const body = JSON.parse(mockFetch.calls[0]!.args[1].body as string);
      expect(body.pre_populated_data.buyer_phone_number).toBeUndefined();
    });

    test("returns undefined paymentLink when API returns no payment_link", async () => {
      installMockFetch(() => Promise.resolve(jsonResponse({})));

      const client = await getSquareClient();
      const result = await client!.checkout.paymentLinks.create({
        checkoutOptions: { redirectUrl: "https://example.com" },
        idempotencyKey: "idem-3",
        order: { lineItems: [], locationId: "L", metadata: {} },
        prePopulatedData: { buyerEmail: "a@b.com" },
      });

      expect(result.paymentLink).toBeUndefined();
    });

    test("orders.get fetches correct URL and maps response to camelCase", async () => {
      installMockFetch(() =>
        Promise.resolve(
          jsonResponse({
            order: {
              id: "ord_100",
              metadata: { items: '[{"e":5,"q":1,"p":0}]' },
              state: "COMPLETED",
              tenders: [
                { id: "t_1", payment_id: "pay_1" },
                { id: "t_2", payment_id: null },
              ],
              total_money: { amount: 5000, currency: "USD" },
            },
          }),
        ),
      );

      const client = await getSquareClient();
      const result = await client!.orders.get({ orderId: "ord_100" });

      expect(mockFetch.calls[0]!.args[0]).toBe(
        "https://connect.squareupsandbox.com/v2/orders/ord_100",
      );
      expect(result.order!.id).toBe("ord_100");
      expect(result.order!.metadata!.items).toBe('[{"e":5,"q":1,"p":0}]');
      expect(result.order?.tenders?.[0]?.paymentId).toBe("pay_1");
      expect(result.order?.tenders?.[1]?.paymentId).toBeNull();
      expect(result.order!.state).toBe("COMPLETED");
      expect(result.order!.totalMoney!.amount).toBe(BigInt(5000));
      expect(result.order!.totalMoney!.currency).toBe("USD");
    });

    test("orders.get handles missing total_money", async () => {
      installMockFetch(() =>
        Promise.resolve(
          jsonResponse({
            order: { id: "ord_no_total", metadata: {}, state: "OPEN" },
          }),
        ),
      );

      const client = await getSquareClient();
      const result = await client!.orders.get({ orderId: "ord_no_total" });
      expect(result.order!.id).toBe("ord_no_total");
      expect(result.order!.totalMoney).toBeUndefined();
    });

    test("orders.get returns null order when API returns none", async () => {
      installMockFetch(() => Promise.resolve(jsonResponse({})));

      const client = await getSquareClient();
      const result = await client!.orders.get({ orderId: "missing" });
      expect(result.order).toBeNull();
    });

    test("payments.get maps response with BigInt amounts", async () => {
      installMockFetch(() =>
        Promise.resolve(
          jsonResponse({
            payment: {
              amount_money: { amount: 3000, currency: "GBP" },
              id: "pay_1",
              order_id: "ord_1",
              refunded_money: { amount: 1000, currency: "GBP" },
              status: "COMPLETED",
            },
          }),
        ),
      );

      const client = await getSquareClient();
      const result = await client!.payments.get({ paymentId: "pay_1" });

      expect(mockFetch.calls[0]!.args[0]).toBe(
        "https://connect.squareupsandbox.com/v2/payments/pay_1",
      );
      expect(result.payment!.id).toBe("pay_1");
      expect(result.payment!.orderId).toBe("ord_1");
      expect(result.payment!.amountMoney!.amount).toBe(BigInt(3000));
      expect(result.payment!.refundedMoney!.amount).toBe(BigInt(1000));
    });

    test("payments.get handles missing amount_money", async () => {
      installMockFetch(() =>
        Promise.resolve(
          jsonResponse({
            payment: {
              id: "pay_no_amount",
              order_id: "ord_x",
              status: "PENDING",
            },
          }),
        ),
      );

      const client = await getSquareClient();
      const result = await client!.payments.get({ paymentId: "pay_no_amount" });
      expect(result.payment!.id).toBe("pay_no_amount");
      expect(result.payment!.amountMoney).toBeUndefined();
    });

    test("payments.get handles missing refunded_money", async () => {
      installMockFetch(() =>
        Promise.resolve(
          jsonResponse({
            payment: {
              amount_money: { amount: 2000, currency: "USD" },
              id: "pay_2",
              order_id: "ord_2",
              status: "COMPLETED",
            },
          }),
        ),
      );

      const client = await getSquareClient();
      const result = await client!.payments.get({ paymentId: "pay_2" });
      expect(result.payment!.amountMoney!.amount).toBe(BigInt(2000));
      expect(result.payment!.refundedMoney).toBeUndefined();
    });

    test("payments.get returns null payment when API returns none", async () => {
      installMockFetch(() => Promise.resolve(jsonResponse({})));

      const client = await getSquareClient();
      const result = await client!.payments.get({ paymentId: "missing" });
      expect(result.payment).toBeNull();
    });

    test("refunds.refundPayment sends correct snake_case body", async () => {
      installMockFetch(() =>
        Promise.resolve(jsonResponse({ refund: { id: "ref_1" } })),
      );

      const client = await getSquareClient();
      await client!.refunds.refundPayment({
        amountMoney: { amount: BigInt(3000), currency: "GBP" },
        idempotencyKey: "idem-ref",
        paymentId: "pay_1",
      });

      const [url, opts] = mockFetch.calls[0]!.args;
      expect(url).toBe("https://connect.squareupsandbox.com/v2/refunds");
      expect(opts.method).toBe("POST");
      const body = JSON.parse(opts.body!);
      expect(body.idempotency_key).toBe("idem-ref");
      expect(body.payment_id).toBe("pay_1");
      expect(body.amount_money.amount).toBe(3000);
      expect(body.amount_money.currency).toBe("GBP");
    });

    test("throws error with status code and body for HTTP errors", async () => {
      installMockFetch(() =>
        Promise.resolve({
          ok: false,
          status: 400,
          text: () => Promise.resolve('{"errors":[{"code":"BAD_REQUEST"}]}'),
        }),
      );

      const client = await getSquareClient();
      try {
        await client!.orders.get({ orderId: "bad" });
        expect(true).toBe(false);
      } catch (err) {
        expect((err as Error).message).toContain("Status code: 400");
        expect((err as Error).message).toContain("BAD_REQUEST");
      }
    });

    test("locations.list sends GET to /v2/locations", async () => {
      installMockFetch(() =>
        Promise.resolve(
          jsonResponse({
            locations: [
              { id: "L_1", name: "Main", status: "ACTIVE" },
              { id: "L_2", name: "Branch", status: "INACTIVE" },
            ],
          }),
        ),
      );

      const client = await getSquareClient();
      const result = await client!.locations.list();

      expect(mockFetch.calls[0]!.args[0]).toBe(
        "https://connect.squareupsandbox.com/v2/locations",
      );
      expect(result.locations).toHaveLength(2);
      expect(result.locations?.[0]?.id).toBe("L_1");
      expect(result.locations?.[0]?.name).toBe("Main");
      expect(result.locations?.[1]?.status).toBe("INACTIVE");
    });

    test("uses production URL when sandbox is disabled", async () => {
      resetSquareClient();
      await settings.update.square.sandbox(false);
      installMockFetch(() => Promise.resolve(jsonResponse({})));

      const client = await getSquareClient();
      await client!.orders.get({ orderId: "test" });

      expect(mockFetch.calls[0]!.args[0]).toContain("connect.squareup.com");
    });
  });

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
        () => stub(squareApi, "getSquareClient", () => client),
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
        () => stub(squareApi, "getSquareClient", () => client),
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
        () => stub(squareApi, "getSquareClient", () => client),
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
        () => stub(squareApi, "getSquareClient", () => client),
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
        () => stub(squareApi, "getSquareClient", () => client),
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
        () => stub(squareApi, "getSquareClient", () => client),
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
        () => stub(squareApi, "getSquareClient", () => client),
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
        () => stub(squareApi, "getSquareClient", () => client),
        async () => {
          await settings.update.square.accessToken("EAAAl_test_123");
          await settings.update.square.locationId("L_loc_prov");
          const intent = {
            address: "",
            date: null,
            email: "john@example.com",
            items: [
              {
                eventId: 1,
                name: "Test",
                quantity: 1,
                slug: "test-event",
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
        () => stub(squareApi, "getSquareClient", () => client),
        async () => {
          await settings.update.square.accessToken("EAAAl_test_123");
          await settings.update.square.locationId("L_loc_prov");
          const intent = {
            address: "",
            date: null,
            email: "john@example.com",
            items: [
              {
                eventId: 1,
                name: "Event 1",
                quantity: 1,
                slug: "event-1",
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
        () => stub(squareApi, "getSquareClient", () => client),
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
