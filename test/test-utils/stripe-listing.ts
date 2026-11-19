/** A listing on a site with Stripe configured — the fixture a checkout
 *  callback or a running-total quote starts from. */

import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import type { TestListingOverrides } from "#test-utils/factories.ts";
import { setupStripe } from "#test-utils/settings.ts";
import type { ListingWithCount } from "#types";

/** Configure Stripe, then create the listing the case quotes or replays. */
export const createStripeListing = async (
  overrides: TestListingOverrides = {},
): Promise<ListingWithCount> => {
  await setupStripe();
  return await createTestListing(overrides);
};
