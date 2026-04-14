import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb, insert, rawSql, setDb } from "#lib/db/client.ts";
import { describeWithEnv, setTestEnv } from "#test-utils";

describeWithEnv("db > client", { db: true }, () => {
  test("getDb throws error when DB_URL is not set", () => {
    setDb(null);
    const restore = setTestEnv({ DB_URL: undefined });
    try {
      expect(() => getDb()).toThrow(
        "DB_URL environment variable is required",
      );
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
      name: "Alice",
      email: "a@b.com",
    });
    expect(stmt.sql).toBe(
      "INSERT INTO users (name, email)" + " VALUES (?, ?)",
    );
    expect(stmt.args).toEqual(["Alice", "a@b.com"]);
  });

  test("insert supports rawSql for expressions", () => {
    const stmt = insert("event_attendees", {
      event_id: 1,
      attendee_id: rawSql("last_insert_rowid()"),
      quantity: 2,
    });
    expect(stmt.sql).toBe(
      "INSERT INTO event_attendees" +
        " (event_id, attendee_id, quantity)" +
        " VALUES (?, last_insert_rowid(), ?)",
    );
    expect(stmt.args).toEqual([1, 2]);
  });

  test("insert handles null values as params", () => {
    const stmt = insert("payments", {
      id: "p1",
      attendee_id: null,
      created: "now",
    });
    expect(stmt.sql).toBe(
      "INSERT INTO payments" +
        " (id, attendee_id, created)" +
        " VALUES (?, ?, ?)",
    );
    expect(stmt.args).toEqual(["p1", null, "now"]);
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
});
