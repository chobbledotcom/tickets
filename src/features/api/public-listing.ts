import { compact } from "#fp";
import { isRegistrationClosed } from "#routes/format.ts";
import {
  buildTicketListing,
  type TicketListing,
} from "#shared/booking/model.ts";
import { getAvailableDates } from "#shared/dates.ts";
import { getGroupRemainingForListing } from "#shared/db/attendees/capacity.ts";
import { getActiveHolidays } from "#shared/db/holidays.ts";
import { getChildrenForParents } from "#shared/db/listing-parents.ts";
import {
  availableDayCounts,
  dayPriceFor,
  type ListingWithCount,
} from "#shared/types.ts";

/** The plain listing fields shared by the public API shape and the syndication
 * feed item — name, slug, description, and the optional event date. */
export type CoreListingFields = {
  name: string;
  slug: string;
  description: string;
  date: string | null;
};

export type PublicListing = CoreListingFields & {
  location: string | null;
  /** Filename of the listing's primary image, or `null` when it has none. Like
   * `date`/`location`, the model's empty-string convention is normalised to
   * `null` at this API boundary so clients can branch on absence uniformly. */
  imageUrl: string | null;
  /** Operator-provided alt text for `imageUrl`, or `null` when unset. Lets
   * API-driven storefronts render the image accessibly. */
  imageAltText: string | null;
  unitPrice: number;
  canPayMore: boolean;
  maxPrice: number;
  nonTransferable: boolean;
  purchaseOnly: boolean;
  fields: string;
  listingType: string;
  /** True when visitors choose how many days to book; price comes from
   * `dayPrices` rather than `unitPrice`. */
  customisableDays: boolean;
  /** Offered day counts mapped to their price (minor units). Present only for
   * customisable-days listings. */
  dayPrices?: Record<number, number>;
  isSoldOut: boolean;
  isClosed: boolean;
  maxPurchasable: number;
  availableDates?: string[];
  /** The required children a buyer must choose from when booking this listing as
   * a parent (per-unit; the chosen quantities total the parent quantity). Present
   * only on the detail endpoint for a parent listing, so a client knows which
   * child slugs, prices, and inputs are valid before calling the booking POST. */
  children?: PublicListing[];
};

/** `groupRemaining`, when defined, clamps the displayed sold-out state to
 * the group's combined cap. The sold-out/max-purchasable core is the shared
 * {@link buildTicketListing} (the same availability projection the web cards and
 * the parent-sold-out discovery path use), so the API and the web never compute
 * "is this listing bookable, and how many?" differently. */
export const toPublicListing = (
  listing: ListingWithCount,
  closed: boolean,
  availableDates: string[] | undefined,
  groupRemaining: number | undefined,
): PublicListing =>
  resolvedToPublicListing(
    { ...buildTicketListing(listing, closed, groupRemaining), listing },
    availableDates,
  );

/** The public shape of an ALREADY availability-resolved {@link TicketListing}
 * (the booking ctx hydrates members and their children once — no re-query). */
export const resolvedToPublicListing = (
  resolved: TicketListing,
  availableDates: string[] | undefined,
): PublicListing => {
  const { isClosed: closed, isSoldOut, listing, maxPurchasable } = resolved;
  const result: PublicListing = {
    canPayMore: listing.can_pay_more,
    customisableDays: listing.customisable_days,
    date: listing.date || null,
    description: listing.description,
    fields: listing.fields,
    imageAltText: listing.image_alt_text || null,
    imageUrl: listing.image_url || null,
    isClosed: closed,
    isSoldOut,
    listingType: listing.listing_type,
    location: listing.location || null,
    maxPrice: listing.max_price,
    maxPurchasable,
    name: listing.name,
    nonTransferable: listing.non_transferable,
    purchaseOnly: listing.purchase_only,
    slug: listing.slug,
    unitPrice: listing.unit_price,
  };

  if (availableDates) {
    result.availableDates = availableDates;
  }

  if (listing.customisable_days) {
    // availableDayCounts only yields priced counts, so dayPriceFor is non-null.
    result.dayPrices = Object.fromEntries(
      availableDayCounts(listing).map((n) => [n, dayPriceFor(listing, n)!]),
    );
  }

  return result;
};

/** Resolve a listing row to its public shape, filling in the closed flag and the
 * group-remaining clamp from the listing itself (the caller supplies only the
 * availableDates, which differ per surface). The single place the API turns a row
 * into a {@link PublicListing} with its live availability. */
export const toResolvedPublicListing = async (
  listing: ListingWithCount,
  availableDates: string[] | undefined,
): Promise<PublicListing> =>
  toPublicListing(
    listing,
    isRegistrationClosed(listing),
    availableDates,
    await getGroupRemainingForListing(listing),
  );

/** Map a parent's required children to a per-child result, or null when the
 * listing is not a parent (no child edges) so the caller can omit the field. The
 * one place the API loads a parent's children for a response, so the detail and
 * availability surfaces never drift on which children they report. */
export const mapParentChildren = async <T>(
  parent: ListingWithCount,
  map: (child: ListingWithCount) => T | Promise<T>,
): Promise<T[] | null> => {
  const children =
    (await getChildrenForParents([parent.id])).get(parent.id) ?? [];
  return children.length === 0 ? null : Promise.all(children.map(map));
};

/** The public shape of each required child of a parent, for the detail endpoint.
 * Children carry their own price/inputs/availability so a client can pick a valid
 * one (and pay the right amount) before booking; a daily child reports its own
 * bookable start dates. Empty array for a non-parent listing.
 *
 * An inactive (`active=0`) child is omitted: `toPublicListing` doesn't
 * expose `active`, so an inactive child with spare capacity would otherwise read
 * `isClosed:false` with a positive `maxPurchasable` while the booking fold
 * rejects it (`childActive` in shared.tsx) — so the detail endpoint must not
 * advertise a child the booking POST refuses, the same `active` predicate the
 * availability endpoint (`buildChildAvailability`) already applies. */
export const buildChildPublicListings = async (
  parent: ListingWithCount,
): Promise<PublicListing[]> =>
  compact(
    (await mapParentChildren(parent, async (child) =>
      child.active
        ? toResolvedPublicListing(
            child,
            child.listing_type === "daily"
              ? getAvailableDates(child, await getActiveHolidays())
              : undefined,
          )
        : null,
    )) ?? [],
  );
