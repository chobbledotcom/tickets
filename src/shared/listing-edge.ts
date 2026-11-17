/** The edge row a listing form input projects onto, with each optional field
 *  defaulted the way the form layer does. Shared by the listing save's edge
 *  validation and the catalog import so the defaults never drift. */

import type { EdgeListing } from "#shared/listing-parents-rules.ts";
import type { ListingInput } from "#shared/records/listing-fields.ts";
import { clampDurationDays, type DayPricedListing } from "#types";

/** The day-count pricing fields of a listing form input, each optional field
 *  defaulted the way the form layer does. Shared by the edge-compatibility shape
 *  and the catalog import's member-price check so the defaults never drift. */
export const dayPriceFieldsFromInput = (
  input: ListingInput,
): DayPricedListing => ({
  customisableDays: input.customisableDays ?? false,
  dayPrices: input.dayPrices ?? {},
  durationDays: clampDurationDays(input.durationDays ?? 1),
});

/** Project a (possibly partial) listing form input onto the edge-compatibility
 *  shape for the row it becomes. Default each optional field as the form layer
 *  does. */
export const listingInputToEdge = (
  input: ListingInput,
  id: number,
): EdgeListing => ({
  ...dayPriceFieldsFromInput(input),
  assignBuiltSite: input.assignBuiltSite ?? false,
  id,
  listingType: input.listingType ?? "standard",
  minQuantity: input.minQuantity ?? 1,
  monthsPerUnit: input.monthsPerUnit ?? 0,
  name: input.name,
});
