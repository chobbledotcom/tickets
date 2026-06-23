/**
 * Read queries for attendees and their per-listing bookings.
 */

import { map, unique } from "#fp";
import {
  accountPredicate,
  attendeeOwedSubquery,
  sumAmountFromTransfers,
} from "#shared/accounting/projection-sql.ts";
import { computeTicketTokenIndex } from "#shared/crypto/hashing.ts";
import type {
  AttendeeWithBookings,
  ListingAttendeeRow,
} from "#shared/db/attendee-types.ts";
import {
  decryptAttendeeFields,
  decryptPiiBlob,
} from "#shared/db/attendees/pii.ts";
import {
  inPlaceholders,
  queryAll,
  queryOne,
  rowExists,
} from "#shared/db/client.ts";
import { nameMapByIds } from "#shared/db/query.ts";
import type { Attendee } from "#shared/types.ts";

/**
 * Order-level refund status, projected from the transfers ledger rather than a
 * stored column: an attendee is refunded iff a `refund_cash` leg sourced from
 * their account exists (a refund reverses the booking's payment leg into a
 * `refund_cash` leg whose SOURCE is the attendee — both live and backfilled
 * historical refunds set this). Returns 0/1 aliased `refunded`, matching the
 * `number` shape the booking row type carries. A LEFT JOIN with no matching
 * `listing_attendees` row has `ea.attendee_id` NULL, so the EXISTS is false (0).
 */
const refundedFromLedger = (attendeeIdExpr: string): string =>
  `(SELECT EXISTS(SELECT 1 FROM transfers WHERE kind = 'refund_cash'` +
  ` AND ${accountPredicate("source", "attendee", attendeeIdExpr)})) AS refunded`;

/**
 * Per-row amount paid, projected from the ledger instead of a stored column: the
 * gross `sale` leg this booking row recognised — `kind='sale'`, billed from the
 * attendee to the listing's revenue account, within the row's stored
 * `ledger_event_group` (so an attendee holding several orders for one listing
 * resolves to exactly this booking's leg). A site has one currency, so amounts
 * sum directly. Equals the dropped `price_paid` column for a fully-paid booking
 * (every production booking) and stays put after a refund (the reversal is a
 * separate `refund_*` leg). 0 when the row has no sale leg — a free or
 * provider-less-owed booking, or an unmatched LEFT JOIN row (NULL ids/group match
 * nothing). `eventGroupExpr` is the row's `ledger_event_group` column.
 */
export const pricePaidFromLedger = (
  attendeeIdExpr: string,
  listingIdExpr: string,
  eventGroupExpr: string,
): string =>
  sumAmountFromTransfers(
    `kind = 'sale'` +
      ` AND ${accountPredicate("source", "attendee", attendeeIdExpr)}` +
      ` AND ${accountPredicate("dest", "revenue", listingIdExpr)}` +
      ` AND event_group = ${eventGroupExpr}`,
    "price_paid",
  );

/**
 * An attendee's outstanding balance, projected from the ledger instead of a
 * stored column: the negated account balance — what they still owe is the money
 * they were billed (sale legs sourced from them) minus the cash received (deposit
 * and balance-payment legs into them), with a refund's reversal legs netting back
 * out. 0 for a fully-paid booking (every production attendee) and for an attendee
 * with no legs. `attendeeIdExpr` is the attendee id in the surrounding query.
 */
export const remainingBalanceFromLedger = (attendeeIdExpr: string): string =>
  `${attendeeOwedSubquery(attendeeIdExpr)} AS remaining_balance`;

/**
 * Attendee columns for JOIN queries — only the columns actually used at runtime.
 * All PII is read from the encrypted pii_blob; per-listing status lives on
 * listing_attendees. `remaining_balance` projects from the ledger like the others.
 */
const ATTENDEE_COLS = `a.id, a.created, a.ticket_token_index, a.pii_blob, a.status_id, ${remainingBalanceFromLedger(
  "a.id",
)}, a.split_logistics_agents`;

/** The two ledger-projected money columns (refunded flag + per-row amount paid)
 *  for a listing_attendees row reached through the `ea` alias. Shared by the
 *  INNER and LEFT JOIN selects so the projections never drift apart. */
