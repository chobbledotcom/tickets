import { generateSecureToken } from "#shared/crypto/utils.ts";
import { execute, inPlaceholders, queryOne } from "#shared/db/client.ts";

const DATABASE_NOW_MS =
  "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";

export type MaintenanceClaim = {
  checkpoint: string | null;
  leaseToken: string;
  name: string;
};

export const syncMaintenanceTaskRows = async (
  enabledNames: readonly string[],
  disabledNames: readonly string[],
): Promise<void> => {
  if (enabledNames.length > 0) {
    await execute(
      `INSERT OR IGNORE INTO maintenance_tasks (name, next_run_at)
       VALUES ${enabledNames.map(() => `(?, ${DATABASE_NOW_MS})`).join(", ")}`,
      [...enabledNames],
    );
  }
  if (disabledNames.length > 0) {
    await execute(
      `DELETE FROM maintenance_tasks
        WHERE name IN (${inPlaceholders(disabledNames)})
          AND lease_token IS NULL`,
      [...disabledNames],
    );
  }
};

export const claimNextMaintenanceTask = async (
  allowedNames: readonly string[],
  leaseMs: number,
): Promise<MaintenanceClaim | null> => {
  if (allowedNames.length === 0) return null;
  const leaseToken = generateSecureToken();
  const row = await queryOne<{ checkpoint: string | null; name: string }>(
    `UPDATE maintenance_tasks AS task
        SET lease_token = ?,
            lease_expires_at = ${DATABASE_NOW_MS} + ?,
            last_started_at = ${DATABASE_NOW_MS}
      WHERE task.name = (
        SELECT candidate.name
          FROM maintenance_tasks AS candidate
         WHERE candidate.name IN (${inPlaceholders(allowedNames)})
            AND candidate.completed_at IS NULL
            AND candidate.next_run_at <= ${DATABASE_NOW_MS}
           AND (
             candidate.lease_token IS NULL
             OR candidate.lease_expires_at <= ${DATABASE_NOW_MS}
           )
         ORDER BY candidate.next_run_at ASC, candidate.name ASC
         LIMIT 1
      )
       RETURNING name, checkpoint`,
    [leaseToken, leaseMs, ...allowedNames],
  );
  return row
    ? { checkpoint: row.checkpoint, leaseToken, name: row.name }
    : null;
};

export const finishMaintenanceTask = async (
  claim: MaintenanceClaim,
  result: { checkpoint: string | null; completed: boolean; intervalMs: number },
): Promise<void> => {
  const row = await queryOne<{ name: string }>(
    `UPDATE maintenance_tasks
        SET next_run_at = ${DATABASE_NOW_MS} + ?,
            checkpoint = ?,
            completed_at = CASE WHEN ? = 1 THEN ${DATABASE_NOW_MS} ELSE NULL END,
            lease_token = NULL,
            lease_expires_at = NULL,
            last_finished_at = ${DATABASE_NOW_MS}
      WHERE name = ? AND lease_token = ?
      RETURNING name`,
    [
      result.intervalMs,
      result.checkpoint,
      result.completed ? 1 : 0,
      claim.name,
      claim.leaseToken,
    ],
  );
  if (!row) throw new Error(`Lost maintenance lease for ${claim.name}`);
};
