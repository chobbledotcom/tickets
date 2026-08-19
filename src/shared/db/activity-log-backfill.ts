/**
 * Activity-log backfill — re-encrypt legacy env-key messages to the owner key.
 *
 * Before the owner-key switch, `activity_log.message` was encrypted with
 * DB_ENCRYPTION_KEY, so a database dump plus that key could read the whole
 * history. This converts those rows in bounded batches: decrypt each `enc:` row
 * with the env key, re-encrypt under the owner's public key, write it back.
 * Only the public key is needed (no password), so it runs unattended.
 *
 * It is resumable without a row cursor: a converted row no longer matches the
 * `enc:` prefix, so each batch shrinks the remaining set. The maintenance task
 * stores a completion checkpoint after the final batch, avoiding future scans.
 */

/* jscpd:ignore-start */
import { decrypt, ENCRYPTION_PREFIX } from "#crypto/encryption.ts";
import { encryptWithOwnerKey } from "#crypto/keys.ts";
import type { EnvKeyEncrypted } from "#crypto/sealed.ts";
import { executeBatch, queryAll, update } from "#db/client.ts";
import { ACTIVITY_LOG_BACKFILL_BATCH } from "#shared/limits.ts";
import { logDebug } from "#shared/logger.ts";

/* jscpd:ignore-end */

/** Legacy env-key row awaiting re-encryption. */
// The batch query filters on the env-key prefix, so every fetched message is
// legacy env-key ciphertext.
type LegacyRow = { id: number; message: EnvKeyEncrypted };

export const ACTIVITY_LOG_BACKFILL_COMPLETE = "complete";

/**
 * Re-encrypt one batch of legacy env-key rows to the owner key. Returns the
 * number of rows converted (0 when none remain). All the rewrites land in a
 * single transactional `executeBatch`, so a batch costs two subrequests (the
 * SELECT and the batched write) however large it is.
 */
export const backfillActivityLogBatch = async (
  publicKey: string,
): Promise<number> => {
  const rows = await queryAll<LegacyRow>(
    "SELECT id, message FROM activity_log WHERE message LIKE ? ORDER BY id LIMIT ?",
    [`${ENCRYPTION_PREFIX}%`, ACTIVITY_LOG_BACKFILL_BATCH],
  );
  if (rows.length === 0) return 0;
  const updates = await Promise.all(
    rows.map(async (row) =>
      update(
        "activity_log",
        {
          message: await encryptWithOwnerKey(
            await decrypt(row.message),
            publicKey,
          ),
        },
        { id: row.id },
      ),
    ),
  );
  await executeBatch(updates);
  return rows.length;
};

export const runActivityLogBackfill = async (
  publicKey: string,
): Promise<number> => {
  const converted = await backfillActivityLogBatch(publicKey);
  if (converted > 0) {
    logDebug("Backfill", `activity_log: re-encrypted ${converted} rows`);
  }
  return converted;
};
