/**
 * The clause is embedded in the same INSERT/UPDATE that mutates the row, so
 * there is no read-modify-write race. Range length is bounded at 90 by form
 * validation, so the per-day clauses stay cheap.
 *
 * The type predicates are interpolated from `#shared/capacity-rules.ts`, never
 * hardcoded, so this guard and the JS preflight read the same declaration.
 */

import type { LineBooking } from "#db/attendee-types.ts";
import type {
  SqlParameter,
  SqlParameterToken,
} from "#db/numbered-statement.ts";
import { capacityRuleTypeSql } from "#shared/capacity-rules.ts";
import { addDays } from "#shared/dates.ts";
import { DAY_MS } from "#shared/now.ts";
import { parseDateStringOrThrow } from "#shared/validation/date-string.ts";
import { clampDurationDays } from "#types";

/** A half-open [startAt, endAt) window of whole days, as timestamps. Also
 * the shape of an attendee's booked windows on the Logistics tab. */
export type DayRange = { startAt: string; endAt: string };

/** Convert a date string ("YYYY-MM-DD") to a half-open [start, end) pair.
 * `durationDays` is normalized (whole days in [1, MAX]) so `end_at` is always
 * a clean midnight boundary N full days after start — the stored range and
 * every capacity check derive their span the same way.
 *
 * Format note: `startAt` is `"…T00:00:00Z"` (template literal); `endAt`
 * is `"…T00:00:00.000Z"` (Date.toISOString). The overlap predicate
 * `start_at < endAt AND end_at > startAt` is strict-less/strict-greater,
 * so the `.000Z` / `Z` difference is irrelevant — but do not "tidy" them
 * to match, because SQLite TEXT comparison is byte-for-byte and tests
 * assert the exact stored format. */
export const dateToRange = (date: string, durationDays = 1): DayRange => {
  const days = clampDurationDays(durationDays);
  const ms = new Date(`${date}T00:00:00Z`).getTime();
  const endIso = new Date(ms + days * DAY_MS).toISOString();
  return { endAt: endIso, startAt: `${date}T00:00:00Z` };
};

/** The day-window expressions a counting subquery compares against: bound
 * parameter tokens in the write predicate, dayDemand column references in
 * the batch clauses. Never a raw date — a date reaches the statement only
 * through bind, so this type is deliberately not a DayRange. */
export type CountingDayRange = { endSql: string; startSql: string };

type CountSqlValues = {
  dayRange: CountingDayRange | null;
  excludeAttendeeId: SqlParameterToken | null;
  listingId: SqlParameterToken;
};

export type CapacitySql = (
  bind: SqlParameter,
  shared?: Partial<{
    excludeAttendeeId: SqlParameterToken;
    listingId: SqlParameterToken;
    quantity: SqlParameterToken;
  }>,
) => string;

const attendeeExclusionSql = (
  alias: string,
  excludeAttendeeId: SqlParameterToken | null,
): string =>
  excludeAttendeeId === null
    ? ""
    : `AND ${alias}.attendee_id != ${excludeAttendeeId} `;

const dailyListingCountSql = (
  values: CountSqlValues & { dayRange: CountingDayRange },
): string =>
  `(SELECT CASE
          WHEN ${capacityRuleTypeSql("perDateCap", "listing.listing_type")} THEN (
            SELECT COALESCE(SUM(attendee.quantity), 0)
              FROM listing_attendees AS attendee
             WHERE attendee.listing_id = ${values.listingId} ${attendeeExclusionSql(
               "attendee",
               values.excludeAttendeeId,
             )}
               AND attendee.start_at < ${values.dayRange.endSql}
               AND attendee.end_at > ${values.dayRange.startSql}
          )
          ELSE listing.booked_quantity
        END
        FROM listings AS listing WHERE listing.id = ${values.listingId})`;

const undatedListingCountSql = (values: CountSqlValues): string => {
  if (values.excludeAttendeeId !== null) {
    return `((SELECT booked_quantity FROM listings WHERE id = ${values.listingId})
          - COALESCE((
            SELECT SUM(attendee.quantity)
              FROM listing_attendees AS attendee
             WHERE attendee.listing_id = ${values.listingId}
               AND attendee.attendee_id = ${values.excludeAttendeeId}
          ), 0))`;
  }

  return `(SELECT booked_quantity FROM listings WHERE id = ${values.listingId})`;
};

export const buildListingCountSql = (values: CountSqlValues): string =>
  values.dayRange === null
    ? undatedListingCountSql(values)
    : dailyListingCountSql({ ...values, dayRange: values.dayRange });

