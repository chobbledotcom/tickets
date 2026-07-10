import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { settings } from "#shared/db/settings.ts";
import {
  extractSessionMetadata,
  PaymentUserError,
} from "#shared/payment-helpers.ts";
import type { SessionMetadata } from "#shared/payments.ts";
import type { CreatePaymentLinkInput } from "#shared/square.ts";
import { squareApi } from "#shared/square.ts";
import { withMocks } from "#test-utils";
import { createMockClient, describeSquare } from "./harness.ts";

describeSquare(() => {
  describe("createPaymentLink", () => {
    test("returns null when access token not set", async () => {
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
          {
            listingId: 2,
            name: "Listing 2",
            quantity: 2,
            slug: "listing-2",
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
            listingId: 1,
            name: "Listing 1",
            quantity: 1,
            slug: "listing-1",
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
        () => stub(squareApi, "getSquareClient", () => Promise.resolve(client)),
        async () => {
          const intent = {
            address: "",
            date: null,
            email: "bob@example.com",
            items: [
              {
                listingId: 1,
                name: "Listing 1",
                quantity: 1,
                slug: "listing-1",
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
        () => stub(squareApi, "getSquareClient", () => Promise.resolve(client)),
        async () => {
          const intent = {
            address: "",
            date: null,
            email: "alice@example.com",
            items: [
              {
                listingId: 10,
                name: "Workshop A",
                quantity: 2,
                slug: "workshop-a",
                unitPrice: 1500,
              },
              {
                listingId: 20,
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

          // Verify multi-intent metadata (small fields packed into `b`).
          const metadata = extractSessionMetadata(
            args.order.metadata as unknown as SessionMetadata,
          );
          expect(metadata.name).toBe("Alice Wonder");
          expect(metadata.email).toBe("alice@example.com");
          expect(metadata.phone).toBe("555-1111");
          const items = JSON.parse(metadata.items);
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
        () => stub(squareApi, "getSquareClient", () => Promise.resolve(client)),
        async () => {
          // Generate enough items to exceed 255-char serialized metadata
          const items = Array.from({ length: 30 }, (_, i) => ({
            listingId: i + 1,
            name: `Listing ${i + 1}`,
            quantity: 1,
            slug: `listing-${i + 1}`,
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
          listingId: 1,
          name: "Test Listing",
          quantity: 1,
          slug: "test-listing",
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
        () => stub(squareApi, "getSquareClient", () => Promise.resolve(client)),
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
        () => stub(squareApi, "getSquareClient", () => Promise.resolve(client)),
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
        () => stub(squareApi, "getSquareClient", () => Promise.resolve(client)),
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
        () => stub(squareApi, "getSquareClient", () => Promise.resolve(client)),
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
        () => stub(squareApi, "getSquareClient", () => Promise.resolve(client)),
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
        () => stub(squareApi, "getSquareClient", () => Promise.resolve(client)),
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
});
