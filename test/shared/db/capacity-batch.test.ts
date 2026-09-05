import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { dateToRange } from "#db/capacity.ts";
import {
  buildBatchCapacitySql,
  buildManyFitsSql,
  type CapacityBucket,
  type CartDemand,
} from "#db/capacity-batch.ts";
import { flatSql, occurrences } from "#test-utils/sql-text.ts";

/**
 * Pure unit tests for the cart read preflight's SQL builders. Behaviour
 * against a real database lives in the availability suites; these lock the
 * clause shape — one clause per listing and per group, whatever the day
 * count — and the argument order the preflight and the diagnosis probes
 * embed.
 */

const LISTING = 7;
const QTY = 2;
const DAY = "2026-05-01";
const { startAt, endAt } = dateToRange(DAY);

describe("buildBatchCapacitySql", () => {
  const bucket = (
    perDay: [string, number][],
    undated: number,
  ): CapacityBucket => ({
    everyDay: undated,
    perDay: new Map(perDay),
    undatedOnly: 0,
  });

  test("no demand at all trivially fits", () => {
    expect(buildBatchCapacitySql(new Map(), new Map())).toEqual({
      args: [],
      sql: "SELECT 1 AS fits",
    });
  });

  test("an empty bucket produces no clause", () => {
    expect(
      buildBatchCapacitySql(new Map([[LISTING, bucket([], 0)]]), new Map()),
    ).toEqual({ args: [], sql: "SELECT 1 AS fits" });
  });

  test("date-less listing demand checks the running total against the cap", () => {
    const { sql, args } = buildBatchCapacitySql(
      new Map([[LISTING, bucket([], QTY)]]),
      new Map(),
    );
    expect(args).toEqual([LISTING]);
    expect(sql).toContain(`+ ${QTY} <=`);
    expect(sql).toContain("id = ?1 AND active = 1");
    expect(sql).toContain("THEN 1 ELSE 0 END AS fits");
  });

  test("a single remaining unit of demand still gets its clause", () => {
    const { sql } = buildBatchCapacitySql(
      new Map([[LISTING, bucket([], 1)]]),
      new Map(),
    );
    expect(sql).toContain("+ 1 <=");
  });

  test("a single undated unit on either demand component gets its clause", () => {
    // One undated unit is undated demand: the bucket must not silently
    // produce no clause at exactly one, on the every-day side or on the
    // date-less side of a per-date listing.
    for (const component of [
      { everyDay: 1, perDay: new Map(), undatedOnly: 0 },
      { everyDay: 0, perDay: new Map(), undatedOnly: 1 },
    ]) {
      const { sql } = buildBatchCapacitySql(
        new Map([[LISTING, component]]),
        new Map(),
      );
      expect(sql).toContain("+ 1 <=");
    }
  });

  test("per-day listing demand is one clause carrying a VALUES row per day", () => {
    const other = dateToRange("2026-05-02");
    const { args, sql } = buildBatchCapacitySql(
      new Map([
        [
          LISTING,
          bucket(
            [
              [DAY, 1],
              ["2026-05-02", 3],
            ],
            0,
          ),
        ],
      ]),
      new Map(),
    );
    expect(args).toEqual([LISTING, startAt, endAt, other.startAt, other.endAt]);
    expect(occurrences(flatSql(sql), "dayDemand.column3")).toBe(1);
    expect(occurrences(flatSql(sql), "VALUES")).toBe(1);
    expect(occurrences(flatSql(sql), ") AND (")).toBe(0);
    expect(sql).toContain("max_attendees");
  });

  test("group demand folds the cart's date-less units into every day and keeps the running-total clause", () => {
    const { args, sql } = buildBatchCapacitySql(
      new Map(),
      new Map([[9, bucket([[DAY, 2]], 3)]]),
    );
    // The per-day clause carries the day's 2 booked units beside the 3
    // date-less units that occupy the group every day; the undated clause
    // counts the whole 5-unit bucket against the group's running total.
    expect(sql).toContain("+ 5 <=");
    expect(sql).toContain("(SELECT max_attendees FROM groups WHERE id = ?1)");
    expect(sql).toContain("= 0 OR");
    expect(args).toEqual([9, startAt, endAt]);
  });

  test("several group days share one VALUES table and one group id slot", () => {
    const other = dateToRange("2026-05-02");
    const { args, sql } = buildBatchCapacitySql(
      new Map(),
      new Map([
        [
          9,
          bucket(
            [
              [DAY, 2],
              ["2026-05-02", 1],
            ],
            0,
          ),
        ],
      ]),
    );

    expect(args).toEqual([9, startAt, endAt, other.startAt, other.endAt]);
    expect(sql.match(/group_id = \?1/gu)).toHaveLength(2);
    expect(sql.match(/VALUES/gu)).toHaveLength(1);
  });

  test("date-less-only group demand emits a single total clause", () => {
    const { args, sql } = buildBatchCapacitySql(
      new Map(),
      new Map([[9, bucket([], 3)]]),
    );
    expect(sql).toContain("+ 3 <=");
    expect(sql).not.toContain("start_at");
    expect(args).toEqual([9]);
  });
});

describe("buildManyFitsSql", () => {
  const demandFor = (listingId: number, undated: number): CartDemand => ({
    groupDemand: new Map(),
    listingDemand: new Map([
      [listingId, { everyDay: undated, perDay: new Map(), undatedOnly: 0 }],
    ]),
  });

  test("answers each cart demand in its own numbered column", () => {
    const { args, sql } = buildManyFitsSql([
      demandFor(LISTING, 2),
      demandFor(8, 3),
    ]);
    expect(sql).toContain(") AS fit0");
    expect(sql).toContain(") AS fit1");
    // One comma between the two demand columns keeps them separate selects.
    expect(sql).toContain(") AS fit0, (");
    expect(sql).toContain("+ 2 <=");
    expect(sql).toContain("+ 3 <=");
    expect(args).toEqual([LISTING, 8]);
  });

  test("a demand with no clauses trivially fits", () => {
    expect(buildManyFitsSql([demandFor(LISTING, 0)])).toEqual({
      args: [],
      sql: "SELECT (1) AS fit0",
    });
  });

  test("refuses to build a query for no demands at all", () => {
    expect(() => buildManyFitsSql([])).toThrow(
      "A fits query needs at least one cart demand",
    );
  });
});