const EA_LEDGER_MONEY_COLS = `${refundedFromLedger("ea.attendee_id")}, ${pricePaidFromLedger(
  "ea.attendee_id",
  "ea.listing_id",
  "ea.ledger_event_group",
)}`;

/** Columns sourced from listing_attendees (per-listing data) */
const EA_COLS = `ea.listing_id, SUBSTR(ea.start_at, 1, 10) as date, SUBSTR(ea.end_at, 1, 10) as end_date, ea.quantity, ea.checked_in, ${EA_LEDGER_MONEY_COLS}, ea.attachment_downloads`;

/** SELECT clause for attendee + listing_attendees JOINs (INNER JOIN context).
 * Derives `date` from start_at for the Attendee type shape. */
export const ATTENDEE_JOIN_SELECT = `${ATTENDEE_COLS}, ${EA_COLS}`;

/** SELECT clause for LEFT JOIN context — COALESCEs nullable join columns so
 * attendees with broken/missing listing_attendees linkage still appear in results
 * (with listing_id=0 as an obvious corruption indicator). */
export const ATTENDEE_LEFT_JOIN_SELECT = `${ATTENDEE_COLS}, COALESCE(ea.listing_id, 0) as listing_id, SUBSTR(ea.start_at, 1, 10) as date, SUBSTR(ea.end_at, 1, 10) as end_date, COALESCE(ea.quantity, 0) as quantity, COALESCE(ea.checked_in, 0) as checked_in, ${EA_LEDGER_MONEY_COLS}, COALESCE(ea.attachment_downloads, 0) as attachment_downloads`;

/**
 * Columns for a `ListingAttendeeRow` read straight from `listing_attendees`
 * (no attendee join) — every helper that loads an attendee's own booking rows
 * shares this list so the ledger-fed `refunded` projection is identical across
 * them. The bare `attendee_id` column feeds the correlated refund subquery.
 */
export const LISTING_ATTENDEE_ROW_COLS = `listing_id, start_at, end_at, quantity, checked_in, ${refundedFromLedger(
  "attendee_id",
)}, ${pricePaidFromLedger(
  "attendee_id",
  "listing_id",
  "ledger_event_group",
)}, ledger_event_group, attachment_downloads`;

/**
 * Get attendees for an listing without decrypting PII
 * Used for tests and operations that don't need decrypted data
 */
export const getAttendeesRaw = (listingId: number): Promise<Attendee[]> =>
  queryAll<Attendee>(
    `SELECT ${ATTENDEE_JOIN_SELECT}
     FROM attendees a
     JOIN listing_attendees ea ON ea.attendee_id = a.id
     WHERE ea.listing_id = ?
     ORDER BY a.created DESC`,
    [listingId],
  );

/**
 * Get the newest attendees across all listings without decrypting PII.
 * Used for the admin dashboard to show recent registrations.
 */
export const getNewestAttendeesRaw = (limit: number): Promise<Attendee[]> =>
  // Order by a.id DESC, not a.created: id is AUTOINCREMENT so it is
  // co-monotonic with created (newest attendee = highest id), but ordering by
  // the rowid drives the scan off the primary key with no sort over the whole
  // (unbounded) attendees table.
  queryAll<Attendee>(
    `SELECT ${ATTENDEE_LEFT_JOIN_SELECT}
     FROM attendees a
     LEFT JOIN listing_attendees ea ON ea.attendee_id = a.id
     ORDER BY a.id DESC LIMIT ?`,
    [limit],
  );

/** Sort order for the admin attendees browser */
export type AttendeeSort = "newest" | "oldest";

/**
 * Attendee rows per page in the admin attendees browser. Fixed here so the
 * page size is never derived from the request — callers choose only the page.
 */
export const ATTENDEES_PAGE_SIZE = 100;

/** One page of attendee rows, plus whether a further page exists */
export type AttendeesPage = {
  rows: Attendee[];
  hasNext: boolean;
};

