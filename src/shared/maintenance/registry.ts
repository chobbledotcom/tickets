import { ACTIVITY_LOG_BACKFILL_COMPLETE } from "#db/activity-log-backfill.ts";
import { settings } from "#db/settings.ts";
import {
  ACTIVITY_LOG_BACKFILL_BATCH,
  ACTIVITY_LOG_BACKFILL_INTERVAL_MS,
  PRUNE_INTERVAL_MS,
  SUMUP_RECOVERY_BATCH,
  SUMUP_RECOVERY_INTERVAL_MS,
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
      const { runDatabasePruning } = await import("#db/prune.ts");
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
        "#db/activity-log-backfill.ts"
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
  {
    check: {
      // A site with no SumUp key has no staged checkouts to ask about, and
      // syncMaintenanceTaskRows removes the task row while that is true.
      enabled: () => settings.sumup.hasKey,
      maxDatabaseCalls: 0,
      maxExternalCalls: 0,
      settingsKeys: [
        CONFIG_KEYS.SUMUP_API_KEY,
        CONFIG_KEYS.SUMUP_MERCHANT_CODE,
      ],
    },
    deadlineMs: 20_000,
    failureRetryIntervalMs: FAILURE_RETRY_MS,
    intervalMs: SUMUP_RECOVERY_INTERVAL_MS,
    // One read for the queue, then per checkout: one SumUp read plus the
    // engine's own writes. A paid checkout needing a refund spends the most,
    // which is what keeps the batch small.
    maxDatabaseCalls: 1 + SUMUP_RECOVERY_BATCH * 6,
    maxExternalCalls: SUMUP_RECOVERY_BATCH * 2,
    name: "sumup_checkout_recovery",
    run: async ({ requestFollowUp }) => {
      const { runSumupRecovery } = await import(
        "#shared/sumup/recovery-run.ts"
      );
      if (await runSumupRecovery()) requestFollowUp();
    },
    wakePolicy: "organic_safe",
  },
]);
