import {
  expectAttendeeCounts,
  expectReservedRedirectWithTokens,
} from "#test-utils/assertions.ts";

/**
 * Asserts a multi-listing booking reserved both listings — one attendee each,
 * the first at quantity 2 and the second at quantity 1.
 */
export const expectBothReservedAtTwoAndOne = async (
  response: Response,
  listing1: { id: number },
  listing2: { id: number },
): Promise<void> => {
  expectReservedRedirectWithTokens(response);
  await expectAttendeeCounts([
    { count: 1, listingId: listing1.id, quantity: 2 },
    { count: 1, listingId: listing2.id, quantity: 1 },
  ]);
};
