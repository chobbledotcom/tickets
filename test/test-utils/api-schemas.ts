/**
 * valibot schemas mirroring the JSON API response shapes, for validating
 * responses in tests. Keeping them here lets every API test assert against one
 * canonical shape instead of re-deriving it (hand-rolled key checks or casts).
 */

import * as v from "valibot";
import { CONTACT_FIELDS, DayPricesSchema } from "#shared/types.ts";
import { IsoDateSchema } from "#shared/validation/date.ts";
import { EmailSchema } from "#shared/validation/email.ts";

/**
 * Shape of a public listing as returned by the JSON API (mirrors the production
 * `PublicListing` type from `#routes/api/public-listing.ts`). `strictObject` rejects any
 * unexpected key, so a leaked internal field (id, max_attendees, hidden, …)
 * fails the parse. JSON object keys are strings, so `dayPrices` is keyed by
 * string here. `entriesFromList` groups same-typed fields to keep it compact.
 */
const publicListingEntries = {
  ...v.entriesFromList(
    ["description", "fields", "listingType", "name", "slug"],
    v.string(),
  ),
  ...v.entriesFromList(["maxPrice", "maxPurchasable", "unitPrice"], v.number()),
  ...v.entriesFromList(
    ["canPayMore", "isClosed", "isSoldOut", "nonTransferable", "purchaseOnly"],
    v.boolean(),
  ),
  ...v.entriesFromList(
    ["date", "imageAltText", "imageUrl", "location"],
    v.nullable(v.string()),
  ),
  availableDates: v.optional(v.array(IsoDateSchema)),
};

/** Only a listing sold by the day is asked for the dates it is free, so any
 * other kind carrying them is an answer the endpoints never give. */
const datesOnlyWhenDaily = (listing: {
  availableDates?: unknown;
  listingType: string;
}): boolean =>
  listing.availableDates === undefined || listing.listingType === "daily";

/** A public listing, plus whatever extra the surface adds. A listing sold by
 * the day always prices its day counts, and one sold by the unit never does,
 * so the two are told apart by the flag itself. */
const publicListing = <E extends v.ObjectEntries>(extra: E) =>
  v.union([
    v.pipe(
      v.strictObject({
        ...publicListingEntries,
        ...extra,
        customisableDays: v.literal(false),
      }),
      v.check(datesOnlyWhenDaily),
    ),
    v.pipe(
      v.strictObject({
        ...publicListingEntries,
        ...extra,
        customisableDays: v.literal(true),
        // The same shape the prices are stored in, so a day count the system
        // could never price is refused here too.
        dayPrices: DayPricesSchema,
      }),
      v.check(datesOnlyWhenDaily),
    ),
  ]);

export const PublicListingSchema = publicListing({});

/**
 * A listing as the API returns it on its own page, where a parent also carries
 * the add-ons a buyer must choose from. An add-on cannot itself have add-ons —
 * the app does not offer two levels of nesting — so this shape is one deep.
 */
export const PublicListingDetailSchema = publicListing({
  children: v.optional(v.array(PublicListingSchema)),
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

/** A bundle lists each of its parts once: a listing can only be in a group
 * once, and two listings cannot share a slug. */
const oneEntryPerSlug = <T extends { slug: string }>(entries: T[]): boolean =>
  new Set(entries.map((entry) => entry.slug)).size === entries.length;

/**
 * A published add-on, as a package member's `children` carry it. It is a public
 * listing, plus the values a caller has to be able to act on: a name and slug
 * to choose it by, a price, and room to actually book it.
 */
const PublishedChildSchema = v.intersect([
  PublicListingSchema,
  v.object({
    // An add-on may be sold without a description, like the bundle itself.
    description: v.string(),
    // An empty list is the real "name and email only" setting.
    fields: v.string(),
    listingType: NonEmpty,
    maxPrice: Price,
    // Room for none is real: a sold-out add-on is published with a capacity of
    // zero. The add-on a booking chooses is checked for room separately.
    maxPurchasable: v.pipe(v.number(), v.integer(), v.minValue(0)),
    name: NonEmpty,
    slug: Slug,
    unitPrice: Price,
  }),
]);

/**
 * One member of a package bundle as `GET /api/packages/:slug` returns it. The
 * quantity is how many of that listing one bundle includes, so it is never
 * zero, and the slug has to be one a caller can actually ask for.
 */
const PackageMemberSchema = v.strictObject({
  children: v.optional(
    v.pipe(
      v.array(PublishedChildSchema),
      v.nonEmpty(),
      v.check(oneEntryPerSlug),
    ),
  ),
  name: NonEmpty,
  quantity: AtLeastOne,
  slug: Slug,
});

const packageBundleEntries = {
  availableDates: v.optional(v.array(IsoDateSchema)),
  // A bundle may be sold without a description; the operator chooses.
  description: v.string(),
  // An empty list is the real "name and email only" setting.
  fields: v.string(),
  maxPurchasable: AtLeastOne,
  members: v.optional(
    v.pipe(
      v.array(PackageMemberSchema),
      v.nonEmpty(),
      v.check(oneEntryPerSlug),
    ),
  ),
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
    // An empty list is the endpoint's way of saying no length can be booked
    // right now, so it is a real answer rather than a missing one.
    dayCounts: v.pipe(
      v.array(v.strictObject({ days: AtLeastOne, priceMinor: Price })),
      // The endpoint prices each length once, so two prices for one length
      // would leave a caller unable to say what that length costs.
      v.check(
        (counts) =>
          new Set(counts.map(({ days }) => days)).size === counts.length,
      ),
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

const groupEntries = {
  description: v.string(),
  ...v.entriesFromList(["hidden", "hide_package_listings"], v.boolean()),
  id: AtLeastOne,
  // Zero is a real setting here: a group with no cap of its own.
  max_attendees: v.pipe(v.number(), v.integer(), v.minValue(0)),
  name: NonEmpty,
  slug: Slug,
  terms_and_conditions: v.string(),
};

/** One priced member of a package group, as the admin API hydrates it. Only a
 * member with repriced spans carries `day_prices`. */
const AdminPackageMemberSchema = v.strictObject({
  // Present only on a member with repriced spans: the API leaves it out
  // rather than sending an empty map.
  day_prices: v.optional(
    v.pipe(
      v.record(v.string(), v.pipe(v.number(), v.integer(), v.minValue(0))),
      v.check((spans) => Object.keys(spans).length > 0),
    ),
  ),
  listing_id: v.pipe(v.number(), v.integer(), v.minValue(1)),
  price: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0))),
  quantity: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

/**
 * A group as the admin API returns it. A package group also carries the
 * members it prices, which the API adds to every package response — an empty
 * list when no member has an override — so the two shapes are told apart by
 * the flag itself.
 */
export const AdminGroupSchema = v.union([
  v.strictObject({ ...groupEntries, is_package: v.literal(false) }),
  v.strictObject({
    ...groupEntries,
    is_package: v.literal(true),
    package_members: v.array(AdminPackageMemberSchema),
  }),
]);
