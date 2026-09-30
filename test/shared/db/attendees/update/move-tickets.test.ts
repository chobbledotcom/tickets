import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { TicketDirection } from "#booking/ticket-moves.ts";
import { moveTickets } from "#db/attendees/update.ts";
import { executeUpdate, queryOne } from "#db/client.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

describeWithEnv(
  "db > attendees > admit and release tickets",
  { db: true },
  () => {
    const attendeeOnListing = async (quantity = 2) => {
      const listing = await createTestListing({
        maxAttendees: 100,
        maxQuantity: 10,
      });
      const { attendee } = await createTestAttendeeDirect(
        listing.id,
        "Check User",
        "check@example.com",
        quantity,
      );
      return { attendee, listing };
    };

    const storedCheckedIn = async (
      attendeeId: number,
      listingId: number,
    ): Promise<number> => {
      const row = await queryOne<{ checked_in: number }>(
        "SELECT checked_in FROM listing_attendees WHERE attendee_id = ? AND listing_id = ?",
        [attendeeId, listingId],
      );
      return row!.checked_in;
    };

    /** Move `count` tickets one way on the person's line, then name the
     * count the line holds afterwards. */
    const movesTo =
      (direction: TicketDirection, attendeeId: number, listingId: number) =>
      async (count: number, stored: number): Promise<void> => {
        await moveTickets(direction, [{ attendeeId, count, listingId }]);
        expect(await storedCheckedIn(attendeeId, listingId)).toBe(stored);
      };

    test("admit adds tickets up to the line's quantity", async () => {
      const { listing, attendee } = await attendeeOnListing(2);
      const admit = movesTo("admit", attendee.id, listing.id);

      await admit(1, 1);
      await admit(1, 2);
    });

    test("admit caps at the line's quantity, so a full line stays full", async () => {
      const { listing, attendee } = await attendeeOnListing(2);
      const admit = movesTo("admit", attendee.id, listing.id);

      await admit(2, 2);
      await admit(5, 2);
    });

    test("release removes tickets and floors at zero", async () => {
      const { listing, attendee } = await attendeeOnListing(2);
      await movesTo("admit", attendee.id, listing.id)(2, 2);
      const release = movesTo("release", attendee.id, listing.id);

      await release(1, 1);
      await release(2, 0);
    });

    test("a quantity 0 line never admits and never releases", async () => {
      const { listing, attendee } = await attendeeOnListing(2);
      await executeUpdate(
        "listing_attendees",
        { quantity: 0 },
        { attendee_id: attendee.id, listing_id: listing.id },
      );

      await movesTo("admit", attendee.id, listing.id)(2, 0);
      await movesTo("release", attendee.id, listing.id)(2, 0);
    });

    test("answers the tickets each move really moved", async () => {
      const { listing, attendee } = await attendeeOnListing(3);
      const move = { attendeeId: attendee.id, listingId: listing.id };
      await moveTickets("admit", [{ ...move, count: 2 }]);

      // Only one ticket is left, so asking for three admits one, and the
      // answer names what the line still owes afterwards.
      expect(await moveTickets("admit", [{ ...move, count: 3 }])).toEqual([
        { ...move, count: 1, owedAfter: 0 },
      ]);
      expect(await moveTickets("release", [{ ...move, count: 5 }])).toEqual([
        { ...move, count: 3, owedAfter: 3 },
      ]);
    });

    test("moves several people in one call, each on their own line", async () => {
      const { listing, attendee } = await attendeeOnListing(2);
      const { attendee: other } = await createTestAttendeeDirect(
        listing.id,
        "Other User",
        "other@example.com",
        2,
      );

      await moveTickets("admit", [
        { attendeeId: attendee.id, count: 1, listingId: listing.id },
        { attendeeId: other.id, count: 2, listingId: listing.id },
      ]);
      expect(await storedCheckedIn(attendee.id, listing.id)).toBe(1);
      expect(await storedCheckedIn(other.id, listing.id)).toBe(2);
    });
  },
);
