import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  createStagedCheckout,
  getCheckoutStage,
  markCheckoutStage,
} from "#shared/db/checkout-stages.ts";
import { getDb } from "#shared/db/client.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import { checkoutIntent, checkoutItem } from "#test-utils/checkout.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

const intentFor = (listing: { id: number; name: string; slug: string }) =>
  checkoutIntent({
    items: [
      checkoutItem({
        listingId: listing.id,
        name: listing.name,
        slug: listing.slug,
      }),
    ],
  });

describeWithEnv("db > checkout stages", { db: true }, () => {
  test("fails loudly when the listing vanishes before local staging", async () => {
    const listing = await createTestListing({ unitPrice: 1000 });
    using _checkout = stub(
      stripePaymentProvider,
      "createCheckoutSession",
      async () => {
        await getDb().execute("DELETE FROM listings WHERE id = ?", [
          listing.id,
        ]);
        return {
          checkoutUrl: "https://stripe.example/vanished",
          sessionId: "cs_stage_vanished",
        };
      },
    );

    await expect(
      createStagedCheckout(
        stripePaymentProvider,
        intentFor(listing),
        "https://example.com",
      ),
    ).rejects.toThrow(`Listing ${listing.id} vanished before checkout`);
  });

  test("fails loudly when a quantity-zero stage cannot be written", async () => {
    const listing = await createTestListing({ unitPrice: 1000 });
    using _checkout = stub(
      stripePaymentProvider,
      "createCheckoutSession",
      async () => {
        await getDb().execute("UPDATE listings SET active = 0 WHERE id = ?", [
          listing.id,
        ]);
        return {
          checkoutUrl: "https://stripe.example/inactive",
          sessionId: "cs_stage_inactive",
        };
      },
    );

    await expect(
      createStagedCheckout(
        stripePaymentProvider,
        intentFor(listing),
        "https://example.com",
      ),
    ).rejects.toThrow("Could not stage checkout: capacity_exceeded");
  });

  test("fails loudly when a staged ticket token is missing", async () => {
    const listing = await createTestListing({ unitPrice: 1000 });
    using _checkout = stub(stripePaymentProvider, "createCheckoutSession", () =>
      Promise.resolve({
        checkoutUrl: "https://stripe.example/corrupt",
        sessionId: "cs_stage_corrupt",
      }),
    );
    await createStagedCheckout(
      stripePaymentProvider,
      intentFor(listing),
      "https://example.com",
    );
    await getDb().execute(
      "UPDATE checkout_stages SET ticket_tokens = '' WHERE payment_session_id = ?",
      ["cs_stage_corrupt"],
    );

    await expect(getCheckoutStage("cs_stage_corrupt")).rejects.toThrow(
      "Checkout stage cs_stage_corrupt has no token",
    );
  });

  test("round-trips booked and failed stage states", async () => {
    const listing = await createTestListing({ unitPrice: 1000 });
    using _checkout = stub(stripePaymentProvider, "createCheckoutSession", () =>
      Promise.resolve({
        checkoutUrl: "https://stripe.example/states",
        sessionId: "cs_stage_states",
      }),
    );
    await createStagedCheckout(
      stripePaymentProvider,
      intentFor(listing),
      "https://example.com",
    );

    await markCheckoutStage("cs_stage_states", "booked");
    expect((await getCheckoutStage("cs_stage_states"))?.state).toBe("booked");
    await markCheckoutStage("cs_stage_states", "failed");
    expect((await getCheckoutStage("cs_stage_states"))?.state).toBe("failed");
  });
});
