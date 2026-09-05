import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { buildCapacityCondition, dateToRange } from "#db/capacity.ts";
import {
  buildBatchCapacitySql,
  buildManyFitsSql,
  type CapacityBucket,
  type CartDemand,
} from "#db/capacity-batch.ts";
import { numberedStatement } from "#db/numbered-statement.ts";
import { capacityRuleTypeSql } from "#shared/capacity-rules.ts";

/**
 * Pure unit tests for the SQL capacity builders. Behaviour against a real
 * database lives in the availability/servicing suites; these lock the exact
 * statements and argument order the atomic write embeds — including that
 * every listing-type predicate is interpolated from CAPACITY_RULES rather
 * than hardcoded, so the SQL guard and the JS preflight share one
 * declaration.
 */

const LISTING = 7;
const QTY = 2;
const EXCLUDE = 99;
const DAY = "2026-05-01";
const { startAt, endAt } = dateToRange(DAY);

/** How many times `needle` appears in `haystack`. */
const occurrences = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

/** Collapse whitespace runs so layout can change without breaking snapshots. */
const flat = (sql: string): string => sql.replace(/\s+/g, " ").trim();

/** One day's distinct range values. */
const dayRangeArgs = (day: string): unknown[] => {
  const range = dateToRange(day);
  return [range.endAt, range.startAt];
};

const capacityStatement = (
  ...args: Parameters<typeof buildCapacityCondition>
) => numberedStatement(buildCapacityCondition(...args));

describe("dateToRange", () => {
  test("returns exact half-open UTC timestamps", () => {
    expect(dateToRange(DAY).startAt).toBe("2026-05-01T00:00:00Z");
    expect(dateToRange(DAY).endAt).toBe("2026-05-02T00:00:00.000Z");
    expect(dateToRange(DAY, 3).endAt).toBe("2026-05-04T00:00:00.000Z");
  });
});

