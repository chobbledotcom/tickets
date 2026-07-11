import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { extractSessionMetadata } from "#shared/payment-helpers.ts";
import type { SessionMetadata } from "#shared/payments.ts";
import type { CreatePaymentLinkInput } from "#shared/square.ts";
import { squareApi } from "#shared/square.ts";
import { checkoutIntent, checkoutItem } from "#test-utils/checkout.ts";
import { testListing } from "#test-utils/factories.ts";
import {
  configureSquare,
  expectNoLink,
  linkResult,
  withSquareClient,
} from "./fixtures.ts";
import { describeSquare } from "./harness.ts";

describeSquare(() => {
  describe("createPaymentLink", () => {
    test("returns null when access token not set", async () => {
      await expectNoLink(
        checkoutIntent({
          items: [checkoutItem({ name: "Test Listing" })],
          name: "John Doe",
        }),
      );
    });

    test("returns null when location ID not configured", async () => {
      await configureSquare();
      // No location ID set
      await expectNoLink(checkoutIntent());
    });

    test("constructs correct SDK call for single-listing checkout", async () => {
      await configureSquare({ locationId: "L_loc_456" });
      await withSquareClient(
        linkResult("order_abc", "https://square.link/abc"),
        async ({ checkoutCreate }) => {
          const result = await squareApi.createPaymentLink(
            checkoutIntent({
              email: "jane@example.com",
              items: [
                checkoutItem({
                  listingId: 7,
                  name: "Concert",
                  quantity: 3,
                  slug: "concert-2025",
                  unitPrice: 2500,
                }),
              ],
              name: "Jane Smith",
              phone: "555-9876",
            }),
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
      await configureSquare({ locationId: "L_loc_456" });
      await withSquareClient(
        linkResult("order_fee", "https://square.link/fee"),
        async ({ checkoutCreate }) => {
          const listing = testListing({ unit_price: 1000 });
          await squareApi.createPaymentLink(
            checkoutIntent({
              email: "jane@example.com",
              items: [
                checkoutItem({
                  listingId: listing.id,
                  name: listing.name,
                  quantity: 2,
                  slug: listing.slug,
                  unitPrice: listing.unit_price,
                }),
              ],
              name: "Jane",
            }),
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
      await configureSquare({ locationId: "L_loc_456" });
      await withSquareClient(
        linkResult("order_xyz", "https://square.link/xyz"),
        async ({ checkoutCreate }) => {
          await squareApi.createPaymentLink(
            checkoutIntent(),
            "http://localhost",
          );

          const args = checkoutCreate.calls[0]
            ?.args[0] as CreatePaymentLinkInput;
          expect(args.prePopulatedData.buyerPhoneNumber).toBeUndefined();
          expect(args.order.metadata.phone).toBeUndefined();
          expect(args.order.lineItems[0]!.note).toBe("Ticket");
        },
      );
    });

    test("returns null when SDK response missing orderId", async () => {
      await configureSquare({ locationId: "L_loc_456" });
      await withSquareClient(
        {
          checkoutCreate: () =>
            Promise.resolve({
              paymentLink: { url: "https://square.link/abc" },
            }),
        },
        async () => {
          const result = await squareApi.createPaymentLink(
            checkoutIntent(),
            "http://localhost",
          );
          expect(result).toBeNull();
        },
      );
    });
  });
});
