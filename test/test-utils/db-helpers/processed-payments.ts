import { stageCheckout } from "#shared/db/checkout-stages.ts";
import { execute } from "#shared/db/client.ts";
import { batchFinalizeStatement } from "#shared/db/payment-finalize.ts";
import { checkoutIntent, checkoutItem } from "#test-utils/checkout.ts";

/** Create the standard one-listing staged checkout used by DB-backed tests. */
export const stageTestCheckout = (
  sessionId: string,
  listing: { id: number; name: string; slug: string },
) =>
  stageCheckout(
    sessionId,
    "stripe",
    checkoutIntent({
      items: [
        checkoutItem({
          listingId: listing.id,
          name: listing.name,
          slug: listing.slug,
        }),
      ],
    }),
  );

/** Put a reserved payment into the finalized state needed by a test fixture,
 * through the REAL guarded finalize statement — so fixtures can only reach
 * states production can write, and finalizing an already-resolved session
 * fails loudly instead of silently overwriting it. The token list joins with
 * "+" exactly as the stored form does, so [] and ["tok"] behave as before. */
export const finalizeTestPaymentSession = async (
  sessionId: string,
  attendeeId: number,
  ticketTokens: string[],
  paymentReference: string,
): Promise<void> => {
  const statement = await batchFinalizeStatement(
    sessionId,
    "?",
    attendeeId,
    { args: [], sql: "1 = 1" },
    paymentReference,
    ticketTokens.join("+"),
  );
  const result = await execute(statement.sql, statement.args);
  if (result.rowsAffected !== 1) {
    throw new Error(
      `finalizeTestPaymentSession: session ${sessionId} was not an unresolved reservation`,
    );
  }
};
