import { stageCheckout } from "#shared/db/checkout-stages.ts";
import { execute } from "#shared/db/client.ts";
import { encryptPaymentReference } from "#shared/db/payment-references.ts";
import { encryptTicketTokens } from "#shared/db/processed-payments.ts";
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

/** Put a reserved payment into the finalized state needed by a test fixture. */
export const finalizeTestPaymentSession = async (
  sessionId: string,
  attendeeId: number,
  ticketTokens: string[],
  paymentReference: string,
): Promise<void> => {
  await execute(
    `UPDATE processed_payments
     SET attendee_id = ?, ticket_tokens = ?, payment_reference = ?
     WHERE payment_session_id = ?`,
    [
      attendeeId,
      await encryptTicketTokens(ticketTokens),
      await encryptPaymentReference(paymentReference),
      sessionId,
    ],
  );
};
