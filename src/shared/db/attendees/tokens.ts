/**
 * Ticket-token lookups for attendees.
 */

import { groupToMap, map, unique } from "#fp";
import { computeTicketTokenIndex } from "#shared/crypto/hashing.ts";
import type { BlindIndex, OwnerKeyEncrypted } from "#shared/crypto/sealed.ts";
import type {
  AttendeeWithBookings,
  ListingAttendeeRow,
} from "#shared/db/attendee-types.ts";
import { ATTENDEE_KIND } from "#shared/db/attendees/kind.ts";
import {
  listingAttendeeRowColumnsFrom,
  pricePaidFromLedger,
  remainingBalanceFromLedger,
} from "#shared/db/attendees/queries.ts";
import { inPlaceholders, queryAll } from "#shared/db/client.ts";

const ATTENDEE_ALIAS = "attendee";
const LISTING_ATTENDEE_ALIAS = "listingAttendee";
const listingAttendeeColumn = (name: string): string =>
  `${LISTING_ATTENDEE_ALIAS}.${name}`;

/** Shared ordering for an attendee's booking rows so grouped reads are
 * deterministic: date, then listing id. */
const BOOKING_ROWS_ORDER = `${listingAttendeeColumn("start_at")}, ${listingAttendeeColumn("listing_id")}`;

/** PII-free booking rows for a token-resolved attendee. */
export type AttendeeBookingRows = {
  id: number;
  created: string;
  status_id: number | null;
  bookings: PreviousBookingLine[];
};

/** The only booking-line fields the Previous bookings panel needs. */
type PreviousBookingLine = Pick<
  ListingAttendeeRow,
  "listing_id" | "quantity" | "price_paid"
>;

type BookingRowWithAttendee = ListingAttendeeRow & { attendee_id: number };
type RowWithAttendee<Row> = Row & { attendee_id: number };

const bookingRowWithoutAttendee = (
  row: BookingRowWithAttendee,
): ListingAttendeeRow => ({
  attachment_downloads: row.attachment_downloads,
  checked_in: row.checked_in,
  end_at: row.end_at,
  ledger_event_group: row.ledger_event_group,
  listing_id: row.listing_id,
  order_token: row.order_token,
  package_group_id: row.package_group_id,
  parent_listing_id: row.parent_listing_id,
  price_paid: row.price_paid,
  quantity: row.quantity,
  refunded: row.refunded,
  start_at: row.start_at,
});

const bookingRowsByAttendeeIds = async (
  attendeeIds: number[],
): Promise<Map<number, ListingAttendeeRow[]>> => {
  const attendeePlaceholders = inPlaceholders(attendeeIds);
  const rows = await queryAll<BookingRowWithAttendee>(
    `SELECT ${listingAttendeeColumn("attendee_id")}, ${listingAttendeeRowColumnsFrom(
      LISTING_ATTENDEE_ALIAS,
    )}
     FROM listing_attendees AS ${LISTING_ATTENDEE_ALIAS}
     WHERE ${listingAttendeeColumn("attendee_id")} IN (${attendeePlaceholders})
     ORDER BY ${BOOKING_ROWS_ORDER}`,
    attendeeIds,
  );

  return groupToMap(
    (row: BookingRowWithAttendee) => row.attendee_id,
    bookingRowWithoutAttendee,
  )(rows);
};

const PREVIOUS_BOOKING_LINE_COLS = `${listingAttendeeColumn("listing_id")}, ${listingAttendeeColumn("quantity")}, ${pricePaidFromLedger(
  listingAttendeeColumn("attendee_id"),
  listingAttendeeColumn("listing_id"),
  listingAttendeeColumn("ledger_event_group"),
  listingAttendeeColumn("id"),
)}`;

const previousBookingLineWithoutAttendee = (
  row: RowWithAttendee<PreviousBookingLine>,
): PreviousBookingLine => ({
  listing_id: row.listing_id,
  price_paid: row.price_paid,
  quantity: row.quantity,
});

const previousBookingLinesByAttendeeIds = async (
  attendeeIds: number[],
): Promise<Map<number, PreviousBookingLine[]>> => {
  const attendeePlaceholders = inPlaceholders(attendeeIds);
  const rows = await queryAll<RowWithAttendee<PreviousBookingLine>>(
    `SELECT ${listingAttendeeColumn("attendee_id")}, ${PREVIOUS_BOOKING_LINE_COLS}
     FROM listing_attendees AS ${LISTING_ATTENDEE_ALIAS}
     WHERE ${listingAttendeeColumn("attendee_id")} IN (${attendeePlaceholders})
       AND ${listingAttendeeColumn("quantity")} > 0
     ORDER BY ${BOOKING_ROWS_ORDER}`,
    attendeeIds,
  );

  return groupToMap(
    (row: RowWithAttendee<PreviousBookingLine>) => row.attendee_id,
    previousBookingLineWithoutAttendee,
  )(rows);
};

type TokenIndexedRow = { ticket_token_index: BlindIndex };

type TokenIndexedRows<Row extends TokenIndexedRow> = {
  rows: Row[];
  tokenIndexes: BlindIndex[];
  uniqueTokens: string[];
};

const tokenIndexesFor = (tokens: string[]): Promise<BlindIndex[]> =>
  Promise.all(map((token: string) => computeTicketTokenIndex(token))(tokens));

