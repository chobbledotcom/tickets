import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { setupStripe } from "#test-utils/settings.ts";

type TestListing = Awaited<ReturnType<typeof createTestListing>>;

/**
 * Enables Stripe, makes a paid listing with a single spot, and fills that spot,
 * so a later booking of the same listing fails as sold out. Returns the listing.
 */
export const fillSoldOutListing = async (): Promise<TestListing> => {
  await setupStripe();
  const listing = await createTestListing({
    maxAttendees: 1,
    thankYouUrl: "https://example.com",
    unitPrice: 1000,
  });
  await bookAttendee(listing, {
    email: "first@example.com",
    name: "First",
    paymentId: "pi_first",
  });
  return listing;
};
