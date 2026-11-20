import { bookingEventGroup } from "#accounting/mappers.ts";
import { lineGroupIds } from "#booking/signed-metadata.ts";
import { hashEmail, hashPhone } from "#db/contact-preferences.ts";
import { decryptListingWithCount } from "#db/listings/records.ts";
import {
  decodedListingRead,
  type ListingRecordRow,
  listingColumns,
} from "#db/listings/select.ts";
import { readBatch } from "#db/read.ts";
import { among, or } from "#db/select/expression.ts";
import { from } from "#db/select/query.ts";
import { tables } from "#db/select/tables.ts";
import {
  type RowsStatement,
  type SqlStatement,
  sql,
  sqlList,
  sqlName,
  typedSql,
} from "#db/sql.ts";
import { unique } from "#fp";
import { buildPaidOrderSnapshot } from "#routes/api/payment-processing/snapshot/build.ts";
import type {
  PaidOrderSnapshot,
  SnapshotDayPriceRow,
  SnapshotRows,
} from "#routes/api/payment-processing/snapshot/types.ts";
import type { BookingIntent } from "#shared/booking-intent.ts";
import type { GroupListing, ListingWithCount } from "#types";

const selectIn = (
  column: string,
  values: readonly (number | string)[],
): SqlStatement =>
  values.length === 0
    ? sql`0`
    : sql`${sqlName(column)} IN (${sqlList(values)})`;

const listingStatement = (listingIds: number[]): SqlStatement => {
  const requested = selectIn("listing.id", listingIds);
  const linked = selectIn("listingParent.parent_listing_id", listingIds);
  return decodedListingRead(sql`SELECT ${listingColumns()}
     FROM listings AS listing
     WHERE ${requested}
        OR listing.id IN (
          SELECT listingParent.child_listing_id
          FROM listing_parents AS listingParent
          WHERE ${linked}
        )`);
};

const usableContactHashes = async (
  intent: BookingIntent,
): Promise<string[]> => {
  const values: Promise<string>[] = [];
  if (intent.email?.trim()) values.push(hashEmail(intent.email));
  if (intent.phone?.trim()) values.push(hashPhone(intent.phone));
  return Promise.all(values);
};

