import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  defineMaintenanceTasks,
  MAINTENANCE_RELEASE_HEADROOM_MS,
  MAINTENANCE_REQUEST_CALL_LIMIT,
  MAINTENANCE_REQUEST_DATABASE_CALL_LIMIT,
  MAINTENANCE_TASK_CALL_LIMIT,
  type MaintenanceTaskDeclaration,
  maintenanceStartupCalls,
  maintenanceTaskByName,
} from "#shared/maintenance/definition.ts";
import {
  PAYMENT_CASE_ALERT_TASK_BUDGET,
  PAYMENT_MAINTENANCE_TASK_BUDGET,
  PAYMENT_RECONCILIATION_TASK_BUDGET,
} from "#shared/payment-runtime/maintenance-budget.ts";
import { BUNNY_SUBREQUEST_LIMIT } from "#shared/subrequest-budget.ts";
import { maintenanceDeclaration } from "./fixtures.ts";

const task = (
  overrides: Parameters<typeof maintenanceDeclaration>[2] = {},
): MaintenanceTaskDeclaration =>
  maintenanceDeclaration("test_task", () => Promise.resolve(), {
    maxDatabaseCalls: 1,
    ...overrides,
  });

describe("maintenance task declarations", () => {
  test("totals every startup call and the shared settings and sync calls", () => {
    expect(maintenanceStartupCalls([])).toEqual({
      database: 0,
      external: 0,
      total: 0,
    });
    expect(
      maintenanceStartupCalls([
        task({
          check: {
            maxDatabaseCalls: 2,
            maxExternalCalls: 4,
            settingsKeys: ["first"],
          },
          name: "first",
        }),
        task({
          check: { maxDatabaseCalls: 3, maxExternalCalls: 5 },
          name: "second",
        }),
      ]),
    ).toEqual({ database: 8, external: 9, total: 17 });
  });

  test("keeps scheduler work below Bunny's request limits", () => {
    expect(BUNNY_SUBREQUEST_LIMIT - MAINTENANCE_REQUEST_CALL_LIMIT).toBe(8);
    expect(MAINTENANCE_REQUEST_DATABASE_CALL_LIMIT).toBe(40);
    expect(MAINTENANCE_REQUEST_CALL_LIMIT - MAINTENANCE_TASK_CALL_LIMIT).toBe(
      8,
    );
    expect(MAINTENANCE_RELEASE_HEADROOM_MS).toBe(1_000);
    expect(
      PAYMENT_RECONCILIATION_TASK_BUDGET.database +
        PAYMENT_RECONCILIATION_TASK_BUDGET.external,
    ).toBe(MAINTENANCE_TASK_CALL_LIMIT - 1);
    expect(
      PAYMENT_CASE_ALERT_TASK_BUDGET.database +
        PAYMENT_CASE_ALERT_TASK_BUDGET.external,
    ).toBe(12);
    expect(
      PAYMENT_MAINTENANCE_TASK_BUDGET.database +
        PAYMENT_MAINTENANCE_TASK_BUDGET.external,
    ).toBe(MAINTENANCE_TASK_CALL_LIMIT);
  });

  test("rejects a name that cannot be stored as a task key", () => {
    expect(() => defineMaintenanceTasks([task({ name: "Not valid" })])).toThrow(
      "Invalid maintenance task name",
    );
  });

  test("fails loudly when a claimed task was not declared", () => {
    expect(() => maintenanceTaskByName([task()], "missing")).toThrow(
      "Claimed undeclared maintenance task: missing",
    );
  });

  test("keeps one validated static declaration", () => {
    const declaration = task();
    expect(defineMaintenanceTasks([declaration])[0]).toBe(declaration);
  });

  test("rejects duplicate stable names", () => {
    expect(() => defineMaintenanceTasks([task(), task()])).toThrow(
      "Duplicate maintenance task: test_task",
    );
  });

  test("rejects intervals shorter than one minute", () => {
    expect(() =>
      defineMaintenanceTasks([task({ intervalMs: 59_999 })]),
    ).toThrow("test_task interval must be at least 60000ms");
  });

  test("rejects retries longer than the normal interval", () => {
    expect(() =>
      defineMaintenanceTasks([
        task({ failureRetryIntervalMs: 60_001, intervalMs: 60_000 }),
      ]),
    ).toThrow("test_task failure retry must be between 60000ms and 60000ms");
  });

  test("rejects a task that cannot fit the whole request budget", () => {
    expect(() =>
      defineMaintenanceTasks([
        task({
          maxDatabaseCalls: MAINTENANCE_TASK_CALL_LIMIT,
          maxExternalCalls: 1,
        }),
      ]),
    ).toThrow(
      `test_task declares ${MAINTENANCE_TASK_CALL_LIMIT + 1} calls; maximum is ${MAINTENANCE_TASK_CALL_LIMIT}`,
    );
  });

  test("accepts the exact whole-request task allowance", () => {
    expect(() =>
      defineMaintenanceTasks([
        task({ maxDatabaseCalls: MAINTENANCE_TASK_CALL_LIMIT }),
      ]),
    ).not.toThrow();
  });

  test("rejects activation checks above the database request limit", () => {
    expect(() =>
      defineMaintenanceTasks([
        task({
          check: {
            maxDatabaseCalls: MAINTENANCE_REQUEST_DATABASE_CALL_LIMIT - 1,
          },
        }),
      ]),
    ).toThrow(
      `Maintenance checks declare ${MAINTENANCE_REQUEST_DATABASE_CALL_LIMIT + 1} database and ${MAINTENANCE_REQUEST_DATABASE_CALL_LIMIT + 1} total startup calls; maximums are ${MAINTENANCE_REQUEST_DATABASE_CALL_LIMIT} and ${MAINTENANCE_REQUEST_CALL_LIMIT}`,
    );
  });

  test("rejects activation checks above the combined request limit", () => {
    expect(() =>
      defineMaintenanceTasks([
        task({
          check: { maxExternalCalls: MAINTENANCE_REQUEST_CALL_LIMIT - 1 },
        }),
      ]),
    ).toThrow(
      `Maintenance checks declare 2 database and ${MAINTENANCE_REQUEST_CALL_LIMIT + 1} total startup calls; maximums are ${MAINTENANCE_REQUEST_DATABASE_CALL_LIMIT} and ${MAINTENANCE_REQUEST_CALL_LIMIT}`,
    );
  });

  test("rejects invalid call counts and deadlines", () => {
    expect(() =>
      defineMaintenanceTasks([task({ maxDatabaseCalls: -1 })]),
    ).toThrow("test_task database calls must be a non-negative integer");
    expect(() =>
      defineMaintenanceTasks([task({ maxExternalCalls: -1 })]),
    ).toThrow("test_task external calls must be a non-negative integer");
    expect(() =>
      defineMaintenanceTasks([task({ check: { maxDatabaseCalls: -1 } })]),
    ).toThrow(
      "test_task enabled-check database calls must be a non-negative integer",
    );
    expect(() =>
      defineMaintenanceTasks([task({ check: { maxExternalCalls: -1 } })]),
    ).toThrow(
      "test_task enabled-check external calls must be a non-negative integer",
    );
    expect(() => defineMaintenanceTasks([task({ deadlineMs: 0 })])).toThrow(
      "test_task deadline must be greater than 0ms",
    );
    expect(() =>
      defineMaintenanceTasks([task({ deadlineMs: 1 })]),
    ).not.toThrow();
  });
});