describe("buildCapacityCondition", () => {
  test("date-less: exactly the running-total listing cap plus the group pool guard", () => {
    const cond = capacityStatement(LISTING, QTY, null);
    expect(cond.args).toEqual([LISTING, QTY]);
    expect(flat(cond.sql)).toBe(
      "( (SELECT booked_quantity FROM listings WHERE id = ?1) ) + ?2 <= (SELECT max_attendees FROM listings WHERE id = ?1 AND active = 1) AND NOT EXISTS ( SELECT 1 FROM group_listings AS groupListing JOIN groups AS groupRow ON groupRow.id = groupListing.group_id WHERE groupListing.listing_id = ?1 AND groupRow.max_attendees > 0 AND ((COALESCE(( SELECT SUM(memberListing.booked_quantity) FROM listings AS memberListing JOIN group_listings AS groupListing ON groupListing.listing_id = memberListing.id WHERE groupListing.group_id = groupRow.id ), 0) )) + ?2 > groupRow.max_attendees )",
    );
  });

  test("date-less with exclusion: the group count carries a real exclusion subquery", () => {
    const cond = capacityStatement(LISTING, QTY, null, EXCLUDE);
    expect(occurrences(cond.sql, "- COALESCE((")).toBe(2);
    expect(flat(cond.sql)).toContain(
      "FROM listing_attendees AS attendee JOIN group_listings AS groupListing ON groupListing.listing_id = attendee.listing_id WHERE groupListing.group_id = groupRow.id AND attendee.attendee_id = ?3",
    );
    expect(cond.sql).not.toContain("undefined");
  });

  test("date-less with exclusion: both counts subtract the attendee's rows", () => {
    const cond = capacityStatement(LISTING, QTY, null, EXCLUDE);
    expect(cond.args).toEqual([LISTING, QTY, EXCLUDE]);
  });

  test("dated: every listing-type predicate comes from the rule table", () => {
    const cond = capacityStatement(LISTING, QTY, DAY);
    expect(cond.sql).toContain(
      capacityRuleTypeSql("perDateCap", "listing.listing_type"),
    );
    expect(cond.sql).toContain(
      capacityRuleTypeSql("dateLessCap", "memberListing.listing_type"),
    );
    expect(cond.sql).toContain(
      capacityRuleTypeSql("perDateCap", "memberListing.listing_type"),
    );
    // No hand-written type comparison survives anywhere in the guard.
    expect(cond.sql).not.toContain("!= 'daily'");
    expect(cond.sql).not.toContain("= 'daily'");
    expect(cond.args).toEqual([LISTING, QTY, ...dayRangeArgs(DAY)]);
  });

  test("dated: exactly the per-date listing cap plus the split group pool guard", () => {
    const cond = capacityStatement(LISTING, QTY, DAY);
    expect(flat(cond.sql)).toBe(
      "(( (SELECT CASE WHEN listing.listing_type IN ('daily') THEN ( SELECT COALESCE(SUM(attendee.quantity), 0) FROM listing_attendees AS attendee WHERE attendee.listing_id = ?1 AND attendee.start_at < ?3 AND attendee.end_at > ?4 ) ELSE listing.booked_quantity END FROM listings AS listing WHERE listing.id = ?1) ) + ?2 <= (SELECT max_attendees FROM listings WHERE id = ?1 AND active = 1) AND NOT EXISTS ( SELECT 1 FROM group_listings AS groupListing JOIN groups AS groupRow ON groupRow.id = groupListing.group_id WHERE groupListing.listing_id = ?1 AND groupRow.max_attendees > 0 AND ((COALESCE(( SELECT SUM(memberListing.booked_quantity) FROM listings AS memberListing JOIN group_listings AS groupListing ON groupListing.listing_id = memberListing.id WHERE groupListing.group_id = groupRow.id AND memberListing.listing_type IN ('standard') ), 0) + COALESCE(( SELECT SUM(attendee.quantity) FROM listing_attendees AS attendee JOIN group_listings AS groupListing ON groupListing.listing_id = attendee.listing_id JOIN listings AS memberListing ON memberListing.id = attendee.listing_id WHERE groupListing.group_id = groupRow.id AND memberListing.listing_type IN ('daily') AND attendee.start_at < ?3 AND attendee.end_at > ?4 ), 0))) + ?2 > groupRow.max_attendees ))",
    );
  });

  test("dated with exclusion: excludes the attendee in listing and group counts", () => {
    const cond = capacityStatement(LISTING, QTY, DAY, EXCLUDE);
    // One exclusion in the listing count, one in the group's per-date count —
    // and the group's date-less members are excluded via their own subquery.
    expect(occurrences(cond.sql, "attendee.attendee_id != ?")).toBe(2);
    expect(occurrences(cond.sql, "attendee.attendee_id = ?")).toBe(1);
    expect(
      occurrences(
        cond.sql,
        capacityRuleTypeSql("dateLessCap", "memberListing.listing_type"),
      ),
    ).toBe(2);
    expect(cond.sql).not.toContain("undefined");
    expect(cond.args).toEqual([LISTING, QTY, EXCLUDE, endAt, startAt]);
  });

  test("multi-day: one clause per day, each with its own day's range", () => {
    const cond = capacityStatement(LISTING, QTY, DAY, undefined, 3);
    // Three per-day clauses, so two AND joints between them.
    expect(occurrences(flat(cond.sql), ") AND (")).toBe(2);
    expect(cond.args).toEqual([
      LISTING,
      QTY,
      ...dayRangeArgs("2026-05-01"),
      ...dayRangeArgs("2026-05-02"),
      ...dayRangeArgs("2026-05-03"),
    ]);
  });

  test("a non-positive duration is normalized to one day", () => {
    expect(capacityStatement(LISTING, QTY, DAY, undefined, 0)).toEqual(
      capacityStatement(LISTING, QTY, DAY, undefined, 1),
    );
  });
});

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
    expect(occurrences(flat(sql), "dayDemand.column3")).toBe(1);
    expect(occurrences(flat(sql), "VALUES")).toBe(1);
    expect(occurrences(flat(sql), ") AND (")).toBe(0);
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
