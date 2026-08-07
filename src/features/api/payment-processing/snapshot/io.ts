/* jscpd:ignore-start */
import { unique } from "#fp";
import { buildPaidOrderSnapshot } from "#routes/api/payment-processing/snapshot/build.ts";
import type {
  PaidOrderSnapshot,
  SnapshotDayPriceRow,
  SnapshotGroupRow,
  SnapshotModifierRow,
  SnapshotRows,
} from "#routes/api/payment-processing/snapshot/types.ts";
import { bookingEventGroup } from "#shared/accounting/mappers.ts";
import {
  accountBalanceSubquery,
  creditsLessWriteoffDebits,
} from "#shared/accounting/projection-sql.ts";
import { lineGroupIds } from "#shared/booking/signed-metadata.ts";
import type { BookingIntent } from "#shared/booking-intent.ts";
import { decrypt } from "#shared/crypto/encryption.ts";
import type { EnvKeyEncrypted } from "#shared/crypto/sealed.ts";
import {
  inPlaceholders,
  queryBatch,
  resultRows,
  type SqlStatement,
} from "#shared/db/client.ts";
import { hashEmail, hashPhone } from "#shared/db/contact-preferences.ts";
import { imageFilenameSubqueries } from "#shared/db/images.ts";
import { decryptListingWithCount } from "#shared/db/listings/records.ts";
import type { ListingRecordRow } from "#shared/db/listings/select.ts";
import { rawListingsTable } from "#shared/db/listings/table.ts";
import type { GroupListing, ListingWithCount } from "#shared/types.ts";

/* jscpd:ignore-end */

const selectIn = (column: string, values: readonly unknown[]): string =>
  values.length === 0 ? "0" : `${column} IN (${inPlaceholders(values)})`;

const statement = (sql: string, args: SqlStatement["args"]): SqlStatement => ({
  args,
  sql,
});

