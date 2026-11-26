/** Listing reads batched with attendee data and daily attendee queries. */

import type { ResultSet } from "@libsql/client";
import {
  BROWSING_FIELDS,
  type BrowsingAttendee,
  peopleWithLinesOn,
} from "#db/attendees/queries.ts";
import {
  ATTENDEE_FIELDS,
  type AttendeeField,
  type AttendeeOrder,
  type AttendeeRowFor,
  type AttendeeWhere,
  attendeeBatchStatement,
  getAttendees,
} from "#db/attendees/select.ts";
import { dateToRange } from "#db/capacity.ts";
import { queryAll, queryBatch, resultRows } from "#db/client.ts";
import { type SqlStatement, sql } from "#db/sql.ts";
import { flatMap, sortStrings, unique } from "#fp";
import { coveredDays } from "#shared/dates.ts";
import type { Attendee, ListingWithCount } from "#types";
import { decryptListingWithCount } from "./records.ts";
import { type ListingRecordRow, listingReader } from "./select.ts";

const withBatchListing = async <T>(
  listingResult: ResultSet,
  build: (listing: ListingWithCount) => T,
): Promise<T | null> => {
  const listingRow = resultRows<ListingRecordRow>(listingResult)[0];
  if (!listingRow) return null;
  return build(await decryptListingWithCount(listingRow));
};

/** The listing half of these one-round-trip batch reads. */
const oneListing = (id: number): SqlStatement =>
  listingReader.statement({ where: { ids: [id] } });

export type ListingWithAttendees = {
  listing: ListingWithCount;
  attendeesRaw: Attendee[];
};

