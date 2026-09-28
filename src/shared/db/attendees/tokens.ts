/**
 * Ticket-token lookups for attendees.
 */

import { hmacHash } from "#crypto/hashing.ts";
import type { BlindIndex, OwnerKeyEncrypted } from "#crypto/sealed.ts";
import type {
  AttendeeWithBookings,
  ListingAttendeeRow,
} from "#db/attendee-types.ts";
import { ATTENDEE_KIND } from "#db/attendees/kind.ts";
import { listingAttendeeRowColumnsFrom } from "#db/attendees/queries.ts";
import {
  pricePaidFromLedger,
  remainingBalanceFromLedger,
} from "#db/attendees/select.ts";
import { inPlaceholders, queryAll } from "#db/client.ts";
import { groupToMap, map, unique } from "#fp";

const ATTENDEE_ALIAS = "attendee";
const LISTING_ATTENDEE_ALIAS = "listingAttendee";
const listingAttendeeColumn = (name: string): string =>
  `${LISTING_ATTENDEE_ALIAS}.${name}`;

/** Shared ordering for an attendee's booking rows so grouped reads are
 * deterministic: date, then listing id. */
const BOOKING_ROWS_ORDER = `${listingAttendeeColumn("start_at")}, ${
  listingAttendeeColumn("listing_id")
}`;

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

/** Load the booking lines for a set of attendees, grouped by attendee id.
 * Callers vary only in which columns they read, any extra WHERE clause, and how
 * each row is mapped once the `attendee_id` grouping key is stripped. */
const bookingLinesByAttendeeIds = async <
  Row extends { attendee_id: number },
  Result,
>(
  attendeeIds: number[],
  columns: string,
  extraWhere: string,
  toResult: (row: Row) => Result,
): Promise<Map<number, Result[]>> => {
  const rows = await queryAll<Row>(
    `SELECT ${listingAttendeeColumn("attendee_id")}, ${columns}
     FROM listing_attendees AS ${LISTING_ATTENDEE_ALIAS}
     WHERE ${listingAttendeeColumn("attendee_id")} IN (${
      inPlaceholders(
        attendeeIds,
      )
    })${extraWhere}
     ORDER BY ${BOOKING_ROWS_ORDER}`,
    attendeeIds,
  );

  return groupToMap((row: Row) => row.attendee_id, toResult)(rows);
};

const bookingRowsByAttendeeIds = (
  attendeeIds: number[],
): Promise<Map<number, ListingAttendeeRow[]>> =>
  bookingLinesByAttendeeIds<BookingRowWithAttendee, ListingAttendeeRow>(
    attendeeIds,
    listingAttendeeRowColumnsFrom(LISTING_ATTENDEE_ALIAS),
    "",
    bookingRowWithoutAttendee,
  );

const PREVIOUS_BOOKING_LINE_COLS = `${listingAttendeeColumn("listing_id")}, ${
  listingAttendeeColumn("quantity")
}, ${
  pricePaidFromLedger(
    listingAttendeeColumn("attendee_id"),
    listingAttendeeColumn("listing_id"),
    listingAttendeeColumn("ledger_event_group"),
    listingAttendeeColumn("id"),
  )
}`;

const previousBookingLineWithoutAttendee = (
  row: RowWithAttendee<PreviousBookingLine>,
): PreviousBookingLine => ({
  listing_id: row.listing_id,
  price_paid: row.price_paid,
  quantity: row.quantity,
});

const previousBookingLinesByAttendeeIds = (
  attendeeIds: number[],
): Promise<Map<number, PreviousBookingLine[]>> =>
  bookingLinesByAttendeeIds<
    RowWithAttendee<PreviousBookingLine>,
    PreviousBookingLine
  >(
    attendeeIds,
    PREVIOUS_BOOKING_LINE_COLS,
    `\n       AND ${listingAttendeeColumn("quantity")} > 0`,
    previousBookingLineWithoutAttendee,
  );

type TokenIndexedRow = { ticket_token_index: BlindIndex };

type TokenIndexedRows<Row extends TokenIndexedRow> = {
  rows: Row[];
  tokenIndexes: BlindIndex[];
  uniqueTokens: string[];
};

const tokenIndexesFor = (tokens: string[]): Promise<BlindIndex[]> =>
  Promise.all(map((token: string) => hmacHash(token))(tokens));