const listingStatement = (listingIds: number[]): SqlStatement => {
  const columns = rawListingsTable.columns
    .map((column) => `listing.${column}`)
    .join(", ");
  const requested = selectIn("listing.id", listingIds);
  const linked = selectIn("listingParent.parent_listing_id", listingIds);
  return statement(
    `SELECT ${columns},
       ${creditsLessWriteoffDebits("revenue", "listing.id")} AS income,
       -${accountBalanceSubquery("cost", "listing.id")} AS cost,
       COALESCE((SELECT json_group_object(listingPrice.price_id, listingPrice.unit_price)
         FROM listing_prices AS listingPrice
         WHERE listingPrice.listing_id = listing.id
           AND listingPrice.price_type = 'day_count'), '{}') AS day_prices,
       ${imageFilenameSubqueries("listing", "listing.id")},
       listing.booked_quantity AS attendee_count
     FROM listings AS listing
     WHERE ${requested}
        OR listing.id IN (
          SELECT listingParent.child_listing_id
          FROM listing_parents AS listingParent
          WHERE ${linked}
        )`,
    [...listingIds, ...listingIds],
  );
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
): SqlStatement[] => {
  const listingIds = unique(intent.items.map((item) => item.e));
  const groupIds = [...lineGroupIds(intent.items)];
  const modifierIds = unique(intent.modifiers.map((ref) => ref.i));
  return [
    statement(
      `SELECT EXISTS(SELECT 1 FROM transfers WHERE event_group = ? LIMIT 1) AS has_legs,
        (SELECT attendee_id FROM listing_attendees WHERE ledger_event_group = ? LIMIT 1) AS owner_attendee_id`,
      [eventGroup, eventGroup],
    ),
    listingStatement(listingIds),
    statement(
      `SELECT id, name, hide_package_listings
       FROM groups AS groupRow
       WHERE ${selectIn("groupRow.id", groupIds)} AND groupRow.is_package = 1
       ORDER BY groupRow.id`,
      groupIds,
    ),
    statement(
      `SELECT groupListing.group_id, groupListing.listing_id, groupListing.quantity,
        (SELECT listingPrice.unit_price FROM listing_prices AS listingPrice
          WHERE listingPrice.listing_id = groupListing.listing_id
            AND listingPrice.price_type = 'group'
            AND listingPrice.price_id = CAST(groupListing.group_id AS TEXT)) AS package_price
       FROM group_listings AS groupListing
       WHERE ${selectIn("groupListing.group_id", groupIds)}
       ORDER BY groupListing.group_id, groupListing.listing_id`,
      groupIds,
    ),
    statement(
      `SELECT groupListing.group_id, listingPrice.listing_id,
        CAST(SUBSTR(listingPrice.price_id, LENGTH(CAST(groupListing.group_id AS TEXT)) + 2) AS INTEGER) AS days,
        listingPrice.unit_price
       FROM group_listings AS groupListing
       JOIN listing_prices AS listingPrice
         ON listingPrice.listing_id = groupListing.listing_id
        AND listingPrice.price_type = 'group_day'
        AND listingPrice.price_id LIKE (groupListing.group_id || '/%')
       WHERE ${selectIn("groupListing.group_id", groupIds)}`,
      groupIds,
    ),
    statement(
      `SELECT DISTINCT groupListing.listing_id
       FROM group_listings AS groupListing
       JOIN groups AS groupRow ON groupRow.id = groupListing.group_id
       WHERE ${selectIn("groupListing.listing_id", listingIds)}
         AND groupRow.is_package = 1 AND groupRow.hide_package_listings = 1`,
      listingIds,
    ),
    statement(
      `SELECT parent_listing_id, child_listing_id
       FROM listing_parents AS listingParent
       WHERE ${selectIn("listingParent.parent_listing_id", listingIds)}
          OR ${selectIn("listingParent.child_listing_id", listingIds)}
       ORDER BY parent_listing_id, child_listing_id`,
      [...listingIds, ...listingIds],
    ),
    statement(
      `SELECT modifier.id, modifier.name, modifier.calc_kind, modifier.calc_value,
        modifier.direction, modifier.min_visits, modifier.scope, modifier.trigger
       FROM modifiers AS modifier
       WHERE ${selectIn("modifier.id", modifierIds)} AND modifier.active = 1
       ORDER BY modifier.id`,
      modifierIds,
    ),
    statement(
      `SELECT modifierListing.modifier_id, modifierListing.listing_id
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
      [...modifierIds, ...modifierIds],
    ),
    statement(
      `SELECT visits FROM contact_preferences
       WHERE ${selectIn("contact_hash", contactHashes)}`,
      contactHashes,
    ),
    statement(
      "SELECT id FROM attendee_statuses WHERE is_public_default = 1 ORDER BY sort_order, id",
      [],
    ),
  ];
};

type RawGroupRow = {
  hide_package_listings: number;
  id: number;
  name: EnvKeyEncrypted;
};
type ChildEdgeRow = {
  child_listing_id: number;
  parent_listing_id: number;
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
type RawModifierRow = {
  calc_kind: SnapshotModifierRow["calcKind"];
  calc_value: number;
  direction: SnapshotModifierRow["direction"];
  id: number;
  min_visits: number;
  name: EnvKeyEncrypted;
  scope: SnapshotModifierRow["scope"];
  trigger: SnapshotModifierRow["trigger"];
};
type RawDayPriceRow = ListingIdRow & {
  days: number;
  group_id: number;
  unit_price: number;
};
type PublicStatusRow = {
  id: number;
};
type VisitCountRow = {
  visits: number;
};

const mapListings = async (
  rows: ListingRecordRow[],
): Promise<ListingWithCount[]> =>
  Promise.all(rows.map(decryptListingWithCount));

const decryptNames = async <Row extends { name: EnvKeyEncrypted }>(
  rows: Row[],
): Promise<Array<Omit<Row, "name"> & { name: string }>> =>
  Promise.all(
    rows.map(async ({ name, ...row }) => ({
      ...row,
      name: await decrypt(name),
    })),
  );

const mapNamedRows = async <Row extends { name: EnvKeyEncrypted }, Output>(
  rows: Row[],
  toOutput: (row: Omit<Row, "name"> & { name: string }) => Output,
): Promise<Output[]> => (await decryptNames(rows)).map(toOutput);

const mapGroups = async (rows: RawGroupRow[]): Promise<SnapshotGroupRow[]> =>
  mapNamedRows(rows, (row) => ({
    hideListings: row.hide_package_listings === 1,
    id: row.id,
    name: row.name,
  }));

const mapModifiers = async (
  rows: RawModifierRow[],
): Promise<SnapshotModifierRow[]> =>
  mapNamedRows(rows, (row) => ({
    calcKind: row.calc_kind,
    calcValue: row.calc_value,
    direction: row.direction,
    id: row.id,
    minVisits: row.min_visits,
    name: row.name,
    scope: row.scope,
    trigger: row.trigger,
  }));

export const loadPaidOrderSnapshot = async (
  eventId: string,
  intent: BookingIntent,
): Promise<PaidOrderSnapshot> => {
  const [eventGroup, contactHashes] = await Promise.all([
    bookingEventGroup(eventId),
    usableContactHashes(intent),
  ]);
  const [
    ledgerResult,
    listingsResult,
    groupsResult,
    membershipsResult,
    dayPricesResult,
    hiddenMembersResult,
    childEdgesResult,
    modifiersResult,
    modifierScopesResult,
    visitCountsResult,
    publicStatusesResult,
  ] = await queryBatch(snapshotStatements(eventGroup, intent, contactHashes));
  const ledger = resultRows<LedgerRow>(ledgerResult!)[0]!;
  const rows: SnapshotRows = {
    childEdges: resultRows<ChildEdgeRow>(childEdgesResult!).map((row) => ({
      childId: row.child_listing_id,
      parentId: row.parent_listing_id,
    })),
    groups: await mapGroups(resultRows<RawGroupRow>(groupsResult!)),
    hiddenMemberIds: resultRows<ListingIdRow>(hiddenMembersResult!).map(
      (row) => row.listing_id,
    ),
    ledger: {
      hasLegs: ledger.has_legs === 1,
      ownerAttendeeId: ledger.owner_attendee_id,
    },
    listings: await mapListings(resultRows<ListingRecordRow>(listingsResult!)),
    memberships: resultRows<GroupListing>(membershipsResult!),
    modifierScopes: resultRows<ModifierScopeRow>(modifierScopesResult!).map(
      (row) => ({
        listingId: row.listing_id,
        modifierId: row.modifier_id,
      }),
    ),
    modifiers: await mapModifiers(resultRows<RawModifierRow>(modifiersResult!)),
    publicStatusIds: resultRows<PublicStatusRow>(publicStatusesResult!).map(
      (row) => row.id,
    ),
    visitCounts: resultRows<VisitCountRow>(visitCountsResult!).map(
      (row) => row.visits,
    ),
  };
  const dayPrices = resultRows<RawDayPriceRow>(dayPricesResult!).map(
    (row): SnapshotDayPriceRow => ({
      days: row.days,
      groupId: row.group_id,
      listingId: row.listing_id,
      unitPrice: row.unit_price,
    }),
  );
  return buildPaidOrderSnapshot(intent.modifiers, rows, dayPrices);
};
