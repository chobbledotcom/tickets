import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { createAttendeeAtomic } from "#shared/db/attendees/api.ts";
import {
  attendeeIdsWithPendingStage,
  createStagedCheckout,
  discardPendingCheckoutSessions,
  getCheckoutStageOrNull,
  markCheckoutStage,
  prunePendingCheckoutStages,
  stageCheckout,
} from "#shared/db/checkout-stages.ts";
import { getDb } from "#shared/db/client.ts";
import { reserveSession } from "#shared/db/processed-payments.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import { checkoutIntent, checkoutItem } from "#test-utils/checkout.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
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

  test("stages even when the listing was deactivated mid-checkout", async () => {
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

    // The quantity-0 stage claims nothing, so it writes regardless; the
    // activation capacity check (which requires an active listing) is the
    // gate, and its refusal refunds the customer rather than crashing here.
    await createStagedCheckout(
      stripePaymentProvider,
      intentFor(listing),
      "https://example.com",
    );
    expect((await getCheckoutStageOrNull("cs_stage_inactive"))?.state).toBe(
      "pending",
    );
  });

  test("stages a checkout for an already-overbooked listing", async () => {
    const listing = await createTestListing({
      maxAttendees: 1,
      unitPrice: 1000,
    });
    // Admin overbooking is a supported state: two attendees on a one-spot
    // listing (the second added the way an admin manual add does, with the
    // overbook flag). Starting a checkout must still work — the staged rows
    // claim nothing, and the post-payment activation is where capacity decides.
    await createTestAttendeeDirect(listing.id, "First", "first@example.com");
    const overbooked = await createAttendeeAtomic({
      allowOverbook: true,
      bookings: [{ listingId: listing.id, quantity: 1 }],
      email: "second@example.com",
      name: "Second",
      source: "admin",
    });
    if (!overbooked.success) throw new Error("Expected admin overbook to save");

    const stage = await stageCheckout(
      "cs_stage_overbooked",
      "stripe",
      intentFor(listing),
    );
    expect(
      (await getCheckoutStageOrNull("cs_stage_overbooked"))?.attendeeId,
    ).toBe(stage.attendeeId);
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

    await expect(getCheckoutStageOrNull("cs_stage_corrupt")).rejects.toThrow(
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
    expect((await getCheckoutStageOrNull("cs_stage_states"))?.state).toBe(
      "booked",
    );
    await markCheckoutStage("cs_stage_states", "failed");
    expect((await getCheckoutStageOrNull("cs_stage_states"))?.state).toBe(
      "failed",
    );
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
    expect(await getCheckoutStageOrNull("cs_stage_discard_first")).toBeNull();
    expect(await getCheckoutStageOrNull("cs_stage_discard_second")).toBeNull();
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
    expect((await getCheckoutStageOrNull("cs_stage_claimed"))?.state).toBe(
      "pending",
    );
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
    expect(await getCheckoutStageOrNull("cs_stage_old")).toBeNull();
    expect((await getCheckoutStageOrNull("cs_stage_recent"))?.state).toBe(
      "pending",
    );
    expect((await getCheckoutStageOrNull("cs_stage_failed"))?.state).toBe(
      "failed",
    );
  });

  test("discarding no sessions is a no-op", async () => {
    expect(await discardPendingCheckoutSessions([])).toBe(0);
  });

  test("treats a pending stage with a deleted attendee as no stage", async () => {
    const listing = await createTestListing({ unitPrice: 1000 });
    const stage = await stageCheckout(
      "cs_stage_orphan_pending",
      "stripe",
      intentFor(listing),
    );
    // Bypass the delete cascade (which removes the stage) to simulate a
    // deletion path that missed it: the stage now points at a dead id.
    await getDb().execute("DELETE FROM attendees WHERE id = ?", [
      stage.attendeeId,
    ]);

    // A pending orphan can never activate — the lookup reports it loudly and
    // answers "no stage", so the payment books fresh from its signed details.
    expect(await getCheckoutStageOrNull("cs_stage_orphan_pending")).toBeNull();
  });

  test("keeps returning a resolved stage whose attendee was deleted", async () => {
    const listing = await createTestListing({ unitPrice: 1000 });
    const stage = await stageCheckout(
      "cs_stage_orphan_failed",
      "stripe",
      intentFor(listing),
    );
    await markCheckoutStage("cs_stage_orphan_failed", "failed");
    await getDb().execute("DELETE FROM attendees WHERE id = ?", [
      stage.attendeeId,
    ]);

    // A resolved orphan still answers with its state, so the resolved-stage
    // guard refuses to re-process money that was already handled.
    expect(
      (await getCheckoutStageOrNull("cs_stage_orphan_failed"))?.state,
    ).toBe("failed");
  });

  test("names only attendees whose stage is still pending", async () => {
    const listing = await createTestListing({ unitPrice: 1000 });
    const pending = await stageCheckout(
      "cs_stage_pending_ids",
      "stripe",
      intentFor(listing),
    );
    const failed = await stageCheckout(
      "cs_stage_failed_ids",
      "stripe",
      intentFor(listing),
    );
    await markCheckoutStage("cs_stage_failed_ids", "failed");

    // A resolved (failed) stage and an unknown id are both out: only the
    // still-being-paid checkout blocks admin mutations.
    expect(
      await attendeeIdsWithPendingStage([
        pending.attendeeId,
        failed.attendeeId,
        999999,
      ]),
    ).toEqual(new Set([pending.attendeeId]));
    expect(await attendeeIdsWithPendingStage([])).toEqual(new Set());
  });
});
