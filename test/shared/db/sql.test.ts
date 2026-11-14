import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type SqlSlot,
  sql,
  sqlCommas,
  sqlFromDump,
  sqlInsertRowsOrNull,
  sqlJoin,
  sqlList,
  sqlLiteral,
  sqlName,
  sqlNames,
  sqlRows,
} from "#db/sql.ts";

/** The text and the arguments, without the type mark. */
const rendered = ({ args, sql: text }: { args: unknown[]; sql: string }) => ({
  args,
  sql: text,
});

describe("sql", () => {
  test("keeps a template with no slot as its own text", () => {
    expect(rendered(sql`SELECT id FROM listings`)).toEqual({
      args: [],
      sql: "SELECT id FROM listings",
    });
  });

  test("binds each value where it is written", () => {
    expect(
      rendered(sql`SELECT id FROM listings WHERE id = ${7} AND slug = ${"a"}`),
    ).toEqual({
      args: [7, "a"],
      sql: "SELECT id FROM listings WHERE id = ?1 AND slug = ?2",
    });
  });

  test("gives a repeated value one slot", () => {
    expect(
      rendered(sql`SELECT ${3} AS a, ${"2026-05-01"} AS b, ${3} AS c`),
    ).toEqual({
      args: [3, "2026-05-01"],
      sql: "SELECT ?1 AS a, ?2 AS b, ?1 AS c",
    });
  });

  test("keeps equal-looking values of different types apart", () => {
    expect(rendered(sql`SELECT ${1}, ${"1"}, ${true}, ${1n}`)).toEqual({
      args: [1, "1", true, 1n],
      sql: "SELECT ?1, ?2, ?3, ?4",
    });
  });

  test("binds null, bytes, a buffer and a date", () => {
    const bytes = new Uint8Array([1, 2]);
    const buffer = new ArrayBuffer(2);
    const date = new Date(0);
    expect(rendered(sql`SELECT ${null}, ${bytes}, ${buffer}, ${date}`)).toEqual(
      {
        args: [null, bytes, buffer, date],
        sql: "SELECT ?1, ?2, ?3, ?4",
      },
    );
  });

  test("never puts a value that looks like SQL into the text", () => {
    const typed = "1; DROP TABLE listings";
    expect(rendered(sql`DELETE FROM listings WHERE id = ${typed}`)).toEqual({
      args: [typed],
      sql: "DELETE FROM listings WHERE id = ?1",
    });
  });

  test("splices a statement in with its own values", () => {
    const paid = sql`status = ${"paid"}`;
    expect(
      rendered(sql`SELECT id FROM orders WHERE id > ${5} AND ${paid}`),
    ).toEqual({
      args: [5, "paid"],
      sql: "SELECT id FROM orders WHERE id > ?1 AND status = ?2",
    });
  });

  test("numbers a nested statement again as part of the whole", () => {
    const inner = sql`a = ${"x"} OR b = ${"y"}`;
    const middle = sql`(${inner}) AND c = ${"x"}`;
    expect(rendered(sql`SELECT ${"y"} WHERE ${middle}`)).toEqual({
      args: ["y", "x"],
      sql: "SELECT ?1 WHERE (a = ?2 OR b = ?1) AND c = ?2",
    });
  });

  test("renders one statement the same way inside two statements", () => {
    const shared = sql`id = ${9}`;
    expect(rendered(sql`SELECT 1 WHERE ${shared}`)).toEqual({
      args: [9],
      sql: "SELECT 1 WHERE id = ?1",
    });
    expect(rendered(sql`SELECT ${"first"} WHERE ${shared}`)).toEqual({
      args: ["first", 9],
      sql: "SELECT ?1 WHERE id = ?2",
    });
    expect(rendered(shared)).toEqual({ args: [9], sql: "id = ?1" });
  });

  test("uses one statement twice in one statement", () => {
    const shared = sql`id = ${9}`;
    expect(rendered(sql`${shared} OR ${shared}`)).toEqual({
      args: [9],
      sql: "id = ?1 OR id = ?1",
    });
  });

  test("refuses a slot inside a quoted SQL literal", () => {
    expect(() => sql`SELECT 'id_${7}'`).toThrow(
      "A slot sits inside a quoted SQL literal: SELECT 'id_{slot}'",
    );
    expect(() => sql`SELECT ${1}, 'a', 'b${sqlLiteral("c")}'`).toThrow(
      "A slot sits inside a quoted SQL literal",
    );
  });

  test("takes a slot after a closed literal and after a doubled quote", () => {
    expect(
      rendered(sql`SELECT 'a', 'it''s', ${1} WHERE note = '' AND id = ${2}`),
    ).toEqual({
      args: [1, 2],
      sql: "SELECT 'a', 'it''s', ?1 WHERE note = '' AND id = ?2",
    });
  });

  test("reads an apostrophe in a SQL comment as a comment", () => {
    expect(
      sql`SELECT 1 -- the row's id
 WHERE id = ${1} /* it's */ AND n = ${2}`.args,
    ).toEqual([1, 2]);
  });

  test("reads comment marks inside a literal as text", () => {
    expect(() => sql`SELECT '--', '/*${1}'`).toThrow(
      "A slot sits inside a quoted SQL literal",
    );
    expect(sql`SELECT '--', '/*', ${1}`.args).toEqual([1]);
  });

  test("a comment ends where SQL says it ends", () => {
    expect(
      () => sql`SELECT 1 -- note
, 'a${1}'`,
    ).toThrow("A slot sits inside a quoted SQL literal");
    expect(() => sql`SELECT 1 /* a * b / c */, 'a${1}'`).toThrow(
      "A slot sits inside a quoted SQL literal",
    );
    expect(sql`SELECT 1 /* it's * / still */ + ${1}`.args).toEqual([1]);
  });

  test("reads a mark at the start of the text", () => {
    expect(() => sql`'${1}'`).toThrow(
      "A slot sits inside a quoted SQL literal",
    );
    expect(
      sql`${1}--'
${2}`.args,
    ).toEqual([1, 2]);
  });

  test("a character that ends one mark does not start the next mark", () => {
    // The comment stays open after `/*/`, so the quote is comment text.
    expect(sql`SELECT 1 /*/ it's */ + ${1}`.args).toEqual([1]);
    // The first `*/` ends the comment, so the quote starts a literal.
    expect(() => sql`SELECT 1 /* a */*/ 'b${1}'`).toThrow(
      "A slot sits inside a quoted SQL literal",
    );
  });

  test("leaves a quote after the last slot alone", () => {
    expect(sql`SELECT ${1} || 'tail`.sql).toBe("SELECT ?1 || 'tail");
  });

  test("refuses to become plain text", () => {
    const statement = sql`id = ${9}`;
    expect(() => `SELECT 1 WHERE ${statement}`).toThrow(
      "A statement is not text. Put it into a sql template.",
    );
  });

  for (const [name, slot, named] of [
    ["an array", [1, 2], "an array"],
    ["a plain object", { args: [], sql: "DROP TABLE x" }, "object"],
    ["an absent value", undefined, "undefined"],
  ] as const) {
    test(`refuses ${name} in a slot`, () => {
      expect(() => sql`SELECT ${slot as unknown as SqlSlot}`).toThrow(
        `A value in SQL must be a statement or a value libsql can bind. Got ${named}.`,
      );
    });
  }
});

