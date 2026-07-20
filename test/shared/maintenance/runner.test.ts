import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute, queryOne } from "#shared/db/client.ts";
import {
  defineMaintenanceTasks,
  MAINTENANCE_MIN_INTERVAL_MS,
  type MaintenanceTaskDeclaration,
} from "#shared/maintenance/definition.ts";
import { maintenance } from "#shared/maintenance/runner.ts";
import {
  countSubrequest,
  getSubrequestUsage,
  runWithSubrequestBudget,
} from "#shared/subrequest-budget.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const declaration = (
  name: string,
  run: MaintenanceTaskDeclaration["run"],
  overrides: Partial<MaintenanceTaskDeclaration> = {},
): MaintenanceTaskDeclaration => ({
  deadlineMs: 10_000,
  enabled: () => true,
  failureRetryIntervalMs: 60_000,
  intervalMs: 60_000,
  maxDatabaseCalls: 0,
  maxExternalCalls: 0,
  name,
  run,
  settingsKeys: [],
  wakePolicy: "organic_safe",
  ...overrides,
});

const forceDue = (names: string[]): Promise<unknown> =>
  execute(
    `UPDATE maintenance_tasks SET next_run_at = 0
      WHERE name IN (${names.map(() => "?").join(", ")})`,
    names,
  );

const nextRunAt = async (name: string): Promise<number> => {
  const row = await queryOne<{ next_run_at: number }>(
    "SELECT next_run_at FROM maintenance_tasks WHERE name = ?",
    [name],
  );
  if (!row) throw new Error(`Maintenance task not found: ${name}`);
  return row.next_run_at;
};

const taskTiming = (name: string) =>
  queryOne<{ last_finished_at: number; next_run_at: number }>(
    `SELECT last_finished_at, next_run_at
       FROM maintenance_tasks WHERE name = ?`,
    [name],
  );

