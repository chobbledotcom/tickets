import { execute } from "#shared/db/client.ts";
import { encryptPaymentReference } from "#shared/db/payment-references.ts";
import { encryptTicketTokens } from "#shared/db/processed-payments.ts";

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
