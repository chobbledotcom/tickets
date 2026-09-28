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
  type MaintenanceSweepOutcome,
  type MaintenanceTaskCheck,
  type MaintenanceTaskDeclaration,
  SQUARE_CANCELLATION_BATCH,
} from "#shared/maintenance/definition.ts";
import { DAY_MS } from "#shared/now.ts";
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

/** A task only a configured provider can have work for: its key gates the
 * task row in sync, and its settings keys ride along for the audit. */
const providerCheck = (
  enabled: () => boolean,
  settingsKeys: readonly string[],
): MaintenanceTaskCheck => ({
  enabled,
  maxDatabaseCalls: 0,
  maxExternalCalls: 0,
  settingsKeys,
});

/** What a checkpoint-driven sweep hands back; every sweep module declares
 * this same outcome. */
type SweepOutcome = MaintenanceSweepOutcome;
/** A run body that loads a sweep module and keeps its checkpoint. */
const sweepRun =
  (
    load: () => Promise<(checkpoint: string | null) => Promise<SweepOutcome>>,
  ): MaintenanceTaskDeclaration["run"] =>
  async ({ checkpoint, requestFollowUp, setCheckpoint }) => {
    const result = await (await load())(checkpoint);
    setCheckpoint(result.checkpoint);
    if (result.fullBatch) requestFollowUp();
  };

/** A run body that loads a worker and asks for a follow-up while it reports
 * more work. */
const runWhileMore =
  (
    load: () => Promise<() => Promise<boolean>>,
  ): MaintenanceTaskDeclaration["run"] =>
  async ({ requestFollowUp }) => {
    if (await (await load())()) requestFollowUp();
  };

/** The checkpoint sweeps' lazy workers, named by their task. Each literal
 * dynamic import keeps the worker's production use visible to the export
 * scan, and one dispatcher holds them all so no two loaders repeat. */
const loadSweepWorker = async (
  task: "database_pruning" | "terminal_checkout_cleanup",
): Promise<(checkpoint: string | null) => Promise<SweepOutcome>> => {
  if (task === "database_pruning") {
    const { runDatabasePruning } = await import("#db/prune.ts");
    return runDatabasePruning;
  }
  const { runTerminalCheckoutCleanup } = await import(
    "#db/checkout-answer-cleanup.ts"
  );
  return runTerminalCheckoutCleanup;
};

/** The follow-up sweeps' lazy workers, named by their task. */
const loadMoreWorker = async (
  task:
    | "sumup_checkout_recovery"
    | "square_checkout_cancellation"
    | "registration_email_delivery",
): Promise<() => Promise<boolean>> => {
  if (task === "sumup_checkout_recovery") {
    const { runSumupRecovery } = await import("#shared/sumup/recovery-run.ts");
    return runSumupRecovery;
  }
  if (task === "square_checkout_cancellation") {
    const { runSquareCheckoutCancellation } = await import(
      "#shared/square/cancel-old-links.ts"
    );
    return runSquareCheckoutCancellation;
  }
  const { deliverDueRegistrationEmails } = await import(
    "#shared/email/registration-work.ts"
  );
  return async () => (await deliverDueRegistrationEmails()).more;
};

/** The skeleton every always-on periodic sweep shares; a task names only
 * what makes it different. */
const sweepTask = (
  declaration: Partial<MaintenanceTaskDeclaration> &
    Pick<
      MaintenanceTaskDeclaration,
      "maxDatabaseCalls" | "maxExternalCalls" | "name" | "run"
    >,
): MaintenanceTaskDeclaration => ({
  deadlineMs: 15_000,
  failureRetryIntervalMs: FAILURE_RETRY_MS,
  intervalMs: PRUNE_INTERVAL_MS,
  ...declaration,
  check: declaration.check ?? alwaysEnabled([]),
  wakePolicy: declaration.wakePolicy ?? "organic_safe",
});

export const MAINTENANCE_TASKS = defineMaintenanceTasks([
  sweepTask({
    check: alwaysEnabled([
      CONFIG_KEYS.AUTO_PURGE_ORPHANS,
      CONFIG_KEYS.ORPHAN_PURGE_RETENTION,
    ]),
    maxDatabaseCalls: 2,
    maxExternalCalls: 0,
    name: "database_pruning",
    run: sweepRun(() => loadSweepWorker("database_pruning")),
  }),
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
    // A site with no SumUp key has no staged checkouts to ask about, and
    // syncMaintenanceTaskRows removes the task row while that is true.
    check: providerCheck(
      () => settings.sumup.hasKey,
      [CONFIG_KEYS.SUMUP_API_KEY, CONFIG_KEYS.SUMUP_MERCHANT_CODE],
    ),
    deadlineMs: 20_000,
    failureRetryIntervalMs: FAILURE_RETRY_MS,
    intervalMs: SUMUP_RECOVERY_INTERVAL_MS,
    // One read for the queue, then per checkout: one SumUp read plus the
    // engine's own writes. A paid checkout needing a refund spends the most,
    // which is what keeps the batch small.
    maxDatabaseCalls: 1 + SUMUP_RECOVERY_BATCH * 6,
    maxExternalCalls: SUMUP_RECOVERY_BATCH * 2,
    name: "sumup_checkout_recovery",
    run: runWhileMore(() => loadMoreWorker("sumup_checkout_recovery")),
    wakePolicy: "organic_safe",
  },
  {
    // A site with no Square key cannot create Square links to cancel.
    check: providerCheck(
      () => settings.square.hasToken,
      [CONFIG_KEYS.SQUARE_ACCESS_TOKEN, CONFIG_KEYS.SQUARE_LOCATION_ID],
    ),
    deadlineMs: 20_000,
    failureRetryIntervalMs: FAILURE_RETRY_MS,
    intervalMs: DAY_MS,
    // One read for the queue, then per link: identity decrypt plus one
    // Square delete, one Square order read, and the guarded delete.
    maxDatabaseCalls: 1 + SQUARE_CANCELLATION_BATCH * 5,
    maxExternalCalls: SQUARE_CANCELLATION_BATCH * 2,
    name: "square_checkout_cancellation",
    run: runWhileMore(() => loadMoreWorker("square_checkout_cancellation")),
    wakePolicy: "scheduled_only",
  },
  sweepTask({
    maxDatabaseCalls: 4,
    maxExternalCalls: 0,
    name: "terminal_checkout_cleanup",
    run: sweepRun(() => loadSweepWorker("terminal_checkout_cleanup")),
  }),
  sweepTask({
    // One read for the due queue, then per message: claim, attendee check,
    // and finish — three database calls and one provider send.
    maxDatabaseCalls: 19,
    maxExternalCalls: 6,
    name: "registration_email_delivery",
    run: runWhileMore(() => loadMoreWorker("registration_email_delivery")),
  }),
]);
