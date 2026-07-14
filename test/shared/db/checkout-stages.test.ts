import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { t } from "#i18n";
import { createAttendeeAtomic } from "#shared/db/attendees/api.ts";
import {
  discardPendingCheckoutSessions,
  pruneCheckoutStageRows,
} from "#shared/db/checkout-stage-cleanup.ts";
import {
  attendeeIdsWithPendingStage,
  beginCheckoutStageRefund,
  createStagedCheckout,
  getCheckoutStageOrNull,
  listingHasPendingCheckout,
  markCheckoutStage,
  resolvePendingStage,
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

/** Assert a checkout for `listing` is refused up front: the provider is stubbed
 * to throw (so a checkout that reached it fails loudly with `reason`), the
 * result is the unavailable error, and no stage was written. */
const expectStagedCheckoutRefused = async (
  listing: { id: number; name: string; slug: string },
  reason: string,
): Promise<void> => {
  using _checkout = stub(stripePaymentProvider, "createCheckoutSession", () => {
    throw new Error(`provider reached for ${reason}`);
  });
  const result = await createStagedCheckout(
    stripePaymentProvider,
    intentFor(listing),
    "https://example.com",
  );
  expect(result).toEqual({ error: t("public.checkout_unavailable") });
  expect(await listingHasPendingCheckout(listing.id)).toBe(false);
};

describeWithEnv("db > checkout stages", { db: true }, () => {
  test("refuses to begin a refund for a missing stage", async () => {
    await expect(beginCheckoutStageRefund("cs_missing_refund")).rejects.toThrow(
      "did not enter refunding",
    );
  });

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

    // The preflight sees the listing still active (deactivation happens inside
    // the provider stub, after the check passes), so the checkout starts. The
    // quantity-0 stage then claims nothing and writes regardless; the activation
    // capacity check (which requires an active listing) is the gate, and its
    // refusal refunds the customer rather than crashing here.
    await createStagedCheckout(
      stripePaymentProvider,
      intentFor(listing),
      "https://example.com",
    );
    expect((await getCheckoutStageOrNull("cs_stage_inactive"))?.state).toBe(
      "pending",
    );
  });

  test("refuses a checkout for an already-overbooked listing", async () => {
    const listing = await createTestListing({
      maxAttendees: 1,
      unitPrice: 1000,
    });
    // Fill the one seat, then admin-overbook a second (a supported admin state,
    // added the way a manual admin add does, with the overbook flag). A new
    // public checkout for its real quantity (1) cannot fit, so it is refused up
    // front — before the provider session — instead of after the customer pays.
    await createTestAttendeeDirect(listing.id, "First", "first@example.com");
    const overbooked = await createAttendeeAtomic({
      allowOverbook: true,
      bookings: [{ listingId: listing.id, quantity: 1 }],
      email: "second@example.com",
      name: "Second",
      source: "admin",
    });
    if (!overbooked.success) throw new Error("Expected admin overbook to save");

    await expectStagedCheckoutRefused(listing, "an unbookable order");
  });

  test("refuses a checkout for an off-sale listing", async () => {
    const listing = await createTestListing({ unitPrice: 1000 });
    // Take the listing off sale before the customer starts paying. It has room,
    // but an inactive listing can't be booked, so the checkout is refused up
    // front rather than after payment.
    await getDb().execute("UPDATE listings SET active = 0 WHERE id = ?", [
      listing.id,
    ]);

    await expectStagedCheckoutRefused(listing, "an off-sale listing");
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
    const bookedRow = await getDb().execute(
      "SELECT ticket_tokens FROM checkout_stages WHERE payment_session_id = ?",
      ["cs_stage_states"],
    );
    expect(bookedRow.rows[0]!.ticket_tokens).toBe("");
    expect((await getCheckoutStageOrNull("cs_stage_states"))?.state).toBe(
      "booked",
    );
    await markCheckoutStage("cs_stage_states", "failed");
    expect((await getCheckoutStageOrNull("cs_stage_states"))?.state).toBe(
      "failed",
    );
  });

  test("indexes stage state and age for pruning and pending guards", async () => {
    const index = await getDb().execute(
      "PRAGMA index_info(idx_checkout_stages_state_created_at)",
    );
    expect(index.rows.map((row) => row.name)).toEqual(["state", "created_at"]);
  });

  test("scrubs the ticket token when healing an open stage", async () => {
    const listing = await createTestListing({ unitPrice: 1000 });
    await stageCheckout("cs_stage_healed", "stripe", intentFor(listing));

    await resolvePendingStage("cs_stage_healed");

    const row = await getDb().execute(
      "SELECT state, ticket_tokens FROM checkout_stages WHERE payment_session_id = ?",
      ["cs_stage_healed"],
    );
    expect(row.rows.map((value) => [value.state, value.ticket_tokens])).toEqual(
      [["failed", ""]],
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

    expect(
      await pruneCheckoutStageRows(
        "2020-01-01T00:00:00.000Z",
        "1990-01-01T00:00:00.000Z",
        "1990-01-01T00:00:00.000Z",
      ),
    ).toBe(1);
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

  test("throws on a pending stage whose attendee was deleted", async () => {
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

    // A pending orphan is an impossible state — a pending stage is never deleted
    // without its stage row (the cascade removes both; admin/listing deletes are
    // blocked while pending) — so the lookup throws instead of quietly booking
    // fresh around a missed cascade.
    await expect(
      getCheckoutStageOrNull("cs_stage_orphan_pending"),
    ).rejects.toThrow("must never outlive its attendee");
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

  test("names attendees whose stage is pending or refunding", async () => {
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
    const refunding = await stageCheckout(
      "cs_stage_refunding_ids",
      "stripe",
      intentFor(listing),
    );
    await beginCheckoutStageRefund("cs_stage_refunding_ids");
    await markCheckoutStage("cs_stage_failed_ids", "failed");

    // Both open states block admin mutations. A resolved stage and an unknown
    // id are out.
    expect(
      await attendeeIdsWithPendingStage([
        pending.attendeeId,
        refunding.attendeeId,
        failed.attendeeId,
        999999,
      ]),
    ).toEqual(new Set([pending.attendeeId, refunding.attendeeId]));
    expect(await attendeeIdsWithPendingStage([])).toEqual(new Set());
  });

  test("reports a listing with a pending checkout, and clears once resolved", async () => {
    const listing = await createTestListing({ unitPrice: 1000 });
    const other = await createTestListing({ unitPrice: 1000 });
    await stageCheckout(
      "cs_stage_listing_pending",
      "stripe",
      intentFor(listing),
    );

    // The staged listing has a mid-payment booking; an unrelated listing does not.
    expect(await listingHasPendingCheckout(listing.id)).toBe(true);
    expect(await listingHasPendingCheckout(other.id)).toBe(false);

    await beginCheckoutStageRefund("cs_stage_listing_pending");
    expect(await listingHasPendingCheckout(listing.id)).toBe(true);

    // Resolving the stage clears the listing, so it can be deleted again.
    await markCheckoutStage("cs_stage_listing_pending", "failed");
    expect(await listingHasPendingCheckout(listing.id)).toBe(false);
  });
});