describeWithEnv("maintenance runner", { db: true }, () => {
  test("isolates a failed task and reports it after another task runs", async () => {
    const ran: string[] = [];
    const tasks = defineMaintenanceTasks([
      declaration(
        "fails",
        () => {
          ran.push("fails");
          throw new Error("broken task");
        },
        { intervalMs: 120_000 },
      ),
      declaration(
        "works",
        () => {
          ran.push("works");
        },
        { intervalMs: 120_000 },
      ),
    ]);

    await expect(
      runWithSubrequestBudget(() => maintenance.run(tasks)),
    ).rejects.toThrow("Maintenance failed: fails");
    expect(ran.sort()).toEqual(["fails", "works"]);
    expect(
      (await nextRunAt("works")) - (await nextRunAt("fails")),
    ).toBeGreaterThan(50_000);
  });

  test("reports every failed task by name", async () => {
    const fail = (name: string): MaintenanceTaskDeclaration =>
      declaration(name, () => {
        throw new Error(name);
      });

    await expect(
      runWithSubrequestBudget(() =>
        maintenance.run(
          defineMaintenanceTasks([fail("first"), fail("second")]),
        ),
      ),
    ).rejects.toThrow("Maintenance failed: first, second");
  });

  test("reports a lost release without hiding the completed task", async () => {
    const tasks = defineMaintenanceTasks([
      declaration(
        "release_fails",
        async () => {
          await execute(`CREATE TRIGGER fail_maintenance_release
            BEFORE UPDATE ON maintenance_tasks
            WHEN OLD.name = 'release_fails' AND NEW.lease_token IS NULL
            BEGIN SELECT RAISE(ABORT, 'release failed'); END`);
        },
        { maxDatabaseCalls: 1 },
      ),
    ]);

    await expect(
      runWithSubrequestBudget(() => maintenance.run(tasks)),
    ).rejects.toThrow("Maintenance failed: release_fails");
  });

  test("an immediate second run does not catch up missed intervals", async () => {
    const calls: number[] = [];
    const tasks = defineMaintenanceTasks([
      declaration("cadence", () => {
        calls.push(Date.now());
      }),
    ]);

    await runWithSubrequestBudget(() => maintenance.run(tasks));
    await runWithSubrequestBudget(() => maintenance.run(tasks));

    expect(calls.length).toBe(1);
  });

  test("a successful task can request an early follow-up", async () => {
    const tasks = defineMaintenanceTasks([
      declaration("follow_up", ({ requestFollowUp }) => requestFollowUp(), {
        intervalMs: 300_000,
      }),
    ]);
    await runWithSubrequestBudget(() => maintenance.run(tasks));

    const timing = await taskTiming("follow_up");
    expect(timing?.next_run_at).toBe(
      (timing?.last_finished_at ?? 0) + MAINTENANCE_MIN_INTERVAL_MS,
    );
  });

  test("passes and saves a successful task checkpoint", async () => {
    await execute(
      `INSERT INTO maintenance_tasks (name, checkpoint, next_run_at)
       VALUES ('checkpoint_task', 'page-1', 0)`,
    );
    const tasks = defineMaintenanceTasks([
      declaration("checkpoint_task", ({ checkpoint, setCheckpoint }) => {
        expect(checkpoint).toBe("page-1");
        setCheckpoint("page-2");
      }),
    ]);

    await runWithSubrequestBudget(() => maintenance.run(tasks));

    expect(
      await queryOne<{ checkpoint: string }>(
        "SELECT checkpoint FROM maintenance_tasks WHERE name = 'checkpoint_task'",
      ),
    ).toEqual({ checkpoint: "page-2" });
  });

  test("scheduled-only work is excluded from organic runs", async () => {
    const calls: string[] = [];
    const tasks = defineMaintenanceTasks([
      declaration(
        "scheduled_only",
        () => {
          calls.push("ran");
        },
        { wakePolicy: "scheduled_only" },
      ),
    ]);

    await runWithSubrequestBudget(() => maintenance.runOrganic(tasks));

    expect(calls).toEqual([]);
  });

  test("the default scheduled wake includes scheduled-only work", async () => {
    const calls: string[] = [];
    const tasks = defineMaintenanceTasks([
      declaration(
        "scheduled_default",
        () => {
          calls.push("ran");
        },
        { wakePolicy: "scheduled_only" },
      ),
    ]);

    await runWithSubrequestBudget(() => maintenance.run(tasks));

    expect(calls).toEqual(["ran"]);
  });

  test("a task that cannot fit keeps its due time", async () => {
    const tasks = defineMaintenanceTasks([
      declaration("too_large", () => {}, { maxDatabaseCalls: 1 }),
    ]);
    await runWithSubrequestBudget(() => maintenance.run(tasks));
    await forceDue(["too_large"]);
    const before = await queryOne<{ next_run_at: number }>(
      "SELECT next_run_at FROM maintenance_tasks WHERE name = 'too_large'",
    );

    await runWithSubrequestBudget(() =>
      maintenance.run(tasks, { combinedAllowance: 4 }),
    );

    const after = await queryOne<{ next_run_at: number }>(
      "SELECT next_run_at FROM maintenance_tasks WHERE name = 'too_large'",
    );
    expect(after?.next_run_at).toBe(before?.next_run_at);
  });

  test("passes a cooperative deadline and exact task allowances", async () => {
    const seen: {
      database: number;
      deadline: number;
      external: number;
      total: number;
    }[] = [];
    const tasks = defineMaintenanceTasks([
      declaration(
        "budgeted",
        ({ budget, deadline }) => {
          const remaining = budget.remaining();
          seen.push({
            database: remaining.database,
            deadline,
            external: remaining.external,
            total: remaining.total,
          });
        },
        { deadlineMs: 5_000, maxDatabaseCalls: 3, maxExternalCalls: 2 },
      ),
    ]);
    const before = Date.now();

    await runWithSubrequestBudget(() => maintenance.run(tasks));

    expect(seen).toEqual([
      {
        database: 3,
        deadline: seen[0]!.deadline,
        external: 2,
        total: 5,
      },
    ]);
    expect(seen[0]!.deadline).toBeGreaterThanOrEqual(before + 4_000);
    expect(seen[0]!.deadline).toBeLessThanOrEqual(before + 5_100);
  });

  test("keeps the lease past the request deadline", async () => {
    let leaseExpiresAt = 0;
    const tasks = defineMaintenanceTasks([
      declaration(
        "lease_lifetime",
        async () => {
          const row = await queryOne<{ lease_expires_at: number }>(
            "SELECT lease_expires_at FROM maintenance_tasks WHERE name = 'lease_lifetime'",
          );
          if (!row) throw new Error("Maintenance lease not found");
          leaseExpiresAt = row.lease_expires_at;
        },
        { maxDatabaseCalls: 1 },
      ),
    ]);
    const requestDeadline = Date.now() + 5_000;

    await runWithSubrequestBudget(() =>
      maintenance.run(tasks, { requestDeadline }),
    );

    expect(leaseExpiresAt - requestDeadline).toBeGreaterThan(500);
    expect(leaseExpiresAt - requestDeadline).toBeLessThan(1_500);
  });

  test("the default request deadline preserves release headroom", async () => {
    let deadline = 0;
    const tasks = defineMaintenanceTasks([
      declaration(
        "release_headroom",
        (context) => {
          deadline = context.deadline;
        },
        { deadlineMs: 25_000 },
      ),
    ]);
    const before = Date.now();

    await runWithSubrequestBudget(() => maintenance.run(tasks));

    expect(deadline).toBeGreaterThan(before + 23_000);
    expect(deadline).toBeLessThan(before + 24_500);
  });

  test("an expired request deadline starts no task", async () => {
    const calls: string[] = [];
    const tasks = defineMaintenanceTasks([
      declaration("expired_request", () => {
        calls.push("ran");
      }),
    ]);

    await runWithSubrequestBudget(() =>
      maintenance.run(tasks, { requestDeadline: 0 }),
    );

    expect(calls).toEqual([]);
  });

  test("zero combined allowance skips scheduler bookkeeping", async () => {
    const calls: string[] = [];
    const tasks = defineMaintenanceTasks([
      declaration("no_allowance", () => {
        calls.push("ran");
      }),
    ]);

    await runWithSubrequestBudget(async () => {
      await maintenance.run(tasks, { combinedAllowance: 0 });
      expect(getSubrequestUsage()).toEqual({
        database: 0,
        external: 0,
        total: 0,
      });
    });
    expect(calls).toEqual([]);
  });

  test("subtracts request calls already used from the maintenance envelope", async () => {
    const calls: string[] = [];
    const tasks = defineMaintenanceTasks([
      declaration(
        "prior_usage",
        () => {
          calls.push("ran");
        },
        { maxDatabaseCalls: 30 },
      ),
    ]);

    await runWithSubrequestBudget(async () => {
      countSubrequest("database", "earlier request work");
      countSubrequest("database", "more earlier request work");
      await maintenance.run(tasks);
    });

    expect(calls).toEqual(["ran"]);
  });

  test("zero external allowance leaves external tasks due", async () => {
    const calls: string[] = [];
    const tasks = defineMaintenanceTasks([
      declaration(
        "external",
        () => {
          calls.push("ran");
        },
        { maxExternalCalls: 1 },
      ),
    ]);

    await runWithSubrequestBudget(() => maintenance.runOrganic(tasks));

    expect(calls).toEqual([]);
  });

  test("organic and authenticated wakes race through one durable claim", async () => {
    const calls: string[] = [];
    const tasks = defineMaintenanceTasks([
      declaration("wake_race", () => {
        calls.push("ran");
      }),
    ]);

    await Promise.all([
      runWithSubrequestBudget(() =>
        maintenance.run(tasks, { wakePolicy: "organic_safe" }),
      ),
      runWithSubrequestBudget(() => maintenance.run(tasks)),
    ]);

    expect(calls).toEqual(["ran"]);
  });

  for (const [minutes, expectedBatches] of [
    [1, 15],
    [5, 3],
    [15, 1],
  ] as const) {
    test(`${minutes}-minute pings drain ${expectedBatches} bounded batch(es) in fifteen minutes`, async () => {
      const name = `cadence_${minutes}`;
      let batches = 0;
      const tasks = defineMaintenanceTasks([
        declaration(name, () => {
          batches += 1;
        }),
      ]);

      for (let minute = minutes; minute <= 15; minute += minutes) {
        await forceDue([name]);
        await runWithSubrequestBudget(() => maintenance.run(tasks));
      }

      expect(batches).toBe(expectedBatches);
    });
  }
});
