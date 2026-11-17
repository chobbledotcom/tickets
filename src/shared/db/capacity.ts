/**
 * The clause is embedded in the same INSERT/UPDATE that mutates the row, so
 * there is no read-modify-write race. Range length is bounded at 90 by form
 * validation, so the per-day clauses stay cheap.
 *
 * The type predicates are interpolated from `#shared/capacity-rules.ts`, never
 * hardcoded, so this guard and the JS preflight read the same declaration.
 */

import type { LineBooking } from "#db/attendee-types.ts";
import {
  and,
  atMost,
  type Condition,
  type Counted,
  type Expr,
  equal,
  greaterThan,
  lessThan,
  literal,
  minus,
  not,
  notEqual,
  type Operand,
  orZero,
  plus,
  sum,
  when,
} from "#db/select/expression.ts";
import { from } from "#db/select/query.ts";
import type { Node, Query } from "#db/select/shape.ts";
import { tables } from "#db/select/tables.ts";
import {
  type CapacityRuleKey,
  capacityRuleTypeSql,
} from "#shared/capacity-rules.ts";
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

/** The day window a counting subquery compares against: bound dates in the
 * write predicate, dayDemand column references in the batch clauses. */
export type CountingDayRange = {
  end: Operand<string>;
  start: Operand<string>;
};

type CountValues = {
  dayRange: CountingDayRange | null;
  excludeAttendeeId: Operand<number> | null;
  listingId: Operand<number>;
};

/** The booking rows a count reads. */
const bookedLines = () => from(tables.listing_attendees).as("attendee");

type BookedLine = Node<"listing_attendees">;

/** Keeps the rows of other attendees. An edit must not count its own row. */
const notBookedBy =
  (excludeAttendeeId: Operand<number> | null) =>
  (line: BookedLine): Condition =>
    excludeAttendeeId === null || notEqual(line.attendeeId, excludeAttendeeId);

/** Keeps the rows that occupy some part of the day window. */
const overlapping =
  (dayRange: CountingDayRange) =>
  (line: BookedLine): Condition[] => [
    lessThan(line.startAt, dayRange.end),
    greaterThan(line.endAt, dayRange.start),
  ];

/** Keeps the rows of other attendees that occupy some part of the day
 *  window. */
const heldThatDay =
  (dayRange: CountingDayRange, excludeAttendeeId: Operand<number> | null) =>
  (line: BookedLine): Condition[] => [
    notBookedBy(excludeAttendeeId)(line),
    ...overlapping(dayRange)(line),
  ];

/** The quantity that the rows hold. Zero with no row. */
const quantityOf = <Line extends BookedLine>(
  lines: Query<Line>,
): Expr<Counted> => orZero(lines.scalar((line) => sum(line.quantity)));

/** The booking rows of one listing. */
const listingLines = (listingId: Operand<number>) =>
  bookedLines().where((line) => equal(line.listingId, listingId));

/** The row of the listing itself. */
const listingRow = (listingId: Operand<number>) =>
  from(tables.listings).where((listing) => equal(listing.id, listingId));

const dailyListingCount = (
  values: CountValues & { dayRange: CountingDayRange },
): Expr<Counted | null> => {
  const bookedThatDay = quantityOf(
    listingLines(values.listingId).where(
      heldThatDay(values.dayRange, values.excludeAttendeeId),
    ),
  );
  return listingRow(values.listingId).scalar((listing) =>
    when(
      [[capacityRuleTypeSql("perDateCap", listing.listingType), bookedThatDay]],
      listing.bookedQuantity,
    ),
  );
};

const undatedListingCount = (values: CountValues): Expr<Counted | null> => {
  const booked = listingRow(values.listingId).scalar(
    (listing) => listing.bookedQuantity,
  );
  const { excludeAttendeeId } = values;
  if (excludeAttendeeId === null) return booked;
  return minus(
    booked,
    quantityOf(
      listingLines(values.listingId).where((line) =>
        equal(line.attendeeId, excludeAttendeeId),
      ),
    ),
  );
};

