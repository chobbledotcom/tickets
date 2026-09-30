/**
 * Read queries for attendees and their per-listing bookings.
 */

/* jscpd:ignore-start */
import { saleLegPredicate } from "#accounting/projection-sql.ts";
import type { OwnerKeyEncrypted } from "#crypto/sealed.ts";
import { ATTENDEE_KIND } from "#db/attendees/kind.ts";
import { decryptAttendeeFields, decryptPiiBlob } from "#db/attendees/pii.ts";
import {
  ATTENDEE_FIELDS,
  type AttendeeRowFor,
  type AttendeeWhere,
  type GetAttendeesQuery,
  getAttendees,
  pricePaidFromLedger,
  refundedFromLedger,
} from "#db/attendees/select.ts";
import {
  inPlaceholders,
  queryOne,
  rowExists,
  rowExistsForIdList,
} from "#db/client.ts";
import { columnFrom, columnMapByIds, nameSource } from "#db/query.ts";
import type { AttendeeSort } from "#shared/attendee-list-controls.ts";
import type { Attendee } from "#types";
/* jscpd:ignore-end */

/**
 * Columns for a `ListingAttendeeRow` read straight from one `listing_attendees`
 * source. The source name feeds correlated ledger subqueries, so a caller can
 * pass either the table name or a query alias without the `sibling` subquery
 * shadowing bare column names.
 */
export const listingAttendeeRowColumnsFrom = (sourceName: string): string => {
  const column = columnFrom(sourceName);
  return `${column("listing_id")}, ${column("start_at")}, ${column(
    "end_at",
  )}, ${column("quantity")}, ${column("checked_in")}, ${refundedFromLedger({
    attendeeId: column("attendee_id"),
    eventGroup: column("ledger_event_group"),
    listingId: column("listing_id"),
    placeholderWhen: `${column("quantity")} = 0`,
  })}, ${pricePaidFromLedger(
    column("attendee_id"),
    column("listing_id"),
    column("ledger_event_group"),
    column("id"),
  )}, ${column("ledger_event_group")}, ${column("attachment_downloads")}, ${column(
    "order_token",
  )}, ${column("parent_listing_id")}, ${column("package_group_id")}`;
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

/** Which lines one resend reads: the member lines of one package group,
 * every standalone line the attendee holds, or every line the attendee holds
 * (the site assignment's view, because one site serves the whole buyer). */
export type BookingScope =
  | { kind: "package"; packageGroupId: number }
  | { kind: "standalone" }
  | { kind: "whole" };

/** The row filter each resend scope adds. */
const scopeWhere = (scope: BookingScope): Partial<AttendeeWhere> => {
  switch (scope.kind) {
    case "package":
      return { packageGroupId: scope.packageGroupId };
    case "standalone":
      return { standaloneOnly: true };
    case "whole":
      return {};
  }
};

/**
 * One attendee's raw booking rows (real lines only — quantity > 0) within one
 * resend scope. Lets a listing-scoped action rehydrate the WHOLE purchase the
 * selected line belongs to — every standalone line for a standalone attendee,
 * or every package member line for a package row — so a per-member
 * notification resend doesn't treat a single member row as the complete
 * purchase, and never pulls another package into the confirmation.
 */
export const getAttendeeBookingRowsRaw = (
  attendeeId: number,
  scope: BookingScope,
): Promise<Attendee[]> =>
  loadAttendeeRows({
    // No kind filter: the attendee id already pins one attendee, and its rows
    // are returned whatever their kind.
    order: "listing_asc",
    where: {
      attendeeIds: [attendeeId],
      kind: "attendee-or-servicing",
      realLinesOnly: true,
      ...scopeWhere(scope),
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
 * Pagination counts ATTENDEES, not booking lines, so a grouped attendee row
 * carries their complete listings list and never splits across a page boundary.
 * `listingIds` decides WHICH attendees match, and the returned rows still cover
 * all of a matched attendee's listings.
 *
 * An order by id works because AUTOINCREMENT ids are unique and always rise.
 * Each page is therefore deterministic. One extra attendee reports `hasNext`
 * without a second count query. PII stays encrypted, so decrypt with
 * decryptAttendees first.
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

export type FirstBooking = {
  readonly active: boolean;
  readonly listingId: number;
  /** The selected row's package group: a resend of this booking rehydrates
   * this package alone, or every standalone line when it holds none. */
  readonly packageGroupId: number;
};

/** The first real booking, or a no-quantity placeholder when no real one
 * remains. The returned row itself proves whether the action has a live
 * booking; callers do not need a second existence query. */
export const getFirstBooking = async (
  attendeeId: number,
): Promise<FirstBooking | null> => {
  const row = await queryOne<{
    listing_id: number;
    package_group_id: number;
    quantity: number;
  }>(
    `SELECT listingAttendee.listing_id
              , listingAttendee.package_group_id
              , listingAttendee.quantity
         FROM listing_attendees AS listingAttendee
        WHERE listingAttendee.attendee_id = ?
        ORDER BY (listingAttendee.quantity > 0) DESC,
                 listingAttendee.start_at, listingAttendee.listing_id
        LIMIT 1`,
    [attendeeId],
  );
  return row === null
    ? null
    : {
        active: Number(row.quantity) > 0,
        listingId: Number(row.listing_id),
        packageGroupId: Number(row.package_group_id),
      };
};

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
export const getAttendeeOrNull = async (
  id: number,
  privateKey: CryptoKey,
): Promise<Attendee | null> => {
  const row = await getAttendeeRaw(id);
  return row ? decryptAttendeeFields(row, privateKey) : null;
};
