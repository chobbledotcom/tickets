import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { settleAttendeeBalance } from "#shared/db/attendees/balance.ts";
import {
  incrementAttachmentDownloads,
  markRefunded,
  updateCheckedIn,
} from "#shared/db/attendees/update.ts";
import { execute } from "#shared/db/client.ts";
import { getAllListings, getListingWithCount } from "#shared/db/listings.ts";
import {
  createPaidTestAttendee,
  createTestListing,
  describeWithEnv,
} from "#test-utils";

/**
 * These tests pin the behaviour that used to require a manual
 * invalidateListingsCache() in every attendee write path (and whose omission in
 * settleAttendeeBalance was a real staleness bug): a write to listing_attendees
 * must make the listings cache serve fresh aggregate columns, driven entirely by
 * the db-client layer with no explicit invalidate call.
 */
describeWithEnv(
  "db > auto cache invalidation",
  { db: true, triggers: true },
  () => {
    test("a new booking refreshes the cached listing aggregates", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 500,
      });

      await createPaidTestAttendee(
        listing.id,
        "Alice",
        "alice@example.com",
        "pay_1",
        1000,
      );
      // Warm the isolate-level listings cache with the post-first-booking state.
      const afterFirst = (await getAllListings()).find(
        (e) => e.id === listing.id,
      )!;
      expect(afterFirst.tickets_count).toBe(1);
      expect(afterFirst.income).toBe(1000);

      // A second booking writes listing_attendees through the create path, which
      // no longer calls invalidateListingsCache — the client must invalidate it.
      await createPaidTestAttendee(
        listing.id,
        "Bob",
        "bob@example.com",
        "pay_2",
        2000,
      );
      const afterSecond = (await getAllListings()).find(
        (e) => e.id === listing.id,
      )!;
      expect(afterSecond.tickets_count).toBe(2);
      expect(afterSecond.income).toBe(3000);
    });

    test("markRefunded does not invalidate the listings cache", async () => {
      const listing = await createTestListing({
        maxAttendees: 10,
        unitPrice: 0,
      });
      const attendee = await createPaidTestAttendee(
        listing.id,
        "Dave",
        "dave@example.com",
        "",
        0,
      );
      // Warm the cache.
      const before = (await getAllListings()).find((e) => e.id === listing.id)!;
      expect(before.tickets_count).toBe(1);

      await markRefunded(attendee.id, listing.id);

      // Cache must not be cleared: same tickets_count, no re-fetch.
      const after = (await getAllListings()).find((e) => e.id === listing.id)!;
      expect(after.tickets_count).toBe(1);
      expect(after).toBe(before); // same cached reference
    });

    test("updateCheckedIn does not invalidate the listings cache", async () => {
      const listing = await createTestListing({
        maxAttendees: 10,
        unitPrice: 0,
      });
      const attendee = await createPaidTestAttendee(
        listing.id,
        "Eve",
        "eve@example.com",
        "",
        0,
      );
      const before = (await getAllListings()).find((e) => e.id === listing.id)!;
      expect(before.tickets_count).toBe(1);

      await updateCheckedIn(attendee.id, listing.id, true);

      const after = (await getAllListings()).find((e) => e.id === listing.id)!;
      expect(after).toBe(before); // same cached reference
    });

    test("incrementAttachmentDownloads does not invalidate the listings cache", async () => {
      const listing = await createTestListing({
        maxAttendees: 10,
        unitPrice: 0,
      });
      const attendee = await createPaidTestAttendee(
        listing.id,
        "Frank",
        "frank@example.com",
        "",
        0,
      );
      const before = (await getAllListings()).find((e) => e.id === listing.id)!;

      await incrementAttachmentDownloads(attendee.id, listing.id);

      const after = (await getAllListings()).find((e) => e.id === listing.id)!;
      expect(after).toBe(before); // same cached reference
    });

    test("settling a balance leaves listing income unchanged (gross at sale)", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 500,
      });
      const attendee = await createPaidTestAttendee(
        listing.id,
        "Carol",
        "carol@example.com",
        "pay_3",
        1000,
      );
      // Give the attendee an outstanding balance to settle.
      await execute("UPDATE attendees SET remaining_balance = ? WHERE id = ?", [
        500,
        attendee.id,
      ]);

      // Warm the by-id cache entry before the settlement write.
      const before = (await getListingWithCount(listing.id))!;
      expect(before.income).toBe(1000);

      const result = await settleAttendeeBalance(attendee.id, 500);
      expect(result.settled).toBe(true);

      // A balance payment is cash settling the receivable, not new revenue, so a
      // listing's gross income — recognised in full at sale — does not move.
      const after = (await getListingWithCount(listing.id))!;
      expect(after.income).toBe(1000);
    });
  },
);