/** Read one listing and all its attendee rows in one round-trip. */
export const getListingWithAttendeesRaw = async (
  id: number,
): Promise<ListingWithAttendees | null> => {
  const results = await queryBatch([
    oneListing(id),
    attendeeBatchStatement({
      fields: ATTENDEE_FIELDS,
      order: "created_desc",
      owedScope: "booking",
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
    sql`SELECT DISTINCT listingAttendee.start_at, listingAttendee.end_at
     FROM listing_attendees AS listingAttendee
     INNER JOIN listings AS listing ON listingAttendee.listing_id = listing.id
     WHERE listing.listing_type = 'daily'
       AND listingAttendee.start_at IS NOT NULL
       AND listingAttendee.end_at IS NOT NULL
       AND listingAttendee.quantity > 0`,
  );
  const dates = flatMap((row: { start_at: string; end_at: string }) =>
    coveredDays(row.start_at.slice(0, 10), row.end_at.slice(0, 10)),
  )(rows);
  return sortStrings(unique(dates));
};

/** Booking rows with the chosen fields, in the given order — newest-first
 * unless the caller names another. The daily-range, the listing-filtered,
 * and the door roster reads share the shape. */
const bookingScopedRows =
  <F extends AttendeeField>(fields: readonly F[]) =>
  (
    where: AttendeeWhere,
    order: AttendeeOrder = "created_desc",
  ): Promise<AttendeeRowFor<F>[]> =>
    getAttendees({ fields, order, owedScope: "booking", where });

const bookingScopedAttendeeRows = bookingScopedRows(ATTENDEE_FIELDS);

/** Read daily-listing attendees whose booking overlaps one date. */
export const getDailyListingAttendeesByDate = (
  date: string,
): Promise<Attendee[]> => {
  const { startAt, endAt } = dateToRange(date);
  // Servicing holds occupy dates too. `realLinesOnly` drops no-quantity rows.
  return bookingScopedAttendeeRows({
    dailyRange: { after: startAt, before: endAt },
    kind: "attendee-or-servicing",
    realLinesOnly: true,
  });
};

type ListingAttendeeKindScope = "attendees" | "attendees-and-servicing";

type ListingAttendeeFilter = {
  activeOnly?: boolean;
  kindScope?: ListingAttendeeKindScope;
};

const listingAttendeeFilter = (
  filter: boolean | ListingAttendeeFilter,
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
  order: AttendeeOrder = "created_desc",
): Promise<Attendee[]> => {
  if (listingIds.length === 0) return Promise.resolve([]);
  const { activeOnly, kindScope } = listingAttendeeFilter(filter);
  return bookingScopedAttendeeRows(
    {
      kind: attendeeKindFilter(kindScope),
      listingIds,
      realLinesOnly: activeOnly,
    },
    order,
  );
};

/** The door roster's booking rows on the listings: every core column plus
 * `refunded`. A name search and a digest lookup read no money projection,
 * so the read leaves them out. The rows come in booking order, the order a
 * scan groups a person's lines by, so the roster names the listing a scan
 * lands on. */
export const getRosterAttendeesByListingIds = (
  listingIds: number[],
): Promise<BrowsingAttendee[]> =>
  listingIds.length === 0
    ? Promise.resolve([])
    : bookingScopedRows(BROWSING_FIELDS)(
        { kind: "attendee", listingIds },
        "start_then_listing",
      );

/** One page of the people who hold lines on some listings, in attendee id
 * order. Each person brings every line they hold on those listings, so a
 * page never splits one booking. */
type ListingAttendeesPage = {
  attendees: Attendee[];
  /** The line-id watermark this page read under: lines created after the
   * first page captured it never join. */
  lineMark: number;
  /** The last attendee id on this page, or null on the last page. */
  nextAfter: number | null;
  /** How many people this page holds. */
  people: number;
  /** How many people the listings hold in all, under the same watermark. */
  total: number;
};

/** Read one page of the people who hold lines on the listings, after the
 * attendee id `afterId`, bounded by the line-id watermark `lineMark`. One
 * more id than the page holds tells whether a next page exists. A null
 * `lineMark` is the first page: this read captures the watermark and
 * returns it, so the cursor can carry it to every later page. */
export const getAttendeesPageByListingIds = async (
  listingIds: number[],
  afterId: number,
  pageSize: number,
  order: AttendeeOrder,
  lineMark: number | null,
): Promise<ListingAttendeesPage> => {
  if (listingIds.length === 0) {
    return { attendees: [], lineMark: 0, nextAfter: null, people: 0, total: 0 };
  }
  // The first page is unbounded: it captures the watermark the cursor then
  // carries, so every page of one download reads the same membership. A
  // later page reads the mark again only to keep one batch shape.
  const [idResult, totalResult, markResult] = await queryBatch([
    sql`SELECT pageAttendee.id AS id FROM ${peopleWithLinesOn(
      listingIds,
      lineMark,
    )}
      AND pageAttendee.id > ${afterId}
      GROUP BY pageAttendee.id
      ORDER BY pageAttendee.id ASC
      LIMIT ${pageSize + 1}`,
    sql`SELECT COUNT(DISTINCT pageAttendee.id) AS total
      FROM ${peopleWithLinesOn(listingIds, lineMark)}`,
    sql`SELECT MAX(pageLine.id) AS mark FROM listing_attendees AS pageLine`,
  ]);
  // An empty line table has no mark, and no line can join under zero.
  const captured =
    lineMark ?? resultRows<{ mark: number | null }>(markResult!)[0]!.mark ?? 0;
  const ids = resultRows<{ id: number }>(idResult!).map((row) => row.id);
  const pageIds = ids.slice(0, pageSize);
  const total = resultRows<{ total: number }>(totalResult!)[0]!.total;
  const attendees =
    pageIds.length === 0
      ? []
      : await bookingScopedAttendeeRows(
          { attendeeIds: pageIds, kind: "attendee", listingIds },
          order,
        );
  return {
    attendees,
    lineMark: captured,
    nextAfter: ids.length > pageSize ? pageIds.at(-1)! : null,
    people: pageIds.length,
    total,
  };
};

export type ListingWithAttendeeRaw = {
  /** Every row the (person, listing) pair holds. Several can share the pair
   * (two parents, two dates), so a caller that wants one line picks the
   * first. A booking-wide caller sums them. */
  attendeeRows: Attendee[];
  listing: ListingWithCount;
};

/** Read one listing and the attendee's booking rows on it in one round-trip.
 * The attendee half is every line for THIS listing. A person booked on
 * several listings has lines per listing. The listing-scoped routes act on
 * the ones the address names, never on whichever line a scan reaches first.
 * A person with no booking on the listing reads as no rows. */
export const getListingWithAttendeeRaw = async (
  listingId: number,
  attendeeId: number,
): Promise<ListingWithAttendeeRaw | null> => {
  const results = await queryBatch([
    oneListing(listingId),
    attendeeBatchStatement({
      fields: ATTENDEE_FIELDS,
      join: "left",
      owedScope: "booking",
      where: { attendeeIds: [attendeeId], listingIds: [listingId] },
    }),
  ]);
  return withBatchListing(results[0]!, (listing) => ({
    attendeeRows: resultRows<Attendee>(results[1]!),
    listing,
  }));
};
