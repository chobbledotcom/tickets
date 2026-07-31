import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import { executeBatch, getDb } from "#shared/db/client.ts";
import {
  requirePreviousWrite,
  requireReturnedRows,
  writeRowsAtCurrentTime,
} from "#shared/db/write-helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describe("db > write helpers", () => {
  test("uses the current time unless the caller supplies one", async () => {
    using _time = new FakeTime(1_800_000_000_000);
    const write = writeRowsAtCurrentTime((rows: readonly string[], at) =>
      Promise.resolve({ at, count: rows.length }),
    );

    expect(await write(["first"])).toEqual({
      at: 1_800_000_000_000,
      count: 1,
    });
    expect(await write(["first", "second"], 25)).toEqual({ at: 25, count: 2 });
  });
});

describeWithEnv("db > write guards", { db: true }, () => {
  test("requires the exact number of returned rows", async () => {
    const result = await getDb().execute("SELECT 7 AS id");

    expect(
      requireReturnedRows<{ id: number }>(1, "Expected one row")(result),
    ).toEqual([{ id: 7 }]);
    expect(() => requireReturnedRows(2, "Expected two rows")(result)).toThrow(
      "Expected two rows",
    );
    expect(() =>
      requireReturnedRows(1, "Expected a result")(undefined),
    ).toThrow("Expected a result");
  });

  test("rolls back a batch when its previous write changed no rows", async () => {
    await expect(
      executeBatch([
        {
          args: [],
          sql: "UPDATE payment_sessions SET revision = revision WHERE 0 = 1",
        },
        requirePreviousWrite(),
      ]),
    ).rejects.toThrow("NOT NULL constraint failed");
  });
});
