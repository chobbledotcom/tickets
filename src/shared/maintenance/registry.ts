import { ACTIVITY_LOG_BACKFILL_COMPLETE } from "#shared/db/activity-log-backfill.ts";
import { settings } from "#shared/db/settings.ts";
import {
  ACTIVITY_LOG_BACKFILL_BATCH,
  ACTIVITY_LOG_BACKFILL_INTERVAL_MS,
  PRUNE_INTERVAL_MS,
} from "#shared/limits.ts";
import {
  defineMaintenanceTasks,
  type MaintenanceTaskCheck,
} from "#shared/maintenance/definition.ts";
import { CONFIG_KEYS } from "#shared/settings/keys.ts";

const FAILURE_RETRY_MS = 5 * 60 * 1000;

const alwaysEnabled = (
  settingsKeys: readonly string[],
): MaintenanceTaskCheck => ({
  enabled: () => true,
  maxDatabaseCalls: 0,
  maxExternalCalls: 0,
  settingsKeys,
});

export const MAINTENANCE_TASKS = defineMaintenanceTasks([
  {
    check: alwaysEnabled([
      CONFIG_KEYS.AUTO_PURGE_ORPHANS,
      CONFIG_KEYS.ORPHAN_PURGE_RETENTION,
    ]),
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
    check: alwaysEnabled([CONFIG_KEYS.PUBLIC_KEY]),
    deadlineMs: 10_000,
    failureRetryIntervalMs: ACTIVITY_LOG_BACKFILL_INTERVAL_MS,
    intervalMs: ACTIVITY_LOG_BACKFILL_INTERVAL_MS,
    maxDatabaseCalls: 2,
    maxExternalCalls: 0,
    name: "activity_log_backfill",
    run: async ({
      checkpoint,
      completeTask,
      requestFollowUp,
      setCheckpoint,
    }) => {
      if (checkpoint === ACTIVITY_LOG_BACKFILL_COMPLETE) {
        completeTask();
        return;
      }
      const { runActivityLogBackfill } = await import(
        "#shared/db/activity-log-backfill.ts"
      );
      const converted = await runActivityLogBackfill(settings.publicKey);
      if (converted < ACTIVITY_LOG_BACKFILL_BATCH) {
        setCheckpoint(ACTIVITY_LOG_BACKFILL_COMPLETE);
        completeTask();
      } else {
        requestFollowUp();
      }
    },
    wakePolicy: "organic_safe",
  },
]);
