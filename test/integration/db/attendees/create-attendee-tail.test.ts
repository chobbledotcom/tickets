import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { createAttendeeAtomicImpl as createAttendeeAtomic } from "#db/attendees/create.ts";
import { getAttendeesRaw } from "#db/attendees/queries.ts";
import { queryAll } from "#db/client.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { expectNoAttendeesForListings } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

/** The caller-supplied writes a reservation can ride on the atomic create:
 * creation work on the interactive transaction, or tail statements on the
 * plain batch — never both (no production caller combines them). */
describeWithEnv(
  "db > attendees > createAttendeeAtomic caller writes",
  { db: true },
  () => {
    test("runs caller creation work inside the create transaction", async () => {
      const listing = await createTestListing({ maxAttendees: 5 });

      const result = await createAttendeeAtomic(
        {
          bookings: [{ listingId: listing.id, quantity: 1 }],
          email: "work@example.com",
          name: "Work User",
        },
        (tx, attendeeId) =>
          tx
            .execute({
              args: [attendeeId],
              sql: "UPDATE attendees SET checked_in = 'worked' WHERE id = ?",
            })
            .then(() => undefined),
      );

      expect(result.success).toBe(true);
      // The work ran on the create transaction itself: its write committed
      // with the booking, on the attendee the batch created.
      const attendees = await getAttendeesRaw(listing.id);
      expect(attendees).toHaveLength(1);
      expect(
        await queryAll("SELECT checked_in FROM attendees WHERE id = ?", [
          attendees[0]!.id,
        ]),
      ).toEqual([{ checked_in: "worked" }]);
    });

    test("rolls the booking and the creation work back when the work fails", async () => {
      const listing = await createTestListing({ maxAttendees: 5 });

      await expect(
        createAttendeeAtomic(
          {
            bookings: [{ listingId: listing.id, quantity: 1 }],
            email: "work-fail@example.com",
            name: "Work Fail",
          },
          async (tx) => {
            // A write the caller makes before its failure must not survive.
            await tx.execute({
              args: [],
              sql: `INSERT INTO strings (text_index, encrypted_text, created)
                  VALUES ('work-marker', 'x', 'now')`,
            });
            throw new Error("creation work boom");
          },
        ),
      ).rejects.toThrow("creation work boom");

      // The attendee, the booking, and the work's own write are all absent.
      await expectNoAttendeesForListings([listing.id]);
      expect(
        await queryAll(
          "SELECT id FROM strings WHERE text_index = 'work-marker'",
        ),
      ).toEqual([]);
    });

    test("commits caller tail statements with the booking batch", async () => {
      const listing = await createTestListing({ maxAttendees: 5 });

      const result = await createAttendeeAtomic(
        {
          bookings: [{ listingId: listing.id, quantity: 1 }],
          email: "tail@example.com",
          name: "Tail User",
        },
        undefined,
        (tokenIndex) => [
          {
            args: [tokenIndex],
            sql: `UPDATE attendees SET checked_in = 'tail'
                WHERE ticket_token_index = ?`,
          },
        ],
      );

      expect(result.success).toBe(true);
      // The tail statement landed on the attendee the batch itself created.
      expect(
        await queryAll<{ checked_in: string }>(
          "SELECT checked_in FROM attendees WHERE id IN (SELECT attendee_id FROM listing_attendees WHERE listing_id = ?)",
          [listing.id],
        ),
      ).toEqual([{ checked_in: "tail" }]);
    });

    test("rolls the whole booking back when a tail statement fails", async () => {
      const listing = await createTestListing({ maxAttendees: 5 });

      await expect(
        createAttendeeAtomic(
          {
            bookings: [{ listingId: listing.id, quantity: 1 }],
            email: "tail-fail@example.com",
            name: "Tail Fail",
          },
          undefined,
          () => [
            {
              args: [],
              sql: `INSERT INTO strings (text_index, encrypted_text, created)
                  VALUES (NULL, 'x', 'now')`,
            },
          ],
        ),
      ).rejects.toThrow("NOT NULL constraint failed: strings.text_index");

      // Nothing from the batch survived the failed tail.
      await expectNoAttendeesForListings([listing.id]);
    });
  },
);
