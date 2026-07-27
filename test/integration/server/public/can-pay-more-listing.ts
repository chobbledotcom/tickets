import { createTestListing } from "#test-utils/db-helpers/listings.ts";

/**
 * A £10 can_pay_more listing — the base setup shared by
 * `can-pay-more-single.test.ts` and `can-pay-more-multi.test.ts`. Colocated
 * here rather than duplicated across both files.
 */
export const payMoreListing = (overrides: Record<string, unknown> = {}) =>
  createTestListing({
    canPayMore: true,
    maxAttendees: 50,
    unitPrice: 1000,
    ...overrides,
  });
