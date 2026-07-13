/**
 * Activity-log backfill — re-encrypt legacy env-key messages to the owner key.
 *
 * Before the owner-key switch, `activity_log.message` was encrypted with
 * DB_ENCRYPTION_KEY, so a database dump plus that key could read the whole
 * history. This converts those rows in bounded batches: decrypt each `enc:` row
 * with the env key, re-encrypt under the owner's public key, write it back.
 * Only the public key is needed (no password), so it runs unattended.
 *
 * It is resumable without a cursor: a converted row no longer matches the
 * `enc:` prefix, so each batch shrinks the remaining set. A batch that finds
 * nothing flips a done flag so the scan stops permanently. Scheduling mirrors
 * the prune tasks — fire-and-forget from the request handler, interval-gated by
 * a `last_run` timestamp — to stay within the edge subrequest budget while
 * converging over successive requests.
 */

/* jscpd:ignore-start */
import { decrypt, ENCRYPTION_PREFIX } from "#shared/crypto/encryption.ts";
import { encryptWithOwnerKey } from "#shared/crypto/keys.ts";
import type { EnvKeyEncrypted } from "#shared/crypto/sealed.ts";
import { executeBatch, queryAll, update } from "#shared/db/client.ts";
import { settings } from "#shared/db/settings.ts";
import { taskIsDue } from "#shared/interval-gate.ts";
import {
  ACTIVITY_LOG_BACKFILL_BATCH,
  ACTIVITY_LOG_BACKFILL_INTERVAL_MS,
} from "#shared/limits.ts";
import { logDebug } from "#shared/logger.ts";
import { nowMs } from "#shared/now.ts";

/* jscpd:ignore-end */

/** Legacy env-key row awaiting re-encryption. */
// The batch query filters on the env-key prefix, so every fetched message is
// legacy env-key ciphertext.
type LegacyRow = { id: number; message: EnvKeyEncrypted };

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
    "SELECT id, message FROM activity_log WHERE message LIKE ? LIMIT ?",
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

/** Backfill is finished, or cannot run yet because no key pair is configured. */
const backfillIdle = (): boolean =>
  settings.activityLogBackfillDone === "true" || !settings.publicKey;

/**
 * Run one backfill batch if due. Safe to call fire-and-forget
 * (`addPendingWork`); never throws. Writes the run timestamp before working
 * (claiming the interval so concurrent requests don't double-run) and marks the
 * job done once a batch finds no remaining legacy rows.
 */
export const maybeBackfillActivityLog = async (): Promise<void> => {
  if (backfillIdle()) return;
  const now = nowMs();
  if (
    !taskIsDue(
      settings.lastActivityLogBackfill,
      ACTIVITY_LOG_BACKFILL_INTERVAL_MS,
      now,
    )
  ) {
    return;
  }
  try {
    await settings.update.lastActivityLogBackfill(String(now));
    const converted = await backfillActivityLogBatch(settings.publicKey);
    if (converted === 0) {
      await settings.update.activityLogBackfillDone("true");
    } else {
      logDebug("Backfill", `activity_log: re-encrypted ${converted} rows`);
    }
  } catch (e) {
    logDebug("Backfill", `activity_log failed: ${String(e)}`);
  }
};
