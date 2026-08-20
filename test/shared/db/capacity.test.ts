import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  buildBatchCapacitySql,
  buildCapacityCondition,
  buildListingCountSql,
  type CapacityBucket,
  dateToRange,
} from "#db/capacity.ts";
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

/** One day's expected argument run for a dated, no-exclusion condition. */
const dayConditionArgs = (day: string): unknown[] => {
  const range = dateToRange(day);
  return [
    LISTING,
    range.endAt,
    range.startAt,
    LISTING,
    QTY,
    LISTING,
    LISTING,
    range.endAt,
    range.startAt,
    QTY,
  ];
};

describe("dateToRange", () => {
  test("returns exact half-open UTC timestamps", () => {
    expect(dateToRange(DAY).startAt).toBe("2026-05-01T00:00:00Z");
    expect(dateToRange(DAY).endAt).toBe("2026-05-02T00:00:00.000Z");
    expect(dateToRange(DAY, 3).endAt).toBe("2026-05-04T00:00:00.000Z");
  });
});

describe("buildListingCountSql", () => {
  test("date-less: reads the running total", () => {
    expect(buildListingCountSql(LISTING, null)).toEqual({
      args: [LISTING],
      sql: "(SELECT booked_quantity FROM listings WHERE id = ?)",
    });
  });

  test("date-less with exclusion: subtracts the attendee's own rows", () => {
    const count = buildListingCountSql(LISTING, null, EXCLUDE);
    expect(count.args).toEqual([LISTING, LISTING, EXCLUDE]);
    expect(count.sql).toContain("- COALESCE((");
    expect(count.sql).toContain("attendee.attendee_id = ?");
  });

  test("dated: dispatches per-date counting via the rule table's predicate", () => {
    const count = buildListingCountSql(LISTING, { endAt, startAt });
    expect(count.args).toEqual([LISTING, endAt, startAt, LISTING]);
    expect(count.sql).toContain(
      `WHEN ${capacityRuleTypeSql("perDateCap", "listing.listing_type")} THEN`,
    );
    // The exact statement, so no fragment can silently vanish or gain filler.
    expect(flat(count.sql)).toBe(
      "(SELECT CASE WHEN listing.listing_type IN ('daily') THEN ( SELECT COALESCE(SUM(attendee.quantity), 0) FROM listing_attendees AS attendee WHERE attendee.listing_id = ? AND attendee.start_at < ? AND attendee.end_at > ? ) ELSE listing.booked_quantity END FROM listings AS listing WHERE listing.id = ?)",
    );
  });

  test("dated with exclusion: the exclusion argument sits between id and range", () => {
    const count = buildListingCountSql(LISTING, { endAt, startAt }, EXCLUDE);
    expect(count.args).toEqual([LISTING, EXCLUDE, endAt, startAt, LISTING]);
    expect(count.sql).toContain("attendee.attendee_id != ?");
  });
});

