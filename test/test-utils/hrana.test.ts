import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { emptyResultSet } from "#test-utils/db-helpers/result-set.ts";
import { hranaTestFetch } from "#test-utils/hrana.ts";

describe("Hrana protocol fixture", () => {
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
