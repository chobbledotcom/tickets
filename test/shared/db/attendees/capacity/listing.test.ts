/** The capacity singular path directly: one listing loads and is used, and an
 * absent id returns the caller's documented missing result. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  getListingGroupMembership,
  useListingById,
} from "#db/attendees/capacity/listing.ts";
import { assignListingsToGroup } from "#db/groups/membership/package-writes.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

describeWithEnv("db > capacity singular path", { db: true }, () => {
  test("uses the loaded listing", async () => {
    const listing = await createTestListing({ name: "Main hall" });

    const used = await useListingById(listing.id, "missing", (loaded) =>
      Promise.resolve(`using ${loaded.name}`),
    );
    expect(used).toBe("using Main hall");
  });

  test("returns the caller's missing result for an absent id", async () => {
    const used = await useListingById(999999, "missing", () =>
      Promise.resolve("never"),
    );
    expect(used).toBe("missing");
  });

  test("maps each listing to its group ids", async () => {
    const group = await createTestGroup({ name: "Weekend" });
    const listing = await createTestListing({ name: "Linked hall" });
    await assignListingsToGroup([listing.id], group.id);
    const lone = await createTestListing({ name: "Free hall" });

    const membership = await getListingGroupMembership([listing, lone]);
    expect(membership.get(listing.id)).toEqual([group.id]);
    expect(membership.get(lone.id)).toEqual([]);
  });
});
