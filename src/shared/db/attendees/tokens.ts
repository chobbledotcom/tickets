/**
 * Ticket-token lookups for attendees.
 */

import { hmacHash } from "#crypto/hashing.ts";
import type { BlindIndex, OwnerKeyEncrypted } from "#crypto/sealed.ts";
import type {
  AttendeeWithBookings,
  ListingAttendeeRow,
  TokenBookingRow,
} from "#db/attendee-types.ts";
import { ATTENDEE_KIND } from "#db/attendees/kind.ts";
import { emailOwedColumn } from "#db/attendees/notification-flags.ts";
import { listingAttendeeRowColumnsFrom } from "#db/attendees/queries.ts";
import {
  pricePaidFromLedger,
  remainingBalanceFromLedger,
} from "#db/attendees/select.ts";
import { queryAll } from "#db/client.ts";
import {
  type SqlStatement,
  sql,
  sqlCommas,
  sqlList,
  sqlLiteral,
} from "#db/sql.ts";
import { groupToMap, map, unique } from "#fp";

/** Shared ordering for an attendee's booking rows so grouped reads are
 * deterministic: date, then listing id. */
const BOOKING_ROWS_ORDER = sql`listingAttendee.start_at, listingAttendee.listing_id`;

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

type BookingRowWithAttendee = TokenBookingRow & { attendee_id: number };
type RowWithAttendee<Row> = Row & { attendee_id: number };

const bookingRowWithoutAttendee = ({
  attendee_id: _attendeeId,
  ...line
}: BookingRowWithAttendee): TokenBookingRow => line;

/** Load the booking lines for a set of attendees, grouped by attendee id.
 * Callers vary only in which columns they read, any extra join, and any
 * extra WHERE clause. Each row is mapped once the `attendee_id` grouping
 * key is stripped. */
const bookingLinesByAttendeeIds = async <
  Row extends { attendee_id: number },
  Result,
>(
  attendeeIds: number[],
  columns: SqlStatement,
  joins: SqlStatement,
  extraWhere: SqlStatement,
  toResult: (row: Row) => Result,
): Promise<Map<number, Result[]>> => {
  const rows = await queryAll<Row>(
    sql`SELECT listingAttendee.attendee_id, ${columns}
     FROM listing_attendees AS listingAttendee${joins}
     WHERE listingAttendee.attendee_id IN (${sqlList(attendeeIds)})${extraWhere}
     ORDER BY ${BOOKING_ROWS_ORDER}`,
  );

  return groupToMap((row: Row) => row.attendee_id, toResult)(rows);
};

const bookingRowsByAttendeeIds = (
  attendeeIds: number[],
): Promise<Map<number, TokenBookingRow[]>> =>
  bookingLinesByAttendeeIds<BookingRowWithAttendee, TokenBookingRow>(
    attendeeIds,
    sql`${listingAttendeeRowColumnsFrom("listingAttendee")}, ${emailOwedColumn("attendee", sql`listingAttendee.listing_id`)}`,
    // The owed rule reads the attendee's flag through the same alias the
    // attendee scan uses, so the projection matches the one emailOwedColumn
    // emits everywhere else.
    sql` JOIN attendees AS attendee ON attendee.id = listingAttendee.attendee_id`,
    sql``,
    bookingRowWithoutAttendee,
  );

const PREVIOUS_BOOKING_LINE_COLS = sql`listingAttendee.listing_id, listingAttendee.quantity, ${pricePaidFromLedger(
  sql`listingAttendee.attendee_id`,
  sql`listingAttendee.listing_id`,
  sql`listingAttendee.ledger_event_group`,
  sql`listingAttendee.id`,
)}`;

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
    sql``,
    sql`\n       AND listingAttendee.quantity > 0`,
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
  columns: SqlStatement,
): Promise<TokenIndexedRows<Row>> => {
  const uniqueTokens = unique(tokens);
  const tokenIndexes = await tokenIndexesFor(uniqueTokens);
  const rows = await queryAll<Row>(
    sql`SELECT ${columns}
     FROM attendees AS attendee
     WHERE attendee.ticket_token_index IN (${sqlList(tokenIndexes)}) AND ${IS_ATTENDEE_KIND}`,
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
  columns: SqlStatement,
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

const IS_ATTENDEE_KIND = sql`attendee.kind = ${sqlLiteral(ATTENDEE_KIND)}`;

/** The attendee columns a scan needs: identity, the token index its ticket
 * resolves by, the PII blob for the name, and the ledger balance. The
 * pending-notification flags ride along with the email badge's read-time
 * rule, so the merge preview's badges resolve like every other read. */
const ATTENDEE_SCAN_COLUMNS = sqlCommas([
  sql`attendee.id`,
  sql`attendee.created`,
  sql`attendee.kind`,
  sql`attendee.ticket_token_index`,
  sql`attendee.pii_blob`,
  sql`attendee.status_id`,
  remainingBalanceFromLedger(sql`attendee.id`),
  sql`attendee.email_pending`,
  sql`attendee.webhooks_pending`,
  emailOwedColumn("attendee"),
]);

type AttendeeScanRow = {
  id: number;
  created: string;
  kind: string;
  ticket_token_index: BlindIndex;
  pii_blob: OwnerKeyEncrypted;
  status_id: number | null;
  remaining_balance: number;
  email_pending: number;
  webhooks_pending: number;
  email_owed: number;
};

/** Assemble one attendee's full booking view from its row and lines. */
const attendeeWithBookingsBuild = (
  row: AttendeeScanRow,
  bookings: TokenBookingRow[],
): AttendeeWithBookings => ({
  bookings,
  created: row.created,
  email_owed: row.email_owed,
  email_pending: row.email_pending,
  id: row.id,
  kind: row.kind,
  pii_blob: row.pii_blob,
  remaining_balance: row.remaining_balance,
  status_id: row.status_id,
  ticket_token: "",
  ticket_token_index: row.ticket_token_index,
  webhooks_pending: row.webhooks_pending,
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
  resultsForTokens<AttendeeScanRow, TokenBookingRow, AttendeeWithBookings>(
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
  // The only caller looks up exactly one id. An empty list is a caller bug
  // and fails loudly in SQL rather than answering an empty map.
  const rows = await queryAll<AttendeeScanRow>(
    sql`SELECT ${ATTENDEE_SCAN_COLUMNS}
     FROM attendees AS attendee
     WHERE attendee.id IN (${sqlList(ids)}) AND ${IS_ATTENDEE_KIND}`,
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
    sql`attendee.id, attendee.created, attendee.ticket_token_index, attendee.status_id`,
    previousBookingLinesByAttendeeIds,
    (row, bookings): AttendeeBookingRows => ({
      bookings,
      created: row.created,
      id: row.id,
      status_id: row.status_id,
    }),
  );
};
