/**
 * A sealed order once its session is settled: booked, or ended with a final
 * handled outcome.
 *
 * The order holds the buyer's personal details, so the settle step replaces
 * it with a receipt. `receiptRecord` keeps only the fields that a replay or
 * the buyer's return page reads. The prune deletes the receipt later. After
 * that, the session's standing answers for it (see session-standing.ts).
 */

import { rewriteCheckoutBundle } from "#db/checkout-bundles.ts";
import type { ValidatedSession } from "#routes/api/webhook-types.ts";
import { buildMetadata } from "#shared/payment-helpers.ts";
import { PAYMENT_PROVIDERS } from "#shared/payment-providers.ts";
import { receiptRecord } from "#shared/session-metadata.ts";

/** Replace a settled session's sealed order with its receipt. A provider that
 * stages its own order has nothing sealed to replace. */
export const keepOrderReceipt = async ({
  intent,
  session,
}: ValidatedSession): Promise<void> => {
  if (PAYMENT_PROVIDERS[session.provider].orderCarrier !== "sealed-bundle") {
    return;
  }
  await rewriteCheckoutBundle(
    session.metadata.bundle,
    receiptRecord(buildMetadata(intent)),
  );
};
