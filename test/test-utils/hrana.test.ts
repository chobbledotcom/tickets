import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { emptyResultSet } from "#test-utils/db-helpers/result-set.ts";
import { hranaTestFetch } from "#test-utils/hrana.ts";

const rejectsBeforeSqlWork = async (requests: unknown): Promise<string[]> => {
  const selected: string[] = [];
  const remote = hranaTestFetch((sql) => {
    selected.push(sql);
    return Promise.resolve(emptyResultSet());
  });
  await expect(
    remote.fetch(
      new Request("https://pipeline.test/v2/pipeline", {
        body: JSON.stringify({ requests }),
        method: "POST",
      }),
    ),
  ).rejects.toMatchObject({ name: "ValiError" });
  return selected;
};

describe("Hrana protocol fixture", () => {
  test("refuses a resumed session instead of discarding its state", async () => {
    const remote = hranaTestFetch();
    await expect(
      remote.fetch(
        new Request("https://pipeline.test/v2/pipeline", {
          body: JSON.stringify({ baton: "resumed-session", requests: [] }),
          method: "POST",
        }),
      ),
    ).rejects.toMatchObject({ name: "ValiError" });
    expect(remote.requests).toEqual([]);
  });

  for (const type of ["and", "or", "is_autocommit", "unknown"]) {
    test(`rejects unsupported condition ${type} before SQL work`, async () => {
      const selected = await rejectsBeforeSqlWork([
        {
          batch: {
            steps: [
              { condition: { conds: [], type }, stmt: { sql: "SELECT 1" } },
            ],
          },
          type: "batch",
        },
      ]);
      expect(selected).toEqual([]);
    });
  }

  for (const [name, step] of [
    ["a negative step", -1],
    ["a fractional step", 0.5],
    ["a step beyond uint32", 4294967296],
    ["a step reference to itself", 0],
  ] as const) {
    test(`rejects ${name} in a condition before SQL work`, async () => {
      const selected = await rejectsBeforeSqlWork([
        {
          batch: {
            steps: [
              { condition: { step, type: "ok" }, stmt: { sql: "SELECT 1" } },
            ],
          },
          type: "batch",
        },
      ]);
      expect(selected).toEqual([]);
    });
  }

  test("refuses an unknown stored SQL id", async () => {
    const remote = hranaTestFetch();
    const response = await remote.fetch(
      new Request("https://pipeline.test/v2/pipeline", {
        body: JSON.stringify({
          requests: [{ stmt: { sql_id: 9 }, type: "execute" }],
        }),
        method: "POST",
      }),
    );
    expect(await response.json()).toMatchObject({
      results: [
        {
          error: {
            code: "SQLITE_ERROR",
            message: "Error: The test received an unknown SQL id",
          },
          type: "error",
        },
      ],
    });
  });

  test("runs an error-conditioned step only after the named step fails", async () => {
    const selected: string[] = [];
    const remote = hranaTestFetch((sql) => {
      selected.push(sql);
      if (sql === "SELECT broken") throw new Error("Query failed");
      return Promise.resolve(emptyResultSet());
    });
    const response = await remote.fetch(
      new Request("https://pipeline.test/v2/pipeline", {
        body: JSON.stringify({
          requests: [
            {
              batch: {
                steps: [
                  { stmt: { sql: "SELECT broken" } },
                  {
                    condition: { step: 0, type: "error" },
                    stmt: { sql: "SELECT recovery" },
                  },
                  {
                    condition: { step: 1, type: "error" },
                    stmt: { sql: "SELECT skipped" },
                  },
                ],
              },
              type: "batch",
            },
          ],
        }),
        method: "POST",
      }),
    );
    const body = await response.json();
    expect(selected).toEqual(["SELECT broken", "SELECT recovery"]);
    expect(body.results[0].response.result.step_results).toEqual([
      null,
      {
        affected_row_count: 0,
        cols: [],
        last_insert_rowid: null,
        rows: [],
      },
      null,
    ]);
  });
});
