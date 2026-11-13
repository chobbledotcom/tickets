import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { ENCRYPTION_PREFIX } from "#crypto/encryption.ts";
import { HYBRID_PREFIX } from "#crypto/hybrid.ts";

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

/** What a task asked of the runner during one run. */
type TaskRequests = {
  checkpoints: (string | null)[];
  completions: number;
  followUps: number;
};

/** Run the declared task `name` and record what it asked of the runner. */
const runRecorded = async (
  name: string,
  overrides: Partial<MaintenanceTaskContext> = {},
): Promise<TaskRequests> => {
  const requests: TaskRequests = {
    checkpoints: [],
    completions: 0,
    followUps: 0,
  };
  await runTask(taskNamed(name), {
    completeTask: () => {
      requests.completions += 1;
    },
    requestFollowUp: () => {
      requests.followUps += 1;
    },
    setCheckpoint: (checkpoint) => {
      requests.checkpoints.push(checkpoint);
    },
    ...overrides,
  });
  return requests;
};

/** Run the task `name` over a full batch while `provider` answers for the
 * provider. A full batch means more can wait behind it, so the task asks for
 * a follow-up run. */
const expectFollowUpAfterFullBatch = async (
  name: string,
  provider: { calls: unknown[]; restore: () => void },
  batch: number,
): Promise<void> => {
  try {
    expect((await runRecorded(name)).followUps).toBe(1);
  } finally {
    provider.restore();
  }
  expect(provider.calls.length).toBe(batch);
};

describeWithEnv("maintenance registry", { db: true }, () => {
  test("each provider task is off until its provider is set up", async () => {
    // With nothing set up there is nothing to ask about, so
    // syncMaintenanceTaskRows drops each task row.
    const names = [
      "sumup_checkout_recovery",
      "square_link_expiry",
      "subscription_status_check",
    ];
    expect(
      await Promise.all(names.map((name) => taskNamed(name).check.enabled())),
    ).toEqual([false, false, false]);
  });

  test("the subscription check needs both a Stripe key and the feature", async () => {
    const { enableFeature, setupStripe } = await import(
      "#test-utils/settings.ts"
    );
    const { settings } = await import("#db/settings.ts");
    const { check } = taskNamed("subscription_status_check");
    // The runner loads the declared keys before it asks.
    const enabled = async () => {
      await settings.loadKeys(check.settingsKeys);
      return check.enabled();
    };
    await setupStripe();
    const withKeyOnly = await enabled();
    await enableFeature("subscriptions");
    expect([withKeyOnly, await enabled()]).toEqual([false, true]);
  });

  test("the subscription check finishes its pass when no subscription waits", async () => {
    const { checkpoints, followUps } = await runRecorded(
      "subscription_status_check",
      { checkpoint: "7" },
    );
    expect([checkpoints, followUps]).toEqual([[null], 0]);
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
    await expectFollowUpAfterFullBatch(
      "sumup_checkout_recovery",
      read,
      SUMUP_RECOVERY_BATCH,
    );
  });

  test("the Square link expiry task runs its check and asks for more when full", async () => {
    const { configureSquare } = await import("#test-utils/square/fixtures.ts");
    const { execute } = await import("#db/client.ts");
    const { stageSquareLinkEnd } = await import("#db/square-link-ends.ts");
    const { hmacHash } = await import("#crypto/hashing.ts");
    const { squareApi } = await import("#shared/square/api.ts");
    const { SQUARE_LINK_EXPIRY_BATCH } = await import(
      "#shared/square/limits.ts"
    );
    await configureSquare();
    for (let index = 0; index < SQUARE_LINK_EXPIRY_BATCH; index++) {
      const id = `sq_task_${index}`;
      await stageSquareLinkEnd(id, `link_${id}`, "2026-01-01T00:00:00Z");
      await execute(
        "UPDATE square_link_ends SET next_attempt_at = '2020-01-01T00:00:00Z' WHERE session_index = ?",
        [await hmacHash(id)],
      );
    }
    const read = stub(squareApi, "endLink", () =>
      Promise.resolve({
        headers: new Headers(),
        ok: false,
        status: 404,
        text: `{"errors":[]}`,
      }),
    );
    await expectFollowUpAfterFullBatch(
      "square_link_expiry",
      read,
      SQUARE_LINK_EXPIRY_BATCH,
    );
  });

  test("the pruning task runs one bounded database batch", async () => {
    expect(await taskNamed("database_pruning").check.enabled()).toBe(true);
    const ipHash = await insertLoginAttempt("192.0.2.10", 1, 0, 0);
    expect(await loginAttemptExists(ipHash)).toBe(true);

    // One login attempt is far from a full batch.
    expect((await runRecorded("database_pruning")).followUps).toBe(0);

    expect(await loginAttemptExists(ipHash)).toBe(false);
  });

  test("the pruning task requests a follow-up for a full batch", async () => {
    const old = new Date(
      nowMs() - PRUNE_UNUSED_STRINGS_RETENTION_MS - 60_000,
    ).toISOString();
    await insertStrings("registry-backlog", old, MAINTENANCE_PRUNE_BATCH + 1);

    expect((await runRecorded("database_pruning")).followUps).toBe(1);
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
    const { completions } = await runRecorded("activity_log_backfill", {
      checkpoint: ACTIVITY_LOG_BACKFILL_COMPLETE,
    });
    expect(completions).toBe(1);
  });

  test("the final activity batch saves its completed checkpoint", async () => {
    const { checkpoints, completions } = await runRecorded(
      "activity_log_backfill",
    );
    expect([checkpoints, completions]).toEqual([
      [ACTIVITY_LOG_BACKFILL_COMPLETE],
      1,
    ]);
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
    const { checkpoints, followUps } = await runRecorded(
      "activity_log_backfill",
    );
    expect([checkpoints, followUps]).toEqual([[], 1]);
  });
});
