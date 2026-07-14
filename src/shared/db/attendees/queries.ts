/**
 * Read queries for attendees and their per-listing bookings.
 */

import type { InValue } from "@libsql/client";
import * as v from "valibot";
import { ATTENDEE } from "#shared/accounting/accounts.ts";
import {
  accountBalanceSubquery,
  saleLegPredicate,
} from "#shared/accounting/projection-sql.ts";
import { computeTicketTokenIndex } from "#shared/crypto/hashing.ts";
import type { OwnerKeyEncrypted } from "#shared/crypto/sealed.ts";
import { ATTENDEE_KIND } from "#shared/db/attendees/kind.ts";
import {
  decryptAttendeeFields,
  decryptPiiBlob,
} from "#shared/db/attendees/pii.ts";
import {
  ATTENDEE_FIELDS,
  type AttendeeRowFor,
  type GetAttendeesQuery,
  getAttendees,
  pricePaidFromLedger,
  refundedFromLedger,
} from "#shared/db/attendees/select.ts";
import {
  inPlaceholders,
  primaryMatchingIdSet,
  queryAll,
  queryAllPrimary,
  queryOne,
  rowExists,
  rowExistsForIdList,
} from "#shared/db/client.ts";
import { columnMapByIds, nameSource } from "#shared/db/query.ts";
import type { Attendee } from "#shared/types.ts";
import { guardFor } from "#shared/validation/guard.ts";

/**
 * Columns for a `ListingAttendeeRow` read straight from one `listing_attendees`
 * source. The source name feeds correlated ledger subqueries, so a caller can
 * pass either the table name or a query alias without the `sibling` subquery
 * shadowing bare column names.
 */
export const listingAttendeeRowColumnsFrom = (sourceName: string): string => {
  const column = (name: string): string => `${sourceName}.${name}`;
  return `${column("listing_id")}, ${column("start_at")}, ${column("end_at")}, ${column("quantity")}, ${column("checked_in")}, ${refundedFromLedger(
    column("attendee_id"),
  )}, ${pricePaidFromLedger(
    column("attendee_id"),
    column("listing_id"),
    column("ledger_event_group"),
    column("id"),
  )}, ${column("ledger_event_group")}, ${column("attachment_downloads")}, ${column("order_token")}, ${column("parent_listing_id")}, ${column("package_group_id")}`;
};

export const LISTING_ATTENDEE_ROW_COLS =
  listingAttendeeRowColumnsFrom("listing_attendees");

/**
 * The fields the browsing tables (the dashboard's newest attendees and the
 * admin attendees browser) actually display: `refunded` drives the status
 * badge, and `checked_in`/`quantity`/`date` are already core columns. Neither
 * table shows `price_paid` or `remaining_balance`, so these reads skip those
 * subqueries entirely.
 */
const BROWSING_FIELDS = ["refunded"] as const;

/** A browsing-table attendee row — every core column plus `refunded`, but none
 * of the expensive money projections. */
export type BrowsingAttendee = AttendeeRowFor<"refunded">;

/**
 * Get attendees for an listing without decrypting PII
 * Used for tests and operations that don't need decrypted data
 */
/** Load attendee rows carrying the standard {@link ATTENDEE_FIELDS} set (PII
 * still encrypted — decrypt before display). Callers vary only in join, order,
 * and where, so the field set is declared in exactly one place. */
export const loadAttendeeRows = (
  query: Omit<GetAttendeesQuery<(typeof ATTENDEE_FIELDS)[number]>, "fields">,
): Promise<Attendee[]> => getAttendees({ ...query, fields: ATTENDEE_FIELDS });

export const getAttendeesRaw = (listingId: number): Promise<Attendee[]> =>
  loadAttendeeRows({
    order: "created_desc",
    where: { listingIds: [listingId] },
  });

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
  loadAttendeeRows({
    // No kind filter (as the original query): the attendee id already pins one
    // attendee, and its rows are returned whatever its kind. `attendee-or-
    // servicing` matches every kind the CHECK constraint allows.
    order: "listing_asc",
    where: {
      attendeeIds: [attendeeId],
      kind: "attendee-or-servicing",
      packageGroupId,
      realLinesOnly: true,
    },
  });

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
export const getNewestAttendeesRaw = (
  limit: number,
): Promise<BrowsingAttendee[]> =>
  getAttendees({
    fields: BROWSING_FIELDS,
    join: "left",
    order: "id_desc",
    where: {
      attendeeIdsSubquery: {
        args: [limit],
        sql: `SELECT newest.id FROM attendees AS newest
           WHERE newest.kind = '${ATTENDEE_KIND}'
           ORDER BY newest.id DESC LIMIT ?`,
      },
    },
  });

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

