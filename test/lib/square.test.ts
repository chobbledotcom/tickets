import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { settings } from "#lib/db/settings.ts";
import { PaymentUserError } from "#lib/payment-helpers.ts";
import {
  type CreatePaymentLinkInput,
  getSquareClient,
  resetSquareClient,
  retrievePayment,
  squareApi,
  testSquareConnection,
} from "#lib/square.ts";
import { createTestDb, resetDb, testEvent, withMocks } from "#test-utils";
import { createMockClient } from "#test-utils/square-helpers.ts";

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
});
