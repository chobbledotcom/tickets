import type { ResultSet } from "@libsql/client";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  DATABASE_MAX_ATTEMPTS,
  deleteByFieldStatement,
  execute,
  executeReturningRow,
  executeUpdate,
  getDb,
  insert,
  insertOrIgnore,
  queryAll,
  queryAllPrimary,
  queryBatch,
  queryOne,
  queryOnePrimary,
  requireOne,
  requireOnePrimary,
  resetAggregates,
  rowExists,
  setDb,
  update,
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

describe("insertOrIgnore", () => {
  test("writes an insert that skips a clash", () => {
    expect(insertOrIgnore("settings", { key: 1 })).toEqual(
      sql`INSERT OR IGNORE INTO settings (key) VALUES (${1})`,
    );
  });
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

  /** The value column stored for `key`. It reads the table directly, so a write
   *  shows its effect without the reader under test in the way. */
  const storedValue = async (key: string): Promise<unknown> => {
    const row = await getDb().execute(
      sql`SELECT value FROM settings WHERE key = ${key}`,
    );
    return row.rows[0]!.value;
  };

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

  /** Each builder must render the whole statement and bind the args in slot
   *  order: SET args before WHERE args, a statement value spliced as written,
   *  a null value kept as a param. Each row is the name, the statement, the
   *  SQL text, and the args. */
  const builtStatements: [
    name: string,
    stmt: SqlStatement,
    sqlText: string,
    args: SqlStatement["args"],
  ][] = [
    [
      "deleteByFieldStatement builds the DELETE for one table, field and value",
      deleteByFieldStatement({ field: "user_id", table: "sessions", value: 7 }),
      "DELETE FROM sessions WHERE user_id = ?1",
      [7],
    ],
    [
      "insert builds sql and args from record",
      insert("users", { email: "a@b.com", name: "Alice" }),
      "INSERT INTO users (email, name) VALUES (?1, ?2)",
      ["a@b.com", "Alice"],
    ],
    [
      "insert takes a statement as a column value",
      insert("listing_attendees", {
        attendee_id: sql`last_insert_rowid()`,
        listing_id: 1,
        quantity: 2,
      }),
      "INSERT INTO listing_attendees (attendee_id, listing_id, quantity) VALUES (last_insert_rowid(), ?1, ?2)",
      [1, 2],
    ],
    [
      "insert handles null values as params",
      insert("payments", { attendee_id: null, created: "now", id: "p1" }),
      "INSERT INTO payments (attendee_id, created, id) VALUES (?1, ?2, ?3)",
      [null, "now", "p1"],
    ],
    [
      "update builds sql and args, SET args before WHERE args",
      update(
        "attendees",
        { pii_blob: "encrypted" },
        { id: 4, kind: "attendee" },
      ),
      "UPDATE attendees SET pii_blob = ?1 WHERE id = ?2 AND kind = ?3",
      ["encrypted", 4, "attendee"],
    ],
    [
      "update takes a statement as a SET value",
      update(
        "listing_attendees",
        { attachment_downloads: sql`attachment_downloads + 1` },
        { attendee_id: 1, listing_id: 2 },
      ),
      "UPDATE listing_attendees SET attachment_downloads = attachment_downloads + 1 WHERE attendee_id = ?1 AND listing_id = ?2",
      [1, 2],
    ],
    [
      "update joins multiple SET assignments with commas",
      update("listings", { name: "n", slug: "s" }, { id: 3 }),
      "UPDATE listings SET name = ?1, slug = ?2 WHERE id = ?3",
      ["n", "s", 3],
    ],
    [
      "update passes null SET values as params",
      update(
        "listing_attendees",
        { start_agent_id: null },
        { start_agent_id: 7 },
      ),
      "UPDATE listing_attendees SET start_agent_id = ?1 WHERE start_agent_id = ?2",
      [null, 7],
    ],
  ];

  for (const [name, stmt, sqlText, args] of builtStatements) {
    test(name, () => {
      expect(stmt.sql).toBe(sqlText);
      expect(stmt.args).toEqual(args);
    });
  }

  test("insert executes correctly against db", async () => {
    await getDb().execute(
      insert("settings", { key: "insert_test", value: "works" }),
    );
    expect(await storedValue("insert_test")).toBe("works");
  });

  /** Assert one executeUpdate over a row seeded with `seed`: the count the write
   *  reports and the value the row keeps afterwards. */
  const expectUpdate = async (
    [key, seed]: [key: string, value: string],
    set: Record<string, string>,
    where: Record<string, string>,
    affected: number,
    stored: string,
  ): Promise<void> => {
    await seedSetting(key, seed);
    const result = await executeUpdate("settings", set, where);
    expect(result.rowsAffected).toBe(affected);
    expect(await storedValue(key)).toBe(stored);
  };

  // A write touches exactly the rows its WHERE matches: the matched row takes
  // the new value, and a WHERE that matches nothing leaves its row as it was.
  test("executeUpdate writes the matched row", async () => {
    await expectUpdate(
      ["update_test", "before"],
      { value: "after" },
      { key: "update_test" },
      1,
      "after",
    );
  });

  test("executeUpdate leaves non-matching rows alone", async () => {
    await expectUpdate(
      ["update_scope", "kept"],
      { value: "clobbered" },
      { key: "update_scope", value: "other" },
      0,
      "kept",
    );
  });

  test("resetAggregates does not issue an empty update", async () => {
    const executeStub = stub(getDb(), "execute", () =>
      Promise.reject(new Error("unexpected aggregate reset query")),
    );
    try {
      await resetAggregates("settings", 1, [], {});
      expect(executeStub.calls.length).toBe(0);
    } finally {
      executeStub.restore();
    }
  });

  test("resetAggregates joins the reset expressions with commas", async () => {
    const captured: SqlStatement[] = [];
    const executeStub = stub(getDb(), "execute", (stmt: SqlStatement) => {
      captured.push(stmt);
      return Promise.resolve(emptyResultSet());
    });
    try {
      await resetAggregates("agg_t", 7, ["a", "b"], {
        a: sql`a + agg_t.id`,
        b: sql`${3}`,
      });
    } finally {
      executeStub.restore();
    }
    // Two recounts must join into one valid SET clause, each under its own
    // column name, with the entity id bound for the WHERE.
    expect(captured).toEqual([
      sql`UPDATE agg_t SET a = a + agg_t.id, b = ${3} WHERE id = ${7}`,
    ]);
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
