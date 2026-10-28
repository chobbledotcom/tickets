import {
  lineListPrice,
  lineTotalsByListingId,
  type PricedLine,
  type PricedOrder,
} from "#shared/checkout-pricing.ts";
import { assessTax } from "#shared/tax/assessment.ts";
import { NO_TAX } from "#shared/tax/types.ts";

/** Factory for a {@link PricedLine}: `chargedUnitAmount` defaults to `unitPrice`
 *  but can be overridden to test discount/non-discount pricing paths. */
export const pricedLine = (
  listingId: number,
  unitPrice: number,
  quantity: number,
  chargedUnitAmount = unitPrice,
): PricedLine => ({
  chargedUnitAmount,
  item: {
    listingId,
    name: `L${listingId}`,
    quantity,
    slug: `l${listingId}`,
    unitPrice,
  },
  quantity,
});

/** Factory for a {@link PricedOrder}: all totals default to zero so a test
 *  only spells out the fields it varies (e.g. `lines`, `extras`). */
export const pricedOrder = (
  overrides: Partial<PricedOrder> = {},
): PricedOrder => ({
  extras: [],
  lines: [],
  modifierApplications: [],
  tax: assessTax(
    {
      lines: [
        ...lineTotalsByListingId(overrides.lines ?? [], lineListPrice),
      ].map(([listingId, gross]) => ({ gross, listingId })),
      modifiers: (overrides.modifierApplications ?? []).map(
        ({ modifierId, delta }) => ({ delta, modifierId }),
      ),
    },
    NO_TAX,
  ),
  total: 0,
  ...overrides,
});
