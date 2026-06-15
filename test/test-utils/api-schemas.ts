/**
 * valibot schemas mirroring the JSON API response shapes, for validating
 * responses in tests. Keeping them here lets every API test assert against one
 * canonical shape instead of re-deriving it (hand-rolled key checks or casts).
 */

import * as v from "valibot";

/**
 * Shape of a public listing as returned by the JSON API (mirrors the production
 * `PublicListing` type from `#routes/api/index.ts`). `strictObject` rejects any
 * unexpected key, so a leaked internal field (id, max_attendees, hidden, …)
 * fails the parse. JSON object keys are strings, so `dayPrices` is keyed by
 * string here. `entriesFromList` groups same-typed fields to keep it compact.
 */
export const PublicListingSchema = v.strictObject({
  ...v.entriesFromList(
    ["description", "fields", "listingType", "name", "slug"],
    v.string(),
  ),
  ...v.entriesFromList(["maxPrice", "maxPurchasable", "unitPrice"], v.number()),
  ...v.entriesFromList(
    [
      "canPayMore",
      "customisableDays",
      "isClosed",
      "isSoldOut",
      "nonTransferable",
      "purchaseOnly",
    ],
    v.boolean(),
  ),
  ...v.entriesFromList(
    ["date", "imageUrl", "location"],
    v.nullable(v.string()),
  ),
  availableDates: v.optional(v.array(v.string())),
  dayPrices: v.optional(v.record(v.string(), v.number())),
});
