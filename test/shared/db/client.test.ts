import type { ResultSet } from "@libsql/client";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  DATABASE_MAX_ATTEMPTS,
  execute,
  executeReturningRow,
  getDb,
  queryAll,
  queryAllPrimary,
  queryBatch,
  queryOne,
  queryOnePrimary,
  requireOne,
  requireOnePrimary,
  rowExists,
  setDb,
} from "#db/client.ts";
import { runWithPrimaryReads } from "#db/primary-reads.ts";
import { type SqlStatement, sql } from "#db/sql.ts";
import { registerTableInvalidation } from "#shared/cache-registry.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withEnv } from "#test-utils/env.ts";

/** A minimal libsql ResultSet for stubbed execute/batch calls. */
const emptyResultSet = (): ResultSet => ({
  columns: [],
  columnTypes: [],
  lastInsertRowid: undefined,
  rows: [],
  rowsAffected: 0,
  toJSON: () => ({}),
});

describe("DATABASE_MAX_ATTEMPTS", () => {
  // The refund budgets size themselves from this number, so it has to match
  // what the client really does: one try, then the 50/150/350ms ladder.
  test("counts the first try plus every wait on the remote ladder", () => {
    expect(DATABASE_MAX_ATTEMPTS).toBe(4);
  });
});

describeWithEnv("invalidateForSql fallback path", { db: true }, () => {
  test("UPDATE with unparseable SET fires column-gated invalidators unconditionally", async () => {
    let fired = 0;
    const unregister = registerTableInvalidation(
      ["t"],
      () => {
        fired++;
      },
      { whenColumns: ["col1"] },
    );
    const executeStub = stub(getDb(), "execute", () =>
      Promise.resolve(emptyResultSet()),
    );
    try {
      // Empty SET clause → extractUpdateColumns returns null → fallback fires
      await execute(sql`UPDATE t SET WHERE true`);
      expect(fired).toBe(1);
    } finally {
      executeStub.restore();
      unregister();
    }
  });

  test("REPLACE INTO invalidates the target table", async () => {
    let fired = 0;
    const unregister = registerTableInvalidation(["settings"], () => {
      fired++;
    });
    try {
      await execute(
        sql`REPLACE INTO settings (key, value) VALUES (${"replace_test"}, ${"val"})`,
      );
      expect(fired).toBe(1);
    } finally {
      unregister();
    }
  });
});

