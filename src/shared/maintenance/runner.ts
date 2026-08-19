import { settings } from "#db/settings.ts";
import { unique } from "#fp";
import {
  getSubrequestRemaining,
  getSubrequestUsage,
  withSubrequestAllowance,
} from "#shared/subrequest-budget.ts";
import {
  claimNextMaintenanceTask,
  finishMaintenanceTask,
  type MaintenanceClaim,
  syncMaintenanceTaskRows,
} from "./claims.ts";
import {
  MAINTENANCE_MIN_INTERVAL_MS,
  MAINTENANCE_RELEASE_HEADROOM_MS,
  MAINTENANCE_REQUEST_CALL_LIMIT,
  MAINTENANCE_REQUEST_DATABASE_CALL_LIMIT,
  MAINTENANCE_REQUEST_DEADLINE_MS,
  type MaintenanceTaskDeclaration,
  type MaintenanceWakePolicy,
  maintenanceStartupCalls,
  maintenanceTaskByName,
} from "./definition.ts";

export type RunMaintenanceOptions = {
  combinedAllowance?: number;
  externalAllowance?: number;
  requestDeadline?: number;
  wakePolicy?: MaintenanceWakePolicy;
};

const taskCalls = (task: MaintenanceTaskDeclaration): number =>
  task.maxDatabaseCalls + task.maxExternalCalls;

const tasksForWake = (
  declarations: readonly MaintenanceTaskDeclaration[],
  wakePolicy: MaintenanceWakePolicy,
): readonly MaintenanceTaskDeclaration[] =>
  declarations.filter(
    (task) =>
      wakePolicy === "scheduled_only" || task.wakePolicy === "organic_safe",
  );

// Claim, finish, and the final no-work claim remain outside the task allowance.
const TASK_RUNNER_CALL_RESERVE = 3;

const taskFits = (
  task: MaintenanceTaskDeclaration,
  remaining: { database: number; external: number; total: number },
): boolean =>
  task.maxDatabaseCalls <= remaining.database - TASK_RUNNER_CALL_RESERVE &&
  task.maxExternalCalls <= remaining.external &&
  taskCalls(task) <= remaining.total - TASK_RUNNER_CALL_RESERVE;

const enabledTasks = async (
  tasks: readonly MaintenanceTaskDeclaration[],
): Promise<{
  disabledNames: string[];
  enabled: MaintenanceTaskDeclaration[];
}> => {
  const states = await Promise.all(
    tasks.map(async (task) => ({
      enabled: await task.check.enabled(),
      task,
    })),
  );
  return {
    disabledNames: states
      .filter((state) => !state.enabled)
      .map(({ task }) => task.name),
    enabled: states.filter((state) => state.enabled).map(({ task }) => task),
  };
};

const runClaimedTask = async (
  task: MaintenanceTaskDeclaration,
  claim: MaintenanceClaim,
  requestDeadline: number,
): Promise<unknown | null> => {
  const deadline = Math.min(
    Date.now() + task.deadlineMs,
    requestDeadline - MAINTENANCE_RELEASE_HEADROOM_MS,
  );
  let failure: unknown | null = null;
  let completed = false;
  let needsFollowUp = false;
  let checkpoint = claim.checkpoint;
  try {
    await withSubrequestAllowance(
      {
        database: task.maxDatabaseCalls,
        external: task.maxExternalCalls,
        total: taskCalls(task),
      },
      () =>
        task.run({
          budget: { remaining: getSubrequestRemaining },
          checkpoint: claim.checkpoint,
          completeTask: () => {
            completed = true;
          },
          deadline,
          requestFollowUp: () => {
            needsFollowUp = true;
          },
          setCheckpoint: (nextCheckpoint) => {
            checkpoint = nextCheckpoint;
          },
        }),
    );
    if (completed && needsFollowUp) {
      throw new Error(`${task.name} cannot complete and request a follow-up`);
    }
  } catch (error) {
    failure = error;
  }
  await finishMaintenanceTask(claim, {
    checkpoint: failure === null ? checkpoint : claim.checkpoint,
    completed: failure === null && completed,
    intervalMs:
      failure === null
        ? needsFollowUp
          ? MAINTENANCE_MIN_INTERVAL_MS
          : task.intervalMs
        : task.failureRetryIntervalMs,
  });
  return failure;
};

const runWithinAllowance = async (
  candidates: readonly MaintenanceTaskDeclaration[],
  requestDeadline: number,
): Promise<void> => {
  await settings.loadKeys(
    unique(candidates.flatMap((task) => task.check.settingsKeys)),
  );
  const { enabled, disabledNames } = await enabledTasks(candidates);
  try {
    await syncMaintenanceTaskRows(
      enabled.map((task) => task.name),
      disabledNames,
    );
  } catch (error) {
    throw new Error("Maintenance task list update failed", { cause: error });
  }
  const failures: { error: unknown; name: string }[] = [];

  while (Date.now() < requestDeadline - MAINTENANCE_RELEASE_HEADROOM_MS) {
    const remaining = getSubrequestRemaining();
    const allowed = enabled.filter((task) => taskFits(task, remaining));
    if (allowed.length === 0) break;
    const claim = await claimNextMaintenanceTask(
      allowed.map((task) => task.name),
      requestDeadline - Date.now() + MAINTENANCE_RELEASE_HEADROOM_MS,
    );
    if (!claim) break;
    const task = maintenanceTaskByName(enabled, claim.name);
    try {
      const failure = await runClaimedTask(task, claim, requestDeadline);
      if (failure !== null) failures.push({ error: failure, name: task.name });
    } catch (error) {
      failures.push({ error, name: task.name });
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => failure.error),
      `Maintenance failed: ${failures.map((failure) => failure.name).join(", ")}`,
    );
  }
};

const runMaintenance = (
  declarations: readonly MaintenanceTaskDeclaration[],
  options: RunMaintenanceOptions = {},
): Promise<void> => {
  const requestDeadline =
    options.requestDeadline ?? Date.now() + MAINTENANCE_REQUEST_DEADLINE_MS;
  const used = getSubrequestUsage();
  const combinedAllowance = Math.max(
    0,
    Math.min(
      options.combinedAllowance ?? MAINTENANCE_REQUEST_CALL_LIMIT,
      MAINTENANCE_REQUEST_CALL_LIMIT - used.total,
    ),
  );
  const databaseAllowance = Math.max(
    0,
    Math.min(
      combinedAllowance,
      MAINTENANCE_REQUEST_DATABASE_CALL_LIMIT - used.database,
    ),
  );
  const externalAllowance = Math.min(
    options.externalAllowance ?? combinedAllowance,
    combinedAllowance,
  );
  const candidates = tasksForWake(
    declarations,
    options.wakePolicy ?? "scheduled_only",
  );
  const startup = maintenanceStartupCalls(candidates);
  if (
    startup.database > databaseAllowance ||
    startup.external > externalAllowance ||
    startup.total > combinedAllowance
  ) {
    return Promise.resolve();
  }
  return withSubrequestAllowance(
    {
      database: databaseAllowance,
      external: externalAllowance,
      total: combinedAllowance,
    },
    () => runWithinAllowance(candidates, requestDeadline),
  );
};

/** Run only database-safe work from an ordinary foreground request. */
const runOrganicMaintenance = (
  declarations: readonly MaintenanceTaskDeclaration[],
): Promise<void> =>
  runMaintenance(declarations, {
    externalAllowance: 0,
    wakePolicy: "organic_safe",
  });

export const maintenance = {
  run: runMaintenance,
  runOrganic: runOrganicMaintenance,
};