/**
 * Get one page of attendee+booking rows for the admin attendees browser.
 *
 * Returns one row per (attendee, listing) booking, ordered by attendee id —
 * newest or oldest first. id is AUTOINCREMENT, so it is co-monotonic with the
 * registration date but unique, making paging deterministic and index-backed
 * (no sort over the whole attendees table). When `listingId` is given, only
 * that listing's bookings are returned; otherwise every booking is included.
 *
 * The page size is fixed; callers pass a zero-based `page`. One extra row is
 * read to report `hasNext` without a separate count query, then trimmed off.
 * PII stays encrypted — decrypt with decryptAttendees before display.
 */
export const getAttendeesPage = async ({
  listingIds,
  sort,
  page,
}: {
  /** Restrict to these listings (a single selected listing, or every listing of
   * a chosen type); null is the unfiltered "all listings" view. */
  listingIds: number[] | null;
  sort: AttendeeSort;
  page: number;
}): Promise<AttendeesPage> => {
  // An empty filter set matches nothing — e.g. a type with no listings yet.
  if (listingIds?.length === 0) return { hasNext: false, rows: [] };
  // `dir` is derived from the AttendeeSort enum and the WHERE clause is fixed
  // text, so neither is user-controlled — only the bound args are.
  const dir = sort === "oldest" ? "ASC" : "DESC";
  const where = listingIds
    ? `WHERE ea.listing_id IN (${inPlaceholders(listingIds)})`
    : "";
  const limit = ATTENDEES_PAGE_SIZE + 1;
  const offset = page * ATTENDEES_PAGE_SIZE;
  const args = listingIds ? [...listingIds, limit, offset] : [limit, offset];
  const rows = await queryAll<Attendee>(
    `SELECT ${ATTENDEE_JOIN_SELECT}
     FROM attendees a
     JOIN listing_attendees ea ON ea.attendee_id = a.id
     ${where}
     ORDER BY a.id ${dir}
     LIMIT ? OFFSET ?`,
    args,
  );
  const hasNext = rows.length > ATTENDEES_PAGE_SIZE;
  return { hasNext, rows: hasNext ? rows.slice(0, ATTENDEES_PAGE_SIZE) : rows };
};

/**
 * Get every attendee's encrypted PII blob (one row per attendee).
 * Used to resolve bulk-email recipient lists, where only the email inside each
 * blob is needed. De-duplication of addresses happens after decryption.
 */
export const getAllAttendeePiiBlobs = async (): Promise<string[]> => {
  // Restrict the "all attendees" bulk-email audience to attendees with ≥1 real
  // (quantity > 0) line, so a no-quantity-only attendee (an interested/cancelled
  // placeholder) isn't emailed — its ticket URL would 404.
  const rows = await queryAll<{ pii_blob: string }>(
    `SELECT pii_blob FROM attendees
     WHERE EXISTS (
       SELECT 1 FROM listing_attendees
       WHERE attendee_id = attendees.id AND quantity > 0
     )`,
  );
  return rows.map((r) => r.pii_blob);
};

/**
 * Get the encrypted PII blobs for attendees booked onto any of the given
 * listings (one row per attendee, even if booked onto several of them).
 * Returns an empty array when no listing IDs are supplied.
 */
export const getAttendeePiiBlobsForListings = async (
  listingIds: number[],
): Promise<string[]> => {
  if (listingIds.length === 0) return [];
  const rows = await queryAll<{ pii_blob: string }>(
    // quantity > 0: only attendees with a real line on these listings — a
    // no-quantity sentinel line doesn't make someone an "attendee of X".
    `SELECT pii_blob FROM attendees
     WHERE id IN (
       SELECT DISTINCT attendee_id FROM listing_attendees
       WHERE listing_id IN (${inPlaceholders(listingIds)}) AND quantity > 0
     )`,
    listingIds,
  );
  return rows.map((r) => r.pii_blob);
};

/**
 * Get the encrypted PII blob for the attendee identified by a plaintext ticket
 * token. Used to resolve a single-attendee bulk-email recipient. Ticket tokens
 * are unique, so this matches at most one attendee; returns null when the token
 * matches none, so a stale or unknown token resolves to no recipient rather
 * than erroring.
 */
