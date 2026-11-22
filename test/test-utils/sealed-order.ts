/** Sealed Stripe checkouts for webhook and return-page tests: a real sealed
 * order, and the ways a test reads, prunes, or replaces its row. */

import { expect } from "@std/expect";
import { hmacHash } from "#crypto/hashing.ts";
import {
  openCheckoutBundle,
  rewriteCheckoutBundle,
} from "#db/checkout-bundles.ts";
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

const PERSONAL_DETAILS = ["Sealed Buyer", "buyer@example.com", "07700900000"];

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

const tokenOf = (session: SealedSession): string =>
  session.metadata.bundle as string;

export const openBundleOf = (session: SealedSession) =>
  openCheckoutBundle(tokenOf(session));

/** Delete the sealed row, as the prune does. */
export const pruneBundleOf = async (session: SealedSession): Promise<void> => {
  await execute(
    sql`DELETE FROM checkout_bundles WHERE token_index = ${await hmacHash(tokenOf(session))}`,
  );
};

/** Put a record back under the session's token. */
export const resealBundleOf = (
  session: SealedSession,
  record: Record<string, string>,
): Promise<void> => rewriteCheckoutBundle(tokenOf(session), record);

/** Assert the row holds a receipt: the lines and the thank-you link, and none
 *  of the buyer's personal details. */
export const expectReceiptOnly = async (
  session: SealedSession,
): Promise<void> => {
  const opened = await openBundleOf(session);
  expect(opened).toMatchObject({
    record: { thank_you_url: "https://example.com/thanks" },
    status: "opened",
  });
  const text = JSON.stringify(opened);
  for (const personal of PERSONAL_DETAILS) {
    expect(text).not.toContain(personal);
  }
  expect(text).toContain('\\"q\\":1');
};

/** Stub the Stripe read that the buyer's return page and cancel page make. */
export const stubSessionRead = (session: SealedSession) =>
  stubRetrieveCheckoutSession({
    amountTotal: session.amount_total,
    metadata: session.metadata,
    paymentIntent: `pi_${session.id}`,
    sessionId: session.id,
  });
