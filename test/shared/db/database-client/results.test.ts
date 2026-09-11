import type { Client } from "@libsql/client";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { emptyResultSet } from "#test-utils/db-helpers/result-set.ts";
import {
  hranaBatchReply,
  hranaChangedReply,
  hranaTestDatabase,
  hranaTestSqlite,
} from "#test-utils/hrana.ts";

describe("primary read results", () => {
  for (const intMode of ["number", "bigint", "string"] as const) {
    test(`preserves scalar values and JSON in ${intMode} mode`, async () => {
      using remote = hranaTestSqlite(intMode);
      const [result] = await remote.client.batch(
        [
          {
            args: [
              -42n,
              1.25,
              'quoted "text"',
              null,
              new Uint8Array([0, 128, 255]),
            ],
            sql: "SELECT ? AS whole, ? AS fraction, ? AS text, ? AS absent, ? AS bytes",
          },
        ],
        "write",
      );
      const integer = { bigint: -42n, number: -42, string: "-42" }[intMode];
      expect(result!.columns).toEqual([
        "whole",
        "fraction",
        "text",
        "absent",
        "bytes",
      ]);
      expect(result!.columnTypes).toEqual(["", "", "", "", ""]);
      expect(result!.rows).toHaveLength(1);
      expect(result!.rows[0]).toMatchObject({
        absent: null,
        fraction: 1.25,
        length: 5,
        text: 'quoted "text"',
        whole: integer,
      });
      expect(Array.from(result!.rows[0]!)).toEqual([
        integer,
        1.25,
        'quoted "text"',
        null,
        new Uint8Array([0, 128, 255]).buffer,
      ]);
      expect(result!.rows[0]!.bytes).toBeInstanceOf(ArrayBuffer);
      expect(result!.toJSON()).toEqual({
        columns: result!.columns,
        columnTypes: ["", "", "", "", ""],
        lastInsertRowid: null,
        rows: [
          [
            intMode === "number" ? -42 : "-42",
            1.25,
            'quoted "text"',
            null,
            "AID/",
          ],
        ],
        rowsAffected: 0,
      });
      expect(JSON.parse(JSON.stringify(result))).toEqual(result!.toJSON());
    });
  }

  for (const intMode of ["bigint", "string"] as const) {
    test(`preserves signed 64-bit limits in ${intMode} mode`, async () => {
      using remote = hranaTestSqlite(intMode);
      const values = [-9223372036854775808n, 9223372036854775807n];
      const [result] = await remote.client.batch(
        [["SELECT ? AS smallest, ? AS largest", values]],
        "write",
      );
      expect(Array.from(result!.rows[0]!)).toEqual(
        intMode === "bigint" ? values : values.map(String),
      );
      expect(result!.toJSON().rows).toEqual([values.map(String)]);
    });
  }

  test("preserves column declarations, empty results, and result order", async () => {
    using remote = hranaTestSqlite();
    await remote.local.batch(
      [
        "CREATE TABLE listings (id INTEGER PRIMARY KEY, name TEXT)",
        "INSERT INTO listings VALUES (2, 'Second')",
        "INSERT INTO listings VALUES (1, 'First')",
      ],
      "write",
    );
    const results = await remote.client.batch(
      [
        "SELECT id, name FROM listings ORDER BY id",
        "SELECT name FROM listings WHERE id = 0",
        "SELECT name FROM listings WHERE id = 2",
      ],
      "write",
    );
    expect(results.map((result) => result.toJSON())).toEqual([
      {
        columns: ["id", "name"],
        columnTypes: ["INTEGER", "TEXT"],
        lastInsertRowid: null,
        rows: [
          [1, "First"],
          [2, "Second"],
        ],
        rowsAffected: 0,
      },
      {
        columns: ["name"],
        columnTypes: ["TEXT"],
        lastInsertRowid: null,
        rows: [],
        rowsAffected: 0,
      },
      {
        columns: ["name"],
        columnTypes: ["TEXT"],
        lastInsertRowid: null,
        rows: [["Second"]],
        rowsAffected: 0,
      },
    ]);
    expect(remote.requests).toHaveLength(1);
  });

  test("preserves affected rows and a large insert row id from the server", async () => {
    using remote = hranaTestDatabase({
      select: () =>
        Promise.resolve({
          ...emptyResultSet(),
          lastInsertRowid: 9223372036854775807n,
          rowsAffected: 7,
        }),
    });
    const [result] = await remote.client.batch(["SELECT 1"], "write");
    expect(result!.rowsAffected).toBe(7);
    expect(result!.lastInsertRowid).toBe(9223372036854775807n);
    expect(result!.toJSON()).toEqual({
      columns: [],
      columnTypes: [],
      lastInsertRowid: "9223372036854775807",
      rows: [],
      rowsAffected: 7,
    });
  });

  test("normalises optional column metadata without losing row positions", async () => {
    using remote = hranaTestDatabase({
      reply: hranaChangedReply((body) => {
        body.results[1] = hranaBatchReply(
          [
            {
              affected_row_count: 0,
              cols: [{}, { decltype: null, name: null }],
              rows: [[{ type: "text", value: "first" }, { type: "null" }]],
            },
          ],
          [null],
        );
      }),
    });
    const [result] = await remote.client.batch(["SELECT 1, 2"], "write");
    expect(result!.columns).toEqual(["", ""]);
    expect(result!.columnTypes).toEqual(["", ""]);
    expect(Array.from(result!.rows[0]!)).toEqual(["first", null]);
    expect(result!.lastInsertRowid).toBeUndefined();
    expect(result!.toJSON().lastInsertRowid).toBeNull();
  });

  test("binds strings, objects, tuples, and named arguments through Hrana", async () => {
    using remote = hranaTestSqlite();
    const statements: Parameters<Client["batch"]>[0] = [
      "SELECT 1 AS value",
      { sql: "SELECT 2 AS value" },
      ["SELECT ? AS value", [3]],
      { args: [4], sql: "SELECT ? AS value" },
      {
        args: { ":first": 1, "@second": 2, $third: 3 },
        sql: "SELECT :first + @second + $third AS value",
      },
      ["SELECT :value AS value", { value: 7 }],
      ["SELECT ? AS value", [true]],
      ["SELECT ? AS value", [false]],
      ["SELECT ? AS value", [new Date("2026-01-01T00:00:00Z")]],
      ["SELECT ? AS value", [new Uint8Array([1, 2]).buffer]],
      { args: {}, sql: "SELECT 8 AS value" },
      ["SELECT 9 AS value", []],
    ];
    const results = await remote.client.batch(statements, "write");
    expect(results.map((result) => result.rows[0]!.value)).toEqual([
      1,
      2,
      3,
      4,
      6,
      7,
      1,
      0,
      1767225600000,
      new Uint8Array([1, 2]).buffer,
      8,
      9,
    ]);
    expect(
      remote.envelopes[0]!.requests[1]!.batch!.steps.map(
        (step) => step.stmt.want_rows,
      ),
    ).toEqual(statements.map(() => true));
    expect(remote.requests).toEqual([
      ["BEGIN IMMEDIATE", "batch", "COMMIT", "close"],
    ]);
  });
});