/** One page of attendee booking rows, plus whether a further page exists.
 * Carries the full field set because the same page query feeds both the
 * browsing table (which shows no money) and the CSV export (which sums
 * `price_paid`); the table simply ignores the columns it doesn't render. */
export type AttendeesPage = {
  rows: Attendee[];
  hasNext: boolean;
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
  // The inner subquery pages the ATTENDEE ids (grouped, so paging counts
  // attendees not lines); getAttendees then returns every booking line for
  // those attendees. The listing filter and LIMIT/OFFSET are bound args.
  const idsArgs = listingIds ? [...listingIds, limit, offset] : [limit, offset];
  const rows = await loadAttendeeRows({
    order: dir === "ASC" ? "id_asc" : "id_desc",
    where: {
      attendeeIdsSubquery: {
        args: idsArgs,
        sql: `SELECT pageAttendee.id
           FROM attendees AS pageAttendee
           JOIN listing_attendees AS pageLine ON pageLine.attendee_id = pageAttendee.id
           WHERE pageAttendee.kind = '${ATTENDEE_KIND}'${lineFilter}
           GROUP BY pageAttendee.id
           ORDER BY pageAttendee.id ${dir}
           LIMIT ? OFFSET ?`,
      },
    },
  });
  return trimAttendeePage(rows);
};

/** Keeps only attendees who have at least one real (quantity > 0) booking line —
 * a no-quantity-only placeholder (interested/cancelled) has no valid ticket URL,
 * so it is never part of an email audience. Shared by every pii_blob read. */
const HAS_REAL_LINE = `EXISTS (
       SELECT 1 FROM listing_attendees
       WHERE attendee_id = attendees.id AND quantity > 0
     )`;

/** Select the encrypted pii_blob of each real-audience attendee (an
 * ATTENDEE_KIND row with a real line) matching one extra narrowing clause, then
 * return just the blobs. The bulk-email audience reads all read and unwrap the
 * blob the same way; they differ only in how they pick which attendees match. */
const selectAudiencePiiBlobs = async (
  extraWhere: string,
  args?: InValue[],
): Promise<OwnerKeyEncrypted[]> => {
  const rows = await queryAll<{ pii_blob: OwnerKeyEncrypted }>(
    `SELECT pii_blob FROM attendees
     WHERE kind = '${ATTENDEE_KIND}' AND ${extraWhere}`,
    args,
  );
  return rows.map((r) => r.pii_blob);
};

/**
 * Get every attendee's encrypted PII blob (one row per attendee).
 * Used to resolve bulk-email recipient lists, where only the email inside each
 * blob is needed. De-duplication of addresses happens after decryption.
 */
export const getAllAttendeePiiBlobs = (): Promise<OwnerKeyEncrypted[]> =>
  selectAudiencePiiBlobs(HAS_REAL_LINE);

/**
 * Get the encrypted PII blobs for attendees booked onto any of the given
 * listings (one row per attendee, even if booked onto several of them).
 * Returns an empty array when no listing IDs are supplied.
 */
export const getAttendeePiiBlobsForListings = (
  listingIds: number[],
): Promise<OwnerKeyEncrypted[]> =>
  listingIds.length === 0
    ? Promise.resolve([])
    : // quantity > 0: only attendees with a real line on these listings — a
      // no-quantity sentinel line doesn't make someone an "attendee of X".
      selectAudiencePiiBlobs(
        `id IN (
       SELECT DISTINCT attendee_id FROM listing_attendees
       WHERE listing_id IN (${inPlaceholders(listingIds)}) AND quantity > 0
     )`,
        listingIds,
      );

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
export const hasPaidLine = rowExistsForIdList(
  (listingIdPlaceholders) =>
    `SELECT 1 FROM listing_attendees AS listingAttendee
     WHERE listingAttendee.attendee_id = ? AND listingAttendee.listing_id IN (${listingIdPlaceholders})
       AND EXISTS (
         SELECT 1 FROM transfers
         WHERE ${saleLegPredicate(
           "listingAttendee.attendee_id",
           "listingAttendee.listing_id",
           "listingAttendee.ledger_event_group",
         )}
       ) LIMIT 1`,
);