const attendeeRowsForTokens = async <Row extends TokenIndexedRow>(
  tokens: string[],
  columns: string,
): Promise<TokenIndexedRows<Row>> => {
  const uniqueTokens = unique(tokens);
  const tokenIndexes = await tokenIndexesFor(uniqueTokens);
  const rows = await queryAll<Row>(
    `SELECT ${columns}
     FROM attendees AS ${ATTENDEE_ALIAS}
     WHERE ${ATTENDEE_ALIAS}.ticket_token_index IN (${
      inPlaceholders(
        tokenIndexes,
      )
    }) AND ${ATTENDEE_ALIAS}.kind = '${ATTENDEE_KIND}'`,
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

/** Turns one attendee row plus its booking lines into a caller's result shape. */
type BuildTokenResult<Row, Booking, Result> = (
  row: Row,
  bookings: Booking[],
) => Result;

/** Turn attendee rows plus their booking lines into results keyed by a row
 * value (a token index, or the attendee id itself). */
const resultsByRowKey = <Row extends { id: number }, Booking, Result, Key>(
  rows: Row[],
  keyOf: (row: Row) => Key,
  bookingsByAttendee: Map<number, Booking[]>,
  build: (row: Row, bookings: Booking[]) => Result,
): Map<Key, Result> =>
  new Map(
    rows.map((row) => [
      keyOf(row),
      build(row, bookingsByAttendee.get(row.id) ?? []),
    ]),
  );

const tokenResultMap = <Row extends TokenResultRow, Booking, Result>(
  rows: Row[],
  bookingsByAttendee: Map<number, Booking[]>,
  build: BuildTokenResult<Row, Booking, Result>,
): Map<string, Result> =>
  resultsByRowKey(
    rows,
    (row) => row.ticket_token_index,
    bookingsByAttendee,
    build,
  );

const resultsForTokens = async <Row extends TokenResultRow, Booking, Result>(
  tokens: string[],
  columns: string,
  bookingsFor: (attendeeIds: number[]) => Promise<Map<number, Booking[]>>,
  build: BuildTokenResult<Row, Booking, Result>,
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

/** The attendee columns a scan needs: identity, the token index its ticket
 * resolves by, the PII blob for the name, and the ledger balance. */
const ATTENDEE_SCAN_COLUMNS =
  `${ATTENDEE_ALIAS}.id, ${ATTENDEE_ALIAS}.created, ${ATTENDEE_ALIAS}.kind, ${ATTENDEE_ALIAS}.ticket_token_index, ${ATTENDEE_ALIAS}.pii_blob, ${ATTENDEE_ALIAS}.status_id, ${TOKEN_ATTENDEE_BALANCE}`;

type AttendeeScanRow = {
  id: number;
  created: string;
  kind: string;
  ticket_token_index: BlindIndex;
  pii_blob: OwnerKeyEncrypted;
  status_id: number | null;
  remaining_balance: number;
};

/** Assemble one attendee's full booking view from its row and lines. */
const attendeeWithBookingsBuild = (
  row: AttendeeScanRow,
  bookings: ListingAttendeeRow[],
): AttendeeWithBookings => ({
  bookings,
  created: row.created,
  id: row.id,
  kind: row.kind,
  pii_blob: row.pii_blob,
  remaining_balance: row.remaining_balance,
  status_id: row.status_id,
  ticket_token: "",
  ticket_token_index: row.ticket_token_index,
});

/**
 * Look up attendees by plaintext tokens, returning full booking data.
 * Two queries: attendees by token index, then all listing_attendees for those attendees.
 * Returns results in the same order as input tokens. Bookings sorted by
 * start_at then listing_id for deterministic ordering.
 */
export const getAttendeesByTokens = async (
  tokens: string[],
): Promise<(AttendeeWithBookings | null)[]> =>
  resultsForTokens<AttendeeScanRow, ListingAttendeeRow, AttendeeWithBookings>(
    tokens,
    ATTENDEE_SCAN_COLUMNS,
    bookingRowsByAttendeeIds,
    attendeeWithBookingsBuild,
  );

/**
 * Look up one attendee by internal id with the same full booking data the
 * token lookup returns. Backs scope-checked manual check-in picks, which
 * must never carry the ticket credential itself.
 */
export const getAttendeesByIdsWithBookings = async (
  ids: number[],
): Promise<Map<number, AttendeeWithBookings>> => {
  // The only caller looks up exactly one id; an empty list is a caller bug
  // and fails loudly in SQL rather than answering an empty map.
  const rows = await queryAll<AttendeeScanRow>(
    `SELECT ${ATTENDEE_SCAN_COLUMNS}
     FROM attendees AS ${ATTENDEE_ALIAS}
     WHERE ${ATTENDEE_ALIAS}.id IN (${
      inPlaceholders(ids)
    }) AND ${ATTENDEE_ALIAS}.kind = '${ATTENDEE_KIND}'`,
    ids,
  );
  const bookingsByAttendee = await bookingRowsByAttendeeIds(
    rows.map((row) => row.id),
  );
  return resultsByRowKey(
    rows,
    (row) => row.id,
    bookingsByAttendee,
    attendeeWithBookingsBuild,
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