describeWithEnv("db > client", { db: true }, () => {
  test("getDb throws error when DB_URL is not set", () => {
    setDb(null);
    using _env = withEnv({ DB_URL: undefined });
    expect(() => getDb()).toThrow("DB_URL environment variable is required");
  });

  test("getDb creates client when db is null", () => {
    setDb(null);
    using _env = withEnv({ DB_URL: ":memory:" });
    const client = getDb();
    expect(typeof client.execute).toBe("function");
  });

  test("getDb returns existing client when db is set", () => {
    const client1 = getDb();
    const client2 = getDb();
    expect(client1).toBe(client2);
  });

  /** Store one settings row, so a read below has a known row to find. */
  const seedSetting = (key: string, value: string): Promise<ResultSet> =>
    execute(sql`INSERT INTO settings (key, value) VALUES (${key}, ${value})`);

  /** The transaction modes the client is asked for while `read` runs. An empty
   *  list means the read never went out as a batch at all. */
  const batchModesWhile = async <T>(
    read: () => Promise<T>,
  ): Promise<{ modes: unknown[]; result: T }> => {
    const modes: unknown[] = [];
    const batchStub = stub(getDb(), "batch", (_statements, mode) => {
      modes.push(mode);
      return Promise.resolve([emptyResultSet()]);
    });
    try {
      return { modes, result: await read() };
    } finally {
      batchStub.restore();
    }
  };

  test("primary read scopes use remote write mode and local read mode", async () => {
    const { modes, result } = await batchModesWhile(async () => {
      await queryBatch([sql`SELECT 1`]);
      {
        using _env = withEnv({ DB_URL: "libsql://primary.test" });
        await runWithPrimaryReads(() => queryAll(sql`SELECT 1`));
        await runWithPrimaryReads(() => queryBatch([sql`SELECT 1`]));
      }
      return await runWithPrimaryReads(() =>
        queryAll<{ one: number }>(sql`SELECT 1 AS one`),
      );
    });
    expect(result).toEqual([{ one: 1 }]);
    expect(modes).toEqual(["read", "write", "write"]);
  });

  test("a read outside a primary scope is left to a replica", async () => {
    const { modes, result } = await batchModesWhile(async () => {
      using _env = withEnv({ DB_URL: "libsql://primary.test" });
      return await queryAll<{ one: number }>(sql`SELECT 1 AS one`);
    });
    // One plain statement, which any replica can answer. A batch here would
    // pin every ordinary read to the primary and take its write-mode lock.
    expect(result).toEqual([{ one: 1 }]);
    expect(modes).toEqual([]);
  });

  test("queryOne returns null for an expected miss", async () => {
    expect(
      await queryOne(
        sql`SELECT value FROM settings WHERE key = ${"missing-query-one-test"}`,
      ),
    ).toBeNull();
  });

  /** Both required readers must reject with the statement text they were
   *  given, naming the primary only in the primary one. */
  const missingRowCases: {
    name: string;
    read: () => Promise<unknown>;
    message: string;
  }[] = [
    {
      message:
        "Required query returned no rows: SELECT value FROM settings WHERE key = ?",
      name: "requireOne throws the failed query when a required row is missing",
      read: () =>
        requireOne(
          sql`SELECT value FROM settings WHERE key = ${"missing-query-one-test"}`,
        ),
    },
    {
      message:
        "Required primary query returned no rows: SELECT value FROM settings WHERE key = ?",
      name: "requireOnePrimary names a missing row on the primary",
      read: () =>
        requireOnePrimary(
          sql`SELECT value FROM settings WHERE key = ${"missing-primary-query-one-test"}`,
        ),
    },
  ];

  for (const { name, read, message } of missingRowCases) {
    test(name, async () => {
      await expect(read()).rejects.toThrow(message);
    });
  }

  type SingularRead = (
    statement: SqlStatement,
  ) => Promise<{ value: string } | null>;

  // Both singular readers must surface the one matching row — not null, and not
  // a neighbouring row — so one table covers the replica and the primary read.
  const singularReaders: [name: string, key: string, read: SingularRead][] = [
    ["queryOne returns the single matching row", "query_one", queryOne],
    [
      "queryOnePrimary returns the single matching row from the primary",
      "query_one_primary",
      queryOnePrimary,
    ],
  ];

  for (const [name, key, read] of singularReaders) {
    test(name, async () => {
      await seedSetting(key, "found");
      const row = await read(
        sql`SELECT value FROM settings WHERE key = ${key}`,
      );
      // Exactly one row must surface as that row (not null, not the next one).
      expect(row?.value).toBe("found");
    });
  }

  test("queryAllPrimary returns every matching row from the primary", async () => {
    await seedSetting("query_all_primary_a", "first");
    await seedSetting("query_all_primary_b", "second");
    const rows = await queryAllPrimary<{ value: string }>(
      sql`SELECT value FROM settings WHERE key LIKE ${"query_all_primary_%"} ORDER BY key`,
    );
    // Every match in order: a plural that answered with the first row alone
    // would be the singular wearing the wrong name.
    expect(rows.map(({ value }) => value)).toEqual(["first", "second"]);
  });

  test("rowExists is true when the probe matches a row", async () => {
    await seedSetting("exists_test", "x");
    expect(
      await rowExists(
        sql`SELECT 1 FROM settings WHERE key = ${"exists_test"} LIMIT 1`,
      ),
    ).toBe(true);
  });

  test("rowExists is false when no row matches", async () => {
    expect(
      await rowExists(
        sql`SELECT 1 FROM settings WHERE key = ${"missing_key"} LIMIT 1`,
      ),
    ).toBe(false);
  });

  test("executeReturningRow reads back the written row", async () => {
    const row = await executeReturningRow<{ value: string }>(
      sql`INSERT INTO settings (key, value) VALUES ('returning_test', 'x') RETURNING value`,
    );
    expect(row).toEqual({ value: "x" });
  });

  test("executeReturningRow throws when the write returned no row", async () => {
    await expect(
      executeReturningRow(
        sql`UPDATE settings SET value = 'y' WHERE key = ${"missing_key"} RETURNING value`,
      ),
    ).rejects.toThrow("Write returned no row");
  });
});
