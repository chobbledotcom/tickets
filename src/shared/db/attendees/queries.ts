/**
 * Read queries for attendees and their per-listing bookings.
 */

import * as v from "valibot";
import { map, unique } from "#fp";
import { ATTENDEE } from "#shared/accounting/accounts.ts";
import { KIND } from "#shared/accounting/kinds.ts";
import {
  accountPredicate,
  attendeeOwedSubquery,
  saleLegPredicate,
} from "#shared/accounting/projection-sql.ts";
import { computeTicketTokenIndex } from "#shared/crypto/hashing.ts";
import type { BlindIndex, OwnerKeyEncrypted } from "#shared/crypto/sealed.ts";
import type {
  AttendeeWithBookings,
  ListingAttendeeRow,
} from "#shared/db/attendee-types.ts";
import { ATTENDEE_KIND } from "#shared/db/attendees/kind.ts";
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
import { guardFor } from "#shared/validation/guard.ts";

/**
 * Order-level refund status, projected from the transfers ledger rather than a
 * stored column: an attendee is refunded iff a `refund_cash` leg sourced from
 * their account exists (a refund reverses the booking's payment leg into a
 * `refund_cash` leg whose SOURCE is the attendee — both live and backfilled
 * historical refunds set this). Returns 0/1 aliased `refunded`, matching the
 * `number` shape the booking row type carries. A LEFT JOIN with no matching
 * `listing_attendees` row has `listingAttendee.attendee_id` NULL, so the EXISTS is false (0).
 */
const refundedFromLedger = (attendeeIdExpr: string): string =>
  `(SELECT EXISTS(SELECT 1 FROM transfers WHERE kind = '${KIND.refundCash}'` +
  ` AND ${accountPredicate("source", ATTENDEE, attendeeIdExpr)})) AS refunded`;

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
 * nothing).
 *
 * A booking's `sale` leg is posted once per listing, but a child that folds under
 * several parents — or folds AND keeps a standalone remainder — turns one order
 * into several `listing_attendees` rows sharing that single `(attendee, listing,
 * event_group)` leg. Crediting the whole leg to each row would double-count the
 * child on any summed readback, so the leg is split across those rows in QUANTITY
 * proportion, deterministically by row id: each row takes `floor(total *
 * qtyThroughThisRow / totalQty) − floor(total * qtyBeforeThisRow / totalQty)`.
 * Those shares telescope to the full leg with no penny lost, and collapse to the
 * whole leg for the ordinary one-row-per-listing case. `rowIdExpr` is the row's
 * own `id`; all four expressions MUST be qualified (they seed correlated
 * subqueries whose inner `sibling` alias would otherwise shadow a bare column).
 *
 * The same split covers a listing booked through two order paths (a package
 * member row beside its standalone row). When those paths priced differently,
 * the quantity split AVERAGES the rows — the leg carries no per-path key to do
 * better with (see the per-path TODO entry). Sums over the order stay exact.
 */
export const pricePaidFromLedger = (
  attendeeIdExpr: string,
  listingIdExpr: string,
  eventGroupExpr: string,
  rowIdExpr: string,
): string => {
  const saleTotal = `(SELECT COALESCE(SUM(amount), 0) FROM transfers WHERE ${saleLegPredicate(
    attendeeIdExpr,
    listingIdExpr,
    eventGroupExpr,
  )})`;
  const siblingQty = (idBound: string): string =>
    "(SELECT COALESCE(SUM(sibling.quantity), 0) FROM listing_attendees AS sibling" +
    ` WHERE sibling.attendee_id = ${attendeeIdExpr}` +
    ` AND sibling.listing_id = ${listingIdExpr}` +
    ` AND sibling.ledger_event_group = ${eventGroupExpr}${idBound})`;
  const through = siblingQty(` AND sibling.id <= ${rowIdExpr}`);
  const before = siblingQty(` AND sibling.id < ${rowIdExpr}`);
  // NULLIF guards the divide when no sibling has quantity (a lone no-quantity
  // sentinel, or an unmatched LEFT JOIN row); COALESCE then floors the NULL that
  // divide yields back to 0 so `price_paid` is always a number.
  const totalQty = `NULLIF(${siblingQty("")}, 0)`;
  return (
    `COALESCE(CAST(${saleTotal} * ${through} / ${totalQty} AS INTEGER)` +
    ` - CAST(${saleTotal} * ${before} / ${totalQty} AS INTEGER), 0) AS price_paid`
  );
};

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
const ATTENDEE_COLS = `attendee.id, attendee.created, attendee.kind, attendee.ticket_token_index, attendee.pii_blob, attendee.status_id, ${remainingBalanceFromLedger(
  "attendee.id",
)}, attendee.split_logistics_agents`;

