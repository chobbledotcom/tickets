import { generateSecureToken } from "#crypto/utils.ts";
import { execute, queryOne } from "#db/client.ts";
import { sql, sqlList, sqlRows } from "#db/sql.ts";

const DATABASE_NOW_MS = sql`CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)`;

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
      sql`INSERT OR IGNORE INTO maintenance_tasks (name, next_run_at)
       VALUES ${sqlRows(enabledNames.map((name) => [name, DATABASE_NOW_MS]))}`,
    );
  }
  if (disabledNames.length > 0) {
    await execute(
      sql`DELETE FROM maintenance_tasks
        WHERE name IN (${sqlList(disabledNames)})
          AND lease_token IS NULL`,
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
    sql`UPDATE maintenance_tasks AS task
        SET lease_token = ${leaseToken},
            lease_expires_at = ${DATABASE_NOW_MS} + ${leaseMs},
            last_started_at = ${DATABASE_NOW_MS}
      WHERE task.name = (
        SELECT candidate.name
          FROM maintenance_tasks AS candidate
         WHERE candidate.name IN (${sqlList(allowedNames)})
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
    sql`UPDATE maintenance_tasks
        SET next_run_at = ${DATABASE_NOW_MS} + ${result.intervalMs},
            checkpoint = ${result.checkpoint},
            completed_at = CASE WHEN ${result.completed ? 1 : 0} = 1 THEN ${DATABASE_NOW_MS} ELSE NULL END,
            lease_token = NULL,
            lease_expires_at = NULL,
            last_finished_at = ${DATABASE_NOW_MS}
      WHERE name = ${claim.name} AND lease_token = ${claim.leaseToken}
      RETURNING name`,
  );
  if (!row) throw new Error(`Lost maintenance lease for ${claim.name}`);
};
