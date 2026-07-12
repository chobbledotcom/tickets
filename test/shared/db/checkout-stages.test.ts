import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  createStagedCheckout,
  discardPendingCheckoutSessions,
  getCheckoutStage,
  markCheckoutStage,
  prunePendingCheckoutStages,
  stageCheckout,
} from "#shared/db/checkout-stages.ts";
import { getDb } from "#shared/db/client.ts";
import { reserveSession } from "#shared/db/processed-payments.ts";
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

  test("discards an array of cancelled pending stages", async () => {
    const listing = await createTestListing({ unitPrice: 1000 });
    const first = await stageCheckout(
      "cs_stage_discard_first",
      "stripe",
      intentFor(listing),
    );
    const second = await stageCheckout(
      "cs_stage_discard_second",
      "stripe",
      intentFor(listing),
    );

    expect(
      await discardPendingCheckoutSessions([
        "cs_stage_discard_first",
        "cs_stage_discard_second",
      ]),
    ).toBe(2);
    expect(await getCheckoutStage("cs_stage_discard_first")).toBeNull();
    expect(await getCheckoutStage("cs_stage_discard_second")).toBeNull();
    const attendees = await getDb().execute({
      args: [first.attendeeId, second.attendeeId],
      sql: "SELECT id FROM attendees WHERE id IN (?, ?)",
    });
    expect(attendees.rows).toEqual([]);
  });

  test("keeps a pending stage once payment processing claims it", async () => {
    const listing = await createTestListing({ unitPrice: 1000 });
    await stageCheckout("cs_stage_claimed", "stripe", intentFor(listing));
    await reserveSession("cs_stage_claimed");

    expect(await discardPendingCheckoutSessions(["cs_stage_claimed"])).toBe(0);
    expect((await getCheckoutStage("cs_stage_claimed"))?.state).toBe("pending");
  });

  test("prunes only old pending stages", async () => {
    const listing = await createTestListing({ unitPrice: 1000 });
    await stageCheckout("cs_stage_old", "stripe", intentFor(listing));
    await stageCheckout("cs_stage_recent", "stripe", intentFor(listing));
    await stageCheckout("cs_stage_failed", "stripe", intentFor(listing));
    await getDb().execute(
      "UPDATE checkout_stages SET created_at = ? WHERE payment_session_id = ?",
      ["2000-01-01T00:00:00.000Z", "cs_stage_old"],
    );
    await markCheckoutStage("cs_stage_failed", "failed");

    expect(await prunePendingCheckoutStages("2020-01-01T00:00:00.000Z")).toBe(
      1,
    );
    expect(await getCheckoutStage("cs_stage_old")).toBeNull();
    expect((await getCheckoutStage("cs_stage_recent"))?.state).toBe("pending");
    expect((await getCheckoutStage("cs_stage_failed"))?.state).toBe("failed");
  });

  test("discarding no sessions is a no-op", async () => {
    expect(await discardPendingCheckoutSessions([])).toBe(0);
  });
});
