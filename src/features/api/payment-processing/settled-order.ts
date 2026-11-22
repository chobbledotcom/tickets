/**
 * A sealed order once its session is settled: booked, or ended with a final
 * handled outcome.
 *
 * The order holds the buyer's personal details, so the settle step replaces
 * it with a receipt. The receipt keeps only what a replay or the buyer's
 * return page reads: the lines, the package picks, the thank-you link, and
 * the balance target. The prune deletes the receipt later. After that, the
 * session's standing answers for it (see session-standing.ts).
 */

import { rewriteCheckoutBundle } from "#db/checkout-bundles.ts";
import type { ValidatedSession } from "#routes/api/webhook-types.ts";
import { buildMetadata } from "#shared/payment-helpers.ts";

/** Replace a settled session's sealed order with its receipt. A checkout that
 * carries its order in its own fields has nothing sealed to replace. */
export const keepOrderReceipt = async ({
  intent,
  session,
}: ValidatedSession): Promise<void> => {
  if (session.metadata.bundle === "") return;
  await rewriteCheckoutBundle(
    session.metadata.bundle,
    buildMetadata({
      allocations: intent.allocations,
      balanceAttendeeId: intent.balanceAttendeeId,
      date: null,
      email: "",
      items: intent.items,
      name: "",
      thankYouUrl: intent.thankYouUrl,
    }),
  );
};
