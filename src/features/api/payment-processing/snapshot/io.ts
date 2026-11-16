import { bookingEventGroup } from "#accounting/mappers.ts";
import {
  accountBalanceSubquery,
  creditsLessWriteoffDebits,
} from "#accounting/projection-sql.ts";
import { lineGroupIds } from "#booking/signed-metadata.ts";
import { hashEmail, hashPhone } from "#db/contact-preferences.ts";
import { imageFilenameSubqueries } from "#db/images.ts";
import { decryptListingWithCount } from "#db/listings/records.ts";
import { LISTING_ROW, type ListingRecordRow } from "#db/listings/select.ts";
import { rawListingsTable } from "#db/listings/table.ts";
import { readBatch } from "#db/read.ts";
import { among, or } from "#db/select/expression.ts";
import { from } from "#db/select/query.ts";
import { type DecodedRowOf, tables } from "#db/select/tables.ts";
import {
  type RowsStatement,
  type SqlStatement,
  sql,
  sqlList,
  sqlName,
  sqlNames,
  typedSql,
} from "#db/sql.ts";
import { unique } from "#fp";
import { buildPaidOrderSnapshot } from "#routes/api/payment-processing/snapshot/build.ts";
import type {
  PaidOrderSnapshot,
  SnapshotDayPriceRow,
  SnapshotGroupRow,
  SnapshotModifierRow,
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
  const columns = sqlNames(
    rawListingsTable.columns.map((column) => `listing.${column}`),
  );
  const requested = selectIn("listing.id", listingIds);
  const linked = selectIn("listingParent.parent_listing_id", listingIds);
  return sql`SELECT ${columns},
       ${creditsLessWriteoffDebits("revenue", LISTING_ROW.id)} AS income,
       -${accountBalanceSubquery("cost", LISTING_ROW.id)} AS cost,
       COALESCE((SELECT json_group_object(listingPrice.price_id, listingPrice.unit_price)
         FROM listing_prices AS listingPrice
         WHERE listingPrice.listing_id = listing.id
           AND listingPrice.price_type = 'day_count'), '{}') AS day_prices,
       ${imageFilenameSubqueries("listing", sql`listing.id`)},
       listing.booked_quantity AS attendee_count
     FROM listings AS listing
     WHERE ${requested}
        OR listing.id IN (
          SELECT listingParent.child_listing_id
          FROM listing_parents AS listingParent
          WHERE ${linked}
        )`;
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
      .where({ id: groupIds, is_package: 1 })
      .sortedBy("id")
      .pick("id", "name", "hide_package_listings"),
    typedSql<RowsStatement<GroupListing>>(
      sql`SELECT groupListing.group_id, groupListing.listing_id, groupListing.quantity,
        (SELECT listingPrice.unit_price FROM listing_prices AS listingPrice
          WHERE listingPrice.listing_id = groupListing.listing_id
            AND listingPrice.price_type = 'group'
            AND listingPrice.price_id = CAST(groupListing.group_id AS TEXT)) AS package_price
       FROM group_listings AS groupListing
       WHERE ${selectIn("groupListing.group_id", groupIds)}
       ORDER BY groupListing.group_id, groupListing.listing_id`,
    ),
    typedSql<RowsStatement<RawDayPriceRow>>(
      sql`SELECT groupListing.group_id, listingPrice.listing_id,
        CAST(SUBSTR(listingPrice.price_id, LENGTH(CAST(groupListing.group_id AS TEXT)) + 2) AS INTEGER) AS days,
        listingPrice.unit_price
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
          among(edge.parent_listing_id, listingIds),
          among(edge.child_listing_id, listingIds),
        ),
      )
      .sortedBy("parent_listing_id", "child_listing_id")
      .pick("parent_listing_id", "child_listing_id"),
    from(tables.modifiers)
      .where({ active: 1, id: modifierIds })
      .sortedBy("id")
      .pick(
        "id",
        "name",
        "calc_kind",
        "calc_value",
        "direction",
        "min_visits",
        "scope",
        "trigger",
      ),
    typedSql<RowsStatement<ModifierScopeRow>>(
      sql`SELECT modifierListing.modifier_id, modifierListing.listing_id
       FROM modifier_listings AS modifierListing
        JOIN modifiers AS modifier
          ON modifier.id = modifierListing.modifier_id
         AND modifier.scope = 'listings'
        WHERE ${selectIn("modifierListing.modifier_id", modifierIds)}
        UNION
        SELECT modifierGroup.modifier_id, groupListing.listing_id
        FROM modifier_groups AS modifierGroup
        JOIN modifiers AS modifier
          ON modifier.id = modifierGroup.modifier_id
         AND modifier.scope = 'groups'
        JOIN group_listings AS groupListing ON groupListing.group_id = modifierGroup.group_id
        WHERE ${selectIn("modifierGroup.modifier_id", modifierIds)}`,
    ),
    from(tables.contact_preferences)
      .where({ contact_hash: contactHashes })
      .pick("visits"),
    from(tables.attendee_statuses)
      .where({ is_public_default: 1 })
      .sortedBy("sort_order", "id")
      .pick("id"),
  ] as const;
};

type LedgerRow = {
  has_legs: number;
  owner_attendee_id: number | null;
};
type ListingIdRow = {
  listing_id: number;
};
type ModifierScopeRow = ListingIdRow & {
  modifier_id: number;
};
type RawDayPriceRow = ListingIdRow & {
  days: number;
  group_id: number;
  unit_price: number;
};

const mapListings = async (
  rows: ListingRecordRow[],
): Promise<ListingWithCount[]> =>
  Promise.all(rows.map(decryptListingWithCount));

type GroupRow = Pick<
  DecodedRowOf<"groups">,
  "hide_package_listings" | "id" | "name"
>;

const mapGroup = (row: GroupRow): SnapshotGroupRow => ({
  hideListings: row.hide_package_listings,
  id: row.id,
  name: row.name,
});

type ModifierRow = Pick<
  DecodedRowOf<"modifiers">,
  | "calc_kind"
  | "calc_value"
  | "direction"
  | "id"
  | "min_visits"
  | "name"
  | "scope"
  | "trigger"
>;

const mapModifier = (row: ModifierRow): SnapshotModifierRow => ({
  calcKind: row.calc_kind,
  calcValue: row.calc_value,
  direction: row.direction,
  id: row.id,
  minVisits: row.min_visits,
  name: row.name,
  scope: row.scope,
  trigger: row.trigger,
});

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
      childId: row.child_listing_id,
      parentId: row.parent_listing_id,
    })),
    groups: groups.map(mapGroup),
    ledger: { hasLegs: has_legs === 1, ownerAttendeeId: owner_attendee_id },
    listings: await mapListings(listings),
    memberships,
    modifierScopes: modifierScopes.map((row) => ({
      listingId: row.listing_id,
      modifierId: row.modifier_id,
    })),
    modifiers: modifiers.map(mapModifier),
    publicStatusIds: publicStatuses.map((row) => row.id),
    visitCounts: visitCounts.map((row) => row.visits),
  };
  const dayPrices = dayPriceRows.map(
    (row): SnapshotDayPriceRow => ({
      days: row.days,
      groupId: row.group_id,
      listingId: row.listing_id,
      unitPrice: row.unit_price,
    }),
  );
  return buildPaidOrderSnapshot(intent.modifiers, rows, dayPrices);
};
