/** Test-only construction of payment rows written before provider tags existed. */

import { assert } from "@std/assert";
import { hmacHash } from "#shared/crypto/hashing.ts";
import { encryptWithOwnerKey } from "#shared/crypto/keys.ts";
import { execute } from "#shared/db/client.ts";
import type { StoredPaymentReference } from "#shared/db/payment-reference-store.ts";
import { reserveSession } from "#shared/db/processed-payments.ts";
import { settings } from "#shared/db/settings.ts";

/** Reproduce the raw owner-encrypted value and raw blind index old rows used. */
export const historicalPaymentReferenceStorage = async (
  reference: string,
): Promise<StoredPaymentReference> => ({
  encrypted: await encryptWithOwnerKey(reference, settings.publicKey),
  index: await hmacHash(reference),
});

/** Seed one old finalized row without opening a legacy production writer. */
export const seedHistoricalProcessedPayment = async (
  sessionId: string,
  attendeeId: number,
  reference: string,
): Promise<void> => {
  await reserveSession(sessionId);
  const stored = await historicalPaymentReferenceStorage(reference);
  const result = await execute(
    `UPDATE processed_payments
        SET attendee_id = ?, payment_reference = ?, payment_reference_index = ?
      WHERE payment_session_id = ? AND attendee_id IS NULL`,
    [attendeeId, stored.encrypted, stored.index, sessionId],
  );
  assert(
    result.rowsAffected === 1,
    `Could not seed historical payment ${sessionId}`,
  );
};
