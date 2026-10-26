/**
 * Example catalog-transfer blobs for the admin guide.
 *
 * A test parses each one with the real {@link CatalogTransferSchema}, so a
 * format change breaks the test and forces this example and the guide to be
 * updated. That is what stops a second, hand-maintained copy.
 *
 * The two examples are cross-consistent: the listing belongs to the "Weekend
 * Pass" group, and that group lists it as a member.
 */

import {
  CATALOG_TRANSFER_VERSION,
  type CatalogBundle,
  type GroupTransfer,
  type ListingTransfer,
} from "#routes/admin/catalog-transfer/schema.ts";

/**
 * A listing export/import blob. Shows the listing's own transferable columns
 * (prices are in the smallest currency unit — pence/cents) and its membership
 * of a package group. The membership carries per-member price and quantity
 * overrides.
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

/** A transfer without its envelope fields: the item shape a bundle holds. */
const transferBodyOf = <T extends { kind: string; version: number }>(
  transfer: T,
): Omit<T, "kind" | "version"> => {
  const { kind, version, ...body } = transfer;
  return body;
};

/**
 * A bundle blob: many listings and groups in one document. It carries the two
 * single-file examples as items, with the envelope fields (kind, version)
 * held once at the top. The listing references the bundle's own group by
 * name, and the group lists the bundle's own listings as members — the
 * relationships resolve inside the document, so the import creates the whole
 * subtree even when the target site holds none of it yet.
 */
export const CATALOG_BUNDLE_EXAMPLE: CatalogBundle = {
  groups: [transferBodyOf(CATALOG_GROUP_EXAMPLE)],
  kind: "bundle",
  listings: [transferBodyOf(CATALOG_LISTING_EXAMPLE)],
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

/** The bundle example rendered as pretty-printed JSON for the guide. */
export const CATALOG_BUNDLE_EXAMPLE_JSON: string = JSON.stringify(
  CATALOG_BUNDLE_EXAMPLE,
  null,
  2,
);
