import { packageMemberMaps } from "#db/groups.ts";
import { byId } from "#fp";
import type {
  PaidOrderSnapshot,
  SnapshotDayPriceRow,
  SnapshotModifierRow,
  SnapshotRows,
} from "#routes/api/payment-processing/snapshot/types.ts";
import type { ModifierRef } from "#shared/booking-intent.ts";
import type { ModifierSpec } from "#shared/payments.ts";
import { signedModifierValue } from "#shared/price-modifier.ts";
import type { RegistrationPackagePricing } from "#shared/registration-package-facts.ts";
import { classifyBookingLedger } from "#shared/session-ledger.ts";
import type { GroupListing } from "#types";

const appendToMap = (
  map: Map<number, number[]>,
  key: number,
  value: number,
): void => {
  const values = map.get(key);
  if (values) values.push(value);
  else map.set(key, [value]);
};

const relationshipMaps = (
  edges: SnapshotRows["childEdges"],
): Pick<PaidOrderSnapshot, "childrenByParentId" | "parentsByChildId"> => {
  const childrenByParentId = new Map<number, number[]>();
  const parentsByChildId = new Map<number, number[]>();
  for (const edge of edges) {
    appendToMap(childrenByParentId, edge.parentId, edge.childId);
    appendToMap(parentsByChildId, edge.childId, edge.parentId);
  }
  return { childrenByParentId, parentsByChildId };
};

const packagePricing = (
  groups: SnapshotRows["groups"],
  memberships: GroupListing[],
  dayPrices: SnapshotDayPriceRow[],
): Map<number, RegistrationPackagePricing> =>
  new Map(
    groups.map((group) => {
      const members = memberships.filter((row) => row.group_id === group.id);
      const memberDayPrices = dayPrices.filter(
        (row) => row.groupId === group.id,
      );
      const memberMaps = packageMemberMaps(members);
      return [
        group.id,
        {
          dayPriceMap: new Map(
            [...Map.groupBy(memberDayPrices, (row) => row.listingId)].map(
              ([listingId, rows]) => [
                listingId,
                new Map(rows.map((row) => [row.days, row.unitPrice])),
              ],
            ),
          ),
          memberIds: new Set(members.map((row) => row.listing_id)),
          priceMap: memberMaps.prices,
          quantityMap: memberMaps.quantities,
        },
      ];
    }),
  );

const modifierSpecs = (
  refs: ModifierRef[],
  rows: SnapshotModifierRow[],
  scopeRows: SnapshotRows["modifierScopes"],
  visits: number,
): ModifierSpec[] => {
  const rowsById = byId(rows);
  const scopes = Map.groupBy(scopeRows, (row) => row.modifierId);
  return refs.flatMap((ref) => {
    const modifier = rowsById.get(ref.i);
    if (!modifier || modifier.minVisits > visits) return [];
    return [
      {
        id: modifier.id,
        kind: modifier.calcKind,
        listingIds:
          modifier.scope === "all"
            ? null
            : (scopes.get(modifier.id) ?? []).map((row) => row.listingId),
        name: modifier.name,
        quantity: ref.q,
        trigger: modifier.trigger,
        value: signedModifierValue({
          direction: modifier.direction,
          kind: modifier.calcKind,
          value: modifier.calcValue,
        }),
      },
    ];
  });
};

export const buildPaidOrderSnapshot = (
  refs: ModifierRef[],
  rows: SnapshotRows,
  dayPrices: SnapshotDayPriceRow[],
): PaidOrderSnapshot => {
  const publicStatusId = rows.publicStatusIds[0];
  if (publicStatusId === undefined) {
    throw new Error(
      "No attendee status has the required is_public_default flag",
    );
  }
  const visits = Math.max(0, ...rows.visitCounts);
  const pricingByGroup = packagePricing(
    rows.groups,
    rows.memberships,
    dayPrices,
  );
  return {
    ...relationshipMaps(rows.childEdges),
    hiddenPackageMemberIds: new Set(rows.hiddenMemberIds),
    ledger: classifyBookingLedger(
      rows.ledger.hasLegs,
      rows.ledger.ownerAttendeeId,
    ),
    listingsById: new Map(
      rows.listings.map((listing) => [listing.id, listing]),
    ),
    modifierSpecs: modifierSpecs(
      refs,
      rows.modifiers,
      rows.modifierScopes,
      visits,
    ),
    notificationPackages: {
      displays: new Map(
        rows.groups.map((group) => [
          group.id,
          { hideListings: group.hideListings, name: group.name },
        ]),
      ),
      pricingByGroup,
    },
    publicStatusId,
  };
};
