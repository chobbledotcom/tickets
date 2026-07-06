/**
 * Shared "set up this exact payment situation" helpers for the payment-flow and
 * webhook tests. Each one builds a small world (a sold-out listing, a hidden
 * package) that several tests across different files were spelling out by hand.
 */

import { groupsTable } from "#shared/db/groups.ts";
import type { Group, Listing } from "#shared/types.ts";
import {
  bookAttendee,
  createTestGroup,
  createTestListing,
} from "#test-utils/db-helpers.ts";
import type { TestListingOverrides } from "#test-utils/factories.ts";
import { setupStripe } from "#test-utils/settings.ts";

/**
 * A paid listing with its single spot already taken, so the next booking finds
 * it sold out. Turns on Stripe, makes a 1-spot £10 listing, and books the first
 * buyer into it — the arrange step every "sold out after payment" test shares.
 */
export const arrangeSoldOutListing = async (): Promise<Listing> => {
  await setupStripe();
  const listing = await createTestListing({
    maxAttendees: 1,
    unitPrice: 1000,
  });
  await bookAttendee(listing, {
    email: "first@example.com",
    name: "First",
    paymentId: "pi_first",
  });
  return listing;
};

/**
 * A package group that hides its own listings, plus one member listing inside
 * it. Pass overrides for the member (its name, price, capacity, ...). The tests
 * that refund or 404 a hidden package's member all start from this shape.
 */
export const createHiddenPackage = async (
  memberOverrides: TestListingOverrides = {},
  groupName = "Bundle",
): Promise<{ group: Group; member: Listing }> => {
  const group = await createTestGroup({ isPackage: true, name: groupName });
  await groupsTable.update(group.id, { hidePackageListings: true });
  const member = await createTestListing({
    groupId: group.id,
    ...memberOverrides,
  });
  return { group, member };
};
