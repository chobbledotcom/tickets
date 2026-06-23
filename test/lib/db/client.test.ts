import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  registerTableInvalidation,
  resetCacheRegistry,
} from "#shared/cache-registry.ts";
import {
  execute,
  extractUpdateColumns,
  getDb,
  insert,
  rawSql,
  resetAggregates,
  setDb,
} from "#shared/db/client.ts";
import { describeWithEnv, setTestEnv } from "#test-utils";

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
  beforeEach(() => resetCacheRegistry());
  afterEach(() => resetCacheRegistry());

  test("UPDATE with unparseable SET fires column-gated invalidators unconditionally", async () => {
    let fired = 0;
    registerTableInvalidation(
      ["t"],
      () => {
        fired++;
      },
      { whenColumns: ["col1"] },
    );
    const executeStub = stub(getDb(), "execute", () =>
      Promise.resolve({
        columns: [],
        columnTypes: [],
        lastInsertRowid: undefined,
        rows: [],
        rowsAffected: 0,
        toJSON: () => ({}),
      }),
    );
    try {
      // Empty SET clause → extractUpdateColumns returns null → fallback fires
      await execute("UPDATE t SET WHERE true", []);
      expect(fired).toBe(1);
    } finally {
      executeStub.restore();
    }
  });

  test("REPLACE INTO invalidates the target table", async () => {
    let fired = 0;
    registerTableInvalidation(["settings"], () => {
      fired++;
    });
    await execute("REPLACE INTO settings (key, value) VALUES (?, ?)", [
      "replace_test",
      "val",
    ]);
    expect(fired).toBe(1);
  });
});

describeWithEnv("db > client", { db: true }, () => {
  test("getDb throws error when DB_URL is not set", () => {
    setDb(null);
    const restore = setTestEnv({ DB_URL: undefined });
    try {
      expect(() => getDb()).toThrow("DB_URL environment variable is required");
    } finally {
      restore();
    }
  });

  test("getDb creates client when db is null", () => {
    setDb(null);
    const restore = setTestEnv({ DB_URL: ":memory:" });
    const client = getDb();
    expect(client).toBeDefined();
    restore();
  });

  test("getDb returns existing client when db is set", () => {
    const client1 = getDb();
    const client2 = getDb();
    expect(client1).toBe(client2);
  });

  test("insert builds sql and args from record", () => {
    const stmt = insert("users", {
      email: "a@b.com",
      name: "Alice",
    });
    expect(stmt.sql).toBe("INSERT INTO users (email, name)" + " VALUES (?, ?)");
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
      "SELECT value FROM settings" + " WHERE key = 'insert_test'",
    );
    expect(row.rows[0]!.value).toBe("works");
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
});