/**
 * True when the attendee holds provider cash the ledger has not returned or
 * applied to a sale — a POSITIVE account balance (money paid in, nothing owed
 * against it). The only source is a stage_active conflict's held `payment` leg
 * (a charge the operator must reconcile), which posts no `sale`, so
 * {@link hasPaidLine} (sale-scoped) and the price_paid guard (0 without a sale)
 * both miss it. Read from the live ledger, no decryption. A fully-paid booking
 * nets to 0, a deposit is negative (owed), and a refunded record nets back to 0,
 * so none of them read as held cash.
 *
 * Array in, set out — call with one id for the single case. Pinned to the
 * primary: this gates writes (no-quantity edits, deletes, merges), and a replica
 * lagging the just-posted held-payment leg would let a mutation slip through the
 * guard — the same reason the pending-checkout guard reads the primary.
 */
export const attendeeIdsHoldingUnreturnedCash = primaryMatchingIdSet(
  (placeholders) =>
    `SELECT attendee.id AS id FROM attendees AS attendee
      WHERE attendee.id IN (${placeholders})
        AND ${accountBalanceSubquery(ATTENDEE, "attendee.id")} > 0`,
);

/** Whether this one attendee holds unreturned conflict cash — single-id form of
 * {@link attendeeIdsHoldingUnreturnedCash} for the no-quantity and delete guards. */
export const attendeeHoldsUnreturnedCash = async (
  attendeeId: number,
): Promise<boolean> =>
  (await attendeeIdsHoldingUnreturnedCash([attendeeId])).has(attendeeId);

/** Whether any attendee booked on this listing holds unreturned conflict cash
 * — the listing-scoped form of {@link attendeeIdsHoldingUnreturnedCash}, for
 * the listing delete guard: deleting the listing cascades its booking rows,
 * and the in-app refund needs an active booking line, so the delete would
 * strand the held charge with no refund path. Primary-pinned like the other
 * cash guards. */
export const listingHoldsUnreturnedCash = async (
  listingId: number,
): Promise<boolean> => {
  const rows = await queryAllPrimary<{ attendee_id: number }>(
    "SELECT DISTINCT attendee_id FROM listing_attendees WHERE listing_id = ?",
    [listingId],
  );
  const held = await attendeeIdsHoldingUnreturnedCash(
    rows.map((row) => row.attendee_id),
  );
  return held.size > 0;
};

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
export const getAttendeeRaw = async (id: number): Promise<Attendee | null> =>
  (await loadAttendeeRows({ join: "left", where: { attendeeIds: [id] } }))[0] ??
  null;

/**
 * Get attendees by ID without decrypting PII, one row per (attendee, booking).
 * Used by the agent run sheet, which already knows the attendee ids it needs
 * and only reads each attendee's contact fields. Returns an empty array for no
 * ids. Decrypt with decryptAttendees before display.
 */
export const getAttendeesByIds = (ids: number[]): Promise<Attendee[]> =>
  ids.length === 0
    ? Promise.resolve([])
    : loadAttendeeRows({ join: "left", where: { attendeeIds: ids } });

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
  nameSource(
    "attendees",
    "attendee",
    "pii_blob",
    async (raw: OwnerKeyEncrypted) =>
      (await decryptPiiBlob(raw, privateKey, false)).name,
  ).byIds(ids);

/** Bounded id → kind lookup for attendee-linked admin surfaces. Empty ids ⇒
 * empty map. Unknown/deleted ids are omitted. */
export const getAttendeeKindsByIds = (
  ids: number[],
): Promise<Map<number, string>> =>
  columnMapByIds<string>("attendees", "attendee", "kind", ids);

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