/** The two ledger-projected money columns (refunded flag + per-row amount paid)
 *  for a listing_attendees row reached through the `ea` alias. Shared by the
 *  INNER and LEFT JOIN selects so the projections never drift apart. */
const EA_LEDGER_MONEY_COLS = `${refundedFromLedger(
  "listingAttendee.attendee_id",
)}, ${pricePaidFromLedger(
  "listingAttendee.attendee_id",
  "listingAttendee.listing_id",
  "listingAttendee.ledger_event_group",
  "listingAttendee.id",
)}`;

/** Columns sourced from listing_attendees (per-listing data). `package_group_id`
 * rides along so an attendee loaded through a join still knows its package
 * membership — without it the email/webhook renderers treat a hidden package
 * booking as a standalone member and can leak the hidden listing or its base
 * price. */
const EA_COLS = `listingAttendee.listing_id, SUBSTR(listingAttendee.start_at, 1, 10) as date, SUBSTR(listingAttendee.end_at, 1, 10) as end_date, listingAttendee.quantity, listingAttendee.checked_in, ${EA_LEDGER_MONEY_COLS}, listingAttendee.attachment_downloads, listingAttendee.package_group_id`;

/** SELECT clause for attendee + listing_attendees JOINs (INNER JOIN context).
 * Derives `date` from start_at for the Attendee type shape. */
export const ATTENDEE_JOIN_SELECT = `${ATTENDEE_COLS}, ${EA_COLS}`;

/** SELECT clause for LEFT JOIN context — COALESCEs nullable join columns so
 * attendees with broken/missing listing_attendees linkage still appear in results
 * (with listing_id=0 as an obvious corruption indicator). */
export const ATTENDEE_LEFT_JOIN_SELECT = `${ATTENDEE_COLS}, COALESCE(listingAttendee.listing_id, 0) as listing_id, SUBSTR(listingAttendee.start_at, 1, 10) as date, SUBSTR(listingAttendee.end_at, 1, 10) as end_date, COALESCE(listingAttendee.quantity, 0) as quantity, COALESCE(listingAttendee.checked_in, 0) as checked_in, ${EA_LEDGER_MONEY_COLS}, COALESCE(listingAttendee.attachment_downloads, 0) as attachment_downloads, COALESCE(listingAttendee.package_group_id, 0) as package_group_id`;

/**
 * Columns for a `ListingAttendeeRow` read straight from `listing_attendees`
 * (no attendee join) — every helper that loads an attendee's own booking rows
 * shares this list so the ledger-fed `refunded` projection is identical across
 * them. The bare `attendee_id` column feeds the correlated refund subquery. The
 * amount-paid projection's key columns are table-qualified (`listing_attendees.*`)
 * because its own correlated `sibling` subquery would otherwise shadow them; every
 * consumer selects these from an unaliased `FROM listing_attendees`.
 */
export const LISTING_ATTENDEE_ROW_COLS = `listing_id, start_at, end_at, quantity, checked_in, ${refundedFromLedger(
  "attendee_id",
)}, ${pricePaidFromLedger(
  "listing_attendees.attendee_id",
  "listing_attendees.listing_id",
  "listing_attendees.ledger_event_group",
  "listing_attendees.id",
)}, ledger_event_group, attachment_downloads, order_token, parent_listing_id, package_group_id`;

