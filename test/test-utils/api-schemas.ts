/**
 * valibot schemas mirroring the JSON API response shapes, for validating
 * responses in tests. Keeping them here lets every API test assert against one
 * canonical shape instead of re-deriving it (hand-rolled key checks or casts).
 */

import * as v from "valibot";
import { CONTACT_FIELDS } from "#shared/types.ts";
import { IsoDateSchema } from "#shared/validation/date.ts";
import { EmailSchema } from "#shared/validation/email.ts";

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

const NonEmpty = v.pipe(v.string(), v.trim(), v.nonEmpty());
const Slug = v.pipe(v.string(), v.slug());
const AtLeastOne = v.pipe(v.number(), v.integer(), v.minValue(1));
/** A price in minor units. Zero is a real price — a free item is a thing the
 * system sells — so only a negative one is wrong. */
const Price = v.pipe(v.number(), v.integer(), v.minValue(0));

/**
 * One member of a package bundle as `GET /api/packages/:slug` returns it. The
 * quantity is how many of that listing one bundle includes, so it is never
 * zero, and the slug has to be one a caller can actually ask for.
 */
/**
 * A published add-on, as a package member's `children` carry it. It is a public
 * listing, plus the values a caller has to be able to act on: a name and slug
 * to choose it by, a price, and room to actually book it.
 */
const PublishedChildSchema = v.intersect([
  PublicListingSchema,
  v.object({
    description: NonEmpty,
    fields: NonEmpty,
    listingType: NonEmpty,
    maxPrice: Price,
    maxPurchasable: AtLeastOne,
    name: NonEmpty,
    slug: Slug,
    unitPrice: Price,
  }),
]);

const PackageMemberSchema = v.strictObject({
  children: v.optional(v.pipe(v.array(PublishedChildSchema), v.nonEmpty())),
  name: NonEmpty,
  quantity: AtLeastOne,
  slug: Slug,
});

const packageBundleEntries = {
  availableDates: v.optional(v.array(IsoDateSchema)),
  description: NonEmpty,
  fields: NonEmpty,
  maxPurchasable: AtLeastOne,
  members: v.optional(v.pipe(v.array(PackageMemberSchema), v.nonEmpty())),
  name: NonEmpty,
  slug: Slug,
};

/**
 * A package bundle as `GET /api/packages/:slug` returns it. Every string a
 * caller reads or reuses must be filled in, and a bundle nobody can buy
 * (`maxPurchasable` of zero) is not something the documentation should show.
 *
 * A bundle carries exactly one way of pricing it — one price, or a price per
 * number of days — so a response showing both, or neither, would leave a
 * caller unable to say what the bundle costs.
 */
export const PackageResponseSchema = v.union([
  v.strictObject({ ...packageBundleEntries, priceMinor: Price }),
  v.strictObject({
    ...packageBundleEntries,
    dayCounts: v.pipe(
      v.array(v.strictObject({ days: AtLeastOne, priceMinor: Price })),
      v.nonEmpty(),
    ),
  }),
]);

/**
 * A booking request as `POST /api/packages/:slug/book` accepts it. The email
 * goes through the app's own email schema, so a documented example that would
 * be turned away cannot pass.
 */
export const PackageBookRequestSchema = v.strictObject({
  children: v.optional(v.array(v.unknown())),
  date: v.optional(IsoDateSchema),
  dayCount: v.optional(AtLeastOne),
  email: EmailSchema,
  name: NonEmpty,
  quantity: AtLeastOne,
  // The contact fields a package can ask for beyond the always-required name
  // and email. Which of them a booking must fill in is checked against the
  // package's own `fields` list, not here.
  ...v.entriesFromList(
    CONTACT_FIELDS.filter((field) => field !== "email"),
    v.optional(NonEmpty),
  ),
});

/**
 * A group as the admin API returns it: every stored field except the internal
 * lookup index, which is what `Omit<Group, "slug_index">` gives a caller.
 */
export const AdminGroupSchema = v.strictObject({
  description: v.string(),
  ...v.entriesFromList(
    ["hidden", "hide_package_listings", "is_package"],
    v.boolean(),
  ),
  id: AtLeastOne,
  // Zero is a real setting here: a group with no cap of its own.
  max_attendees: v.pipe(v.number(), v.integer(), v.minValue(0)),
  name: NonEmpty,
  slug: Slug,
  terms_and_conditions: v.string(),
});
