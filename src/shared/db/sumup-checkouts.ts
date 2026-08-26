/**
 * SumUp checkout metadata store — encrypted staging for booking intent. A
 * SumUp checkout carries only a `checkout_reference` string, not the booking
 * metadata Stripe sessions and Square orders round-trip for us, so we persist
 * it locally at checkout creation and read it back when the payment completes.
 *
 * That metadata holds PII, so nothing in the stored row can decrypt it alone:
 * the row is keyed by `hmacHash(reference)`, the blob uses a fresh per-row data
 * key, and that key is stored wrapped with a key derived from the reference. The
 * plaintext reference never rests here, so a database dump cannot decrypt a row.
 *
 * The row also records the SumUp-side checkout id, which is not sensitive and
 * lets the webhook reject checkouts we never created without an API call. Rows
 * are pruned after PRUNE_SUMUP_RETENTION_HOURS, once SumUp's checkout expiry
 * and webhook retry window have both passed.
 */

import * as v from "valibot";
import { decryptWithKey, encryptWithKey } from "#crypto/encryption.ts";
import { hmacHash } from "#crypto/hashing.ts";
import {
  generateDataKey,
  unwrapKeyWithToken,
  wrapKeyWithToken,
} from "#crypto/keys.ts";
import type { KeyEncrypted, WrappedKey } from "#crypto/sealed.ts";
import { execute, executeUpdate, insert, queryOne } from "#db/client.ts";
import { recoveryMoveTo } from "#payment/sumup-recovery-machine-spec.ts";
import { SUMUP_FIRST_CHECK_MS } from "#shared/limits.ts";
import { isoAfter, nowIso } from "#shared/now.ts";
import { defineStoredJson } from "#shared/validation/stored-json.ts";

type SumupCheckoutRow = {
  wrapped_key: WrappedKey;
  metadata: KeyEncrypted;
  sumup_id: string;
};

/** Decrypted staging entry for a checkout. */
export type SumupCheckoutEntry = {
  metadata: Record<string, string>;
  sumupId: string;
};

/** A staged row found by its SumUp id, still sealed: the booking metadata
 *  stays encrypted until the reference that names the row arrives (from the
 *  fetched checkout — the plaintext reference never rests in this database). */
export type SealedSumupCheckout = {
  metadata: KeyEncrypted;
  referenceIndex: string;
  wrappedKey: WrappedKey;
};

const metadataJson = defineStoredJson(v.record(v.string(), v.string()));

/** Persist booking metadata for a checkout, encrypted under its reference. */
export const storeSumupCheckout = async (
  reference: string,
  metadata: Record<string, string>,
): Promise<void> => {
  const dataKey = await generateDataKey();
  const [referenceIndex, wrappedKey, ciphertext] = await Promise.all([
    hmacHash(reference),
    wrapKeyWithToken(dataKey, reference),
    encryptWithKey(
      metadataJson.write(metadata, "sumup_checkouts.metadata"),
      dataKey,
    ),
  ]);
  const { sql, args } = insert("sumup_checkouts", {
    created_at: nowIso(),
    metadata: ciphertext,
    // No checkout id yet, so there is nothing to ask SumUp about and nothing
    // to schedule. Both land together when creation succeeds.
    next_check_at: null,
    recovery_state: "staged",
    reference_index: referenceIndex,
    sumup_id: "",
    wrapped_key: wrappedKey,
  });
  await execute(sql, args);
};

/** Record the SumUp-side checkout id once creation succeeds, and put the row
 * in the queue that will ask SumUp what became of it. The id and the state
 * land in one write because a row carrying one without the other is a shape
 * {@link recoveryNodeOf} refuses. */
export const setSumupCheckoutId = async (
  reference: string,
  sumupId: string,
): Promise<void> => {
  const result = await executeUpdate(
    "sumup_checkouts",
    {
      next_check_at: isoAfter(SUMUP_FIRST_CHECK_MS),
      recovery_state: recoveryMoveTo("staged", "checkout_created"),
      sumup_id: sumupId,
    },
    {
      recovery_state: "staged",
      reference_index: await hmacHash(reference),
    },
  );
  // The hosted URL must never reach a customer while this checkout's
  // callbacks would still be refused as unknown, so creation fails here —
  // before the URL is exposed — when the id did not land on exactly one row.
  if (result.rowsAffected !== 1) {
    throw new Error(
      `Staging the SumUp checkout id updated ${result.rowsAffected} rows, expected exactly 1`,
    );
  }
};

/** Fetch the staged row for a webhook's checkout id, still sealed. One cheap
 * indexed read serves as the pre-filter (unsigned webhook spam never costs an
 * API call) and carries everything {@link openSumupCheckout} needs later. */
export const getSealedSumupCheckout = async (
  sumupId: string,
): Promise<SealedSumupCheckout | null> => {
  const row = await queryOne<{
    metadata: KeyEncrypted;
    reference_index: string;
    wrapped_key: WrappedKey;
  }>(
    "SELECT metadata, reference_index, wrapped_key FROM sumup_checkouts WHERE sumup_id = ?",
    [sumupId],
  );
  if (!row) return null;
  return {
    metadata: row.metadata,
    referenceIndex: row.reference_index,
    wrappedKey: row.wrapped_key,
  };
};

/** Open a sealed row with the reference the fetched checkout echoed back.
 * Returns null when the reference does not name this row — the row's own
 * index is the proof the reference must match before anything decrypts. */
export const openSumupCheckout = async (
  sealed: SealedSumupCheckout,
  reference: string,
): Promise<Record<string, string> | null> => {
  if ((await hmacHash(reference)) !== sealed.referenceIndex) return null;
  return decryptMetadata(
    sealed.wrappedKey,
    sealed.metadata,
    reference,
    sealed.referenceIndex,
  );
};

/** Decrypt a row's metadata blob with the reference that keys its data key. */
const decryptMetadata = async (
  wrappedKey: WrappedKey,
  ciphertext: KeyEncrypted,
  reference: string,
  referenceIndex: string,
): Promise<Record<string, string>> => {
  const dataKey = await unwrapKeyWithToken(wrappedKey, reference);
  const json = await decryptWithKey(ciphertext, dataKey);
  return metadataJson.read(
    json,
    `sumup_checkouts.metadata for reference_index ${referenceIndex}`,
  );
};

/**
 * Look up and decrypt the staging entry for a checkout reference.
 * Returns null for unknown references. A found-but-undecryptable row means
 * corruption and throws (same policy as parseBookingItems).
 */
export const getSumupCheckout = async (
  reference: string,
): Promise<SumupCheckoutEntry | null> => {
  const referenceIndex = await hmacHash(reference);
  const row = await queryOne<SumupCheckoutRow>(
    "SELECT wrapped_key, metadata, sumup_id FROM sumup_checkouts WHERE reference_index = ?",
    [referenceIndex],
  );
  if (!row) return null;
  return {
    metadata: await decryptMetadata(
      row.wrapped_key,
      row.metadata,
      reference,
      referenceIndex,
    ),
    sumupId: row.sumup_id,
  };
};
