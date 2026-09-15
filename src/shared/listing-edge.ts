/** The would-be edge row a listing form input projects onto, with each
 *  optional field defaulted the way the form layer does. Shared by the listing
 *  save's edge validation and the catalog import so the defaults never drift. */

import type { ListingInput } from "#shared/catalog-fields/fields.ts";
import type { EdgeListing } from "#shared/listing-parents-rules.ts";
import { clampDurationDays, type DayPricedListing } from "#types";

/** The day-count pricing fields of a listing form input, each optional field
 *  defaulted the way the form layer does. Shared by the edge-compatibility shape
 *  and the catalog import's member-price check so the defaults never drift. */
export const dayPriceFieldsFromInput = (
  input: ListingInput,
): DayPricedListing => ({
  customisable_days: input.customisableDays ?? false,
  day_prices: input.dayPrices ?? {},
  duration_days: clampDurationDays(input.durationDays ?? 1),
});

/** Project a (possibly partial) listing form input onto the edge-compatibility
 *  shape for the row it would become, defaulting each optional field as the form
 *  layer does. */
export const listingInputToEdge = (
  input: ListingInput,
  id: number,
): EdgeListing => ({
  ...dayPriceFieldsFromInput(input),
  assign_built_site: input.assignBuiltSite ?? false,
  id,
  listing_type: input.listingType ?? "standard",
  months_per_unit: input.monthsPerUnit ?? 0,
  name: input.name,
});
