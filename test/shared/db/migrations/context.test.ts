import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { loadMigrations } from "#shared/db/migrations/context.ts";
import { MIGRATION_IDS } from "#shared/db/migrations/registry.ts";

describe("db > migrations > context", () => {
  test("builds one migration per registry entry, in run order", async () => {
    const migrations = await loadMigrations();

    expect(migrations.map((migration) => migration.id)).toEqual([
      ...MIGRATION_IDS,
    ]);
  });

  test("every built migration describes itself", async () => {
    const migrations = await loadMigrations();

    expect(
      migrations.filter((migration) => migration.description.length === 0),
    ).toEqual([]);
  });

  test("loading again reuses the first build instead of re-importing", async () => {
    const first = await loadMigrations();

    expect(await loadMigrations()).toBe(first);
  });
});
