/** Listing reads batched with attendee data and daily attendee queries. */

import type { ResultSet } from "@libsql/client";
import { reduce, sortStrings, unique } from "#fp";
import { addDays } from "#shared/dates.ts";
import {
  ATTENDEE_FIELDS,
  attendeeBatchStatement,
  getAttendees,
} from "#shared/db/attendees/select.ts";
import { dateToRange } from "#shared/db/capacity.ts";
import {
  queryAll,
  queryBatch,
  resultRows,
  type SqlStatement,
} from "#shared/db/client.ts";
import type { Attendee, Listing, ListingWithCount } from "#shared/types.ts";
import { decryptListingWithCount } from "./records.ts";
import { listingProjectionSql } from "./sql.ts";

type StoredListingAggregateColumns = {
  booked_quantity: number;
  cost: number;
  income: number;
  tickets_count: number;
};

const extractListingRow = (
  result: ResultSet,
): (Listing & StoredListingAggregateColumns) | null =>
  resultRows<Listing & StoredListingAggregateColumns>(result)[0] ?? null;

const withBatchListing = async <T>(
  listingResult: ResultSet,
  build: (listing: ListingWithCount) => T,
): Promise<T | null> => {
  const listingRow = extractListingRow(listingResult);
  if (!listingRow) return null;
  return build(
    await decryptListingWithCount({
      ...listingRow,
      attendee_count: listingRow.booked_quantity,
    }),
  );
};

const listingStatement = (id: number): SqlStatement => ({
  args: [id],
  sql: `SELECT ${listingProjectionSql("listing")} FROM listings AS listing WHERE listing.id = ?`,
});

export type ListingWithAttendees = {
  listing: ListingWithCount;
  attendeesRaw: Attendee[];
};

/** Read one listing and all its attendee rows in one round-trip. */
export const getListingWithAttendeesRaw = async (
  id: number,
): Promise<ListingWithAttendees | null> => {
  const results = await queryBatch([
    listingStatement(id),
    attendeeBatchStatement({
      fields: ATTENDEE_FIELDS,
      order: "created_desc",
      where: { listingIds: [id] },
    }),
  ]);
  const attendeesRaw = resultRows<Attendee>(results[1]!);
  return withBatchListing(results[0]!, (listing) => ({
    attendeesRaw,
    listing,
  }));
};

/** Read every occupied date across daily listing bookings. */
export const getDailyListingAttendeeDates = async (): Promise<string[]> => {
  const rows = await queryAll<{ start_at: string; end_at: string }>(
    `SELECT DISTINCT listingAttendee.start_at, listingAttendee.end_at
     FROM listing_attendees AS listingAttendee
     INNER JOIN listings AS listing ON listingAttendee.listing_id = listing.id
     WHERE listing.listing_type = 'daily'
       AND listingAttendee.start_at IS NOT NULL
       AND listingAttendee.end_at IS NOT NULL
       AND listingAttendee.quantity > 0`,
  );
  const dates = reduce(
    (allDates: string[], row: { start_at: string; end_at: string }) => {
      const endExclusive = row.end_at.slice(0, 10);
      let current = row.start_at.slice(0, 10);
      while (current < endExclusive) {
        allDates.push(current);
        current = addDays(current, 1);
      }
      return allDates;
    },
    [],
  )(rows);
  return sortStrings(unique(dates));
};

/** Read daily-listing attendees whose booking overlaps one date. */
export const getDailyListingAttendeesByDate = (
  date: string,
): Promise<Attendee[]> => {
  const { startAt, endAt } = dateToRange(date);
  return getAttendees({
    fields: ATTENDEE_FIELDS,
    order: "created_desc",
    // Servicing holds occupy dates too; realLinesOnly drops no-quantity rows.
    where: {
      dailyRange: { after: startAt, before: endAt },
      kind: "attendee-or-servicing",
      realLinesOnly: true,
    },
  });
};

type ListingAttendeeKindScope = "attendees" | "attendees-and-servicing";

type ListingAttendeeFilter = {
  activeOnly?: boolean;
  kindScope?: ListingAttendeeKindScope;
};

const listingAttendeeFilter = (
  filter: boolean | ListingAttendeeFilter = false,
): Required<ListingAttendeeFilter> =>
  typeof filter === "boolean"
    ? { activeOnly: filter, kindScope: "attendees" }
    : {
        activeOnly: filter.activeOnly ?? false,
        kindScope: filter.kindScope ?? "attendees",
      };

const attendeeKindFilter = (
  kindScope: ListingAttendeeKindScope,
): "attendee" | "attendee-or-servicing" =>
  kindScope === "attendees-and-servicing"
    ? "attendee-or-servicing"
    : "attendee";

/** Read raw attendees attached to any requested listing. */
export const getAttendeesByListingIds = (
  listingIds: number[],
  filter: boolean | ListingAttendeeFilter = false,
): Promise<Attendee[]> => {
  if (listingIds.length === 0) return Promise.resolve([]);
  const { activeOnly, kindScope } = listingAttendeeFilter(filter);
  return getAttendees({
    fields: ATTENDEE_FIELDS,
    order: "created_desc",
    where: {
      kind: attendeeKindFilter(kindScope),
      listingIds,
      realLinesOnly: activeOnly,
    },
  });
};

export type ListingWithAttendeeRaw = {
  listing: ListingWithCount;
  attendeeRaw: Attendee | null;
};

/** Read one listing and one attendee in one round-trip. */
export const getListingWithAttendeeRaw = async (
  listingId: number,
  attendeeId: number,
): Promise<ListingWithAttendeeRaw | null> => {
  const results = await queryBatch([
    listingStatement(listingId),
    attendeeBatchStatement({
      fields: ATTENDEE_FIELDS,
      join: "left",
      where: { attendeeIds: [attendeeId] },
    }),
  ]);
  return withBatchListing(results[0]!, (listing) => ({
    attendeeRaw: resultRows<Attendee>(results[1]!)[0] ?? null,
    listing,
  }));
};