export const buildListingCountSql = (
  values: CountValues,
): Expr<Counted | null> =>
  values.dayRange === null
    ? undatedListingCount(values)
    : dailyListingCount({ ...values, dayRange: values.dayRange });

// The group counts below reach a group's member listings through the
// group_listings join table, so a listing that belongs to several groups is
// counted against the cap of each group independently.

/** The running total of the group's members, or of its members that carry
 *  `rule`. */
export const groupRunningTotal = (
  groupId: Operand<number>,
  rule: CapacityRuleKey | null,
): Expr<Counted> =>
  orZero(
    from(tables.listings)
      .as("memberListing")
      .join("memberLink", tables.group_listings, (listing) =>
        equal(listing.memberLink.listingId, listing.id),
      )
      .where((listing) => [
        equal(listing.memberLink.groupId, groupId),
        rule === null || capacityRuleTypeSql(rule, listing.listingType),
      ])
      .scalar((listing) => sum(listing.bookedQuantity)),
  );

/** The booking rows of the group's member listings. */
const memberLines = (groupId: Operand<number>) =>
  bookedLines()
    .join("memberLink", tables.group_listings, (line) =>
      equal(line.memberLink.listingId, line.listingId),
    )
    .where((line) => equal(line.memberLink.groupId, groupId));

/** The booking rows of the group's member listings that carry `rule`. */
const memberLinesWithRule = (groupId: Operand<number>, rule: CapacityRuleKey) =>
  memberLines(groupId)
    .join("memberListing", tables.listings, (line) =>
      equal(line.memberListing.id, line.listingId),
    )
    .where((line) => capacityRuleTypeSql(rule, line.memberListing.listingType));

/** What the excluded attendee holds in the running total, so an edit does not
 *  count its own rows. */
const lessOwnRows = (
  total: Expr<Counted>,
  ownRows: ReturnType<typeof memberLines> | null,
  excludeAttendeeId: Operand<number> | null,
): Expr<Counted> =>
  ownRows === null || excludeAttendeeId === null
    ? total
    : minus(
        total,
        quantityOf(
          ownRows.where((line) => equal(line.attendeeId, excludeAttendeeId)),
        ),
      );

/** How much of a group is taken in a day window, without the rows of the
 *  excluded attendee. */
type GroupCount<Range> = (
  dayRange: Range,
  excludeAttendeeId: Operand<number> | null,
  groupId: Operand<number>,
) => Expr<Counted>;

// The write guard passes the group row of its enclosing NOT EXISTS as
// `groupId`. The batch read preflight passes its own group id. The counting
// body is the same, so the write guard and the read preflight cannot count a
// group differently.
const dailyGroupCount: GroupCount<CountingDayRange> = (
  dayRange,
  excludeAttendeeId,
  groupId,
) =>
  plus(
    lessOwnRows(
      groupRunningTotal(groupId, "dateLessCap"),
      memberLinesWithRule(groupId, "dateLessCap"),
      excludeAttendeeId,
    ),
    quantityOf(
      memberLinesWithRule(groupId, "perDateCap").where(
        heldThatDay(dayRange, excludeAttendeeId),
      ),
    ),
  );

export const buildGroupCountSql: GroupCount<CountingDayRange | null> = (
  dayRange,
  excludeAttendeeId,
  groupId,
) =>
  dayRange === null
    ? lessOwnRows(
        groupRunningTotal(groupId, null),
        memberLines(groupId),
        excludeAttendeeId,
      )
    : dailyGroupCount(dayRange, excludeAttendeeId, groupId);

/** The listing's own cap for one day: the counted demand plus the asking
 * quantity against the listing's max. An inactive listing has no cap row, so
 * the comparison is null and the booking is refused. */
const listingCap = (count: CountValues, quantity: number): Expr<boolean> =>
  atMost(
    plus(buildListingCountSql(count), quantity),
    listingRow(count.listingId)
      .where((listing) => equal(listing.active, literal(1)))
      .scalar((listing) => listing.maxAttendees),
  );

