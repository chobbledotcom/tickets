import { executeBatch, queryAll } from "#shared/db/client.ts";
import {
  ACTIVITY_LOG_BACKFILL_INTERVAL_MS,
  PRUNE_INTERVAL_MS,
} from "#shared/limits.ts";
import { schemaMigration } from "./define.ts";

const PRUNE_MARKERS = [
  "last_pruned_addresses",
  "last_pruned_contacts",
  "last_pruned_invites",
  "last_pruned_logins",
  "last_pruned_orphans",
  "last_pruned_payments",
  "last_pruned_sessions",
  "last_pruned_strings",
  "last_pruned_sumup",
  "last_pruned_tokens",
] as const;
const ACTIVITY_MARKERS = [
  "activity_log_backfill_done",
  "last_activity_log_backfill",
] as const;
const OLD_MARKERS = [...PRUNE_MARKERS, ...ACTIVITY_MARKERS];

type MarkerRow = { key: string; value: string };

const markerTime = (
  rows: MarkerRow[],
  keys: readonly string[],
  intervalMs: number,
  fallback: number,
): number => {
  const times = rows
    .filter((row) => keys.includes(row.key))
    .map((row) => Number(row.value))
    .filter((value) => Number.isFinite(value) && value > 0);
  return times.length === 0 ? fallback : Math.min(...times) + intervalMs;
};

export default schemaMigration(
  "2026-07-18_maintenance_tasks",
  "Add durable scheduled maintenance task claims.",
  {
    columns: { built_sites: ["site_data_revision"] },
    indexes: ["idx_maintenance_tasks_due"],
    newTables: ["maintenance_tasks"],
  },
  async () => {
    const rows = await queryAll<MarkerRow>(
      `SELECT key, value FROM settings
        WHERE key IN (${OLD_MARKERS.map(() => "?").join(", ")})`,
      [...OLD_MARKERS],
    );
    const now = Date.now();
    const done = rows.some(
      (row) => row.key === "activity_log_backfill_done" && row.value === "true",
    );
    await executeBatch([
      {
        args: [
          "database_pruning",
          markerTime(rows, PRUNE_MARKERS, PRUNE_INTERVAL_MS, now),
        ],
        sql: "INSERT OR IGNORE INTO maintenance_tasks (name, next_run_at) VALUES (?, ?)",
      },
      ...(done
        ? []
        : [
            {
              args: [
                "activity_log_backfill",
                markerTime(
                  rows,
                  ["last_activity_log_backfill"],
                  ACTIVITY_LOG_BACKFILL_INTERVAL_MS,
                  now,
                ),
              ],
              sql: "INSERT OR IGNORE INTO maintenance_tasks (name, next_run_at) VALUES (?, ?)",
            },
          ]),
      {
        args: [...OLD_MARKERS],
        sql: `DELETE FROM settings
               WHERE key IN (${OLD_MARKERS.map(() => "?").join(", ")})`,
      },
    ]);
  },
);
