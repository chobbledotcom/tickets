import type { EdgeListing } from "#shared/listing-parents-rules.ts";

/** A minimal compatible edge listing; `over` layers the field a test varies. */
export const edgeListing = (over: Partial<EdgeListing> = {}): EdgeListing => ({
  assignBuiltSite: false,
  customisableDays: false,
  dayPrices: {},
  durationDays: 1,
  id: 1,
  listingType: "standard",
  minQuantity: 1,
  monthsPerUnit: 0,
  name: "Test",
  ...over,
});