const attendeeRowsForTokens = async <Row extends TokenIndexedRow>(
  tokens: string[],
  columns: string,
): Promise<TokenIndexedRows<Row>> => {
  const uniqueTokens = unique(tokens);
  const tokenIndexes = await tokenIndexesFor(uniqueTokens);
  const rows = await queryAll<Row>(
    `SELECT ${columns}
     FROM attendees AS ${ATTENDEE_ALIAS}
     WHERE ${ATTENDEE_ALIAS}.ticket_token_index IN (${inPlaceholders(
       tokenIndexes,
     )}) AND ${ATTENDEE_ALIAS}.kind = '${ATTENDEE_KIND}'`,
    tokenIndexes,
  );
  return { rows, tokenIndexes, uniqueTokens };
};

const resultsInTokenOrder = <Result>(
  tokens: string[],
  uniqueTokens: string[],
  tokenIndexes: BlindIndex[],
  byTokenIndex: Map<string, Result>,
): (Result | null)[] => {
  const tokenToResult = new Map(
    uniqueTokens.map((token, index) => [
      token,
      byTokenIndex.get(tokenIndexes[index]!) ?? null,
    ]),
  );
  return tokens.map((token) => tokenToResult.get(token) ?? null);
};

type TokenResultRow = { id: number } & TokenIndexedRow;

const tokenResultMap = <Row extends TokenResultRow, Booking, Result>(
  rows: Row[],
  bookingsByAttendee: Map<number, Booking[]>,
  build: (row: Row, bookings: Booking[]) => Result,
): Map<string, Result> =>
  new Map(
    rows.map((row) => [
      row.ticket_token_index,
      build(row, bookingsByAttendee.get(row.id) ?? []),
    ]),
  );

const resultsForTokens = async <Row extends TokenResultRow, Booking, Result>(
  tokens: string[],
  columns: string,
  bookingsFor: (attendeeIds: number[]) => Promise<Map<number, Booking[]>>,
  build: (row: Row, bookings: Booking[]) => Result,
): Promise<(Result | null)[]> => {
  if (tokens.length === 0) return [];
  const {
    rows: attendeeRows,
    tokenIndexes,
    uniqueTokens,
  } = await attendeeRowsForTokens<Row>(tokens, columns);
  if (attendeeRows.length === 0) return tokens.map(() => null);

  const bookingsByAttendee = await bookingsFor(
    attendeeRows.map((row) => row.id),
  );
  return resultsInTokenOrder(
    tokens,
    uniqueTokens,
    tokenIndexes,
    tokenResultMap(attendeeRows, bookingsByAttendee, build),
  );
};

const TOKEN_ATTENDEE_BALANCE = remainingBalanceFromLedger(
  `${ATTENDEE_ALIAS}.id`,
);

/**
 * Look up attendees by plaintext tokens, returning full booking data.
 * Two queries: attendees by token index, then all listing_attendees for those attendees.
 * Returns results in the same order as input tokens. Bookings sorted by
 * start_at then listing_id for deterministic ordering.
 */
export const getAttendeesByTokens = async (
  tokens: string[],
): Promise<(AttendeeWithBookings | null)[]> => {
  type AttendeeBase = {
    id: number;
    created: string;
    kind: string;
    ticket_token_index: BlindIndex;
    pii_blob: OwnerKeyEncrypted;
    status_id: number | null;
    remaining_balance: number;
  };

  return resultsForTokens<
    AttendeeBase,
    ListingAttendeeRow,
    AttendeeWithBookings
  >(
    tokens,
    `${ATTENDEE_ALIAS}.id, ${ATTENDEE_ALIAS}.created, ${ATTENDEE_ALIAS}.kind, ${ATTENDEE_ALIAS}.ticket_token_index, ${ATTENDEE_ALIAS}.pii_blob, ${ATTENDEE_ALIAS}.status_id, ${TOKEN_ATTENDEE_BALANCE}`,
    bookingRowsByAttendeeIds,
    (row, bookings): AttendeeWithBookings => ({
      bookings,
      created: row.created,
      id: row.id,
      kind: row.kind,
      pii_blob: row.pii_blob,
      remaining_balance: row.remaining_balance,
      status_id: row.status_id,
      ticket_token: "",
      ticket_token_index: row.ticket_token_index,
    }),
  );
};

/**
 * Look up attendees by plaintext tokens for the Previous bookings table.
 *
 * This deliberately does not select `pii_blob`: the panel needs only attendee
 * ids, created dates, statuses and real booking rows.
 */
export const getAttendeeBookingRowsByTokens = async (
  tokens: string[],
): Promise<(AttendeeBookingRows | null)[]> => {
  type AttendeeRow = Omit<AttendeeBookingRows, "bookings"> & TokenIndexedRow;

  return resultsForTokens<
    AttendeeRow,
    PreviousBookingLine,
    AttendeeBookingRows
  >(
    tokens,
    `${ATTENDEE_ALIAS}.id, ${ATTENDEE_ALIAS}.created, ${ATTENDEE_ALIAS}.ticket_token_index, ${ATTENDEE_ALIAS}.status_id`,
    previousBookingLinesByAttendeeIds,
    (row, bookings): AttendeeBookingRows => ({
      bookings,
      created: row.created,
      id: row.id,
      status_id: row.status_id,
    }),
  );
};
