import type { InStatement, ResultSet } from "@libsql/client";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { registerTableInvalidation } from "#shared/cache-registry.ts";
import {
  deleteByFieldStatement,
  execute,
  executeUpdate,
  extractUpdateColumns,
  getDb,
  inPlaceholders,
  insert,
  rawSql,
  resetAggregates,
  rowExists,
  setDb,
  update,
} from "#shared/db/client.ts";
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

describe("extractUpdateColumns", () => {
  test("single column assignment", () => {
    const cols = extractUpdateColumns(
      "UPDATE listing_attendees SET checked_in = ? WHERE attendee_id = ? AND listing_id = ?",
    );
    expect(cols).toBeDefined();
    expect([...cols!]).toEqual(["checked_in"]);
  });

  test("multiple column assignments", () => {
    const cols = extractUpdateColumns("UPDATE t SET a = a + 1, b = ?");
    expect(cols).toBeDefined();
    expect([...cols!].sort()).toEqual(["a", "b"]);
  });

  test("WHERE clause = signs are not mistaken for assignments", () => {
    const cols = extractUpdateColumns(
      "UPDATE users SET password_hash = ?, invite_code_hash = ?, invite_expiry = ? WHERE id = ?",
    );
    expect(cols).toBeDefined();
    expect([...cols!].sort()).toEqual([
      "invite_code_hash",
      "invite_expiry",
      "password_hash",
    ]);
  });

  test("table-qualified column name strips the qualifier", () => {
    const cols = extractUpdateColumns("UPDATE t SET t.col = ?");
    expect(cols).toBeDefined();
    expect([...cols!]).toEqual(["col"]);
  });

  test("quoted column name strips the quotes", () => {
    const cols = extractUpdateColumns('UPDATE t SET "my_col" = ?');
    expect(cols).toBeDefined();
    expect([...cols!]).toEqual(["my_col"]);
  });

  test("commas inside parentheses in an expression do not split the assignment", () => {
    const cols = extractUpdateColumns("UPDATE t SET a = coalesce(x, 0), b = ?");
    expect(cols).toBeDefined();
    expect([...cols!].sort()).toEqual(["a", "b"]);
  });

  test("depth scan starts at the very first character of the SET clause", () => {
    // Synthetic SQL whose SET clause opens with "(": the paren-depth scan must
    // see that first character, otherwise depth goes negative at ")" and the
    // top-level comma never splits — losing the second assignment ("b").
    const cols = extractUpdateColumns("UPDATE t SET (a) = 1, b = 2");
    expect(cols).toBeDefined();
    expect([...cols!].sort()).toEqual(["(a)", "b"]);
  });

  test("returns null for non-UPDATE SQL (no SET clause)", () => {
    expect(extractUpdateColumns("INSERT INTO t (a) VALUES (?)")).toBeNull();
  });

  test("returns null when SET clause has no parseable assignments", () => {
    // Empty content between SET and WHERE: covers the eqIdx < 0 guard and the
    // columns.size === 0 → null return path.
    expect(extractUpdateColumns("UPDATE t SET WHERE true")).toBeNull();
  });

  test("column names are lower-cased", () => {
    const cols = extractUpdateColumns("UPDATE t SET MyCol = ?");
    expect(cols).toBeDefined();
    expect([...cols!]).toEqual(["mycol"]);
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
      await execute("UPDATE t SET WHERE true", []);
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
      await execute("REPLACE INTO settings (key, value) VALUES (?, ?)", [
        "replace_test",
        "val",
      ]);
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
    expect(client).toBeDefined();
  });

  test("getDb returns existing client when db is set", () => {
    const client1 = getDb();
    const client2 = getDb();
    expect(client1).toBe(client2);
  });

  test("deleteByFieldStatement builds the DELETE for one table, field and value", () => {
    const stmt = deleteByFieldStatement({
      field: "user_id",
      table: "sessions",
      value: 7,
    });
    expect(stmt.sql).toBe("DELETE FROM sessions WHERE user_id = ?");
    expect(stmt.args).toEqual([7]);
  });

  test("insert builds sql and args from record", () => {
    const stmt = insert("users", {
      email: "a@b.com",
      name: "Alice",
    });
    expect(stmt.sql).toBe("INSERT INTO users (email, name) VALUES (?, ?)");
    expect(stmt.args).toEqual(["a@b.com", "Alice"]);
  });

  test("insert supports rawSql for expressions", () => {
    const stmt = insert("listing_attendees", {
      attendee_id: rawSql("last_insert_rowid()"),
      listing_id: 1,
      quantity: 2,
    });
    expect(stmt.sql).toBe(
      "INSERT INTO listing_attendees" +
        " (attendee_id, listing_id, quantity)" +
        " VALUES (last_insert_rowid(), ?, ?)",
    );
    expect(stmt.args).toEqual([1, 2]);
  });

  test("insert handles null values as params", () => {
    const stmt = insert("payments", {
      attendee_id: null,
      created: "now",
      id: "p1",
    });
    expect(stmt.sql).toBe(
      "INSERT INTO payments" +
        " (attendee_id, created, id)" +
        " VALUES (?, ?, ?)",
    );
    expect(stmt.args).toEqual([null, "now", "p1"]);
  });

  test("insert executes correctly against db", async () => {
    const stmt = insert("settings", {
      key: "insert_test",
      value: "works",
    });
    await getDb().execute(stmt);
    const row = await getDb().execute(
      "SELECT value FROM settings WHERE key = 'insert_test'",
    );
    expect(row.rows[0]!.value).toBe("works");
  });

  test("update builds sql and args, SET args before WHERE args", () => {
    const stmt = update(
      "attendees",
      { pii_blob: "encrypted" },
      { id: 4, kind: "attendee" },
    );
    expect(stmt.sql).toBe(
      "UPDATE attendees SET pii_blob = ? WHERE id = ? AND kind = ?",
    );
    expect(stmt.args).toEqual(["encrypted", 4, "attendee"]);
  });

  test("update supports rawSql expressions in SET", () => {
    const stmt = update(
      "listing_attendees",
      { attachment_downloads: rawSql("attachment_downloads + 1") },
      { attendee_id: 1, listing_id: 2 },
    );
    expect(stmt.sql).toBe(
      "UPDATE listing_attendees" +
        " SET attachment_downloads = attachment_downloads + 1" +
        " WHERE attendee_id = ? AND listing_id = ?",
    );
    expect(stmt.args).toEqual([1, 2]);
  });

  test("update joins multiple SET assignments with commas", () => {
    const stmt = update("listings", { name: "n", slug: "s" }, { id: 3 });
    expect(stmt.sql).toBe(
      "UPDATE listings SET name = ?, slug = ? WHERE id = ?",
    );
    expect(stmt.args).toEqual(["n", "s", 3]);
  });

  test("inPlaceholders builds one comma-separated placeholder per value", () => {
    expect(inPlaceholders([10, 20, 30])).toBe("?, ?, ?");
    expect(inPlaceholders([])).toBe("");
  });

  test("update passes null SET values as params", () => {
    const stmt = update(
      "listing_attendees",
      { start_agent_id: null },
      { start_agent_id: 7 },
    );
    expect(stmt.sql).toBe(
      "UPDATE listing_attendees SET start_agent_id = ?" +
        " WHERE start_agent_id = ?",
    );
    expect(stmt.args).toEqual([null, 7]);
  });

  test("executeUpdate writes the matched row", async () => {
    await execute(
      "INSERT INTO settings (key, value) VALUES ('update_test', 'before')",
    );
    const result = await executeUpdate(
      "settings",
      { value: "after" },
      { key: "update_test" },
    );
    expect(result.rowsAffected).toBe(1);
    const row = await getDb().execute(
      "SELECT value FROM settings WHERE key = 'update_test'",
    );
    expect(row.rows[0]!.value).toBe("after");
  });

  test("executeUpdate leaves non-matching rows alone", async () => {
    await execute(
      "INSERT INTO settings (key, value) VALUES ('update_scope', 'kept')",
    );
    const result = await executeUpdate(
      "settings",
      { value: "clobbered" },
      { key: "update_scope", value: "other" },
    );
    expect(result.rowsAffected).toBe(0);
    const row = await getDb().execute(
      "SELECT value FROM settings WHERE key = 'update_scope'",
    );
    expect(row.rows[0]!.value).toBe("kept");
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
    const captured: InStatement[] = [];
    const executeStub = stub(getDb(), "execute", (stmt: InStatement) => {
      captured.push(stmt);
      return Promise.resolve(emptyResultSet());
    });
    try {
      await resetAggregates("agg_t", 7, ["a", "b"], {
        a: "a = a + ?",
        b: "b = ?",
      });
    } finally {
      executeStub.restore();
    }
    // Two expressions must join into one valid SET clause, with the entity id
    // bound once per field plus once for the WHERE.
    expect(captured).toEqual([
      {
        args: [7, 7, 7],
        sql: "UPDATE agg_t SET a = a + ?, b = ? WHERE id = ?",
      },
    ]);
  });

  test("rowExists is true when the probe matches a row", async () => {
    await execute(
      "INSERT INTO settings (key, value) VALUES ('exists_test', 'x')",
    );
    expect(
      await rowExists("SELECT 1 FROM settings WHERE key = ? LIMIT 1", [
        "exists_test",
      ]),
    ).toBe(true);
  });

  test("rowExists is false when no row matches", async () => {
    expect(
      await rowExists("SELECT 1 FROM settings WHERE key = ? LIMIT 1", [
        "missing_key",
      ]),
    ).toBe(false);
  });
});
