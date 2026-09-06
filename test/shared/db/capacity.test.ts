import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  buildCapacityCondition,
  capacityConditionFor,
  dateToRange,
} from "#db/capacity.ts";
import { numberedStatement } from "#db/numbered-statement.ts";
import { capacityRuleTypeSql } from "#shared/capacity-rules.ts";
import { flatSql, occurrences } from "#test-utils/sql-text.ts";

/**
 * Pure unit tests for the write predicate's SQL. Behaviour against a real
 * database lives in the availability/servicing suites; these lock the exact
 * statements and argument order the atomic write embeds — including that
 * every listing-type predicate is interpolated from CAPACITY_RULES rather
 * than hardcoded, so the SQL guard and the JS preflight share one
 * declaration. The cart read preflight's builders live beside their mirror
 * in capacity-batch.test.ts.
 */

const LISTING = 7;
const QTY = 2;
const EXCLUDE = 99;
const DAY = "2026-05-01";
const { startAt, endAt } = dateToRange(DAY);

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
    expect(flatSql(cond.sql)).toBe(
      "( (SELECT booked_quantity FROM listings WHERE id = ?1) ) + ?2 <= (SELECT max_attendees FROM listings WHERE id = ?1 AND active = 1) AND NOT EXISTS ( SELECT 1 FROM group_listings AS groupListing JOIN groups AS groupRow ON groupRow.id = groupListing.group_id WHERE groupListing.listing_id = ?1 AND groupRow.max_attendees > 0 AND ((COALESCE(( SELECT SUM(memberListing.booked_quantity) FROM listings AS memberListing JOIN group_listings AS groupListing ON groupListing.listing_id = memberListing.id WHERE groupListing.group_id = groupRow.id ), 0) )) + ?2 > groupRow.max_attendees )",
    );
  });

  test("date-less with exclusion: the group count carries a real exclusion subquery", () => {
    const cond = capacityStatement(LISTING, QTY, null, EXCLUDE);
    expect(occurrences(cond.sql, "- COALESCE((")).toBe(2);
    expect(flatSql(cond.sql)).toContain(
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
    expect(flatSql(cond.sql)).toBe(
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
    expect(occurrences(flatSql(cond.sql), ") AND (")).toBe(2);
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

  test("a zero-quantity line's condition refuses nothing", () => {
    // The no-op contract at the builder: a line that books no places carries
    // the trivially-true clause, so no full or inactive listing can strand
    // it — while any real quantity still gets the full condition.
    expect(
      numberedStatement(
        capacityConditionFor({
          date: null,
          durationDays: 1,
          listingId: LISTING,
          quantity: 0,
        }),
      ).sql,
    ).toBe("1");
    expect(
      numberedStatement(
        capacityConditionFor({
          date: null,
          durationDays: 1,
          listingId: LISTING,
          quantity: QTY,
        }),
      ).sql,
    ).not.toBe("1");
  });
});