describe("sqlJoin", () => {
  test("joins statements with the separator between each pair", () => {
    expect(
      rendered(
        sqlJoin([sql`a = ${1}`, sql`b = ${2}`, sql`c = ${1}`], sql` AND `),
      ),
    ).toEqual({ args: [1, 2], sql: "a = ?1 AND b = ?2 AND c = ?1" });
  });

  test("keeps a separator's own value", () => {
    expect(rendered(sqlJoin([sql`a`, sql`b`], sql` || ${"-"} || `))).toEqual({
      args: ["-"],
      sql: "a || ?1 || b",
    });
  });

  test("gives empty text for no statements", () => {
    expect(rendered(sqlJoin([], sql` AND `))).toEqual({ args: [], sql: "" });
  });
});

describe("sqlCommas", () => {
  test("joins statements with commas", () => {
    expect(rendered(sqlCommas([sql`a = ${1}`, sql`b = ${2}`]))).toEqual({
      args: [1, 2],
      sql: "a = ?1, b = ?2",
    });
  });
});

describe("sqlList", () => {
  test("binds every value of a list", () => {
    expect(
      rendered(sql`SELECT id FROM t WHERE id IN (${sqlList([4, 8, 4])})`),
    ).toEqual({
      args: [4, 8],
      sql: "SELECT id FROM t WHERE id IN (?1, ?2, ?1)",
    });
  });

  test("binds a list too long for one function call", () => {
    const values = Array.from({ length: 200_000 }, (_value, index) => index);
    const inner = sqlList(values);
    expect(sql`SELECT ${inner}`.args).toHaveLength(200_000);
    expect(sqlJoin([inner, inner], sql` | `).args).toHaveLength(200_000);
  });

  test("gives empty text for an empty list", () => {
    expect(rendered(sql`id IN (${sqlList([])})`)).toEqual({
      args: [],
      sql: "id IN ()",
    });
  });
});

