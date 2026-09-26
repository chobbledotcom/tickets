/** The pieces every site-assignment suite shares: the plan-listing entry and
 * the renewal-tier teardown both the assignment and config tests need. */
import { getAllListings } from "#db/listings/records.ts";
import { deactivateTestListing } from "#test-utils/db-helpers/listings.ts";
import { makeTestEntry } from "#test-utils/factories.ts";

/** Deactivate every active, hidden, purchase-only, monthly listing — the
 *  "renewal tier" set — so tests can exercise the no-qualifying-tier path. */
export const deactivateAllTierListings = async (): Promise<void> => {
  const listings = await getAllListings();
  for (const ev of listings) {
    if (ev.months_per_unit > 0 && ev.purchase_only && ev.hidden && ev.active) {
      await deactivateTestListing(ev.id);
    }
  }
};

/** Build an entry with assign_built_site for testing */
export const siteEntry = (
  overrides: {
    listingId?: number;
    listingName?: string;
    assignBuiltSite?: boolean;
    initialSiteMonths?: number;
    attendeeId?: number;
    quantity?: number;
    email?: string;
  } = {},
) =>
  makeTestEntry(
    {
      assign_built_site: overrides.assignBuiltSite ?? true,
      initial_site_months: overrides.initialSiteMonths ?? 3,
      ...(overrides.listingId !== undefined && { id: overrides.listingId }),
      ...(overrides.listingName !== undefined && {
        name: overrides.listingName,
      }),
    },
    {
      ...(overrides.attendeeId !== undefined && { id: overrides.attendeeId }),
      ...(overrides.email !== undefined && { email: overrides.email }),
      ...(overrides.quantity !== undefined && {
        quantity: overrides.quantity,
      }),
    },
  );
