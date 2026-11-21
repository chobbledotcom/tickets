/** A paid Stripe checkout whose metadata holds only a token: the webhook opens
 * the sealed order, books it, and survives a replay. When the sealed order is
 * gone, the webhook stays retryable, tells the admin, and sends no refund. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { hmacHash } from "#crypto/hashing.ts";
import { getAttendeesRaw } from "#db/attendees/queries.ts";
import { execute } from "#db/client.ts";
import { getNoteRows } from "#db/notes/queries.ts";
import { sql } from "#db/sql.ts";
import { assembleCheckoutMetadata } from "#shared/payment-helpers.ts";
import {
  runWebhook,
  setupWithListing,
  webhookRequest,
} from "#test/integration/webhook-price-signature/helpers.ts";
import { getListingActivityLog } from "#test-utils/activity-log.ts";
import { checkoutIntent, checkoutItem } from "#test-utils/checkout-items.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";

describeWithEnv("webhook for a sealed checkout order", { db: true }, () => {
  const errors = setupErrorSpy();

  const sealedSession = async (listingId: number, id: string) => ({
    amount_total: 1000,
    id,
    metadata: await assembleCheckoutMetadata(
      "stripe",
      checkoutIntent({
        items: [checkoutItem({ listingId, unitPrice: 1000 })],
        name: "Sealed Buyer",
      }),
      1000,
    ),
  });

  const loseBundleOf = async (session: { metadata: Record<string, string> }) =>
    execute(
      sql`DELETE FROM checkout_bundles WHERE token_index = ${await hmacHash(session.metadata.bundle!)}`,
    );

  test("books the order that the token opens, and a replay books nothing more", async () => {
    const listing = await setupWithListing();
    const session = await sealedSession(listing.id, "cs_sealed_booked");

    await runWebhook(session, async (refund) => {
      for (let delivery = 0; delivery < 2; delivery++) {
        const response = await webhookRequest();
        expect(response.status).toBe(200);
      }
      expect(refund.calls).toHaveLength(0);
    });

    const attendees = await getAttendeesRaw(listing.id);
    expect(attendees).toHaveLength(1);
    expect(attendees[0]!.quantity).toBe(1);
  });

  test("a lost order stays retryable, books nothing, and sends no refund", async () => {
    const listing = await setupWithListing();
    const session = await sealedSession(listing.id, "cs_sealed_lost");
    await loseBundleOf(session);

    await runWebhook(session, async (refund) => {
      const response = await webhookRequest();
      expect(response.status).toBe(503);
      expect(refund.calls).toHaveLength(0);
    });

    expect(await getAttendeesRaw(listing.id)).toHaveLength(0);
    expect(errors.contains("bundle_missing")).toBe(true);
  });

  test("a lost order leaves one note and one activity line, however often it is retried", async () => {
    const listing = await setupWithListing();
    const session = await sealedSession(listing.id, "cs_sealed_lost_twice");
    await loseBundleOf(session);

    await runWebhook(session, async () => {
      await webhookRequest();
      await webhookRequest();
    });

    expect(await getNoteRows("listing", [listing.id])).toHaveLength(1);
    const lost = (await getListingActivityLog(listing.id)).filter((line) =>
      line.message.includes("could not be booked"),
    );
    expect(lost).toHaveLength(1);
    expect(lost[0]!.message).toContain("No refund was sent");
  });

  test("an order that will not open is reported the same way", async () => {
    const listing = await setupWithListing();
    const session = await sealedSession(listing.id, "cs_sealed_unreadable");
    await execute(
      sql`UPDATE checkout_bundles SET sealed = ${"enc:1:AAAA"} WHERE token_index = ${await hmacHash(session.metadata.bundle!)}`,
    );

    await runWebhook(session, async (refund) => {
      expect((await webhookRequest()).status).toBe(503);
      expect(refund.calls).toHaveLength(0);
    });

    expect(errors.contains("bundle_unreadable")).toBe(true);
    expect(await getNoteRows("listing", [listing.id])).toHaveLength(1);
  });
});
