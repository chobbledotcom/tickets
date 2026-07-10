import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { settings } from "#shared/db/settings.ts";
import { extractSessionMetadata } from "#shared/payment-helpers.ts";
import type { SessionMetadata } from "#shared/payments.ts";
import type { CreatePaymentLinkInput } from "#shared/square.ts";
import { squareApi } from "#shared/square.ts";
import { testListing, withMocks } from "#test-utils";
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
            name: "Test Listing",
            quantity: 1,
            slug: "test-listing",
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
      const result = await squareApi.createPaymentLink(
        intent,
        "http://localhost",
      );
      expect(result).toBeNull();
    });

    test("constructs correct SDK call for single-listing checkout", async () => {
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
        () => stub(squareApi, "getSquareClient", () => Promise.resolve(client)),
        async () => {
          const intent = {
            address: "",
            date: null,
            email: "jane@example.com",
            items: [
              {
                listingId: 7,
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

          // Verify metadata includes intent fields. Small fields (phone, …) are
          // packed into `b` on the wire, so decode the way the webhook does.
          const metadata = extractSessionMetadata(
            args.order.metadata as unknown as SessionMetadata,
          );
          expect(metadata.name).toBe("Jane Smith");
          expect(metadata.email).toBe("jane@example.com");
          expect(metadata.phone).toBe("555-9876");
          const items = JSON.parse(metadata.items);
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
      const { settings: s } = await import("#shared/db/settings.ts");
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
        () => stub(squareApi, "getSquareClient", () => Promise.resolve(client)),
        async () => {
          const listing = testListing({ unit_price: 1000 });
          const intent = {
            address: "",
            date: null,
            email: "jane@example.com",
            items: [
              {
                listingId: listing.id,
                name: listing.name,
                quantity: 2,
                slug: listing.slug,
                unitPrice: listing.unit_price,
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
        () => stub(squareApi, "getSquareClient", () => Promise.resolve(client)),
        async () => {
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
        () => stub(squareApi, "getSquareClient", () => Promise.resolve(client)),
        async () => {
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

          const result = await squareApi.createPaymentLink(
            intent,
            "http://localhost",
          );
          expect(result).toBeNull();
        },
      );
    });
  });
});