// The group-count subqueries below correlate on `groupRow.id` — the group row
// of the enclosing NOT EXISTS in buildDayCapacitySql — and reach that group's member
// listings through the group_listings join table, so a listing that belongs to
// several groups is counted against each group's cap independently.

const DAILY_GROUP_MEMBER_SQL = {
  join: `JOIN listings AS memberListing
              ON memberListing.id = attendee.listing_id`,
  rule: `AND ${capacityRuleTypeSql("dateLessCap", "memberListing.listing_type")}`,
};
const ALL_GROUP_MEMBER_SQL = { join: "", rule: "" };

const buildGroupExclusionSql = (
  excludeAttendeeId: SqlParameterToken | null,
  memberSql: typeof DAILY_GROUP_MEMBER_SQL,
): string => {
  if (excludeAttendeeId === null) return "";

  return `- COALESCE((
          SELECT SUM(attendee.quantity)
            FROM listing_attendees AS attendee
            JOIN group_listings AS groupListing
              ON groupListing.listing_id = attendee.listing_id
            ${memberSql.join}
           WHERE groupListing.group_id = groupRow.id
             ${memberSql.rule}
             AND attendee.attendee_id = ${excludeAttendeeId}
        ), 0)`;
};

// `groupRef` names the group whose members are summed: "groupRow.id" correlates
// on the enclosing NOT EXISTS row (the write predicate), while the batch read
// preflight passes a literal group id. The COUNTING body is otherwise identical,
// so the write guard and the read preflight can never count a group differently.
// (Self-exclusion is write-only — the batch never excludes — so those branches
// keep the correlated "groupRow.id" they are only ever emitted with.)
const buildDailyGroupCountSql = (
  dayRange: CountingDayRange,
  excludeAttendeeId: SqlParameterToken | null,
  groupRef: string,
): string =>
  `(COALESCE((
          SELECT SUM(memberListing.booked_quantity)
            FROM listings AS memberListing
            JOIN group_listings AS groupListing
              ON groupListing.listing_id = memberListing.id
           WHERE groupListing.group_id = ${groupRef}
             AND ${capacityRuleTypeSql("dateLessCap", "memberListing.listing_type")}
        ), 0)
        ${buildGroupExclusionSql(excludeAttendeeId, DAILY_GROUP_MEMBER_SQL)}
        + COALESCE((
          SELECT SUM(attendee.quantity)
            FROM listing_attendees AS attendee
            JOIN group_listings AS groupListing
              ON groupListing.listing_id = attendee.listing_id
            JOIN listings AS memberListing
              ON memberListing.id = attendee.listing_id
           WHERE groupListing.group_id = ${groupRef}
             AND ${capacityRuleTypeSql("perDateCap", "memberListing.listing_type")} ${attendeeExclusionSql(
               "attendee",
               excludeAttendeeId,
             )}
              AND attendee.start_at < ${dayRange.endSql}
              AND attendee.end_at > ${dayRange.startSql}
         ), 0))`;

const buildUndatedGroupCountSql = (
  excludeAttendeeId: SqlParameterToken | null,
  groupRef: string,
): string =>
  `(COALESCE((
          SELECT SUM(memberListing.booked_quantity)
            FROM listings AS memberListing
            JOIN group_listings AS groupListing
              ON groupListing.listing_id = memberListing.id
           WHERE groupListing.group_id = ${groupRef}
        ), 0)
         ${buildGroupExclusionSql(excludeAttendeeId, ALL_GROUP_MEMBER_SQL)})`;

export const buildGroupCountSql = (
  dayRange: CountingDayRange | null,
  excludeAttendeeId: SqlParameterToken | null,
  groupRef = "groupRow.id",
): string => {
  if (dayRange) {
    return buildDailyGroupCountSql(dayRange, excludeAttendeeId, groupRef);
  }

  return buildUndatedGroupCountSql(excludeAttendeeId, groupRef);
};

/** The listing's own cap for one day: the counted demand plus the asking
 * quantity against the listing's max. The line also enforces active = 1 (an
 * inactive listing's max_attendees subquery is NULL, so the comparison
 * fails). */
const buildListingCapSql = (
  count: CountSqlValues,
  quantity: SqlParameterToken,
): string =>
  `(
    ${buildListingCountSql(count)}
  ) + ${quantity} <= (SELECT max_attendees FROM listings WHERE id = ${count.listingId} AND active = 1)`;

/**
 * Build a single-day capacity clause (listing-cap + group-cap when applicable).
 * `dayRange` is null for non-daily / date-less bookings; those use the editable
 * booked_quantity running total. Dated daily checks still count overlapping rows.
 */
