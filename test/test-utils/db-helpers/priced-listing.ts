import type { TestListingOverrides } from "#test-utils/factories.ts";
import type { ListingWithCount } from "#types";
import { createTestListing } from "./listings.ts";

/** A standard listing priced at 500 with room for ten — the fixture behind the
 *  QR-token mint cases and every stats case that needs a priced listing.
 *  `overrides` carry what a case varies besides those two: a capacity, a free
 *  price, or a quantity cap. */
export const createPricedListing = (
  overrides: TestListingOverrides = {},
): Promise<ListingWithCount> =>
  createTestListing({ maxAttendees: 10, unitPrice: 500, ...overrides });