/**
 * The capacity condition of one day: the listing cap, and the group caps.
 * `dayRange` is null for a date-less booking, which reads the running total.
 * A dated daily check counts the rows that overlap the day.
 */
const dayCapacity = (count: CountValues, quantity: number): Expr<boolean> => {
  const { dayRange, excludeAttendeeId, listingId } = count;
  // The group cap passes unless SOME group the listing belongs to is capped
  // and would be pushed over by this booking — so an ungrouped or all-uncapped
  // listing has no offending group and NOT EXISTS is satisfied.
  const overfullGroup = from(tables.group_listings, { group: {} }).where(
    (membership) => [
      equal(membership.listingId, listingId),
      greaterThan(membership.group.maxAttendees, literal(0)),
      greaterThan(
        plus(
          buildGroupCountSql(dayRange, excludeAttendeeId, membership.group.id),
          quantity,
        ),
        membership.group.maxAttendees,
      ),
    ],
  );
  return and(listingCap(count, quantity), not(overfullGroup.exists()));
};

const countingDayRange = (
  dayRange: DayRange | null,
): CountingDayRange | null =>
  dayRange === null ? null : { end: dayRange.endAt, start: dayRange.startAt };

/** One clause per booked day, AND'd together, so a multi-day booking is
 * judged on every day it occupies. A date-less demand is one clause. */
const perDayClauses = (
  date: string | null,
  durationDays: number,
  dayCondition: (dayRange: DayRange | null) => Expr<boolean>,
): Expr<boolean> => {
  if (!date) return dayCondition(null);
  const booked = parseDateStringOrThrow(date, "a stored booking date");
  return and(
    ...Array.from({ length: clampDurationDays(durationDays) }, (_, index) =>
      dayCondition(dateToRange(addDays(booked, index))),
    ),
  );
};

/**
 * Build the WHERE clause for capacity checking on listing_attendees.
 * For multi-day daily bookings, emits one clause per day AND'd together so
 * the atomic SQL guard matches the per-day accuracy of the JS preflight.
 *
 * @param excludeAttendeeId - If set, excludes this attendee's rows from the count (for updates)
 * @param scope - `{ groupCaps: false }` judges the listing's own cap alone.
 */
export const buildCapacityCondition = (
  listingId: number,
  quantity: number,
  date: string | null,
  excludeAttendeeId?: number,
  durationDays = 1,
  scope: { groupCaps: boolean } = { groupCaps: true },
): Expr<boolean> => {
  const conditionFor = (dayRange: DayRange | null): Expr<boolean> =>
    scope.groupCaps
      ? dayCapacity(
          {
            dayRange: countingDayRange(dayRange),
            excludeAttendeeId: excludeAttendeeId ?? null,
            listingId,
          },
          quantity,
        )
      : listingCap(
          {
            dayRange: countingDayRange(dayRange),
            excludeAttendeeId: null,
            listingId,
          },
          quantity,
        );
  return perDayClauses(date, durationDays, conditionFor);
};

/**
 * The per-day shape of {@link buildCapacityCondition}, judged against the
 * listing's own cap alone — no group caps. The listing save's undated-move
 * probe judges its offered dates with it. The confirmed save writes the
 * submission's group memberships before the move reads them, so the probe
 * cannot judge the old memberships against the new ones.
 */
export const buildListingCapCondition = (booking: LineBooking): Expr<boolean> =>
  buildCapacityCondition(
    booking.listingId,
    booking.quantity,
    booking.date,
    undefined,
    booking.durationDays,
    { groupCaps: false },
  );

/**
 * The capacity condition for one booked line. An edit passes the attendee whose
 * own row must not count against the room it is asking for. A zero-quantity
 * line demands no places, so it carries no capacity or active condition.
 */
export const capacityConditionFor = (
  booking: LineBooking,
  excludeAttendeeId?: number,
): Expr<boolean> =>
  booking.quantity === 0
    ? and()
    : buildCapacityCondition(
        booking.listingId,
        booking.quantity,
        booking.date,
        excludeAttendeeId,
        booking.durationDays,
      );
