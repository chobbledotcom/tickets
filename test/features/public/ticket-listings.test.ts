import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { buildTicketListingsWithGroupCapacity } from "#routes/public/ticket-listings.ts";
import { getActiveListingsByGroupId } from "#shared/db/groups.ts";
import {
  bookAttendee,
  createTestGroup,
  createTestListing,
  deactivateTestListing,
  describeWithEnv,
} from "#test-utils";

describeWithEnv("routes > public > ticket-listings", { db: true }, () => {
  describe("buildTicketListingsWithGroupCapacity", () => {
    test("clamps spots to group remaining for standard listings", async () => {
      const group = await createTestGroup({
        maxAttendees: 4,
        name: "with-cap",
        slug: "with-cap-1",
      });
      const e1 = await createTestListing({
        groupId: group.id,
        maxAttendees: 10,
        maxQuantity: 10,
        name: "with-cap-a",
      });
      const e2 = await createTestListing({
        groupId: group.id,
        maxAttendees: 10,
        maxQuantity: 10,
        name: "with-cap-b",
      });
      await bookAttendee(e1, { email: "x@test.com", name: "X" });

      const listings = await getActiveListingsByGroupId(group.id);
      const ticketListings =
        await buildTicketListingsWithGroupCapacity(listings);
      const eb = ticketListings.find((t) => t.listing.id === e2.id)!;
      expect(eb.maxPurchasable).toBe(3);
      expect(eb.isSoldOut).toBe(false);
    });

    test("does not clamp when group is daily", async () => {
      const group = await createTestGroup({
        maxAttendees: 1,
        name: "daily-no-clamp",
        slug: "daily-no-clamp",
      });
      const e1 = await createTestListing({
        groupId: group.id,
        listingType: "daily",
        maxAttendees: 10,
        maxQuantity: 5,
        name: "daily-a",
      });

      const listings = await getActiveListingsByGroupId(group.id);
      const [ticketListing] =
        await buildTicketListingsWithGroupCapacity(listings);
      expect(ticketListing!.maxPurchasable).toBe(5);
      expect(ticketListing!.isSoldOut).toBe(false);
      expect(ticketListing!.listing.id).toBe(e1.id);
    });

    test("counts attendees on inactive sibling listings toward group cap", async () => {
      const group = await createTestGroup({
        maxAttendees: 4,
        name: "inactive-sibling",
        slug: "inactive-sibling",
      });
      const inactive = await createTestListing({
        groupId: group.id,
        maxAttendees: 10,
        maxQuantity: 10,
        name: "inactive-listing",
      });
      const active = await createTestListing({
        groupId: group.id,
        maxAttendees: 10,
        maxQuantity: 10,
        name: "active-listing",
      });
      await bookAttendee(inactive, { email: "p@test.com", name: "P" });
      await bookAttendee(inactive, { email: "q@test.com", name: "Q" });
      await deactivateTestListing(inactive.id);

      const listings = await getActiveListingsByGroupId(group.id);
      expect(listings.map((e) => e.id)).toEqual([active.id]);
      const [ticketListing] =
        await buildTicketListingsWithGroupCapacity(listings);
      expect(ticketListing!.maxPurchasable).toBe(2);
    });
  });
});
