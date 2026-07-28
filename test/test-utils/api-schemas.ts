/**
 * valibot schemas mirroring the JSON API response shapes, for validating
 * responses in tests. Keeping them here lets every API test assert against one
 * canonical shape instead of re-deriving it (hand-rolled key checks or casts).
 */

import * as v from "valibot";

/**
 * Shape of a public listing as returned by the JSON API (mirrors the production
 * `PublicListing` type from `#routes/api/public-listing.ts`). `strictObject` rejects any
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
    ["date", "imageAltText", "imageUrl", "location"],
    v.nullable(v.string()),
  ),
  availableDates: v.optional(v.array(v.string())),
  dayPrices: v.optional(v.record(v.string(), v.number())),
});

/**
 * Shape of a listing as returned by the admin JSON API (mirrors the production
 * `AdminListing` type). Written out by hand rather than derived from
 * `toAdminListing`, so it can catch a change that both the function and its
 * documented example would make together. `strictObject` rejects any
 * unexpected key, which is what keeps the internal `slug_index` out of every
 * admin response.
 */
export const AdminListingSchema = v.strictObject({
  ...v.entriesFromList(
    [
      "attachment_name",
      "attachment_url",
      "created",
      "date",
      "description",
      "fields",
      "image_alt_text",
      "image_thumb_url",
      "image_url",
      "listing_type",
      "location",
      "name",
      "slug",
      "thank_you_url",
      "webhook_url",
    ],
    v.string(),
  ),
  ...v.entriesFromList(
    [
      "attendee_count",
      "cost",
      "duration_days",
      "id",
      "income",
      "initial_site_months",
      "max_attendees",
      "max_price",
      "max_quantity",
      "maximum_days_after",
      "minimum_days_before",
      "months_per_unit",
      "profit",
      "tickets_count",
      "unit_price",
    ],
    v.number(),
  ),
  ...v.entriesFromList(
    [
      "active",
      "assign_built_site",
      "bookable_alone",
      "can_pay_more",
      "customisable_days",
      "hidden",
      "non_transferable",
      "purchase_only",
      "use_defaults",
      "uses_logistics",
    ],
    v.boolean(),
  ),
  bookable_days: v.array(v.string()),
  closes_at: v.nullable(v.string()),
  day_prices: v.record(v.string(), v.number()),
  /** The groups the listing is in, added to every admin response. */
  group_ids: v.array(v.number()),
});
