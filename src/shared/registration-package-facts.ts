import { mapNotNullish, unique } from "#fp";
import {
  getPackageDisplaysByIds,
  loadPackageMemberPricingByGroupIds,
  type PackageDisplay,
} from "#shared/db/groups.ts";

export interface RegistrationPackagePricing {
  dayPriceMap: ReadonlyMap<number, ReadonlyMap<number, number>>;
  memberIds: ReadonlySet<number>;
  priceMap: ReadonlyMap<number, number>;
  quantityMap: ReadonlyMap<number, number>;
}

export interface RegistrationPackageFacts {
  displays: ReadonlyMap<number, PackageDisplay>;
  pricingByGroup: ReadonlyMap<number, RegistrationPackagePricing>;
}

type PackageRow = { attendee: { package_group_id: number } };

export type RegistrationNotification<Entry extends PackageRow> = (
  entries: Entry[],
  currency: string,
  suppliedFacts?: RegistrationPackageFacts,
) => Promise<void>;

export const loadRegistrationPackageFacts = async (
  rows: readonly PackageRow[],
): Promise<RegistrationPackageFacts> => {
  const groupIds = unique(
    mapNotNullish((row: PackageRow) =>
      row.attendee.package_group_id > 0 ? row.attendee.package_group_id : null,
    )(rows),
  );
  if (groupIds.length === 0) {
    return { displays: new Map(), pricingByGroup: new Map() };
  }
  const [displays, pricing] = await Promise.all([
    getPackageDisplaysByIds(groupIds),
    loadPackageMemberPricingByGroupIds(groupIds),
  ]);
  return {
    displays,
    pricingByGroup: new Map(
      [...pricing].map(([groupId, facts]) => [
        groupId,
        {
          dayPriceMap: facts.dayPrices,
          memberIds: new Set(facts.rows.map((row) => row.listing_id)),
          priceMap: facts.prices,
          quantityMap: facts.quantities,
        },
      ]),
    ),
  };
};