/**
 * Get attendees for an listing without decrypting PII
 * Used for tests and operations that don't need decrypted data
 */
export const getAttendeesRaw = (listingId: number): Promise<Attendee[]> =>
  queryAll<Attendee>(
    `SELECT ${ATTENDEE_JOIN_SELECT}
     FROM attendees AS attendee
     JOIN listing_attendees AS listingAttendee ON listingAttendee.attendee_id = attendee.id
     WHERE listingAttendee.listing_id = ? AND attendee.kind = '${ATTENDEE_KIND}'
     ORDER BY attendee.created DESC`,
    [listingId],
  );

/**
 * One attendee's raw booking rows within one package group (real lines only —
 * quantity > 0). Lets a listing-scoped action rehydrate the WHOLE package the
 * selected line belongs to, so a per-member notification resend doesn't treat
 * a single member row as the complete package.
 */
export const getAttendeePackageRowsRaw = (
  attendeeId: number,
  packageGroupId: number,
): Promise<Attendee[]> =>
  queryAll<Attendee>(
    `SELECT ${ATTENDEE_JOIN_SELECT}
     FROM attendees AS attendee
     JOIN listing_attendees AS listingAttendee ON listingAttendee.attendee_id = attendee.id
     WHERE attendee.id = ? AND listingAttendee.package_group_id = ? AND listingAttendee.quantity > 0
     ORDER BY listingAttendee.listing_id ASC`,
    [attendeeId, packageGroupId],
  );

/**
 * Get the newest attendees across all listings without decrypting PII.
 * Used for the admin dashboard to show recent registrations.
 *
 * The limit counts ATTENDEES, not booking lines: the inner subquery picks the
 * newest `limit` attendee ids — by id, which is AUTOINCREMENT and so
 * co-monotonic with created but index-backed (no sort over the whole
 * unbounded attendees table) — and the outer LEFT JOIN returns every booking
 * line for those attendees, so the dashboard's grouped rows always carry an
 * attendee's complete listings.
 */
export const getNewestAttendeesRaw = (limit: number): Promise<Attendee[]> =>
  queryAll<Attendee>(
    `SELECT ${ATTENDEE_LEFT_JOIN_SELECT}
     FROM attendees AS attendee
     LEFT JOIN listing_attendees AS listingAttendee ON listingAttendee.attendee_id = attendee.id
     WHERE attendee.id IN (
       SELECT newest.id FROM attendees AS newest
       WHERE newest.kind = '${ATTENDEE_KIND}'
       ORDER BY newest.id DESC LIMIT ?
     )
     ORDER BY attendee.id DESC, listingAttendee.listing_id ASC`,
    [limit],
  );

/** Sort order for the admin attendees browser */
export const AttendeeSortSchema = v.picklist(["newest", "oldest"]);
export type AttendeeSort = v.InferOutput<typeof AttendeeSortSchema>;

/** Type guard: narrows an arbitrary string to an {@link AttendeeSort}. */
export const isAttendeeSort = guardFor(AttendeeSortSchema);

/**
 * Attendees per page in the admin attendees browser. Fixed here so the
 * page size is never derived from the request — callers choose only the page.
 */
export const ATTENDEES_PAGE_SIZE = 100;

/** One page of attendee booking rows, plus whether a further page exists */
export type AttendeesPage = {
  rows: Attendee[];
  hasNext: boolean;
};

/** PII-free booking rows for a token-resolved attendee. */
export type AttendeeBookingRows = {
  id: number;
  created: string;
  status_id: number | null;
  bookings: ListingAttendeeRow[];
};

/**
 * Collapse the one-extra-attendee overread into `hasNext`, dropping the extra
 * attendee's lines. Rows arrive grouped by attendee id (the outer ORDER BY),
 * so the extra attendee is exactly the last distinct id.
 */
