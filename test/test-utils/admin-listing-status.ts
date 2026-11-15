import { expect } from "@std/expect";
import { assertJson } from "#test-utils/assertions.ts";
import { apiRequest } from "#test-utils/session.ts";

/** Deactivate one listing through the admin JSON API and assert the response
 *  reports the stored row as inactive. The stored row itself is not re-read. */
export const expectApiDeactivation = async (
  listingId: number,
): Promise<void> => {
  await assertJson(
    apiRequest(`/api/admin/listings/${listingId}/deactivate`, {
      method: "POST",
    }),
    200,
    (body) => {
      expect(body.listing.active).toBe(false);
    },
  );
};