export const getAttendeePiiBlobForToken = async (
  token: string,
): Promise<string | null> => {
  const tokenIndex = await computeTicketTokenIndex(token);
  // Apply the real-line guard: an all-ghost (no-quantity-only) attendee has no
  // valid ticket URL, so the single-attendee bulk-email target resolves to no
  // recipient (a genuine one-off transactional mail would be a separate path).
  const row = await queryOne<{ pii_blob: string }>(
    `SELECT pii_blob FROM attendees
     WHERE ticket_token_index = ?
       AND EXISTS (
         SELECT 1 FROM listing_attendees
         WHERE attendee_id = attendees.id AND quantity > 0
       )
     LIMIT 1`,
    [tokenIndex],
  );
  return row ? row.pii_blob : null;
};

/**
 * True when the attendee has a real (quantity > 0) booking on the exact listing.
 * Authorizes per-(attendee, listing) actions — e.g. the signed attachment
 * download — against the EXACT row, not getAttendeeRaw's arbitrary left-joined
 * sibling row (which for a mixed attendee could pass on a ghost/other-listing
 * row, or wrongly reject a valid real-line download). A no-quantity sentinel
 * line is excluded, so a line later marked no-quantity stops authorizing.
 */
export const hasActiveBookingLine = (
  attendeeId: number,
  listingId: number,
): Promise<boolean> =>
  rowExists(
    `SELECT 1 FROM listing_attendees
     WHERE attendee_id = ? AND listing_id = ? AND quantity > 0 LIMIT 1`,
    [attendeeId, listingId],
  );

/**
 * True when any of the listings has a paid line for this attendee — a gross
 * `sale` leg in the row's ledger_event_group (a sale leg's amount is always > 0,
 * so its existence is exactly a non-zero projected price_paid; a refund keeps the
 * gross leg, so a refunded line still reads as paid). One query over all the IDs,
 * read from the live ledger rather than the edit form's submitted key (a
 * stale/missing key can leave it null), so a recorded payment is never dropped
 * onto a fresh quantity-0 row. Callers pass a non-empty list.
 */
export const hasPaidLine = (
  attendeeId: number,
  listingIds: number[],
): Promise<boolean> =>
  rowExists(
    `SELECT 1 FROM listing_attendees la
     WHERE la.attendee_id = ? AND la.listing_id IN (${inPlaceholders(listingIds)})
       AND EXISTS (
         SELECT 1 FROM transfers
         WHERE kind = 'sale'
           AND ${accountPredicate("source", "attendee", "la.attendee_id")}
           AND ${accountPredicate("dest", "revenue", "la.listing_id")}
           AND event_group = la.ledger_event_group
       ) LIMIT 1`,
    [attendeeId, ...listingIds],
  );

/**
 * Get an attendee by ID without decrypting PII
 * Used for payment callbacks and webhooks where decryption is not needed
 * Returns the attendee with encrypted fields (id, listing_id, quantity are plaintext)
 */
export const getAttendeeRaw = (id: number): Promise<Attendee | null> => {
  return queryOne<Attendee>(
    `SELECT ${ATTENDEE_LEFT_JOIN_SELECT}
     FROM attendees a
     LEFT JOIN listing_attendees ea ON ea.attendee_id = a.id
     WHERE a.id = ?`,
    [id],
  );
};

/**
 * Get attendees by ID without decrypting PII, one row per (attendee, booking).
 * Used by the agent run sheet, which already knows the attendee ids it needs
 * and only reads each attendee's contact fields. Returns an empty array for no
 * ids. Decrypt with decryptAttendees before display.
 */
export const getAttendeesByIds = (ids: number[]): Promise<Attendee[]> => {
  if (ids.length === 0) return Promise.resolve([]);
  return queryAll<Attendee>(
    `SELECT ${ATTENDEE_LEFT_JOIN_SELECT}
     FROM attendees a
     LEFT JOIN listing_attendees ea ON ea.attendee_id = a.id
     WHERE a.id IN (${inPlaceholders(ids)})`,
    ids,
  );
};

