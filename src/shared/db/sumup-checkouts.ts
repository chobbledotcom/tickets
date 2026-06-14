/**
 * SumUp checkout metadata store — encrypted staging for booking intent.
 *
 * SumUp checkouts expose only a single `checkout_reference` string and cannot
 * carry the arbitrary booking metadata that Stripe sessions and Square orders
 * round-trip for us. We therefore persist the metadata locally at checkout
 * creation, keyed by a reference we generate, and read it back when the
 * payment completes (via webhook or redirect).
 *
 * The metadata contains PII (name, email, phone, address), so nothing in the
 * stored row can decrypt it on its own:
 * - the row is keyed by `hmacHash(reference)` (not the reference itself)
 * - the blob is encrypted with a fresh per-row data key
 * - that data key is stored wrapped with a key derived from the reference
 *   (the same `wrapKeyWithToken` scheme sessions use for the user data key)
 *
 * The plaintext reference never rests in this database — it arrives at
 * runtime from the success-redirect URL or from SumUp's API (the fetched
 * checkout's `checkout_reference`). A DB dump alone, even combined with the
 * env encryption key, cannot decrypt these rows directly.
 *
 * The row also records the SumUp-side checkout id (set right after creation).
 * It is not sensitive — an attacker with the SumUp API key can list checkout
 * ids anyway — and it lets the webhook handler reject listings for checkouts we
 * never created without spending an outbound API call.
 *
 * Rows are short-lived: pruned after PRUNE_SUMUP_RETENTION_HOURS (see
 * prune.ts) since nothing legitimate reads them once SumUp's checkout expiry
 * (30 min) and webhook retry window (2 h) have passed.
 */

import { decryptWithKey, encryptWithKey } from "#shared/crypto/encryption.ts";
import { hmacHash } from "#shared/crypto/hashing.ts";
import {
  generateDataKey,
  unwrapKeyWithToken,
  wrapKeyWithToken,
} from "#shared/crypto/keys.ts";
import { getDb, insert, queryOne } from "#shared/db/client.ts";
import { nowIso } from "#shared/now.ts";

type SumupCheckoutRow = {
  wrapped_key: string;
  metadata: string;
  sumup_id: string;
};

/** Decrypted staging entry for a checkout. */
export type SumupCheckoutEntry = {
  metadata: Record<string, string>;
  sumupId: string;
};

/** Persist booking metadata for a checkout, encrypted under its reference. */
export const storeSumupCheckout = async (
  reference: string,
  metadata: Record<string, string>,
): Promise<void> => {
  const dataKey = await generateDataKey();
  const [referenceIndex, wrappedKey, ciphertext] = await Promise.all([
    hmacHash(reference),
    wrapKeyWithToken(dataKey, reference),
    encryptWithKey(JSON.stringify(metadata), dataKey),
  ]);
  await getDb().execute(
    insert("sumup_checkouts", {
      created_at: nowIso(),
      metadata: ciphertext,
      reference_index: referenceIndex,
      sumup_id: "",
      wrapped_key: wrappedKey,
    }),
  );
};

/** Record the SumUp-side checkout id once creation succeeds. */
export const setSumupCheckoutId = async (
  reference: string,
  sumupId: string,
): Promise<void> => {
  await getDb().execute({
    args: [sumupId, await hmacHash(reference)],
    sql: "UPDATE sumup_checkouts SET sumup_id = ? WHERE reference_index = ?",
  });
};

/** Whether a webhook's checkout id belongs to a checkout we created.
 * Cheap local pre-filter so unsigned webhook spam never costs an API call. */
export const hasSumupCheckoutId = async (sumupId: string): Promise<boolean> => {
  const row = await queryOne<{ sumup_id: string }>(
    "SELECT sumup_id FROM sumup_checkouts WHERE sumup_id = ?",
    [sumupId],
  );
  return row !== null;
};

/**
 * Look up and decrypt the staging entry for a checkout reference.
 * Returns null for unknown references. A found-but-undecryptable row means
 * corruption and throws (same policy as parseBookingItems).
 */
export const getSumupCheckout = async (
  reference: string,
): Promise<SumupCheckoutEntry | null> => {
  const row = await queryOne<SumupCheckoutRow>(
    "SELECT wrapped_key, metadata, sumup_id FROM sumup_checkouts WHERE reference_index = ?",
    [await hmacHash(reference)],
  );
  if (!row) return null;
  const dataKey = await unwrapKeyWithToken(row.wrapped_key, reference);
  const json = await decryptWithKey(row.metadata, dataKey);
  return {
    metadata: JSON.parse(json) as Record<string, string>,
    sumupId: row.sumup_id,
  };
};
