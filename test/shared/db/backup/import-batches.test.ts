import type { InStatement, TransactionMode } from "@libsql/client";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { restoreFromSql } from "#shared/db/backup.ts";
import { getDb, queryAll } from "#shared/db/client.ts";
import { verifyCurrentAppSchema } from "#shared/db/migrations/schema-sync.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv("backup import batches", { db: true }, () => {
  const restoreAndInspectImport = async (
    sql: string,
  ): Promise<{ schemaObjects: string[] | null; sizes: number[] }> => {
    const client = getDb();
    const originalBatch = client.batch.bind(client);
    const sizes: number[] = [];
    let schemaObjects: string[] | null = null;
    let importing = false;
    const batchStub = stub(client, "batch", (async (
      statements: InStatement[],
      mode?: TransactionMode,
    ) => {
      const sqls = statements.map((statement) =>
        typeof statement === "string" ? statement : statement.sql,
      );
      if (sqls.includes("DELETE FROM settings")) {
        importing = true;
        const result = await client.execute(
          "SELECT name FROM sqlite_master WHERE name LIKE 'idx_%' OR name LIKE 'trg_%'",
        );
        schemaObjects = result.rows.map(({ name }) => String(name));
        sizes.push(statements.length);
        return originalBatch(statements, mode);
      }
      if (importing && !sqls[0]!.includes(" INDEX IF NOT EXISTS ")) {
        sizes.push(statements.length);
      }
      return originalBatch(statements, mode);
    }) as never);

    try {
      await restoreFromSql(sql);
    } finally {
      batchStub.restore();
    }
    return { schemaObjects, sizes };
  };

  const settingsDump = (values: string[]): string =>
    values
      .map(
        (value, index) =>
          `INSERT INTO settings (key, value) VALUES ('large_${index}', '${value}');`,
      )
      .join("\n");

  test("limits the number of statements in one transaction", async () => {
    const { sizes } = await restoreAndInspectImport(
      settingsDump(Array.from({ length: 51 }, (_, index) => String(index))),
    );

    expect(sizes).toEqual([50, 4]);
    expect(
      await queryAll<{ count: number }>(
        "SELECT COUNT(*) AS count FROM settings WHERE key LIKE 'large_%'",
      ),
    ).toEqual([{ count: 51 }]);
  });

  test("limits the SQL bytes in one transaction", async () => {
    const { sizes } = await restoreAndInspectImport(
      settingsDump(["a".repeat(300_000), "b".repeat(300_000)]),
    );

    expect(sizes).toEqual([4, 1]);
  });

  test("defers indexes and triggers until after importing rows", async () => {
    const { schemaObjects } = await restoreAndInspectImport(
      settingsDump(["v"]),
    );

    expect(schemaObjects).toEqual([]);
    await verifyCurrentAppSchema();
  });
});
