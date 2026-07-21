import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { hasLegacyActivityLog } from "#shared/db/activity-log-backfill.ts";
import { settings } from "#shared/db/settings.ts";
import {
  MAINTENANCE_PRUNE_BATCH,
  PRUNE_UNUSED_STRINGS_RETENTION_MS,
} from "#shared/limits.ts";
import type { MaintenanceTaskDeclaration } from "#shared/maintenance/definition.ts";
import { MAINTENANCE_TASKS } from "#shared/maintenance/registry.ts";
import { nowMs } from "#shared/now.ts";
import {
  insertLoginAttempt,
  insertStrings,
  loginAttemptExists,
} from "#test/shared/db/prune/helpers.ts";
import { insertLegacyActivity } from "#test-utils/activity-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const taskNamed = (name: string): MaintenanceTaskDeclaration => {
  const task = MAINTENANCE_TASKS.find((candidate) => candidate.name === name);
  if (!task) throw new Error(`Maintenance task not found: ${name}`);
  return task;
};

const runTask = (
  task: MaintenanceTaskDeclaration,
  requestFollowUp: () => void = () => {},
): void | Promise<void> =>
  task.run({
    budget: {
      remaining: () => ({ database: 2, external: 0, total: 2 }),
    },
    checkpoint: null,
    deadline: Date.now() + 10_000,
    requestFollowUp,
    setCheckpoint: () => {},
  });

describeWithEnv("maintenance registry", { db: true }, () => {
  test("declares only bounded local pruning and activity backfill", () => {
    expect(
      MAINTENANCE_TASKS.map(({ check, run: _run, ...task }) => ({
        ...task,
        check: { ...check, enabled: undefined },
      })),
    ).toEqual([
      {
        check: {
          enabled: undefined,
          maxDatabaseCalls: 0,
          maxExternalCalls: 0,
          settingsKeys: ["auto_purge_orphans", "orphan_purge_retention"],
        },
        deadlineMs: 15_000,
        failureRetryIntervalMs: 300_000,
        intervalMs: 86_400_000,
        maxDatabaseCalls: 2,
        maxExternalCalls: 0,
        name: "database_pruning",
        wakePolicy: "organic_safe",
      },
      {
        check: {
          enabled: undefined,
          maxDatabaseCalls: 1,
          maxExternalCalls: 0,
          settingsKeys: ["public_key"],
        },
        deadlineMs: 10_000,
        failureRetryIntervalMs: 60_000,
        intervalMs: 60_000,
        maxDatabaseCalls: 2,
        maxExternalCalls: 0,
        name: "activity_log_backfill",
        wakePolicy: "organic_safe",
      },
    ]);
  });

  test("the pruning task runs one bounded database batch", async () => {
    expect(await taskNamed("database_pruning").check.enabled()).toBe(true);
    const ipHash = await insertLoginAttempt("192.0.2.10", 1, 0);
    expect(await loginAttemptExists(ipHash)).toBe(true);

    expect(await runTask(taskNamed("database_pruning"))).toBeUndefined();

    expect(await loginAttemptExists(ipHash)).toBe(false);
  });

  test("the pruning task requests a follow-up for a full batch", async () => {
    const old = new Date(
      nowMs() - PRUNE_UNUSED_STRINGS_RETENTION_MS - 60_000,
    ).toISOString();
    await insertStrings("registry-backlog", old, MAINTENANCE_PRUNE_BATCH + 1);

    let followUps = 0;

    await runTask(taskNamed("database_pruning"), () => {
      followUps += 1;
    });

    expect(followUps).toBe(1);
  });

  test("the activity task enables and drains legacy rows", async () => {
    await insertLegacyActivity("registry legacy");
    const task = taskNamed("activity_log_backfill");

    expect(await task.check.enabled()).toBe(true);
    await runTask(task);

    expect(await hasLegacyActivityLog()).toBe(false);
  });

  test("the activity task stays disabled when no legacy rows remain", async () => {
    expect(await taskNamed("activity_log_backfill").check.enabled()).toBe(
      false,
    );
  });

  test("the activity task stays disabled without an owner public key", async () => {
    await insertLegacyActivity("legacy without owner key");
    settings.setForTest({ public_key: "" });

    expect(await taskNamed("activity_log_backfill").check.enabled()).toBe(
      false,
    );
  });
});
