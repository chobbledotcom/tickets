import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { ENCRYPTION_PREFIX } from "#shared/crypto/encryption.ts";
import { HYBRID_PREFIX } from "#shared/crypto/keys.ts";
import { ACTIVITY_LOG_BACKFILL_COMPLETE } from "#shared/db/activity-log-backfill.ts";
import {
  beginCheckoutStageRefund,
  loadCheckoutStageByPaymentSession,
} from "#shared/db/checkout-stages.ts";
import { executeBatch } from "#shared/db/client.ts";
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
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import {
  getSubrequestRemaining,
  runWithSubrequestBudget,
  withSubrequestAllowance,
} from "#shared/subrequest-budget.ts";
import {
  attendeeExists,
  insertLoginAttempt,
  insertOrphanAttendee,
  insertStrings,
  loginAttemptExists,
} from "#test/shared/db/prune/helpers.ts";
import {
  insertLegacyActivity,
  rawActivityMessage,
} from "#test-utils/activity-log.ts";
import {
  insertCheckoutStage,
  testCheckoutRefund,
} from "#test-utils/checkout-stages.ts";
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
      remaining: () => ({
        database: task.maxDatabaseCalls,
        external: task.maxExternalCalls,
        total: task.maxDatabaseCalls + task.maxExternalCalls,
      }),
    },
    checkpoint: null,
    completeTask: () => {},
    deadline: Date.now() + 10_000,
    requestFollowUp: () => {},
    setCheckpoint: () => {},
    ...overrides,
  });

const runTaskAtDeclaredAllowance = (
  task: MaintenanceTaskDeclaration,
  overrides: Partial<MaintenanceTaskContext> = {},
): void | Promise<void> =>
  runWithSubrequestBudget(() =>
    withSubrequestAllowance(
      {
        database: task.maxDatabaseCalls,
        external: task.maxExternalCalls,
        total: task.maxDatabaseCalls + task.maxExternalCalls,
      },
      () =>
        runTask(task, {
          budget: { remaining: getSubrequestRemaining },
          ...overrides,
        }),
    ),
  );

describeWithEnv("maintenance registry", { db: true }, () => {
  test("declares bounded database, checkout, and activity work", () => {
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
          settingsKeys: [],
        },
        deadlineMs: 20_000,
        failureRetryIntervalMs: 300_000,
        intervalMs: 86_400_000,
        maxDatabaseCalls: 25,
        maxExternalCalls: 9,
        name: "checkout_stage_pruning",
        wakePolicy: "scheduled_only",
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

    await runTask(taskNamed("database_pruning"), {
      requestFollowUp: () => {
        followUps += 1;
      },
    });

    expect(followUps).toBe(1);
  });

  test("the checkout task closes and removes an abandoned stage", async () => {
    const created = new Date(nowMs() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const attendeeId = await insertOrphanAttendee(created);
    await insertCheckoutStage(attendeeId, "scheduled-old-stage", {
      createdAt: created,
    });
    using close = stub(stripePaymentProvider, "closeCheckout", () =>
      Promise.resolve("closed" as const),
    );

    await runTask(taskNamed("checkout_stage_pruning"));

    expect(close.calls).toHaveLength(1);
    expect(await attendeeExists(attendeeId)).toBe(false);
  });

  test("the checkout task advances a due refunding stage at its declared allowance", async () => {
    const attendeeId = await insertOrphanAttendee(nowIso());
    const sessionId = "scheduled-refunding-stage";
    await insertCheckoutStage(attendeeId, sessionId);
    await beginCheckoutStageRefund(sessionId, testCheckoutRefund());
    using retrieve = stub(stripePaymentProvider, "retrieveSession", () =>
      Promise.resolve(null),
    );
    const followUps: number[] = [];

    await runTaskAtDeclaredAllowance(taskNamed("checkout_stage_pruning"), {
      requestFollowUp: (afterMs = 60_000) => followUps.push(afterMs),
    });

    expect(await loadCheckoutStageByPaymentSession(sessionId)).toMatchObject({
      attemptCount: 1,
      state: "refunding",
    });
    expect(retrieve.calls).toHaveLength(1);
    expect(followUps).toHaveLength(1);
  });

  test("the checkout task requests follow-ups until its backlog is empty", async () => {
    const created = new Date(nowMs() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const task = taskNamed("checkout_stage_pruning");
    const attendeeIds = await Promise.all(
      Array.from({ length: task.maxDatabaseCalls + 1 }, async (_, index) => {
        const attendeeId = await insertOrphanAttendee(created);
        await insertCheckoutStage(attendeeId, `backlog-${index}`, {
          createdAt: created,
        });
        return attendeeId;
      }),
    );
    using close = stub(stripePaymentProvider, "closeCheckout", () =>
      Promise.resolve("closed" as const),
    );
    const followUps: number[] = [];

    for (let index = 0; index < 2; index++) {
      await runTask(task, {
        requestFollowUp: (afterMs = 60_000) => followUps.push(afterMs),
      });
    }

    expect(close.calls).toHaveLength(attendeeIds.length);
    expect(followUps).toEqual([60_000]);
    expect(
      await Promise.all(
        attendeeIds.map((attendeeId) => attendeeExists(attendeeId)),
      ),
    ).toEqual(attendeeIds.map(() => false));
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
