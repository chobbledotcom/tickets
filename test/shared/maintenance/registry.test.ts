import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { ENCRYPTION_PREFIX } from "#crypto/encryption.ts";
import { HYBRID_PREFIX } from "#crypto/keys.ts";
import { ACTIVITY_LOG_BACKFILL_COMPLETE } from "#db/activity-log-backfill.ts";
import {
  sessionWorkIndex,
  stageCheckoutAnswers,
} from "#db/checkout-pending-answers.ts";
import { execute, executeBatch, queryOne } from "#db/client.ts";
import { queueRegistrationEmails } from "#db/registration-email-work.ts";
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
import { parseEmail } from "#shared/validation/email.ts";
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
import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

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
  test("declares only bounded pruning, backfill, recovery, and delivery", () => {
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
      {
        check: {
          enabled: undefined,
          maxDatabaseCalls: 0,
          maxExternalCalls: 0,
          settingsKeys: ["square_access_token", "square_location_id"],
        },
        deadlineMs: 20_000,
        failureRetryIntervalMs: 300_000,
        intervalMs: 86_400_000,
        maxDatabaseCalls: 21,
        maxExternalCalls: 8,
        name: "square_checkout_cancellation",
        wakePolicy: "scheduled_only",
      },
      {
        check: {
          enabled: undefined,
          maxDatabaseCalls: 0,
          maxExternalCalls: 0,
          settingsKeys: [],
        },
        deadlineMs: 15_000,
        failureRetryIntervalMs: 300_000,
        intervalMs: 86_400_000,
        maxDatabaseCalls: 4,
        maxExternalCalls: 0,
        name: "terminal_checkout_cleanup",
        wakePolicy: "organic_safe",
      },
      {
        check: {
          enabled: undefined,
          maxDatabaseCalls: 0,
          maxExternalCalls: 0,
          settingsKeys: [],
        },
        deadlineMs: 15_000,
        failureRetryIntervalMs: 300_000,
        intervalMs: 86_400_000,
        maxDatabaseCalls: 19,
        maxExternalCalls: 6,
        name: "registration_email_delivery",
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

  test("the terminal cleanup task sweeps its staged answers through the registry", async () => {
    const sessionId = "cs_registry_terminal";
    await stageCheckoutAnswers(sessionId, { "3": "staged answer" });
    await execute(
      `INSERT INTO processed_payments
         (payment_session_id, processed_at, failure_data)
       VALUES (?, ?, 'enc:1:registry:terminal')`,
      [sessionId, nowIso()],
    );
    const checkpoints: (string | null)[] = [];
    let followUps = 0;

    await runTask(taskNamed("terminal_checkout_cleanup"), {
      requestFollowUp: () => {
        followUps += 1;
      },
      setCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
    });

    // The loaded sweep removed the failed payment's staged answers and, with
    // room left in its batch, asked for neither a checkpoint nor a follow-up.
    expect(
      await queryOne(
        "SELECT session_index FROM checkout_pending_answers WHERE session_index = ?",
        [await sessionWorkIndex(sessionId)],
      ),
    ).toBeNull();
    expect(checkpoints).toEqual([null]);
    expect(followUps).toBe(0);
  });

  test("the Square cancellation task is off until Square is connected", async () => {
    expect(
      await taskNamed("square_checkout_cancellation").check.enabled(),
    ).toBe(false);
  });

  test("the Square cancellation task asks for no follow-up when no links wait", async () => {
    let followUps = 0;

    await runTask(taskNamed("square_checkout_cancellation"), {
      requestFollowUp: () => {
        followUps += 1;
      },
    });

    expect(followUps).toBe(0);
  });

  test("the registration delivery task asks for a follow-up when its batch fills", async () => {
    // Six claims fill the delivery worker's batch; an erased attendee ends
    // each claim without a provider call, so the batch always reports more.
    const listing = await createTestListing({ maxAttendees: 5 });
    const { attendee } = await createTestAttendeeDirect(
      listing.id,
      "Registry Batch Buyer",
      "registry-batch@example.com",
    );
    for (let index = 0; index < 6; index++) {
      await queueRegistrationEmails(`cs_registry_batch_${index}`, attendee.id, [
        {
          message: {
            html: "<p>Welcome</p>",
            subject: "Registration",
            text: "Welcome",
            to: parseEmail("registry-batch@example.com")!,
          },
          recipient: "buyer",
        },
      ]);
    }
    await execute("DELETE FROM attendees WHERE id = ?", [attendee.id]);
    let followUps = 0;

    await runTask(taskNamed("registration_email_delivery"), {
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
