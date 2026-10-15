import type { WebhookBookingSource } from "#db/contact-tokens.ts";
import {
  getPackageDisplaysByIds,
  loadPackageMemberPricingByGroupIds,
  type PackageDisplay,
} from "#db/groups.ts";
import { mapNotNullish, unique } from "#fp";

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

export type RegistrationDeliveryResult = { failed: boolean };

export class RegistrationDeliveryError extends Error {
  constructor(
    readonly failed: boolean,
    readonly reasons: readonly unknown[],
    /** Whether the buyer's own confirmation delivery failed. The email side
     * sets both split fields when it knows the per-message outcomes. A send
     * that threw before any delivery was attempted leaves them false. */
    readonly buyerFailed = false,
    readonly ownerFailed = false,
  ) {
    super("Unexpected registration delivery failure");
  }
}

const registrationDeliveryResult = (
  deliveries: readonly { delivered: boolean }[],
): RegistrationDeliveryResult => ({
  failed: deliveries.some(({ delivered }) => !delivered),
});

export const waitForRegistrationDeliveries = async <
  Delivery extends { delivered: boolean },
>(
  deliveries: Promise<Delivery>[],
  enrichError?: (error: RegistrationDeliveryError) => RegistrationDeliveryError,
): Promise<RegistrationDeliveryResult> => {
  const results = await Promise.allSettled(deliveries);
  const delivery = registrationDeliveryResult(
    results
      .filter((result) => result.status === "fulfilled")
      .map((result) => result.value),
  );
  const reasons = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (reasons.length > 0) {
    const error = new RegistrationDeliveryError(delivery.failed, reasons);
    throw enrichError ? enrichError(error) : error;
  }
  return delivery;
};

export type RegistrationNotification<Entry extends PackageRow> = (
  entries: Entry[],
  currency: string,
  source: WebhookBookingSource,
  suppliedFacts?: RegistrationPackageFacts,
) => Promise<RegistrationDeliveryResult>;

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
