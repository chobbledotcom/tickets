import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { listingChildren } from "#shared/db/listing-parents.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { expectReserved, postBooking } from "#test-utils/parents.ts";

describeWithEnv(
  "server > parents booking — Stage B shared child",
  { db: true, triggers: true },
  () => {
    test(
      "Stage B: free booking of a child under two parents creates" +
        " two rows with distinct parentListingId",
      async () => {
        // The buyer books parentA (qty 1) and parentB (qty 1) in one cart.
        // Both require the same shared child. expandChildAllocations
        // splits the folded child into two listing_attendees rows (one per
        // parent), each carrying the correct parentListingId.
        const child = await createTestListing({
          maxAttendees: 10,
          maxQuantity: 10,
          name: "stage-b-child",
        });
        const parentA = await createTestListing({
          maxAttendees: 10,
          maxQuantity: 10,
          name: "stage-b-parentA",
        });
        await listingChildren.setIds(parentA.id, [child.id]);
        const parentB = await createTestListing({
          maxAttendees: 10,
          maxQuantity: 10,
          name: "stage-b-parentB",
        });
        await listingChildren.setIds(parentB.id, [child.id]);

        const slugs = `${parentA.slug}+${parentB.slug}`;
        const res = await postBooking(slugs, {
          email: "stageB@example.com",
          name: "Stage B",
          [`quantity_${parentA.id}`]: "1",
          [`quantity_${parentB.id}`]: "1",
          [`child_qty_${parentA.id}_${child.id}`]: "1",
          [`child_qty_${parentB.id}_${child.id}`]: "1",
        });
        expectReserved(res);

        // Extract the ticket token from the redirect location.
        const location = res.headers.get("location")!;
        const rawToken = location.split("tokens=")[1]!;
        const ticketToken = decodeURIComponent(rawToken);
        const { getAttendeesByTokens } = await import(
          "#shared/db/attendees/tokens.ts"
        );
        const [attendee] = await getAttendeesByTokens([ticketToken]);
        const bookings = attendee!.bookings;

        // The attendee has 4 rows: parentA, parentB, child-under-A,
        // child-under-B.
        expect(bookings.length).toBe(4);
        const childBookings = bookings.filter((b) => b.listing_id === child.id);
        expect(childBookings.length).toBe(2);
        // Each child row links to a distinct parent.
        const parentIds = childBookings.map((b) => b.parent_listing_id);
        expect(parentIds).toContain(parentA.id);
        expect(parentIds).toContain(parentB.id);
        // Each child allocation has qty 1.
        expect(childBookings.every((b) => b.quantity === 1)).toBe(true);
        // All 4 rows share one order_token.
        const token = bookings[0]!.order_token;
        expect(token).toBeTruthy();
        expect(bookings.every((b) => b.order_token === token)).toBe(true);
      },
    );
  },
);