const snapshotStatements = (
  eventGroup: string,
  intent: BookingIntent,
  contactHashes: string[],
) => {
  const listingIds = unique(intent.items.map((item) => item.e));
  const groupIds = [...lineGroupIds(intent.items)];
  const modifierIds = unique(intent.modifiers.map((ref) => ref.i));
  return [
    typedSql<RowsStatement<LedgerRow>>(
      sql`SELECT EXISTS(SELECT 1 FROM transfers WHERE event_group = ${eventGroup} LIMIT 1) AS has_legs,
        (SELECT attendee_id FROM listing_attendees WHERE ledger_event_group = ${eventGroup} LIMIT 1) AS owner_attendee_id`,
    ),
    typedSql<RowsStatement<ListingRecordRow>>(listingStatement(listingIds)),
    from(tables.groups)
      .where({ id: groupIds, isPackage: 1 })
      .sortedBy("id")
      .select((group) => ({
        hideListings: group.hidePackageListings,
        id: group.id,
        name: group.name,
      })),
    typedSql<RowsStatement<GroupListing>>(
      sql`SELECT groupListing.group_id AS groupId, groupListing.listing_id AS listingId, groupListing.quantity,
        (SELECT listingPrice.unit_price FROM listing_prices AS listingPrice
          WHERE listingPrice.listing_id = groupListing.listing_id
            AND listingPrice.price_type = 'group'
            AND listingPrice.price_id = CAST(groupListing.group_id AS TEXT)) AS packagePrice
       FROM group_listings AS groupListing
       WHERE ${selectIn("groupListing.group_id", groupIds)}
       ORDER BY groupListing.group_id, groupListing.listing_id`,
    ),
    typedSql<RowsStatement<SnapshotDayPriceRow>>(
      sql`SELECT groupListing.group_id AS groupId, listingPrice.listing_id AS listingId,
        CAST(SUBSTR(listingPrice.price_id, LENGTH(CAST(groupListing.group_id AS TEXT)) + 2) AS INTEGER) AS days,
        listingPrice.unit_price AS unitPrice
       FROM group_listings AS groupListing
       JOIN listing_prices AS listingPrice
         ON listingPrice.listing_id = groupListing.listing_id
        AND listingPrice.price_type = 'group_day'
        AND listingPrice.price_id LIKE (groupListing.group_id || '/%')
       WHERE ${selectIn("groupListing.group_id", groupIds)}`,
    ),
    from(tables.listing_parents)
      .where((edge) =>
        or(
          among(edge.parentListingId, listingIds),
          among(edge.childListingId, listingIds),
        ),
      )
      .sortedBy("parentListingId", "childListingId")
      .pick("parentListingId", "childListingId"),
    from(tables.modifiers)
      .where({ active: 1, id: modifierIds })
      .sortedBy("id")
      .pick(
        "id",
        "name",
        "calcKind",
        "calcValue",
        "direction",
        "minVisits",
        "scope",
        "trigger",
      ),
    typedSql<RowsStatement<ModifierScopeRow>>(
      sql`SELECT modifierListing.modifier_id AS modifierId, modifierListing.listing_id AS listingId
       FROM modifier_listings AS modifierListing
        JOIN modifiers AS modifier
          ON modifier.id = modifierListing.modifier_id
         AND modifier.scope = 'listings'
        WHERE ${selectIn("modifierListing.modifier_id", modifierIds)}
        UNION
        SELECT modifierGroup.modifier_id AS modifierId, groupListing.listing_id AS listingId
        FROM modifier_groups AS modifierGroup
        JOIN modifiers AS modifier
          ON modifier.id = modifierGroup.modifier_id
         AND modifier.scope = 'groups'
        JOIN group_listings AS groupListing ON groupListing.group_id = modifierGroup.group_id
        WHERE ${selectIn("modifierGroup.modifier_id", modifierIds)}`,
    ),
    from(tables.contact_preferences)
      .where({ contactHash: contactHashes })
      .pick("visits"),
    from(tables.attendee_statuses)
      .where({ isPublicDefault: 1 })
      .sortedBy("sortOrder", "id")
      .pick("id"),
  ] as const;
};

type LedgerRow = {
  has_legs: number;
  owner_attendee_id: number | null;
};
type ModifierScopeRow = {
  listingId: number;
  modifierId: number;
};

const mapListings = async (
  rows: ListingRecordRow[],
): Promise<ListingWithCount[]> =>
  Promise.all(rows.map(decryptListingWithCount));

export const loadPaidOrderSnapshot = async (
  eventId: string,
  intent: BookingIntent,
): Promise<PaidOrderSnapshot> => {
  const [eventGroup, contactHashes] = await Promise.all([
    bookingEventGroup(eventId),
    usableContactHashes(intent),
  ]);
  const [
    [ledger],
    listings,
    groups,
    memberships,
    dayPriceRows,
    childEdges,
    modifiers,
    modifierScopes,
    visitCounts,
    publicStatuses,
  ] = await readBatch(snapshotStatements(eventGroup, intent, contactHashes));
  // The ledger read has no FROM clause, so it always gives one row.
  const { has_legs, owner_attendee_id } = ledger!;
  const rows: SnapshotRows = {
    childEdges: childEdges.map((row) => ({
      childId: row.childListingId,
      parentId: row.parentListingId,
    })),
    groups,
    ledger: { hasLegs: has_legs === 1, ownerAttendeeId: owner_attendee_id },
    listings: await mapListings(listings),
    memberships,
    modifierScopes,
    modifiers,
    publicStatusIds: publicStatuses.map((row) => row.id),
    visitCounts: visitCounts.map((row) => row.visits),
  };
  return buildPaidOrderSnapshot(intent.modifiers, rows, dayPriceRows);
};
