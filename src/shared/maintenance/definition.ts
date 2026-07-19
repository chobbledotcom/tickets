export const MAINTENANCE_MIN_INTERVAL_MS = 60_000;
export const MAINTENANCE_REQUEST_CALL_LIMIT = 40;
const MAINTENANCE_RESERVED_CALLS = 7;
export const MAINTENANCE_TASK_CALL_LIMIT =
  MAINTENANCE_REQUEST_CALL_LIMIT - MAINTENANCE_RESERVED_CALLS;
export const MAINTENANCE_REQUEST_DEADLINE_MS = 25_000;
export const MAINTENANCE_RELEASE_HEADROOM_MS = 1_000;

export type MaintenanceWakePolicy = "organic_safe" | "scheduled_only";

export type MaintenanceTaskBudget = {
  remaining: () => { database: number; external: number; total: number };
};

export type MaintenanceTaskContext = {
  budget: MaintenanceTaskBudget;
  checkpoint: string | null;
  deadline: number;
  requestFollowUp: () => void;
  setCheckpoint: (checkpoint: string | null) => void;
};

export interface MaintenanceTaskDeclaration {
  deadlineMs: number;
  enabled: () => boolean | Promise<boolean>;
  failureRetryIntervalMs: number;
  intervalMs: number;
  maxDatabaseCalls: number;
  maxExternalCalls: number;
  name: string;
  run: (context: MaintenanceTaskContext) => void | Promise<void>;
  settingsKeys: readonly string[];
  wakePolicy: MaintenanceWakePolicy;
}

const assertNonNegativeInteger = (
  task: MaintenanceTaskDeclaration,
  value: number,
  label: string,
): void => {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `${task.name} ${label} calls must be a non-negative integer`,
    );
  }
};

const validateTask = (task: MaintenanceTaskDeclaration): void => {
  if (!/^[a-z][a-z0-9_]*$/.test(task.name)) {
    throw new Error(`Invalid maintenance task name: ${task.name}`);
  }
  if (task.intervalMs < MAINTENANCE_MIN_INTERVAL_MS) {
    throw new Error(
      `${task.name} interval must be at least ${MAINTENANCE_MIN_INTERVAL_MS}ms`,
    );
  }
  if (
    task.failureRetryIntervalMs < MAINTENANCE_MIN_INTERVAL_MS ||
    task.failureRetryIntervalMs > task.intervalMs
  ) {
    throw new Error(
      `${task.name} failure retry must be between ${MAINTENANCE_MIN_INTERVAL_MS}ms and ${task.intervalMs}ms`,
    );
  }
  if (
    task.deadlineMs <= 0 ||
    task.deadlineMs > MAINTENANCE_REQUEST_DEADLINE_MS
  ) {
    throw new Error(
      `${task.name} deadline must be greater than 0ms and at most ${MAINTENANCE_REQUEST_DEADLINE_MS}ms`,
    );
  }
  assertNonNegativeInteger(task, task.maxDatabaseCalls, "database");
  assertNonNegativeInteger(task, task.maxExternalCalls, "external");
  const calls = task.maxDatabaseCalls + task.maxExternalCalls;
  if (calls > MAINTENANCE_TASK_CALL_LIMIT) {
    throw new Error(
      `${task.name} declares ${calls} calls; maximum is ${MAINTENANCE_TASK_CALL_LIMIT}`,
    );
  }
};

export const defineMaintenanceTasks = <
  const Tasks extends readonly MaintenanceTaskDeclaration[],
>(
  tasks: Tasks,
): Tasks => {
  const names = new Set<string>();
  for (const task of tasks) {
    if (names.has(task.name)) {
      throw new Error(`Duplicate maintenance task: ${task.name}`);
    }
    names.add(task.name);
    validateTask(task);
  }
  return tasks;
};

export const maintenanceTaskByName = (
  tasks: readonly MaintenanceTaskDeclaration[],
  name: string,
): MaintenanceTaskDeclaration => {
  const task = tasks.find((candidate) => candidate.name === name);
  if (!task) throw new Error(`Claimed undeclared maintenance task: ${name}`);
  return task;
};
