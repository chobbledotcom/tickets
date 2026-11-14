import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { decrypt } from "#crypto/encryption.ts";
import { hmacHash } from "#crypto/hashing.ts";
import type { EnvKeyEncrypted } from "#crypto/sealed.ts";
import { queryOne } from "#db/client.ts";
import { settings } from "#db/settings.ts";
import { sql } from "#db/sql.ts";
import { extractSessionMetadata } from "#shared/payment-helpers.ts";
import type { CheckoutIntent } from "#shared/payments.ts";
import { squareApi } from "#shared/square/api.ts";
import { squareLinkEndsAt } from "#shared/square/checkout.ts";
import type { CreatePaymentLinkInput } from "#shared/square/client.ts";
import { expectClosedCheckoutFailure } from "#test-utils/checkout-failure.ts";
import { checkoutIntent, checkoutItem } from "#test-utils/checkout-items.ts";
import { debugMessages, useDebugLogSpy } from "#test-utils/debug-log.ts";
import { testListing } from "#test-utils/factories.ts";
import { wireMetadata } from "#test-utils/payment-session.ts";
import {
  configureSquare,
  expectNoLink,
  linkResult,
  withSquareAnswer,
  withSquareClient,
} from "#test-utils/square/fixtures.ts";
import { describeSquare } from "#test-utils/square/harness.ts";

describeSquare(() => {
  describe("createPaymentLink", () => {
    const debugLog = useDebugLogSpy();

    /** Create a payment link that Square answers with `orderId` and `url`, then
     *  hand back the link and the SDK input the stub received. */
    const createLink = async (
      orderId: string,
      url: string,
      intent: CheckoutIntent,
      redirectUrl = "https://tickets.example.com",
    ) => {
      await configureSquare({ locationId: "L_loc_456" });
      return await withSquareClient(
        linkResult(orderId, url),
        async ({ checkoutCreate }) => {
          const result = await squareApi.createPaymentLink(intent, redirectUrl);
          return {
            args: checkoutCreate.calls[0]!.args[0] as CreatePaymentLinkInput,
            result,
          };
        },
      );
    };

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
      expect(debugLog().calls.at(-1)?.args[0]).toBe(
        "[Square] No location ID configured",
      );
    });

    test("reports a configured link that has no available client", async () => {
      await settings.update.square.locationId("L_loc_456");

      await expectNoLink(checkoutIntent());

      expect(debugMessages(debugLog()).slice(-2)).toEqual([
        "[Square] No access token configured, cannot create client",
        "[Square] Payment link creation failed",
      ]);
    });

    test("names a site plan line for the term one unit buys", async () => {
      const { args, result } = await createLink(
        "order_plans",
        "https://square.link/plans",
        checkoutIntent({
          items: [
            checkoutItem({
              name: "(3 Months)",
              purchaseUnit: { kind: "months", monthsPerUnit: 3 },
              quantity: 2,
              unitPrice: 4500,
            }),
          ],
          name: "Jane Smith",
        }),
      );

      expect(result).not.toBeNull();
      expect(args.order.lineItems[0]!.name).toBe("Site plan: (3 Months)");
      expect(args.order.lineItems[0]!.note).toBe("3 months");
      // The priced units stay the checkout's unit count.
      expect(args.order.lineItems[0]!.quantity).toBe("2");
    });

    test("constructs correct SDK call for single-listing checkout", async () => {
      const { args, result } = await createLink(
        "order_abc",
        "https://square.link/abc",
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
      );

      expect(result).not.toBeNull();
      expect(result!.orderId).toBe("order_abc");
      expect(result!.url).toBe("https://square.link/abc");

      // Verify SDK was called with correctly constructed order
      expect(args.order.locationId).toBe("L_loc_456");
      expect(args.order.lineItems).toHaveLength(1);
      expect(args.order.lineItems[0]!.name).toBe("Ticket: Concert");
      expect(args.order.lineItems[0]!.quantity).toBe("3");
      expect(args.order.lineItems[0]!.basePriceMoney.amount).toBe(BigInt(2500));
      expect(args.order.lineItems[0]!.note).toBe("Tickets (x3)");

      // Verify metadata includes intent fields. Small fields (phone, …) are
      // packed into `b` on the wire, so decode the way the webhook does.
      const metadata = extractSessionMetadata(
        wireMetadata(args.order.metadata),
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
      expect(debugMessages(debugLog()).slice(-3)).toEqual([
        "[Square] Creating payment link for x1 listings",
        "[SQL] INSERT INTO square_link_ends (session_index, state, sealed_handle, link_ends_at, next_attempt_at, created_at) VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
        "[Square] Payment link created orderId=order_abc",
      ]);
    });

    test("includes booking fee line item when fee is set", async () => {
      await settings.update.bookingFee("2.5");
      const listing = testListing({ unit_price: 1000 });
      const { args } = await createLink(
        "order_fee",
        "https://square.link/fee",
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
      );

      expect(args.order.lineItems).toHaveLength(2);
      const feeItem = args.order.lineItems[1]!;
      expect(feeItem.name).toBe("Booking fee");
      // 2.5% of 2000 (2 × 1000) = 50
      expect(feeItem.basePriceMoney.amount).toBe(BigInt(50));
    });

    test("omits phone from pre-populated data when empty", async () => {
      const { args } = await createLink(
        "order_xyz",
        "https://square.link/xyz",
        checkoutIntent(),
        "http://localhost",
      );

      expect(Object.hasOwn(args.prePopulatedData, "buyerPhoneNumber")).toBe(
        false,
      );
      expect(Object.hasOwn(args.order.metadata, "phone")).toBe(false);
      expect(args.order.lineItems[0]!.note).toBe("Tickets (x1)");
    });

    test("stages the sealed cancel handle for the link it made", async () => {
      await createLink(
        "order_stage",
        "https://square.link/stage",
        checkoutIntent(),
        "http://localhost",
      );

      const row = await queryOne<{
        link_ends_at: string;
        next_attempt_at: string;
        sealed_handle: string;
        state: string;
      }>(
        sql`SELECT state, sealed_handle, link_ends_at, next_attempt_at FROM square_link_ends WHERE session_index = ${await hmacHash("order_stage")}`,
      );
      expect(row?.state).toBe("pending");
      // The first attempt lands exactly at the window, which Square's
      // own clock decides here: 2026-09-29T12:00:00Z plus one hour.
      expect(row?.link_ends_at).toBe("2026-09-29T13:00:00.000Z");
      expect(row?.next_attempt_at).toBe("2026-09-29T13:00:00.000Z");
      assert(!row!.sealed_handle.includes("link_order_stage"));
      expect(await decrypt(row?.sealed_handle as EnvKeyEncrypted)).toBe(
        "link_order_stage",
      );
    });

    test("refuses a created link that names no address", async () => {
      await configureSquare({ locationId: "L_loc_456" });
      await expectClosedCheckoutFailure(
        withSquareAnswer(
          { payment_link: { id: "link_abc", order_id: "order_abc" } },
          () =>
            squareApi.createPaymentLink(checkoutIntent(), "http://localhost"),
        ),
        { provider: "square", reason: "invalid_response" },
      );
    });
  });

  describe("squareLinkEndsAt", () => {
    test("ends a link one checkout window after Square made it", () => {
      expect(squareLinkEndsAt("2026-01-01T00:00:00Z")).toBe(
        "2026-01-01T01:00:00.000Z",
      );
    });
  });
});
