import { unique } from "#fp";
import { settings } from "#shared/db/settings.ts";
import {
  getSubrequestRemaining,
  getSubrequestUsage,
  withSubrequestAllowance,
} from "#shared/subrequest-budget.ts";
import {
  claimNextMaintenanceTask,
  finishMaintenanceTask,
  syncMaintenanceTaskRows,
} from "./claims.ts";
import {
  MAINTENANCE_MIN_INTERVAL_MS,
  MAINTENANCE_RELEASE_HEADROOM_MS,
  MAINTENANCE_REQUEST_CALL_LIMIT,
  MAINTENANCE_REQUEST_DEADLINE_MS,
  type MaintenanceTaskDeclaration,
  type MaintenanceWakePolicy,
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

const taskFits = (
  task: MaintenanceTaskDeclaration,
  remaining: { database: number; external: number; total: number },
): boolean =>
  task.maxExternalCalls <= remaining.external &&
  taskCalls(task) <= remaining.total - 3;

const enabledTasks = async (
  tasks: readonly MaintenanceTaskDeclaration[],
): Promise<{
  disabledNames: string[];
  enabled: MaintenanceTaskDeclaration[];
}> => {
  const states = await Promise.all(
    tasks.map(async (task) => ({ enabled: await task.enabled(), task })),
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
  claim: { leaseToken: string; name: string },
  requestDeadline: number,
): Promise<unknown | null> => {
  const deadline = Math.min(
    Date.now() + task.deadlineMs,
    requestDeadline - MAINTENANCE_RELEASE_HEADROOM_MS,
  );
  let failure: unknown | null = null;
  let needsFollowUp = false;
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
          deadline,
          requestFollowUp: () => {
            needsFollowUp = true;
          },
        }),
    );
  } catch (error) {
    failure = error;
  }
  await finishMaintenanceTask(claim, {
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
  declarations: readonly MaintenanceTaskDeclaration[],
  options: RunMaintenanceOptions,
  requestDeadline: number,
): Promise<void> => {
  const wakePolicy = options.wakePolicy ?? "scheduled_only";
  const candidates = declarations.filter(
    (task) =>
      wakePolicy === "scheduled_only" || task.wakePolicy === "organic_safe",
  );
  await settings.loadKeys(
    unique(candidates.flatMap((task) => task.settingsKeys)),
  );
  const { enabled, disabledNames } = await enabledTasks(candidates);
  await syncMaintenanceTaskRows(
    enabled.map((task) => task.name),
    disabledNames,
  );
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
  const used = getSubrequestUsage().total;
  const combinedAllowance = Math.max(
    0,
    Math.min(
      options.combinedAllowance ?? MAINTENANCE_REQUEST_CALL_LIMIT,
      MAINTENANCE_REQUEST_CALL_LIMIT - used,
    ),
  );
  return withSubrequestAllowance(
    {
      database: combinedAllowance,
      external: Math.min(
        options.externalAllowance ?? combinedAllowance,
        combinedAllowance,
      ),
      total: combinedAllowance,
    },
    () => runWithinAllowance(declarations, options, requestDeadline),
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
