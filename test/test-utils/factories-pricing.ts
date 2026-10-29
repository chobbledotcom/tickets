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
 *  only spells out the fields it varies (e.g. `lines`, `extras`). The tax
 *  assessment's total is the order's listed total, the number a reservation's
 *  unpaid balance reads, so it stays derived from the lines' list prices. */
export const pricedOrder = (
  overrides: Partial<PricedOrder> = {},
): PricedOrder => {
  const lines = overrides.lines ?? [];
  const modifierApplications = overrides.modifierApplications ?? [];
  return {
    extras: [],
    lines,
    modifierApplications,
    tax: assessTax(
      {
        lines: Array.from(lineTotalsByListingId(lines, lineListPrice)).map(
          ([listingId, gross]) => ({ gross, listingId }),
        ),
        modifiers: modifierApplications.map(({ modifierId, delta }) => ({
          delta,
          modifierId,
        })),
      },
      NO_TAX,
    ),
    total: 0,
    ...overrides,
  };
};