const trimAttendeePage = (rows: Attendee[]): AttendeesPage => {
  const ids: number[] = [];
  for (const row of rows) {
    if (ids[ids.length - 1] !== row.id) ids.push(row.id);
  }
  if (ids.length <= ATTENDEES_PAGE_SIZE) return { hasNext: false, rows };
  const extraId = ids[ids.length - 1];
  return { hasNext: true, rows: rows.filter((row) => row.id !== extraId) };
};

/**
 * Get one page of attendees — with every one of their booking rows — for the
 * admin attendees browser.
 *
 * Pagination counts ATTENDEES, not booking lines: the inner subquery selects
 * one page of attendee ids, ordered by id — AUTOINCREMENT, so co-monotonic
 * with the registration date but unique, making paging deterministic and
 * index-backed — and the outer query returns every listing_attendees line for
 * those attendees. A grouped attendee row therefore always carries their
 * complete listings list and never splits across a page boundary. When
 * `listingIds` is given it decides WHICH attendees match (any booking on
 * those listings); the returned rows still cover all of a matched attendee's
 * listings.
 *
 * The page size is fixed; callers pass a zero-based `page`. One extra
 * attendee is read to report `hasNext` without a separate count query, then
 * trimmed off. PII stays encrypted — decrypt with decryptAttendees before
 * display.
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
  // `dir` is derived from the AttendeeSort enum and the filter clause is fixed
  // text, so neither is user-controlled — only the bound args are.
  const dir = sort === "oldest" ? "ASC" : "DESC";
  const lineFilter = listingIds
    ? ` AND pageLine.listing_id IN (${inPlaceholders(listingIds)})`
    : "";
  const limit = ATTENDEES_PAGE_SIZE + 1;
  const offset = page * ATTENDEES_PAGE_SIZE;
  const args = listingIds ? [...listingIds, limit, offset] : [limit, offset];
  const rows = await queryAll<Attendee>(
    `SELECT ${ATTENDEE_JOIN_SELECT}
     FROM attendees AS attendee
     JOIN listing_attendees AS listingAttendee ON listingAttendee.attendee_id = attendee.id
     WHERE attendee.id IN (
       SELECT pageAttendee.id
       FROM attendees AS pageAttendee
       JOIN listing_attendees AS pageLine ON pageLine.attendee_id = pageAttendee.id
       WHERE pageAttendee.kind = '${ATTENDEE_KIND}'${lineFilter}
       GROUP BY pageAttendee.id
       ORDER BY pageAttendee.id ${dir}
       LIMIT ? OFFSET ?
     )
     ORDER BY attendee.id ${dir}, listingAttendee.listing_id ASC`,
    args,
  );
  return trimAttendeePage(rows);
};

/**
 * Get every attendee's encrypted PII blob (one row per attendee).
 * Used to resolve bulk-email recipient lists, where only the email inside each
 * blob is needed. De-duplication of addresses happens after decryption.
 */
export const getAllAttendeePiiBlobs = async (): Promise<
  OwnerKeyEncrypted[]
