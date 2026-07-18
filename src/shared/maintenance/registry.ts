import { hasLegacyActivityLog } from "#shared/db/activity-log-backfill.ts";
import { settings } from "#shared/db/settings.ts";
import {
  ACTIVITY_LOG_BACKFILL_INTERVAL_MS,
  PRUNE_INTERVAL_MS,
} from "#shared/limits.ts";
import { defineMaintenanceTasks } from "#shared/maintenance/definition.ts";
import { CONFIG_KEYS } from "#shared/settings/keys.ts";

const FAILURE_RETRY_MS = 5 * 60 * 1000;

export const MAINTENANCE_TASKS = defineMaintenanceTasks([
  {
    deadlineMs: 15_000,
    enabled: () => true,
    failureRetryIntervalMs: FAILURE_RETRY_MS,
    intervalMs: PRUNE_INTERVAL_MS,
    maxDatabaseCalls: 2,
    maxExternalCalls: 0,
    name: "database_pruning",
    run: async () => {
      const { runDatabasePruning } = await import("#shared/db/prune.ts");
      await runDatabasePruning();
    },
    settingsKeys: [
      CONFIG_KEYS.AUTO_PURGE_ORPHANS,
      CONFIG_KEYS.ORPHAN_PURGE_RETENTION,
    ],
    wakePolicy: "organic_safe",
  },
  {
    deadlineMs: 10_000,
    enabled: async () => Boolean(settings.publicKey) && hasLegacyActivityLog(),
    failureRetryIntervalMs: ACTIVITY_LOG_BACKFILL_INTERVAL_MS,
    intervalMs: ACTIVITY_LOG_BACKFILL_INTERVAL_MS,
    maxDatabaseCalls: 2,
    maxExternalCalls: 0,
    name: "activity_log_backfill",
    run: async () => {
      const { runActivityLogBackfill } = await import(
        "#shared/db/activity-log-backfill.ts"
      );
      await runActivityLogBackfill(settings.publicKey);
    },
    settingsKeys: [CONFIG_KEYS.PUBLIC_KEY],
    wakePolicy: "organic_safe",
  },
]);
