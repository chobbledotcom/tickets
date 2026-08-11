/** Owner-key storage and blind indexes for provider payment references. */

import { hmacHash } from "#shared/crypto/hashing.ts";
import {
  decryptWithOwnerKey,
  encryptWithOwnerKey,
  HYBRID_PREFIX,
} from "#shared/crypto/keys.ts";
import type { OwnerKeyEncrypted } from "#shared/crypto/sealed.ts";
import {
  executeBatch,
  queryAll,
  type SqlStatement,
} from "#shared/db/client.ts";
import { settings } from "#shared/db/settings.ts";
import {
  type PaymentReference,
  paymentReferenceIndexInput,
  readPaymentReference,
} from "#shared/payment/provider-reference.ts";

/** The two columns that must always be written together. */
export type StoredPaymentReference = {
  readonly encrypted: OwnerKeyEncrypted;
  readonly index: string;
};

type MissingReferenceIndexRow = {
  payment_reference: string;
  payment_session_id: string;
};

/** The blind stable identity of one provider charge. */
export const paymentReferenceIndex = (
  reference: PaymentReference,
): Promise<string> => hmacHash(paymentReferenceIndexInput(reference));

/** Encrypt a reference and calculate its matching index as one value. */
export const storePaymentReference = async (
  reference: PaymentReference,
): Promise<StoredPaymentReference> => ({
  encrypted: await encryptWithOwnerKey(
    paymentReferenceIndexInput(reference),
    settings.publicKey,
  ),
  index: await paymentReferenceIndex(reference),
});

const paymentReferencePlaintextFrom = (
  stored: string,
  privateKey: CryptoKey,
): Promise<string> | string =>
  stored.startsWith(HYBRID_PREFIX)
    ? decryptWithOwnerKey(stored as OwnerKeyEncrypted, privateKey)
    : stored;

/** Decrypt the stored value and parse its tagged or legacy format. */
export const loadPaymentReference = async (
  stored: string,
  privateKey: CryptoKey,
  context: string,
): Promise<PaymentReference> =>
  readPaymentReference(
    await paymentReferencePlaintextFrom(stored, privateKey),
    context,
  );

const missingReferenceIndexes = (): Promise<MissingReferenceIndexRow[]> =>
  queryAll<MissingReferenceIndexRow>(
    `SELECT payment_session_id, payment_reference
       FROM processed_payments
      WHERE payment_reference != '' AND payment_reference_index = ''`,
  );

const indexRepair = async (
  row: MissingReferenceIndexRow,
  privateKey: CryptoKey,
): Promise<SqlStatement> => {
  const reference = await loadPaymentReference(
    row.payment_reference,
    privateKey,
    `processed_payments.payment_reference for ${row.payment_session_id}`,
  );
  return {
    args: [
      await paymentReferenceIndex(reference),
      row.payment_session_id,
      row.payment_reference,
    ],
    sql: `UPDATE processed_payments
             SET payment_reference_index = ?
           WHERE payment_session_id = ?
             AND payment_reference = ?
             AND payment_reference_index = ''`,
  };
};

/**
 * Fill every old blank index while the authenticated request holds the owner
 * key. A claim finds sibling rows by this column, so preparing only the
 * attendee being loaded would leave the same provider charge on another
 * attendee invisible.
 */
export const preparePaymentReferenceIndexes = async (
  privateKey: CryptoKey,
): Promise<void> => {
  const repairs = await Promise.all(
    (await missingReferenceIndexes()).map((row) =>
      indexRepair(row, privateKey),
    ),
  );
  if (repairs.length > 0) await executeBatch(repairs);
};
