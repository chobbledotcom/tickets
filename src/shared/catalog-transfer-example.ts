/**
 * Example catalog-transfer blobs for the admin guide.
 *
 * A test parses each one with the real {@link CatalogTransferSchema}, so a
 * format change breaks the test and forces this example and the guide to be
 * updated. That is what keeps it from becoming a hand-maintained second copy.
 *
 * The two examples are cross-consistent: the listing belongs to the "Weekend
 * Pass" group, and that group lists it as a member.
 */

import {
  CATALOG_TRANSFER_VERSION,
  type GroupTransfer,
  type ListingTransfer,
} from "#routes/admin/catalog-transfer/schema.ts";

/**
 * A listing export/import blob. Shows the listing's own transferable columns
 * (prices are in the smallest currency unit — pence/cents) and its membership of
 * a package group, with per-member price and quantity overrides.
 *
 * `parents` is empty here on purpose: this listing is a member of the "Weekend
 * Pass" package, and the importer forbids a package member from also being an
 * add-on child of another listing — so a member with parents is a shape the
 * importer would reject. The `parents` array is where a non-package listing
 * would name the listings it is offered under.
 */
export const CATALOG_LISTING_EXAMPLE: ListingTransfer = {
  groups: [{ group: "Weekend Pass", packagePrice: 1000, quantity: 2 }],
  kind: "listing",
  listing: {
    description: "A hands-on watercolours and sketching workshop.",
    fields: "email,phone",
    listingType: "standard",
    location: "Village Hall",
    maxAttendees: 20,
    maxPrice: 0,
    maxQuantity: 5,
    name: "Summer Workshop",
    unitPrice: 1500,
  },
  parents: [],
  version: CATALOG_TRANSFER_VERSION,
};

/**
 * A group export/import blob. Shows a bookable package (`isPackage`) that hides
 * its member listings from the public list, its own capacity, and its member
 * listings referenced by name — each carrying its package-price, quantity, and
 * per-day-count price overrides.
 */
export const CATALOG_GROUP_EXAMPLE: GroupTransfer = {
  group: {
    description: "Both days of the festival at one price.",
    hidePackageListings: true,
    isPackage: true,
    maxAttendees: 50,
    name: "Weekend Pass",
  },
  kind: "group",
  members: [
    { listing: "Summer Workshop", packagePrice: 1000, quantity: 2 },
    { dayPrices: { "1": 500 }, listing: "Evening Social" },
  ],
  version: CATALOG_TRANSFER_VERSION,
};

/** The listing example rendered as pretty-printed JSON for the guide. */
export const CATALOG_LISTING_EXAMPLE_JSON: string = JSON.stringify(
  CATALOG_LISTING_EXAMPLE,
  null,
  2,
);

/** The group example rendered as pretty-printed JSON for the guide. */
export const CATALOG_GROUP_EXAMPLE_JSON: string = JSON.stringify(
  CATALOG_GROUP_EXAMPLE,
  null,
  2,
);
