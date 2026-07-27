import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { settings } from "#shared/db/settings.ts";
import type { CheckoutIntent } from "#shared/payments.ts";
import { stripeApi } from "#shared/stripe.ts";
import {
  lineFor,
  okBalance,
  stripeClient,
  withBalanceAndList,
} from "#test/lib/stripe/fixtures.ts";
import { describeStripe } from "#test/lib/stripe/harness.ts";
import {
  checkoutIntent,
  checkoutItem,
  preparedCheckout,
} from "#test-utils/checkout.ts";
import { testListing } from "#test-utils/factories.ts";
import { withMocks } from "#test-utils/mocks.ts";

describeStripe("stripe", () => {
  const expectSessionCreated = async (
    intent: CheckoutIntent,
  ): Promise<void> => {
    await settings.update.stripe.secretKey("sk_test_mock");
    const session = await stripeApi.createCheckout(
      await preparedCheckout(intent),
    );
    expect(session?.id).toMatch(/^cs_test_/u);
    expect(session?.url).toMatch(/^https:\/\/checkout\.stripe\.com\//u);
  };

  describe("createCheckout - phone metadata", () => {
    test("includes phone in metadata when provided", async () => {
      const listing = testListing({ unit_price: 1000 });
      await expectSessionCreated(
        checkoutIntent({
          email: "john@example.com",
          items: [lineFor(listing)],
          name: "John Doe",
          phone: "+44 7700 900000",
        }),
      );
    });
  });

  describe("createCheckout - no email", () => {
    test("creates checkout session without customer_email when email is empty", async () => {
      const listing = testListing({ unit_price: 1000 });
      await expectSessionCreated(
        checkoutIntent({
          email: "",
          items: [lineFor(listing)],
          name: "No Email User",
          phone: "+44 7700 900000",
        }),
      );
    });
  });

  describe("createCheckout", () => {
    test("creates multi-checkout session with phone metadata", async () => {
      await expectSessionCreated(
        checkoutIntent({
          email: "jane@example.com",
          items: [
            checkoutItem({ name: "Listing A", quantity: 2, slug: "listing-a" }),
            checkoutItem({
              listingId: 2,
              name: "Listing B",
              slug: "listing-b",
              unitPrice: 2000,
            }),
          ],
          name: "Jane Doe",
          phone: "+44 7700 900001",
        }),
      );
    });

    test("returns null when stripe key not set", async () => {
      const result = await stripeApi.createCheckout(
        await preparedCheckout(
          checkoutIntent({
            email: "jane@example.com",
            items: [checkoutItem({ name: "Listing A", slug: "listing-a" })],
            name: "Jane Doe",
          }),
        ),
      );
      expect(result).toBeNull();
    });

    test("creates multi-checkout session without customer_email when email is empty", async () => {
      await expectSessionCreated(
        checkoutIntent({
          email: "",
          items: [
            checkoutItem({ name: "Listing A", slug: "listing-a" }),
            checkoutItem({
              listingId: 2,
              name: "Listing B",
              quantity: 2,
              slug: "listing-b",
              unitPrice: 2000,
            }),
          ],
          name: "No Email Multi",
          phone: "+44 7700 900002",
        }),
      );
    });
  });

  describe("refundPayment - non-Error exception", () => {
    test("handles non-Error thrown value in refund", async () => {
      const client = await stripeClient();
      // Throw a non-Error value to exercise the shared string conversion path.
      await withMocks(
        () =>
          stub(client.refunds, "create", () =>
            Promise.reject("network failure string"),
          ),
        async () => {
          const result = await stripeApi.refundPayment(
            "pi_test_123",
            "refund-key",
          );
          expect(result).toBeNull();
        },
      );
    });
  });

  describe("testStripeConnection - non-Error exception", () => {
    test("handles non-Error thrown value in balance check", async () => {
      const client = await stripeClient();
      await withMocks(
        () =>
          stub(client.balance, "retrieve", () =>
            Promise.reject("string error"),
          ),
        async () => {
          const result = await stripeApi.testStripeConnection();
          expect(result.ok).toBe(false);
          expect(result.apiKey).toEqual({
            error: "string error",
            valid: false,
          });
        },
      );
    });

    test("handles non-Error thrown value in webhook list", async () => {
      const client = await stripeClient();
      await withBalanceAndList(
        client,
        okBalance(false),
        () => Promise.reject("webhook string error"),
        async () => {
          const result = await stripeApi.testStripeConnection();
          expect(result.ok).toBe(false);
          expect(result.webhookError).toBe("webhook string error");
        },
      );
    });
  });
});