describe("buildCapacityCondition", () => {
  test("date-less: exactly the running-total listing cap plus the group pool guard", () => {
    const cond = buildCapacityCondition(LISTING, QTY, null);
    expect(cond.args).toEqual([LISTING, QTY, LISTING, LISTING, QTY]);
    expect(flat(cond.sql)).toBe(
      "( (SELECT booked_quantity FROM listings WHERE id = ?) ) + ? <= (SELECT max_attendees FROM listings WHERE id = ? AND active = 1) AND NOT EXISTS ( SELECT 1 FROM group_listings AS groupListing JOIN groups AS groupRow ON groupRow.id = groupListing.group_id WHERE groupListing.listing_id = ? AND groupRow.max_attendees > 0 AND ((COALESCE(( SELECT SUM(memberListing.booked_quantity) FROM listings AS memberListing JOIN group_listings AS groupListing ON groupListing.listing_id = memberListing.id WHERE groupListing.group_id = groupRow.id ), 0) )) + ? > groupRow.max_attendees )",
    );
  });

  test("date-less with exclusion: the group count carries a real exclusion subquery", () => {
    const cond = buildCapacityCondition(LISTING, QTY, null, EXCLUDE);
    expect(occurrences(cond.sql, "- COALESCE((")).toBe(2);
    expect(cond.sql).not.toContain("undefined");
  });

  test("date-less with exclusion: both counts subtract the attendee's rows", () => {
    const cond = buildCapacityCondition(LISTING, QTY, null, EXCLUDE);
    expect(cond.args).toEqual([
      LISTING,
      LISTING,
      EXCLUDE,
      QTY,
      LISTING,
      LISTING,
      EXCLUDE,
      QTY,
    ]);
  });

  test("dated: every listing-type predicate comes from the rule table", () => {
    const cond = buildCapacityCondition(LISTING, QTY, DAY);
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
    expect(cond.args).toEqual(dayConditionArgs(DAY));
  });

  test("dated: exactly the per-date listing cap plus the split group pool guard", () => {
    const cond = buildCapacityCondition(LISTING, QTY, DAY);
    expect(flat(cond.sql)).toBe(
      "(( (SELECT CASE WHEN listing.listing_type IN ('daily') THEN ( SELECT COALESCE(SUM(attendee.quantity), 0) FROM listing_attendees AS attendee WHERE attendee.listing_id = ? AND attendee.start_at < ? AND attendee.end_at > ? ) ELSE listing.booked_quantity END FROM listings AS listing WHERE listing.id = ?) ) + ? <= (SELECT max_attendees FROM listings WHERE id = ? AND active = 1) AND NOT EXISTS ( SELECT 1 FROM group_listings AS groupListing JOIN groups AS groupRow ON groupRow.id = groupListing.group_id WHERE groupListing.listing_id = ? AND groupRow.max_attendees > 0 AND ((COALESCE(( SELECT SUM(memberListing.booked_quantity) FROM listings AS memberListing JOIN group_listings AS groupListing ON groupListing.listing_id = memberListing.id WHERE groupListing.group_id = groupRow.id AND memberListing.listing_type IN ('standard') ), 0) + COALESCE(( SELECT SUM(attendee.quantity) FROM listing_attendees AS attendee JOIN group_listings AS groupListing ON groupListing.listing_id = attendee.listing_id JOIN listings AS memberListing ON memberListing.id = attendee.listing_id WHERE groupListing.group_id = groupRow.id AND memberListing.listing_type IN ('daily') AND attendee.start_at < ? AND attendee.end_at > ? ), 0))) + ? > groupRow.max_attendees ))",
    );
  });

  test("dated with exclusion: excludes the attendee in listing and group counts", () => {
    const cond = buildCapacityCondition(LISTING, QTY, DAY, EXCLUDE);
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
    expect(cond.args).toEqual([
      LISTING,
      EXCLUDE,
      endAt,
      startAt,
      LISTING,
      QTY,
      LISTING,
      LISTING,
      EXCLUDE,
      EXCLUDE,
      endAt,
      startAt,
      QTY,
    ]);
  });

  test("multi-day: one clause per day, each with its own day's range", () => {
    const cond = buildCapacityCondition(LISTING, QTY, DAY, undefined, 3);
    // Three per-day clauses, so two AND joints between them.
    expect(occurrences(flat(cond.sql), ") AND (")).toBe(2);
    expect(cond.args).toEqual([
      ...dayConditionArgs("2026-05-01"),
      ...dayConditionArgs("2026-05-02"),
      ...dayConditionArgs("2026-05-03"),
    ]);
  });

  test("a non-positive duration is normalized to one day", () => {
    expect(buildCapacityCondition(LISTING, QTY, DAY, undefined, 0)).toEqual(
      buildCapacityCondition(LISTING, QTY, DAY, undefined, 1),
    );
  });
});

describe("buildBatchCapacitySql", () => {
  const bucket = (
    perDay: [string, number][],
    total: number,
  ): CapacityBucket => ({
    perDay: new Map(perDay),
    total,
  });

  test("no demand at all trivially fits", () => {
    expect(buildBatchCapacitySql(new Map(), new Map())).toEqual({
      args: [],
      sql: "SELECT 1 AS fits",
    });
  });

  test("a zero-total bucket produces no clause", () => {
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
    expect(sql).toContain(`id = ${LISTING} AND active = 1`);
    expect(sql).toContain("THEN 1 ELSE 0 END AS fits");
  });

  test("a single remaining unit of demand still gets its clause", () => {
    const { sql } = buildBatchCapacitySql(
      new Map([[LISTING, bucket([], 1)]]),
      new Map(),
    );
    expect(sql).toContain("+ 1 <=");
  });

  test("per-day listing demand emits one clause per day", () => {
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
    expect(args).toEqual([
      LISTING,
      endAt,
      startAt,
      LISTING,
      LISTING,
      other.endAt,
      other.startAt,
      LISTING,
    ]);
    expect(sql).toContain("+ 1 <=");
    expect(sql).toContain("+ 3 <=");
    // The two per-day clauses are joined into one AND'd condition.
    expect(occurrences(flat(sql), ") AND (")).toBe(1);
  });

  test("group demand folds the cart's date-less units into every day", () => {
    const { args, sql } = buildBatchCapacitySql(
      new Map(),
      new Map([[9, bucket([[DAY, 2]], 3)]]),
    );
    // 2 booked on the day + 3 date-less units that occupy the group every day.
    expect(sql).toContain("+ 5 <=");
    expect(sql).toContain("(SELECT max_attendees FROM groups WHERE id = 9)");
    expect(sql).toContain("= 0 OR");
    expect(args).toEqual([endAt, startAt]);
  });

  test("date-less-only group demand emits a single total clause", () => {
    const { args, sql } = buildBatchCapacitySql(
      new Map(),
      new Map([[9, bucket([], 3)]]),
    );
    expect(sql).toContain("+ 3 <=");
    expect(sql).not.toContain("start_at");
    expect(args).toEqual([]);
  });
});
