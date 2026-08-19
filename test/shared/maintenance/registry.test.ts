import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { ENCRYPTION_PREFIX } from "#crypto/encryption.ts";
import { HYBRID_PREFIX } from "#crypto/keys.ts";
import { ACTIVITY_LOG_BACKFILL_COMPLETE } from "#db/activity-log-backfill.ts";
import { executeBatch } from "#db/client.ts";
import {
  ACTIVITY_LOG_BACKFILL_BATCH,
  MAINTENANCE_PRUNE_BATCH,
  PRUNE_UNUSED_STRINGS_RETENTION_MS,
} from "#shared/limits.ts";
import type {
  MaintenanceTaskContext,
  MaintenanceTaskDeclaration,
} from "#shared/maintenance/definition.ts";
import { MAINTENANCE_TASKS } from "#shared/maintenance/registry.ts";
import { nowIso, nowMs } from "#shared/now.ts";
import {
  insertLoginAttempt,
  insertStrings,
  loginAttemptExists,
} from "#test/shared/db/prune/helpers.ts";
import {
  insertLegacyActivity,
  rawActivityMessage,
} from "#test-utils/activity-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const taskNamed = (name: string): MaintenanceTaskDeclaration => {
  const task = MAINTENANCE_TASKS.find((candidate) => candidate.name === name);
  if (!task) throw new Error(`Maintenance task not found: ${name}`);
  return task;
};

const runTask = (
  task: MaintenanceTaskDeclaration,
  overrides: Partial<MaintenanceTaskContext> = {},
): void | Promise<void> =>
  task.run({
    budget: {
      remaining: () => ({ database: 2, external: 0, total: 2 }),
    },
    checkpoint: null,
    completeTask: () => {},
    deadline: Date.now() + 10_000,
    requestFollowUp: () => {},
    setCheckpoint: () => {},
    ...overrides,
  });

describeWithEnv("maintenance registry", { db: true }, () => {
  test("declares only bounded pruning, activity backfill and SumUp recovery", () => {
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
          maxDatabaseCalls: 0,
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
      {
        check: {
          enabled: undefined,
          maxDatabaseCalls: 0,
          maxExternalCalls: 0,
          settingsKeys: ["sumup_api_key", "sumup_merchant_code"],
        },
        deadlineMs: 20_000,
        failureRetryIntervalMs: 300_000,
        intervalMs: 1_800_000,
        maxDatabaseCalls: 19,
        maxExternalCalls: 6,
        name: "sumup_checkout_recovery",
        wakePolicy: "organic_safe",
      },
    ]);
  });

  test("the SumUp recovery task runs its check and asks for more when full", async () => {
    // Driving the declared task, not the function behind it: the wiring in
    // the registry is what the scheduler actually calls.
    const { makeSumupCheckoutDue, stageSignedSumupCheckout } = await import(
      "#test-utils/sumup.ts"
    );
    const { sumupApi } = await import("#shared/sumup.ts");
    const { SUMUP_RECOVERY_BATCH } = await import("#shared/limits.ts");
    for (let index = 0; index < SUMUP_RECOVERY_BATCH; index++) {
      const id = `co_task_${index}`;
      await stageSignedSumupCheckout(id);
      await makeSumupCheckoutDue(id);
    }
    const read = stub(sumupApi, "readCheckoutById", () =>
      Promise.resolve({
        reason: "provider_error" as const,
        status: "unavailable" as const,
      }),
    );
    let followUps = 0;
    try {
      await runTask(taskNamed("sumup_checkout_recovery"), {
        requestFollowUp: () => {
          followUps += 1;
        },
      });
    } finally {
      read.restore();
    }
    expect(read.calls.length).toBe(SUMUP_RECOVERY_BATCH);
    // A full batch means there may be more waiting behind it.
    expect(followUps).toBe(1);
  });

  test("the SumUp recovery task is off until SumUp is connected", async () => {
    // A site with no SumUp key stages no checkouts, so there is nothing to
    // ask about and syncMaintenanceTaskRows drops the row entirely.
    expect(await taskNamed("sumup_checkout_recovery").check.enabled()).toBe(
      false,
    );
  });

  test("the pruning task runs one bounded database batch", async () => {
    expect(await taskNamed("database_pruning").check.enabled()).toBe(true);
    const ipHash = await insertLoginAttempt("192.0.2.10", 1, 0, 0);
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

    await runTask(taskNamed("database_pruning"), {
      requestFollowUp: () => {
        followUps += 1;
      },
    });

    expect(followUps).toBe(1);
  });

  test("the activity task enables and drains legacy rows", async () => {
    const id = await insertLegacyActivity("registry legacy");
    const task = taskNamed("activity_log_backfill");

    expect(await task.check.enabled()).toBe(true);
    await runTask(task);

    expect((await rawActivityMessage(id)).startsWith(HYBRID_PREFIX)).toBe(true);
  });

  test("the activity task stays available to preserve its checkpoint", async () => {
    expect(await taskNamed("activity_log_backfill").check.enabled()).toBe(true);
  });

  test("a completed activity checkpoint completes without scanning", async () => {
    let completed = 0;

    await runTask(taskNamed("activity_log_backfill"), {
      checkpoint: ACTIVITY_LOG_BACKFILL_COMPLETE,
      completeTask: () => {
        completed += 1;
      },
    });

    expect(completed).toBe(1);
  });

  test("the final activity batch saves its completed checkpoint", async () => {
    const checkpoints: (string | null)[] = [];
    let completed = 0;

    await runTask(taskNamed("activity_log_backfill"), {
      completeTask: () => {
        completed += 1;
      },
      setCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
    });

    expect(checkpoints).toEqual([ACTIVITY_LOG_BACKFILL_COMPLETE]);
    expect(completed).toBe(1);
  });

  test("the activity task requests a follow-up after a full batch", async () => {
    const firstId = await insertLegacyActivity("full registry batch");
    const message = await rawActivityMessage(firstId);
    expect(message.startsWith(ENCRYPTION_PREFIX)).toBe(true);
    await executeBatch(
      Array.from({ length: ACTIVITY_LOG_BACKFILL_BATCH - 1 }, () => ({
        args: [message, nowIso()],
        sql: "INSERT INTO activity_log (message, created, listing_id, attendee_id) VALUES (?, ?, NULL, NULL)",
      })),
    );
    let followUps = 0;
    const checkpoints: (string | null)[] = [];

    await runTask(taskNamed("activity_log_backfill"), {
      requestFollowUp: () => {
        followUps += 1;
      },
      setCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
    });

    expect(followUps).toBe(1);
    expect(checkpoints).toEqual([]);
  });
});