const buildDayCapacitySql = (
  count: CountSqlValues,
  quantity: SqlParameterToken,
): string => {
  const { dayRange, excludeAttendeeId, listingId } = count;
  const groupCount = buildGroupCountSql(dayRange, excludeAttendeeId);

  // The group cap passes unless SOME group the listing belongs to is capped
  // and would be pushed over by this booking — so an ungrouped or all-uncapped
  // listing has no offending group and NOT EXISTS is satisfied.
  return `${buildListingCapSql(count, quantity)}
  AND NOT EXISTS (
    SELECT 1
    FROM group_listings AS groupListing
    JOIN groups AS groupRow ON groupRow.id = groupListing.group_id
    WHERE groupListing.listing_id = ${listingId}
      AND groupRow.max_attendees > 0
      AND (${groupCount}) + ${quantity} > groupRow.max_attendees
  )`;
};

const bindDayRange = (
  bind: SqlParameter,
  dayRange: DayRange | null,
): CountingDayRange | null =>
  dayRange === null
    ? null
    : { endSql: bind(dayRange.endAt), startSql: bind(dayRange.startAt) };

/** One clause per booked day, AND'd together, so a multi-day booking is
 * judged on every day it occupies. A date-less demand is one clause. */
const perDayClauses = (
  date: string | null,
  durationDays: number,
  daySql: (dayRange: DayRange | null) => string,
): string => {
  if (!date) return daySql(null);
  const booked = parseDateStringOrThrow(date, "a stored booking date");
  return Array.from(
    { length: clampDurationDays(durationDays) },
    (_, index) => `(${daySql(dateToRange(addDays(booked, index)))})`,
  ).join(" AND ");
};

/**
 * Build the WHERE clause for capacity checking on listing_attendees.
 * For multi-day daily bookings, emits one clause per day AND'd together so
 * the atomic SQL guard matches the per-day accuracy of the JS preflight.
 *
 * @param excludeAttendeeId - If set, excludes this attendee's rows from the count (for updates)
 * @param scope - `{ groupCaps: false }` judges the listing's own cap alone.
 */
export const buildCapacityCondition =
  (
    listingId: number,
    qty: number,
    date: string | null,
    excludeAttendeeId?: number,
    durationDays = 1,
    scope: { groupCaps: boolean } = { groupCaps: true },
  ): CapacitySql =>
  (bind, shared = {}) => {
    const listingIdSql = shared.listingId ?? bind(listingId);
    const quantitySql = shared.quantity ?? bind(qty);
    const excludeAttendeeIdSql =
      excludeAttendeeId === undefined
        ? null
        : (shared.excludeAttendeeId ?? bind(excludeAttendeeId));
    const sqlFor = (dayRange: DayRange | null): string =>
      scope.groupCaps
        ? buildDayCapacitySql(
            {
              dayRange: bindDayRange(bind, dayRange),
              excludeAttendeeId: excludeAttendeeIdSql,
              listingId: listingIdSql,
            },
            quantitySql,
          )
        : buildListingCapSql(
            {
              dayRange: bindDayRange(bind, dayRange),
              excludeAttendeeId: null,
              listingId: listingIdSql,
            },
            quantitySql,
          );
    return perDayClauses(date, durationDays, sqlFor);
  };

/**
 * The per-day shape of {@link buildCapacityCondition}, judged against the
 * listing's own cap alone — no group caps. The listing save's undated-move
 * probe judges its offered dates with it. The confirmed save writes the
 * submission's group memberships before the move reads them, so the probe
 * cannot judge the old memberships against the new ones.
 */
export const buildListingCapCondition = (booking: LineBooking): CapacitySql =>
  buildCapacityCondition(
    booking.listingId,
    booking.quantity,
    booking.date,
    undefined,
    booking.durationDays,
    { groupCaps: false },
  );

/** A clause that refuses nothing: the zero-quantity line's demand. */
const alwaysFits: CapacitySql = () => "1";

/**
 * The capacity condition for one booked line. An edit passes the attendee whose
 * own row must not count against the room it is asking for. A zero-quantity
 * line demands no places, so it carries no capacity or active condition.
 */
export const capacityConditionFor = (
  booking: LineBooking,
  excludeAttendeeId?: number,
): CapacitySql =>
  booking.quantity === 0
    ? alwaysFits
    : buildCapacityCondition(
        booking.listingId,
        booking.quantity,
        booking.date,
        excludeAttendeeId,
        booking.durationDays,
      );
