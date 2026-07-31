import type { PaymentWork } from "#routes/api/webhook-types.ts";
import { hmacHash } from "#shared/crypto/hashing.ts";
import { ATTENDEE_BY_TOKEN_SQL } from "#shared/db/attendees/create-batch.ts";
import type { SqlStatement } from "#shared/db/client.ts";
import { paymentFulfilmentStatements } from "#shared/db/payments/claims.ts";
import type { PaymentCompletion } from "#shared/payment-completion.ts";

export const ticketPaymentFulfilmentStatements = async (
  work: PaymentWork,
  ticketToken: string,
  ticketTokens: string[],
  completion: PaymentCompletion,
): Promise<SqlStatement[]> =>
  paymentFulfilmentStatements(
    work.claim,
    work.payment,
    ATTENDEE_BY_TOKEN_SQL,
    [await hmacHash(ticketToken)],
    ticketTokens,
    completion,
  );
