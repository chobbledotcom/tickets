import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { MAX_BOOKING_ATTEMPTS } from "#shared/limits.ts";
import {
  apiBookPackage,
  describePackageBooking,
} from "#test/features/api/packages/helpers.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

describePackageBooking(() => {
  test("POST rate-limits bookings after too many attempts from one IP", async () => {
    // Roomy capacity so the bundle stays bookable for every pre-limit attempt.
    const group = await createTestGroup({
      isPackage: true,
      name: "Limit Kit",
      slug: "limit-kit",
    });
    await createTestListing({
      groupId: group.id,
      maxAttendees: 100,
      maxQuantity: 100,
      name: "Limit Kit Member",
      unitPrice: 100,
    });
    // All test requests share the "direct" fallback IP, so the per-IP counter
    // fills up. The first MAX_BOOKING_ATTEMPTS succeed; the next is blocked.
    for (let i = 0; i < MAX_BOOKING_ATTEMPTS; i++) {
      const { response } = await apiBookPackage(group.slug, {
        email: `limit${i}@test.com`,
        name: `Limit ${i}`,
        quantity: 1,
      });
      expect(response.status).toBe(200);
    }
    const { body, response } = await apiBookPackage(group.slug, {
      email: "blocked@test.com",
      name: "Blocked",
      quantity: 1,
    });
    expect(response.status).toBe(429);
    expect(body.error).toMatch(/too many/i);
  });
});
