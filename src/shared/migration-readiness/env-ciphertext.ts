/**
 * Verification of the env-key-encrypted `processed_payments` fields the
 * migration later decrypts: `ticket_tokens` (replayed ticket state) and
 * `failure_data` (the stored terminal outcome). The database key is already
 * configured, so an undecryptable value is a report finding, not a crash.
 */

import {
  decryptSessionTokens,
  parseSessionFailure,
} from "#db/processed-payments.ts";
import type { ProcessedPaymentRow } from "#shared/migration-readiness/readiness.ts";

export type EnvCiphertextFailures = {
  undecryptableFailureData: Set<string>;
  undecryptableTicketTokens: Set<string>;
};

/** Check every non-empty env-key-encrypted field on the processed-payment
 *  rows. Return the `payment_session_id`s whose ciphertext does not decrypt
 *  and, for `failure_data`, does not parse as a terminal state. Empty values
 *  are genuinely absent fields, not failures. */
export const envCiphertextFailures = async (
  processed: readonly ProcessedPaymentRow[],
): Promise<EnvCiphertextFailures> => {
  const undecryptableFailureData = new Set<string>();
  const undecryptableTicketTokens = new Set<string>();
  for (const row of processed) {
    if (row.ticket_tokens !== "") {
      try {
        await decryptSessionTokens(row.ticket_tokens);
      } catch {
        undecryptableTicketTokens.add(row.payment_session_id);
      }
    }
    if (row.failure_data !== "") {
      try {
        await parseSessionFailure(row.failure_data);
      } catch {
        undecryptableFailureData.add(row.payment_session_id);
      }
    }
  }
  return { undecryptableFailureData, undecryptableTicketTokens };
};