/**
 * Bounded id → name lookup for the given attendees, decrypting only the name
 * from each PII blob with the owner private key (no booking join, one row per
 * attendee). Empty ids ⇒ empty map. Used for link labels in the activity log;
 * a deleted attendee's id simply has no entry.
 */
export const getAttendeeNamesByIds = (
  ids: number[],
  privateKey: CryptoKey,
): Promise<Map<number, string>> =>
  nameMapByIds(
    "attendees",
    "attendee",
    "pii_blob",
    ids,
    async (raw: string) => (await decryptPiiBlob(raw, privateKey, false)).name,
  );

/**
 * Get an attendee by ID (decrypted)
 * Requires private key for decryption - only available to authenticated sessions
 */
export const getAttendee = async (
  id: number,
  privateKey: CryptoKey,
): Promise<Attendee | null> => {
  const row = await getAttendeeRaw(id);
  return row ? decryptAttendeeFields(row, privateKey) : null;
};

/**
 * Look up attendees by plaintext tokens, returning full booking data.
 * Two queries: attendees by token index, then all listing_attendees for those attendees.
 * Returns results in the same order as input tokens (deduped). Bookings sorted
 * by start_at then listing_id for deterministic ordering.
 */
export const getAttendeesByTokens = async (
  tokens: string[],
): Promise<(AttendeeWithBookings | null)[]> => {
  // Dedupe tokens to prevent double processing
  const uniqueTokens = unique(tokens);
  const tokenIndexes = await Promise.all(
    map((t: string) => computeTicketTokenIndex(t))(uniqueTokens),
  );

  // Query 1: Get attendee base rows (no listing join)
  type AttendeeBase = {
    id: number;
    created: string;
    ticket_token_index: string;
    pii_blob: string;
    status_id: number | null;
    remaining_balance: number;
  };
  const attendeeRows = await queryAll<AttendeeBase>(
    `SELECT id, created, ticket_token_index, pii_blob, status_id, ${remainingBalanceFromLedger(
      "attendees.id",
    )}
     FROM attendees WHERE ticket_token_index IN (${inPlaceholders(
       tokenIndexes,
     )})`,
    tokenIndexes,
  );

  if (attendeeRows.length === 0) {
    return tokens.map(() => null);
  }

  // Query 2: Get all listing links for these attendees
  const attendeeIds = attendeeRows.map((a) => a.id);
  const bookingRows = await queryAll<
    ListingAttendeeRow & { attendee_id: number }
  >(
    `SELECT attendee_id, ${LISTING_ATTENDEE_ROW_COLS}
     FROM listing_attendees WHERE attendee_id IN (${inPlaceholders(
       attendeeIds,
     )})
     ORDER BY start_at, listing_id`,
    attendeeIds,
  );

  // Group bookings by attendee_id
  const bookingsByAttendee = new Map<number, ListingAttendeeRow[]>();
  for (const row of bookingRows) {
    const list = bookingsByAttendee.get(row.attendee_id) ?? [];
    list.push({
      attachment_downloads: row.attachment_downloads,
      checked_in: row.checked_in,
      end_at: row.end_at,
      ledger_event_group: row.ledger_event_group,
      listing_id: row.listing_id,
      price_paid: row.price_paid,
      quantity: row.quantity,
      refunded: row.refunded,
      start_at: row.start_at,
    });
    bookingsByAttendee.set(row.attendee_id, list);
  }

  // Build AttendeeWithBookings map by token index
  const byTokenIndex = new Map<string, AttendeeWithBookings>();
  for (const row of attendeeRows) {
    byTokenIndex.set(row.ticket_token_index, {
      bookings: bookingsByAttendee.get(row.id) ?? [],
      created: row.created,
      id: row.id,
      pii_blob: row.pii_blob,
      remaining_balance: row.remaining_balance,
      status_id: row.status_id,
      ticket_token: "", // populated after decryption by caller
      ticket_token_index: row.ticket_token_index,
    });
  }

  // Return in original token order (before dedup) using the unique index mapping
  const indexToResult = new Map(
    uniqueTokens.map((t, i) => [t, byTokenIndex.get(tokenIndexes[i]!) ?? null]),
  );
  return tokens.map((t) => indexToResult.get(t) ?? null);
};
