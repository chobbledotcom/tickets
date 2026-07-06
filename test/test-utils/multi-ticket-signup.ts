import {
  expectAttendeeCounts,
  expectReservedRedirectWithTokens,
} from "#test-utils/assertions.ts";

/** Book two free listings in one multi-ticket POST — two of the first, one of
 *  the second — and confirm both attendees were reserved. The caller passes a
 *  `submit` that already knows the pair of slugs plus the buyer's name/email,
 *  and receives back only the per-listing quantities to fold in; the two suites
 *  address the slug pair differently (array join vs a `+` string), so the shared
 *  part is just the quantities and the two assertions. */
export const bookTwoFreeListings = async (
  submit: (quantities: Record<string, string>) => Promise<Response>,
  listing1: { id: number },
  listing2: { id: number },
): Promise<void> => {
  const response = await submit({
    [`quantity_${listing1.id}`]: "2",
    [`quantity_${listing2.id}`]: "1",
  });
  expectReservedRedirectWithTokens(response);
  await expectAttendeeCounts([
    { count: 1, listingId: listing1.id, quantity: 2 },
    { count: 1, listingId: listing2.id, quantity: 1 },
  ]);
};
