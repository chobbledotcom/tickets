/** Owner-key storage and blind indexes for provider payment references. */

import { hmacHash } from "#shared/crypto/hashing.ts";
import {
  decryptWithOwnerKey,
  encryptWithOwnerKey,
  HYBRID_PREFIX,
} from "#shared/crypto/keys.ts";
import type { OwnerKeyEncrypted } from "#shared/crypto/sealed.ts";
import { inPlaceholders } from "#shared/db/client.ts";
import { settings } from "#shared/db/settings.ts";
import { CLAIM_MIRROR } from "#shared/payment/admit-move.ts";
import {
  type PaymentReference,
  paymentReferenceIndexInput,
  readPaymentReference,
} from "#shared/payment/provider-reference.ts";
import { PaymentProviderSchema } from "#shared/types.ts";

/** The two columns that must always be written together. */
export type StoredPaymentReference = {
  readonly encrypted: OwnerKeyEncrypted;
  readonly index: string;
};

export type PaymentReferenceClaimGuard = {
  readonly args: readonly string[];
  readonly sql: string;
};

export type PreparedPaymentReferenceWrite = {
  readonly claim: PaymentReferenceClaimGuard;
  readonly stored: StoredPaymentReference | null;
};

/** The blind stable identity of one provider charge. */
export const paymentReferenceIndex = (
  reference: PaymentReference,
): Promise<string> => hmacHash(paymentReferenceIndexInput(reference));

/** Blind identities an unauthenticated writer can derive for one reference.
 * Tagged writes also check the old raw spelling; two known providers stay
 * distinct because neither provider's tagged index appears in the other set. */
export const matchingPaymentReferenceIndexes = async (
  reference: PaymentReference,
): Promise<readonly string[]> => {
  const identities: PaymentReference[] =
    reference.kind === "tagged"
      ? [reference, { kind: "untagged", reference: reference.reference }]
      : [
          reference,
          ...PaymentProviderSchema.options.map((provider) => ({
            kind: "tagged" as const,
            provider,
            reference: reference.reference,
          })),
        ];
  return [...new Set(await Promise.all(identities.map(paymentReferenceIndex)))];
};

/** SQL fact used by reference-bearing finalizers inside their own write. */
export const unclaimedPaymentReference = async (
  reference: PaymentReference,
): Promise<PaymentReferenceClaimGuard> => {
  const indexes = await matchingPaymentReferenceIndexes(reference);
  return {
    args: indexes,
    sql: `NOT EXISTS (
      SELECT 1 FROM processed_payments AS referenceHolder
       WHERE referenceHolder.payment_reference_index IN (${inPlaceholders(
         indexes,
       )})
         AND referenceHolder.protected_state = '${CLAIM_MIRROR}'
    )`,
  };
};

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

const paymentReferencePlaintextFrom = async (
  stored: string,
  privateKey: CryptoKey,
): Promise<string> => {
  if (!stored.startsWith(HYBRID_PREFIX)) return stored;
  return await decryptWithOwnerKey(stored as OwnerKeyEncrypted, privateKey);
};

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

/** The encrypted value and live-claim guard one finalize must write together. */
export const preparePaymentReferenceWrite = async (
  reference: PaymentReference | null,
): Promise<PreparedPaymentReferenceWrite> =>
  reference === null
    ? { claim: { args: [], sql: "1 = 1" }, stored: null }
    : {
        claim: await unclaimedPaymentReference(reference),
        stored: await storePaymentReference(reference),
      };

export type IndexedPaymentReferenceSource = {
  readonly payment_reference: string;
  readonly payment_reference_index: string;
  readonly payment_session_id: string;
};

/** Decrypt a row reference and verify any index it already carries. */
export const loadIndexedPaymentReference = async (
  row: IndexedPaymentReferenceSource,
  privateKey: CryptoKey,
): Promise<{ readonly index: string; readonly payment: PaymentReference }> => {
  const payment = await loadPaymentReference(
    row.payment_reference,
    privateKey,
    `processed_payments.payment_reference for ${row.payment_session_id}`,
  );
  const index = await paymentReferenceIndex(payment);
  if (
    row.payment_reference_index !== "" &&
    row.payment_reference_index !== index
  ) {
    throw new Error(
      `Payment reference index does not match ${row.payment_session_id}`,
    );
  }
  return { index, payment };
};
