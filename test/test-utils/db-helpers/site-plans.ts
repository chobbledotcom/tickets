import { createTestListing } from "#test-utils/db-helpers/listings.ts";

/** The hidden monthly tier a plan booking's validation requires. */
export const createTierListing = () =>
  createTestListing({
    hidden: true,
    monthsPerUnit: 1,
    purchaseOnly: true,
    unitPrice: 300,
  });

/** A site-plan listing the tests book buyers onto. */
export const planListing = (name: string) =>
  createTestListing({
    assignBuiltSite: true,
    initialSiteMonths: 3,
    maxAttendees: 100,
    name,
    unitPrice: 300,
  });
