import { LibsqlError } from "@libsql/client";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { execute, getDb, queryOne } from "#db/client.ts";
import {
  claimNextMaintenanceTask,
  finishMaintenanceTask,
  syncMaintenanceTaskRows,
} from "#shared/maintenance/claims.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const TASK = "claim_test";
const OTHER_TASK = "other_test";

const taskRow = (name = TASK) =>
  queryOne<{
    last_finished_at: number | null;
    last_started_at: number | null;
    lease_token: string | null;
    checkpoint: string | null;
    completed_at: number | null;
    next_run_at: number;
  }>(
    `SELECT checkpoint, completed_at, next_run_at, lease_token,
            last_started_at, last_finished_at
       FROM maintenance_tasks WHERE name = ?`,
    [name],
  );

const replaceExpiredClaim = async () => {
  await syncMaintenanceTaskRows([TASK], []);
  const first = await claimNextMaintenanceTask([TASK], 60_000);
  await execute(
    "UPDATE maintenance_tasks SET lease_expires_at = 0 WHERE name = ?",
    [TASK],
  );
  const second = await claimNextMaintenanceTask([TASK], 60_000);
  return { first, second };
};

describeWithEnv("maintenance task claims", { db: true }, () => {
  test("does not claim when no task is allowed", async () => {
    expect(await claimNextMaintenanceTask([], 60_000)).toBeNull();
  });

  test("creates a missing task once and gives one concurrent caller the lease", async () => {
    await syncMaintenanceTaskRows([TASK], []);

    const claims = await Promise.all([
      claimNextMaintenanceTask([TASK], 60_000),
      claimNextMaintenanceTask([TASK], 60_000),
    ]);

    expect(claims.filter(Boolean).length).toBe(1);
    expect(claims.filter((claim) => claim === null).length).toBe(1);
  });

  test("uses direct idempotent writes instead of a batch", async () => {
    await syncMaintenanceTaskRows([TASK], []);
    using batch = stub(getDb(), "batch", () =>
      Promise.reject(
        new LibsqlError("Server returned HTTP status 500", "SERVER_ERROR"),
      ),
    );

    await syncMaintenanceTaskRows([TASK], []);

    expect(batch.calls).toHaveLength(0);
  });

  test("leaves the due time unchanged while work is leased", async () => {
    await syncMaintenanceTaskRows([TASK], []);
    const before = await taskRow();
    const claim = await claimNextMaintenanceTask([TASK], 60_000);
    const after = await taskRow();

    expect(claim?.name).toBe(TASK);
    expect(after?.next_run_at).toBe(before?.next_run_at);
    expect(after?.last_started_at).not.toBeNull();
  });

  test("reclaims crashed work immediately after its lease expires", async () => {
    const { first, second } = await replaceExpiredClaim();

    expect(second?.name).toBe(TASK);
    expect(second?.leaseToken).not.toBe(first?.leaseToken);
  });

  test("prevents a stale worker from finishing its successor's claim", async () => {
    const { first, second } = await replaceExpiredClaim();

    await expect(
      finishMaintenanceTask(first!, {
        checkpoint: null,
        completed: false,
        intervalMs: 60_000,
      }),
    ).rejects.toThrow("Lost maintenance lease for claim_test");
    expect((await taskRow())?.lease_token).toBe(second?.leaseToken);
  });

  test("success schedules from database completion time without catch-up", async () => {
    await syncMaintenanceTaskRows([TASK], []);
    await execute(
      "UPDATE maintenance_tasks SET next_run_at = 1 WHERE name = ?",
      [TASK],
    );
    const claim = await claimNextMaintenanceTask([TASK], 60_000);
    await finishMaintenanceTask(claim!, {
      checkpoint: "next-page",
      completed: false,
      intervalMs: 60_000,
    });

    const row = await taskRow();
    expect(row?.next_run_at).toBe((row?.last_finished_at ?? 0) + 60_000);
    expect(row?.checkpoint).toBe("next-page");
    expect(row?.completed_at).toBeNull();
    expect(row?.last_finished_at).not.toBeNull();
    expect(row?.lease_token).toBeNull();
  });

  test("failure uses the bounded retry interval", async () => {
    await syncMaintenanceTaskRows([TASK], []);
    const claim = await claimNextMaintenanceTask([TASK], 60_000);
    await finishMaintenanceTask(claim!, {
      checkpoint: null,
      completed: false,
      intervalMs: 120_000,
    });

    const row = await taskRow();
    expect(row?.next_run_at).toBe((row?.last_finished_at ?? 0) + 120_000);
    expect(row?.last_finished_at).not.toBeNull();
  });

  test("claims separate tasks by oldest due time", async () => {
    await syncMaintenanceTaskRows([TASK, OTHER_TASK], []);
    await execute(
      `UPDATE maintenance_tasks
          SET next_run_at = CASE name WHEN ? THEN 2 ELSE 1 END`,
      [TASK],
    );

    const claim = await claimNextMaintenanceTask([TASK, OTHER_TASK], 60_000);

    expect(claim?.name).toBe(OTHER_TASK);
  });

  test("removes rows for declarations that are no longer enabled", async () => {
    await syncMaintenanceTaskRows([TASK, OTHER_TASK], []);
    await syncMaintenanceTaskRows([TASK], [OTHER_TASK]);
    expect(await taskRow(OTHER_TASK)).toBeNull();
  });

  test("keeps a disabled row until its active lease finishes", async () => {
    await syncMaintenanceTaskRows([TASK], []);
    const claim = await claimNextMaintenanceTask([TASK], 60_000);

    await syncMaintenanceTaskRows([], [TASK]);

    expect((await taskRow())?.lease_token).toBe(claim?.leaseToken);
    await finishMaintenanceTask(claim!, {
      checkpoint: claim!.checkpoint,
      completed: false,
      intervalMs: 60_000,
    });
    await syncMaintenanceTaskRows([], [TASK]);
    expect(await taskRow()).toBeNull();
  });

  test("does not claim completed work when its old due time has passed", async () => {
    await syncMaintenanceTaskRows([TASK], []);
    const claim = await claimNextMaintenanceTask([TASK], 60_000);
    await finishMaintenanceTask(claim!, {
      checkpoint: "done",
      completed: true,
      intervalMs: 60_000,
    });
    await execute(
      "UPDATE maintenance_tasks SET next_run_at = 0 WHERE name = ?",
      [TASK],
    );

    expect(await claimNextMaintenanceTask([TASK], 60_000)).toBeNull();
  });
});
