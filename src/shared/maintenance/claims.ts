import { generateSecureToken } from "#crypto/utils.ts";
import { execute, queryOne } from "#db/client.ts";
import {
  among,
  atMost,
  equal,
  inQuery,
  or,
  plus,
  valued,
} from "#db/select/expression.ts";
import { from } from "#db/select/query.ts";
import { tables } from "#db/select/tables.ts";
import { sql } from "#db/sql.ts";
import { deleteFrom, insertInto, update } from "#db/write.ts";

const DATABASE_NOW_MS = valued<number>(
  sql`CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)`,
);

export type MaintenanceClaim = {
  checkpoint: string | null;
  leaseToken: string;
  name: string;
};

export const syncMaintenanceTaskRows = async (
  enabledNames: readonly string[],
  disabledNames: readonly string[],
): Promise<void> => {
  const [first, ...rest] = enabledNames.map((name) => ({
    name,
    nextRunAt: DATABASE_NOW_MS,
  }));
  if (first !== undefined) {
    await execute(
      insertInto(tables.maintenance_tasks, [first, ...rest], { or: "IGNORE" }),
    );
  }
  if (disabledNames.length > 0) {
    await execute(
      deleteFrom(tables.maintenance_tasks).where({
        leaseToken: null,
        name: disabledNames,
      }),
    );
  }
};

/** The name of the first allowed task that is due and has no live lease. */
const nextDueTaskName = (allowedNames: readonly string[]) =>
  from(tables.maintenance_tasks)
    .as("candidate")
    .where((candidate) => [
      among(candidate.name, allowedNames),
      equal(candidate.completedAt, null),
      atMost(candidate.nextRunAt, DATABASE_NOW_MS),
      or(
        equal(candidate.leaseToken, null),
        atMost(candidate.leaseExpiresAt, DATABASE_NOW_MS),
      ),
    ])
    .sortedBy("nextRunAt", "name")
    .limit(1)
    .values((candidate) => candidate.name);

export const claimNextMaintenanceTask = async (
  allowedNames: readonly string[],
  leaseMs: number,
): Promise<MaintenanceClaim | null> => {
  if (allowedNames.length === 0) return null;
  const leaseToken = generateSecureToken();
  const row = await queryOne(
    update(tables.maintenance_tasks, {
      lastStartedAt: DATABASE_NOW_MS,
      leaseExpiresAt: plus(DATABASE_NOW_MS, leaseMs),
      leaseToken: leaseToken,
    })
      .where((task) => inQuery(task.name, nextDueTaskName(allowedNames)))
      .returning("name", "checkpoint"),
  );
  return row
    ? { checkpoint: row.checkpoint, leaseToken, name: row.name }
    : null;
};

export const finishMaintenanceTask = async (
  claim: MaintenanceClaim,
  result: { checkpoint: string | null; completed: boolean; intervalMs: number },
): Promise<void> => {
  const row = await queryOne(
    update(tables.maintenance_tasks, {
      checkpoint: result.checkpoint,
      completedAt: result.completed ? DATABASE_NOW_MS : null,
      lastFinishedAt: DATABASE_NOW_MS,
      leaseExpiresAt: null,
      leaseToken: null,
      nextRunAt: plus(DATABASE_NOW_MS, result.intervalMs),
    })
      .where({ leaseToken: claim.leaseToken, name: claim.name })
      .returning("name"),
  );
  if (!row) throw new Error(`Lost maintenance lease for ${claim.name}`);
};
