// test-groups: run-alone
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute, queryOne } from "#shared/db/client.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { adminGet } from "#test-utils/session.ts";

describeWithEnv("organic maintenance failure isolation", { db: true }, () => {
  const errors = setupErrorSpy();

  test("reports maintenance failure without replacing a successful response", async () => {
    await execute("DROP TABLE maintenance_tasks");

    const response = await adminGet("/admin");

    expect(response.status).toBe(200);
    expect(errors.contains("organic maintenance failed")).toBe(true);
    expect(errors.contains("Maintenance task list update failed")).toBe(true);
    expect(errors.calls.length).toBe(1);
    expect(
      await queryOne<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'maintenance_tasks'",
      ),
    ).toBeNull();
  });
});