describe("sqlRows", () => {
  test("puts each row in brackets and binds each value", () => {
    expect(
      rendered(
        sql`VALUES ${sqlRows([
          [1, "a"],
          [2, "b"],
        ])}`,
      ),
    ).toEqual({ args: [1, "a", 2, "b"], sql: "VALUES (?1, ?2), (?3, ?4)" });
  });

  test("keeps a statement in a row as it is written", () => {
    expect(rendered(sqlRows([[7, sql`unixepoch()`]]))).toEqual({
      args: [7],
      sql: "(?1, unixepoch())",
    });
  });

  test("gives empty text for no rows", () => {
    expect(rendered(sqlRows([]))).toEqual({ args: [], sql: "" });
  });
});

describe("sqlInsertRowsOrNull", () => {
  test("writes every row in one INSERT", () => {
    const statement = sqlInsertRowsOrNull(
      "group_listings",
      ["group_id", "listing_id"],
      [
        [1, 2],
        [3, sql`last_insert_rowid()`],
      ],
    );
    expect(statement).toEqual(
      sql`INSERT INTO group_listings (group_id, listing_id) VALUES (${1}, ${2}), (${3}, last_insert_rowid())`,
    );
  });

  test("gives null for no rows", () => {
    expect(sqlInsertRowsOrNull("group_listings", ["group_id"], [])).toBeNull();
  });

  test("refuses a column that is not a name", () => {
    expect(() => sqlInsertRowsOrNull("listings", ["id) --"], [[1]])).toThrow(
      'Not a valid SQL name: "id) --"',
    );
  });
});

describe("sqlName", () => {
  for (const name of ["listings", "listing.id", "_tmp_2", "Table1.Column_2"]) {
    test(`accepts the name ${name}`, () => {
      expect(rendered(sqlName(name))).toEqual({ args: [], sql: name });
    });
  }

  for (const name of [
    "",
    "listings; DROP TABLE users",
    "a.b.c",
    "1table",
    "listing id",
    "listing.",
    ".id",
    'listing"',
    "listing--",
    "a\nb",
    "listing.1id",
  ]) {
    test(`refuses ${JSON.stringify(name)}`, () => {
      expect(() => sqlName(name)).toThrow(
        `Not a valid SQL name: ${JSON.stringify(name)}`,
      );
    });
  }
});

describe("sqlNames", () => {
  test("joins names with commas", () => {
    expect(rendered(sqlNames(["id", "listing.slug"]))).toEqual({
      args: [],
      sql: "id, listing.slug",
    });
  });

  test("refuses a list that holds a bad name", () => {
    expect(() => sqlNames(["id", "slug, secret"])).toThrow(
      'Not a valid SQL name: "slug, secret"',
    );
  });
});

describe("sqlLiteral", () => {
  test("quotes text", () => {
    expect(rendered(sqlLiteral("paid"))).toEqual({ args: [], sql: "'paid'" });
  });

  test("doubles a quote inside text", () => {
    expect(rendered(sqlLiteral("it's '' done"))).toEqual({
      args: [],
      sql: "'it''s '''' done'",
    });
  });

  for (const [value, text] of [
    [0, "0"],
    [-12, "-12"],
    [1.5, "1.5"],
  ] as const) {
    test(`writes the number ${value}`, () => {
      expect(rendered(sqlLiteral(value))).toEqual({ args: [], sql: text });
    });
  }

  for (const value of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ]) {
    test(`refuses the number ${value}`, () => {
      expect(() => sqlLiteral(value)).toThrow(
        `Not a valid SQL number: ${value}`,
      );
    });
  }

  test("stays text when it sits inside a statement", () => {
    expect(
      rendered(sql`CREATE INDEX i ON t (a) WHERE kind = ${sqlLiteral("sale")}`),
    ).toEqual({ args: [], sql: "CREATE INDEX i ON t (a) WHERE kind = 'sale'" });
  });
});

describe("sqlFromDump", () => {
  test("keeps a dump statement as its own text, with no argument", () => {
    const text = "INSERT INTO settings (key, value) VALUES ('a?1', 'it''s')";
    expect(rendered(sqlFromDump(text))).toEqual({ args: [], sql: text });
  });
});
