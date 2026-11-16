import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  among,
  equal,
  lessThan,
  literal,
  plus,
} from "#db/select/expression.ts";
import { tables } from "#db/select/tables.ts";
import { deleteFrom, insertInto, update } from "#db/write.ts";
import { placed } from "#test-utils/sql-text.ts";

describe("insertInto", () => {
  test("adds one row with its values bound", () => {
    expect(
      placed(
        insertInto(tables.holidays, {
          end_date: "b",
          name: "n",
          start_date: "a",
        }),
      ),
    ).toEqual({
      args: ["b", "n", "a"],
      sql: "INSERT INTO holidays (end_date, name, start_date) VALUES (?, ?, ?)",
    });
  });

  test("adds several rows in one statement", () => {
    expect(
      placed(
        insertInto(tables.listing_parents, [
          { child_listing_id: 1, parent_listing_id: 2 },
          { child_listing_id: 3, parent_listing_id: 2 },
        ]),
      ),
    ).toEqual({
      args: [1, 2, 3, 2],
      sql: "INSERT INTO listing_parents (child_listing_id, parent_listing_id) VALUES (?, ?), (?, ?)",
    });
  });

  test("leaves out a column whose value is undefined", () => {
    expect(
      insertInto(tables.settings, { key: "k", value: undefined as never }).sql,
    ).toBe("INSERT INTO settings (key) VALUES (?1)");
  });

  test("refuses rows that name different columns", () => {
    expect(() =>
      insertInto(tables.listing_parents, [
        { child_listing_id: 1, parent_listing_id: 2 },
        { parent_listing_id: 2 } as never,
      ]),
    ).toThrow("must name the same columns");
  });

  test("refuses an empty list of rows and a row with no column", () => {
    expect(() => insertInto(tables.settings, [] as never)).toThrow(
      "has no row",
    );
    expect(() => insertInto(tables.holidays, {} as never)).toThrow(
      "names no column",
    );
  });

  test("says how SQLite answers a broken rule", () => {
    expect(
      insertInto(tables.settings, { key: "k", value: "v" }, { or: "REPLACE" })
        .sql,
    ).toBe("INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)");
  });

  test("keeps the stored row on a conflict", () => {
    expect(
      insertInto(
        tables.settings,
        { key: "k", value: "v" },
        { onConflict: { nothing: true, on: ["key"] } },
      ).sql,
    ).toBe(
      "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO NOTHING",
    );
  });

  test("takes, sets and guards the stored row on a conflict", () => {
    expect(
      placed(
        insertInto(
          tables.login_attempts,
          { attempts: 1, ip: "x" },
          {
            onConflict: {
              on: ["ip"],
              set: (row) => ({ attempts: plus(row.attempts, 1) }),
              take: ["ip"],
              where: (row) => lessThan(row.attempts, 5),
            },
          },
        ),
      ),
    ).toEqual({
      args: [1, "x", 1, 5],
      sql: "INSERT INTO login_attempts (attempts, ip) VALUES (?, ?) ON CONFLICT(ip) DO UPDATE SET ip = excluded.ip, attempts = (login_attempts.attempts + ?) WHERE login_attempts.attempts < ?",
    });
  });

  test("refuses an upsert that changes nothing", () => {
    expect(() =>
      insertInto(
        tables.settings,
        { key: "k", value: "v" },
        { onConflict: { on: ["key"] } },
      ),
    ).toThrow("names no column to change");
  });

  test("adds the one row only where a condition holds", () => {
    expect(
      insertInto(
        tables.settings,
        { key: "k", value: "v" },
        { when: equal(literal(1), 1) },
      ).sql,
    ).toBe("INSERT INTO settings (key, value) SELECT ?1, ?2 WHERE 1 = ?3");
    expect(() =>
      insertInto(
        tables.settings,
        [
          { key: "a", value: "v" },
          { key: "b", value: "v" },
        ],
        { when: true },
      ),
    ).toThrow("adds one row");
  });

  test("reads back the named columns of each written row", () => {
    expect(
      insertInto(tables.holidays, {
        end_date: "b",
        name: "n",
        start_date: "a",
      }).returning("id", "name").sql,
    ).toBe(
      "INSERT INTO holidays (end_date, name, start_date) VALUES (?1, ?2, ?3) RETURNING id, name",
    );
  });
});

describe("update", () => {
  test("changes the matched rows", () => {
    expect(
      placed(
        update(tables.settings, { value: "v" }).where({ key: ["a", "b"] }),
      ),
    ).toEqual({
      args: ["v", "a", "b"],
      sql: "UPDATE settings SET value = ? WHERE settings.key IN (?, ?)",
    });
  });

  test("works out a new value from the current row", () => {
    expect(
      update(tables.login_attempts, (row) => ({
        attempts: plus(row.attempts, 1),
        locked_until: undefined,
      })).where((row) => among(row.ip, ["x"])).sql,
    ).toBe(
      "UPDATE login_attempts SET attempts = (login_attempts.attempts + ?1) WHERE login_attempts.ip IN (?2)",
    );
  });

  test("refuses an update with no change and a match of every row", () => {
    expect(() => update(tables.settings, {})).toThrow("names no column");
    expect(() => update(tables.settings, { value: "v" }).where({})).toThrow(
      "Say everyRow()",
    );
  });

  test("changes every row when it says so", () => {
    expect(update(tables.settings, { value: "v" }).everyRow().sql).toBe(
      "UPDATE settings SET value = ?1",
    );
  });
});

describe("deleteFrom", () => {
  test("removes the matched rows and can read them back", () => {
    expect(
      deleteFrom(tables.sessions).where({ token: "t" }).returning("token").sql,
    ).toBe("DELETE FROM sessions WHERE sessions.token = ?1 RETURNING token");
  });

  test("removes every row when it says so", () => {
    expect(deleteFrom(tables.holidays).everyRow().sql).toBe(
      "DELETE FROM holidays",
    );
  });
});
