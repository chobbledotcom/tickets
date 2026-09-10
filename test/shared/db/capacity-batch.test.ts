import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { dateToRange } from "#db/capacity.ts";
import {
  addDemandToBucket,
  buildCartCapacitySql,
  type CapacityBucket,
  type CartDemand,
  getOrCreateBucket,
} from "#db/capacity-batch.ts";
import { flatSql, occurrences } from "#test-utils/sql-text.ts";

/**
 * Pure unit tests for the cart read preflight's SQL builder. Behaviour
 * against a real database lives in the availability suites; these lock the
 * clause shape — one clause per listing and per group, whatever the day
 * count — and the argument order the preflight and the diagnosis probes
 * embed.
 */

const LISTING = 7;
const QTY = 2;
const DAY = "2026-05-01";
const { startAt, endAt } = dateToRange(DAY);

describe("buildCartCapacitySql", () => {
  /** A bucket as the demand fold produces it: every unit in `everyDay` is a
   * date-less line, so the running total and its last-undated snapshot both
   * hold the bucket's whole demand. */
  const bucket = (
    perDay: [string, number][],
    undated: number,
  ): CapacityBucket => {
    const perDayMap = new Map(perDay);
    const datedTotal = [...perDayMap.values()].reduce(
      (sum, qty) => sum + qty,
      0,
    );
    return {
      everyDay: undated,
      perDay: perDayMap,
      runningTotal: datedTotal + undated,
      throughLastUndated: datedTotal + undated,
      undatedOnly: 0,
    };
  };

  /** A cart demand carrying only listing buckets — the common shape. */
  const demandWith = (listing: Map<number, CapacityBucket>): CartDemand => ({
    groupDemand: new Map(),
    listingDemand: listing,
  });

  test("no demand at all trivially fits", () => {
    expect(buildCartCapacitySql(demandWith(new Map()))).toEqual({
      args: [],
      sql: "SELECT 1 AS fits",
    });
  });

  test("an empty bucket produces no clause", () => {
    expect(
      buildCartCapacitySql(demandWith(new Map([[LISTING, bucket([], 0)]]))),
    ).toEqual({ args: [], sql: "SELECT 1 AS fits" });
  });

  test("date-less listing demand checks the running total against the cap", () => {
    const { sql, args } = buildCartCapacitySql(
      demandWith(new Map([[LISTING, bucket([], QTY)]])),
    );
    expect(args).toEqual([LISTING]);
    expect(sql).toContain(`+ ${QTY} <=`);
    expect(sql).toContain("id = ?1 AND active = 1");
    expect(sql).toContain(") AS fits");
  });

  test("a single remaining unit of demand still gets its clause", () => {
    const { sql } = buildCartCapacitySql(
      demandWith(new Map([[LISTING, bucket([], 1)]])),
    );
    expect(sql).toContain("+ 1 <=");
  });

  test("a single undated unit on either demand component gets its clause", () => {
    // One undated unit is undated demand: the bucket must not silently
    // produce no clause at exactly one, on the every-day side or on the
    // date-less side of a per-date listing.
    for (const component of [
      {
        everyDay: 1,
        perDay: new Map(),
        runningTotal: 1,
        throughLastUndated: 1,
        undatedOnly: 0,
      },
      {
        everyDay: 0,
        perDay: new Map(),
        runningTotal: 1,
        throughLastUndated: 1,
        undatedOnly: 1,
      },
    ]) {
      const { sql } = buildCartCapacitySql(
        demandWith(new Map([[LISTING, component]])),
      );
      expect(sql).toContain("+ 1 <=");
    }
  });

  test("the undated clause reads the running total as of the last date-less line, not the whole bucket", () => {
    // A two-day dated unit bumps the running total once, and a date-less
    // unit after it reads that total — not the dated unit once per occupied
    // day. The whole bucket would say 5; the undated statements see 3.
    const { sql } = buildCartCapacitySql(
      demandWith(
        new Map([
          [
            LISTING,
            {
              everyDay: 0,
              perDay: new Map([
                [DAY, 2],
                ["2026-05-02", 2],
              ]),
              runningTotal: 3,
              throughLastUndated: 3,
              undatedOnly: 1,
            },
          ],
        ]),
      ),
    );
    expect(sql).toContain("+ 3 <=");
    expect(sql).not.toContain("+ 5 <=");
  });

  test("per-day listing demand is one clause carrying a VALUES row per day", () => {
    const other = dateToRange("2026-05-02");
    const { args, sql } = buildCartCapacitySql(
      demandWith(
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
      ),
    );
    expect(args).toEqual([LISTING, startAt, endAt, other.startAt, other.endAt]);
    expect(occurrences(flatSql(sql), "dayDemand.column3")).toBe(1);
    expect(occurrences(flatSql(sql), "VALUES")).toBe(1);
    expect(occurrences(flatSql(sql), ") AND (")).toBe(0);
    expect(sql).toContain("max_attendees");
  });

  test("group demand folds the cart's date-less units into every day and keeps the running-total clause", () => {
    const { args, sql } = buildCartCapacitySql({
      groupDemand: new Map([[9, bucket([[DAY, 2]], 3)]]),
      listingDemand: new Map(),
    });
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
    const { args, sql } = buildCartCapacitySql({
      groupDemand: new Map([
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
      listingDemand: new Map(),
    });

    expect(args).toEqual([9, startAt, endAt, other.startAt, other.endAt]);
    expect(sql.match(/group_id = \?1/gu)).toHaveLength(2);
    expect(sql.match(/VALUES/gu)).toHaveLength(1);
  });

  test("date-less-only group demand emits a single total clause", () => {
    const { args, sql } = buildCartCapacitySql({
      groupDemand: new Map([[9, bucket([], 3)]]),
      listingDemand: new Map(),
    });
    expect(sql).toContain("+ 3 <=");
    expect(sql).not.toContain("start_at");
    expect(args).toEqual([9]);
  });

  test("answers one cart demand's fit in one column", () => {
    const { args, sql } = buildCartCapacitySql(
      demandWith(
        new Map([
          [
            LISTING,
            {
              everyDay: 0,
              perDay: new Map(),
              runningTotal: 2,
              throughLastUndated: 2,
              undatedOnly: 2,
            },
          ],
        ]),
      ),
    );
    expect(sql).toContain("AS fits");
    expect(sql).toContain("+ 2 <=");
    expect(args).toEqual([LISTING]);
  });
});

/** One cart line as the demand fold feeds it. */
const item = (quantity: number, durationDays?: number) => ({
  ...(durationDays === undefined ? {} : { durationDays }),
  listingId: LISTING,
  quantity,
});

describe("addDemandToBucket", () => {
  const freshBucket = (): CapacityBucket =>
    getOrCreateBucket(new Map<number, CapacityBucket>(), 5);

  test("the bucket's last date-less line replaces, not adds to, the snapshot it pins", () => {
    // Two date-less lines on a total-counted listing: the snapshot the write's
    // last undated statement reads is the running total AT that line (3),
    // never an accumulator of earlier snapshots (0 + 1 + 3).
    const bucket = freshBucket();
    addDemandToBucket(bucket, { listing_type: "standard" }, item(1), undefined);
    addDemandToBucket(bucket, { listing_type: "standard" }, item(2), undefined);
    expect(bucket).toEqual({
      everyDay: 3,
      perDay: new Map(),
      runningTotal: 3,
      throughLastUndated: 3,
      undatedOnly: 0,
    });
  });

  test("a date-less line on a per-date listing pins the same snapshot on its own side", () => {
    const bucket = freshBucket();
    addDemandToBucket(bucket, { listing_type: "daily" }, item(2), null);
    expect(bucket).toEqual({
      everyDay: 0,
      perDay: new Map(),
      runningTotal: 2,
      throughLastUndated: 2,
      undatedOnly: 2,
    });
  });

  test("a dated line booked after the last date-less line never raises the pinned snapshot", () => {
    const bucket = freshBucket();
    addDemandToBucket(bucket, { listing_type: "daily" }, item(1), null);
    addDemandToBucket(bucket, { listing_type: "daily" }, item(2), DAY);
    expect(bucket.runningTotal).toBe(3);
    expect(bucket.throughLastUndated).toBe(1);
    expect([...bucket.perDay]).toEqual([[DAY, 2]]);
  });

  test("a zero-quantity line demands nothing", () => {
    // getOrCreateBucket's fields stay untouched by the zero line — the
    // initializer's zeros are visible to the demand fold's caller.
    const bucket = freshBucket();
    addDemandToBucket(bucket, { listing_type: "standard" }, item(0), undefined);
    expect(bucket).toEqual({
      everyDay: 0,
      perDay: new Map(),
      runningTotal: 0,
      throughLastUndated: 0,
      undatedOnly: 0,
    });
  });

  test("a multi-day line occupies each of its days once", () => {
    const bucket = freshBucket();
    addDemandToBucket(bucket, { listing_type: "daily" }, item(1, 2), DAY);
    expect([...bucket.perDay]).toEqual([
      [DAY, 1],
      ["2026-05-02", 1],
    ]);
  });
});
