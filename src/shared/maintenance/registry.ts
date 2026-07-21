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
    check: {
      enabled: () => true,
      maxDatabaseCalls: 0,
      maxExternalCalls: 0,
      settingsKeys: [
        CONFIG_KEYS.AUTO_PURGE_ORPHANS,
        CONFIG_KEYS.ORPHAN_PURGE_RETENTION,
      ],
    },
    deadlineMs: 15_000,
    failureRetryIntervalMs: FAILURE_RETRY_MS,
    intervalMs: PRUNE_INTERVAL_MS,
    maxDatabaseCalls: 2,
    maxExternalCalls: 0,
    name: "database_pruning",
    run: async ({ checkpoint, requestFollowUp, setCheckpoint }) => {
      const { runDatabasePruning } = await import("#shared/db/prune.ts");
      const result = await runDatabasePruning(checkpoint);
      setCheckpoint(result.checkpoint);
      if (result.fullBatch) requestFollowUp();
    },
    wakePolicy: "organic_safe",
  },
  {
    check: {
      enabled: async () =>
        Boolean(settings.publicKey) && hasLegacyActivityLog(),
      maxDatabaseCalls: 1,
      maxExternalCalls: 0,
      settingsKeys: [CONFIG_KEYS.PUBLIC_KEY],
    },
    deadlineMs: 10_000,
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
    wakePolicy: "organic_safe",
  },
]);