> => {
  // Restrict the "all attendees" bulk-email audience to attendees with ≥1 real
  // (quantity > 0) line, so a no-quantity-only attendee (an interested/cancelled
  // placeholder) isn't emailed — its ticket URL would 404.
  const rows = await queryAll<{ pii_blob: OwnerKeyEncrypted }>(
    `SELECT pii_blob FROM attendees
     WHERE kind = '${ATTENDEE_KIND}'
       AND EXISTS (
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
): Promise<OwnerKeyEncrypted[]> => {
  if (listingIds.length === 0) return [];
  const rows = await queryAll<{ pii_blob: OwnerKeyEncrypted }>(
    // quantity > 0: only attendees with a real line on these listings — a
    // no-quantity sentinel line doesn't make someone an "attendee of X".
    `SELECT pii_blob FROM attendees
     WHERE kind = '${ATTENDEE_KIND}'
       AND id IN (
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
): Promise<OwnerKeyEncrypted | null> => {
  const tokenIndex = await computeTicketTokenIndex(token);
  // Apply the real-line guard: an all-ghost (no-quantity-only) attendee has no
  // valid ticket URL, so the single-attendee bulk-email target resolves to no
  // recipient (a genuine one-off transactional mail would be a separate path).
  const row = await queryOne<{ pii_blob: OwnerKeyEncrypted }>(
    `SELECT pii_blob FROM attendees
     WHERE ticket_token_index = ?
       AND kind = '${ATTENDEE_KIND}'
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
    `SELECT 1 FROM listing_attendees AS listingAttendee
     WHERE listingAttendee.attendee_id = ? AND listingAttendee.listing_id IN (${inPlaceholders(
       listingIds,
     )})
       AND EXISTS (
         SELECT 1 FROM transfers
         WHERE ${saleLegPredicate(
           "listingAttendee.attendee_id",
           "listingAttendee.listing_id",
           "listingAttendee.ledger_event_group",
         )}
       ) LIMIT 1`,
    [attendeeId, ...listingIds],
  );

/**
 * The id of the attendee whose booking owns this ledger event group, or null
 * when none does. The single-batch booking write stamps every one of an
 * attendee's `listing_attendees` rows with the booking's `ledger_event_group`
 * (in the same batch that posts the legs), so a paid session's event group
 * resolves back to exactly the attendee it created. This lets an idempotent
 * replay recover the existing booking from the durable ledger after the
 * (prunable) processed_payments idempotency row has gone — without it, a replay
 * whose legs already exist would be mistaken for a capacity failure and refund a
 * live ticket.
 */
export const attendeeIdByLedgerEventGroup = async (
  eventGroup: string,
): Promise<number | null> => {
  const row = await queryOne<{ attendee_id: number }>(
    "SELECT attendee_id FROM listing_attendees WHERE ledger_event_group = ? LIMIT 1",
    [eventGroup],
  );
  return row?.attendee_id ?? null;
};

/**
 * Get an attendee by ID without decrypting PII
 * Used for payment callbacks and webhooks where decryption is not needed
 * Returns the attendee with encrypted fields (id, listing_id, quantity are plaintext)
 */
export const getAttendeeRaw = (id: number): Promise<Attendee | null> => {
  return queryOne<Attendee>(
    `SELECT ${ATTENDEE_LEFT_JOIN_SELECT}
     FROM attendees AS attendee
     LEFT JOIN listing_attendees AS listingAttendee ON listingAttendee.attendee_id = attendee.id
     WHERE attendee.id = ? AND attendee.kind = '${ATTENDEE_KIND}'`,
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
     FROM attendees AS attendee
     LEFT JOIN listing_attendees AS listingAttendee ON listingAttendee.attendee_id = attendee.id
     WHERE attendee.kind = '${ATTENDEE_KIND}' AND attendee.id IN (${inPlaceholders(
       ids,
     )})`,
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
    async (raw: OwnerKeyEncrypted) =>
      (await decryptPiiBlob(raw, privateKey, false)).name,
  );

/** Bounded id → kind lookup for attendee-linked admin surfaces. Empty ids ⇒
 * empty map. Unknown/deleted ids are omitted. */
export const getAttendeeKindsByIds = async (
  ids: number[],
): Promise<Map<number, string>> => {
  if (ids.length === 0) return new Map();
  const rows = await queryAll<{ id: number; kind: string }>(
    `SELECT id, kind FROM attendees
     WHERE id IN (${inPlaceholders(ids)})`,
    ids,
  );
  return new Map(rows.map((row) => [row.id, row.kind]));
};

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

type BookingRowWithAttendee = ListingAttendeeRow & { attendee_id: number };

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
  realLinesOnly: boolean,
): Promise<Map<number, ListingAttendeeRow[]>> => {
  const realLineFilter = realLinesOnly ? " AND quantity > 0" : "";
  const rows = await queryAll<BookingRowWithAttendee>(
    `SELECT attendee_id, ${LISTING_ATTENDEE_ROW_COLS}
     FROM listing_attendees WHERE attendee_id IN (${inPlaceholders(
       attendeeIds,
     )})${realLineFilter}
     ORDER BY start_at, listing_id`,
    attendeeIds,
  );

  const bookingsByAttendee = new Map<number, ListingAttendeeRow[]>();
  for (const row of rows) {
    const list = bookingsByAttendee.get(row.attendee_id) ?? [];
    list.push(bookingRowWithoutAttendee(row));
    bookingsByAttendee.set(row.attendee_id, list);
  }
  return bookingsByAttendee;
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
     FROM attendees WHERE ticket_token_index IN (${inPlaceholders(
       tokenIndexes,
     )}) AND kind = '${ATTENDEE_KIND}'`,
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

type TokenBookingRow = Omit<AttendeeBookingRows, "bookings"> & TokenIndexedRow;

const tokenResultMap = <Row extends TokenBookingRow, Result>(
  rows: Row[],
  bookingsByAttendee: Map<number, ListingAttendeeRow[]>,
  build: (row: Row, bookings: ListingAttendeeRow[]) => Result,
): Map<string, Result> =>
  new Map(
    rows.map((row) => [
      row.ticket_token_index,
      build(row, bookingsByAttendee.get(row.id) ?? []),
    ]),
  );

const TOKEN_ATTENDEE_BALANCE = remainingBalanceFromLedger("attendees.id");

/**
 * Look up attendees by plaintext tokens, returning full booking data.
 * Two queries: attendees by token index, then all listing_attendees for those attendees.
 * Returns results in the same order as input tokens (deduped). Bookings sorted
 * by start_at then listing_id for deterministic ordering.
 */
export const getAttendeesByTokens = async (
  tokens: string[],
): Promise<(AttendeeWithBookings | null)[]> => {
  if (tokens.length === 0) return [];
  // Query 1: Get attendee base rows (no listing join)
  type AttendeeBase = {
    id: number;
    created: string;
    kind: string;
    ticket_token_index: BlindIndex;
    pii_blob: OwnerKeyEncrypted;
    status_id: number | null;
    remaining_balance: number;
  };
  const {
    rows: attendeeRows,
    tokenIndexes,
    uniqueTokens,
  } = await attendeeRowsForTokens<AttendeeBase>(
    tokens,
    `id, created, kind, ticket_token_index, pii_blob, status_id, ${TOKEN_ATTENDEE_BALANCE}`,
  );

  if (attendeeRows.length === 0) {
    return tokens.map(() => null);
  }

  // Query 2: Get all listing links for these attendees
  const attendeeIds = attendeeRows.map((row) => row.id);
  const bookingsByAttendee = await bookingRowsByAttendeeIds(attendeeIds, false);

  const byTokenIndex = tokenResultMap(
    attendeeRows,
    bookingsByAttendee,
    (row, bookings): AttendeeWithBookings => ({
      bookings,
      created: row.created,
      id: row.id,
      kind: row.kind,
      pii_blob: row.pii_blob,
      remaining_balance: row.remaining_balance,
      status_id: row.status_id,
      ticket_token: "", // populated after decryption by caller
      ticket_token_index: row.ticket_token_index,
    }),
  );

  return resultsInTokenOrder(tokens, uniqueTokens, tokenIndexes, byTokenIndex);
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
  if (tokens.length === 0) return [];
  type AttendeeRow = AttendeeBookingRows & { ticket_token_index: BlindIndex };
  const {
    rows: attendeeRows,
    tokenIndexes,
    uniqueTokens,
  } = await attendeeRowsForTokens<AttendeeRow>(
    tokens,
    "id, created, ticket_token_index, status_id",
  );

  if (attendeeRows.length === 0) return tokens.map(() => null);

  const bookingsByAttendee = await bookingRowsByAttendeeIds(
    attendeeRows.map((row) => row.id),
    true,
  );
  const byTokenIndex = tokenResultMap(
    attendeeRows,
    bookingsByAttendee,
    (row, bookings): AttendeeBookingRows => ({
      bookings,
      created: row.created,
      id: row.id,
      status_id: row.status_id,
    }),
  );
  return resultsInTokenOrder(tokens, uniqueTokens, tokenIndexes, byTokenIndex);
};
