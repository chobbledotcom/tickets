import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { moveTickets } from "#db/attendees/update.ts";
import { executeUpdate, queryOne } from "#db/client.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
import { createTestListingDirect } from "#test-utils/db-helpers/listings.ts";

describeWithEnv(
  "db > attendees > admit and release tickets",
  { db: true },
  () => {
    const attendeeOnListing = async (quantity = 2) => {
      const listing = await createTestListingDirect({
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

    /** A two-place line on a fresh listing, named the way the moves name it. */
    const twoPlaceLine = async (): Promise<{
      attendeeId: number;
      listingId: number;
    }> => {
      const { listing, attendee } = await attendeeOnListing(2);
      return { attendeeId: attendee.id, listingId: listing.id };
    };

    test("admit adds tickets up to the line's quantity", async () => {
      const { attendeeId, listingId } = await twoPlaceLine();
      const first = await moveTickets("admit", [
        { attendeeId, count: 1, listingId },
      ]);
      expect(first[0]!.count).toBe(1);
      expect(first[0]!.owedAfter).toBe(1);
      const second = await moveTickets("admit", [
        { attendeeId, count: 1, listingId },
      ]);
      expect(second[0]!.owedAfter).toBe(0);
    });

    test("admit caps at the line's quantity, so a full line stays full", async () => {
      const line = await twoPlaceLine();
      await moveTickets("admit", [{ ...line, count: 2 }]);
      const capped = await moveTickets("admit", [{ ...line, count: 5 }]);
      expect(capped[0]!.count).toBe(0);
      expect(await storedCheckedIn(line.attendeeId, line.listingId)).toBe(2);
    });

    test("release removes tickets and floors at zero", async () => {
      const line = await twoPlaceLine();
      await moveTickets("admit", [{ ...line, count: 2 }]);
      await moveTickets("release", [{ ...line, count: 1 }]);
      expect(await storedCheckedIn(line.attendeeId, line.listingId)).toBe(1);
      await moveTickets("release", [{ ...line, count: 2 }]);
      expect(await storedCheckedIn(line.attendeeId, line.listingId)).toBe(0);
    });

    test("a quantity 0 line never admits and never releases", async () => {
      const line = await twoPlaceLine();
      await executeUpdate(
        "listing_attendees",
        { quantity: 0 },
        { attendee_id: line.attendeeId, listing_id: line.listingId },
      );
      const noMove = [{ ...line, count: 0, owedAfter: 0 }];
      expect(await moveTickets("admit", [{ ...line, count: 2 }])).toEqual(
        noMove,
      );
      expect(await moveTickets("release", [{ ...line, count: 2 }])).toEqual(
        noMove,
      );
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
