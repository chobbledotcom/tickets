/** Sealed Stripe checkouts for webhook and return-page tests: a real sealed
 * order, and the ways a test reads or prunes its row. */

import { hmacHash } from "#crypto/hashing.ts";
import { execute } from "#db/client.ts";
import { sql } from "#db/sql.ts";
import { assembleCheckoutMetadata } from "#shared/payment-helpers.ts";
import { checkoutIntent, checkoutItem } from "#test-utils/checkout-items.ts";
import { stubRetrieveCheckoutSession } from "#test-utils/webhooks/stripe.ts";

export type SealedSession = {
  amount_total: number;
  id: string;
  metadata: Record<string, string>;
};

/** A paid Stripe session for one 1000 line, sealed the way checkout seals it.
 *  `charged` is what Stripe reports, so a test can make a mismatch. */
export const sealedSession = async (
  listingId: number,
  id: string,
  charged = 1000,
): Promise<SealedSession> => ({
  amount_total: charged,
  id,
  metadata: await assembleCheckoutMetadata(
    "stripe",
    checkoutIntent({
      items: [checkoutItem({ listingId, unitPrice: 1000 })],
      name: "Sealed Buyer",
      phone: "07700900000",
      thankYouUrl: "https://example.com/thanks",
    }),
    1000,
  ),
});

/** The token that the session's metadata carries. */
export const tokenOf = (session: SealedSession): string =>
  session.metadata.bundle as string;

/** Delete the sealed row, as the prune does. */
export const pruneBundleOf = async (session: SealedSession): Promise<void> => {
  await execute(
    sql`DELETE FROM checkout_bundles WHERE token_index = ${await hmacHash(tokenOf(session))}`,
  );
};

/** Stub the Stripe read that the buyer's return page and cancel page make. */
export const stubSessionRead = (session: SealedSession) =>
  stubRetrieveCheckoutSession({
    amountTotal: session.amount_total,
    metadata: session.metadata,
    paymentIntent: `pi_${session.id}`,
    sessionId: session.id,
  });
