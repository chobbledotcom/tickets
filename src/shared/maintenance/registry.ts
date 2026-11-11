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
  type MaintenanceTaskContext,
  type MaintenanceTaskDeclaration,
} from "#shared/maintenance/definition.ts";
import { CONFIG_KEYS } from "#shared/settings/keys.ts";
import {
  SQUARE_LINK_EXPIRY_BATCH,
  SQUARE_LINK_EXPIRY_INTERVAL_MS,
} from "#shared/square/limits.ts";
import {
  SUBSCRIPTION_CHECK_BATCH,
  SUBSCRIPTION_CHECK_INTERVAL_MS,
} from "#shared/subscriptions/limits.ts";

const FAILURE_RETRY_MS = 5 * 60 * 1000;

/** A task for work only a connected provider has. Its check is off until that
 * provider is set up, and free to declare while it is not. */
const providerTask = (
  enabled: () => boolean | Promise<boolean>,
  settingsKeys: readonly string[],
  task: Omit<
    MaintenanceTaskDeclaration,
    "check" | "deadlineMs" | "failureRetryIntervalMs"
  >,
): MaintenanceTaskDeclaration => ({
  ...task,
  check: { enabled, maxDatabaseCalls: 0, maxExternalCalls: 0, settingsKeys },
  deadlineMs: 20_000,
  failureRetryIntervalMs: FAILURE_RETRY_MS,
});

/** A task run that loads its runner on first use, so the registry stays cheap
 * to load on cold starts. The runner answers true after a full batch, and the
 * task then asks for a follow-up run. */
const askForMoreWhenFull =
  (load: () => Promise<() => Promise<boolean>>) =>
  async ({ requestFollowUp }: MaintenanceTaskContext): Promise<void> => {
    const runBatch = await load();
    if (await runBatch()) requestFollowUp();
  };

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
  providerTask(
    // A site with no SumUp key has no staged checkouts to ask about, and
    // syncMaintenanceTaskRows removes the task row while that is true.
    () => settings.sumup.hasKey,
    [CONFIG_KEYS.SUMUP_API_KEY, CONFIG_KEYS.SUMUP_MERCHANT_CODE],
    {
      intervalMs: SUMUP_RECOVERY_INTERVAL_MS,
      // One read for the queue, then per checkout: one SumUp read plus the
      // engine's own writes. A paid checkout needing a refund spends the
      // most, which is what keeps the batch small.
      maxDatabaseCalls: 1 + SUMUP_RECOVERY_BATCH * 6,
      maxExternalCalls: SUMUP_RECOVERY_BATCH * 2,
      name: "sumup_checkout_recovery",
      run: askForMoreWhenFull(
        async () =>
          (await import("#shared/sumup/recovery-run.ts")).runSumupRecovery,
      ),
      wakePolicy: "organic_safe",
    },
  ),
  providerTask(
    // A site with no Square token has no payment links to end, and
    // syncMaintenanceTaskRows removes the task row while that is true.
    () => settings.square.hasToken,
    [CONFIG_KEYS.SQUARE_ACCESS_TOKEN, CONFIG_KEYS.SQUARE_LOCATION_ID],
    {
      intervalMs: SQUARE_LINK_EXPIRY_INTERVAL_MS,
      // One read for the queue, then per link: one claim write, one Square
      // delete, and one move on the answer. A lease that expired spends the
      // claim and the move only.
      maxDatabaseCalls: 1 + SQUARE_LINK_EXPIRY_BATCH * 2,
      maxExternalCalls: SQUARE_LINK_EXPIRY_BATCH,
      name: "square_link_expiry",
      run: askForMoreWhenFull(
        async () =>
          (await import("#shared/square/link-expiry-run.ts"))
            .runSquareLinkExpiry,
      ),
      // Public traffic carries an external allowance of zero, so only
      // POST /scheduled can reach this task.
      wakePolicy: "scheduled_only",
    },
  ),
  providerTask(
    () => settings.stripe.hasKey && settings.features.subscriptions,
    // The country sets the site currency that each invoice must match.
    [
      CONFIG_KEYS.STRIPE_SECRET_KEY,
      CONFIG_KEYS.ENABLED_FEATURES,
      CONFIG_KEYS.COUNTRY,
    ],
    {
      intervalMs: SUBSCRIPTION_CHECK_INTERVAL_MS,
      // One read for the queue, then per subscription: one ledger read and
      // one write.
      maxDatabaseCalls: 1 + SUBSCRIPTION_CHECK_BATCH * 2,
      maxExternalCalls: SUBSCRIPTION_CHECK_BATCH * 2,
      name: "subscription_status_check",
      run: async (context) => {
        const { runSubscriptionCheck } = await import(
          "#shared/subscriptions/status-check.ts"
        );
        await runSubscriptionCheck(context);
      },
      wakePolicy: "scheduled_only",
    },
  ),
]);
