import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type {
  BatchAvailabilityItem,
  ListingBooking,
} from "#db/attendee-types.ts";
import { checkBatchAvailabilityImpl as checkBatchAvailability } from "#db/attendees/capacity/checks.ts";
import { createAttendeeAtomicImpl as createAttendeeAtomic } from "#db/attendees/create.ts";
import { queryAll } from "#db/client.ts";
import { listingAggregates } from "#db/listings/aggregates.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";

/**
 * The read-time availability preflight (`checkBatchAvailability`) and the
 * write-time atomic capacity guard (`createAttendeeAtomic`'s INSERT…WHERE) must
 * agree: every cart the preflight admits must actually book, and every cart it
 * rejects must actually fail to book. These are two consumers of the SAME
 * capacity rules; this test pins them together so a future change to one that
 * diverges from the other fails CI rather than silently over/under-offering.
 *
 * The oracle is the real write: run the cart through `createAttendeeAtomic`
 * and check whether EVERY line landed (the unpaid batch path commits whatever
 * fits and reports success on a partial cart, so "all lines committed" — not
 * the success flag — is the fit question the preflight answers). The
 * fully-booked outcome must equal the preflight verdict for the same cart
 * against the same pre-write state.
 */
describeWithEnv(
  "db > attendees > availability preflight matches the write",
  { db: true },
  () => {
    /** Run the cart through both paths and assert they agree. Returns the
     * shared verdict so callers can additionally assert the expected outcome. */
    const assertConsistent = async (
      bookings: ListingBooking[],
      date?: string | null,
    ): Promise<boolean> => {
      const items: BatchAvailabilityItem[] = bookings.map((b) => ({
        listingId: b.listingId,
        quantity: b.quantity ?? 1,
        ...(b.durationDays !== undefined && { durationDays: b.durationDays }),
      }));
      const preflight = await checkBatchAvailability(items, date);
      const write = await createAttendeeAtomic({
        bookings,
        email: "x@example.com",
        name: "X",
      });
      // "Fully booked" — every cart line landed a row — is the fit question.
      // The unpaid batch path commits whatever fits and still reports success
      // on a partial cart, so the success flag alone would over-report.
      let fullyBooked = false;
      if (write.success) {
        const rows = await queryAll<{ c: number }>(
          "SELECT COUNT(*) AS c FROM listing_attendees WHERE attendee_id = ?",
          [write.attendees[0]!.id],
        );
        fullyBooked = rows[0]!.c === bookings.length;
      }
      expect(fullyBooked).toBe(preflight);
      return preflight;
    };

    test("a simple in-capacity cart is admitted and books", async () => {
      const listing = await createTestListing({ maxAttendees: 5 });
      expect(
        await assertConsistent([{ listingId: listing.id, quantity: 2 }]),
      ).toBe(true);
    });

    test("a single line over the listing cap is rejected and fails to book", async () => {
      const listing = await createTestListing({ maxAttendees: 3 });
      expect(
        await assertConsistent([{ listingId: listing.id, quantity: 4 }]),
      ).toBe(false);
    });

    /** A capped group with two standard members (each individually roomy at 10),
     * so only the SHARED group cap can constrain a cross-listing cart. */
    const groupWithTwoMembers = async (groupCap: number) => {
      const group = await createTestGroup({ maxAttendees: groupCap });
      const member = (): Promise<{ id: number }> =>
        createTestListing({ groupId: group.id, maxAttendees: 10 });
      return { a: await member(), b: await member() };
    };

    test("cross-listing demand on a shared group cap that fits exactly", async () => {
      const { a, b } = await groupWithTwoMembers(4);
      expect(
        await assertConsistent([
          { listingId: a.id, quantity: 2 },
          { listingId: b.id, quantity: 2 },
        ]),
      ).toBe(true);
    });

    test("cross-listing demand exceeding a shared group cap is rejected by BOTH", async () => {
      const { a, b } = await groupWithTwoMembers(4);
      // 2 + 3 = 5 against a group cap of 4: each line fits its OWN listing cap,
      // only the combined group demand overflows — the case a per-line check
      // would miss but the aggregated preflight and the sequential write catch.
      expect(
        await assertConsistent([
          { listingId: a.id, quantity: 2 },
          { listingId: b.id, quantity: 3 },
        ]),
      ).toBe(false);
    });

    test("a shared group already partly full, combined cart tips it over", async () => {
      const { a, b } = await groupWithTwoMembers(6);
      await bookAttendee(a, { quantity: 3 });
      // 3 already booked + a cart of 2 + 2 = 7 > 6.
      expect(
        await assertConsistent([
          { listingId: a.id, quantity: 2 },
          { listingId: b.id, quantity: 2 },
        ]),
      ).toBe(false);
    });

    /** A daily listing capped at 2, fully booked on `fullDate` (1-day booking).
     * `durationDays` sets the listing's bookable span for the cart under test. */
    const dailyListingFullOn = async (
      fullDate: string,
      durationDays?: number,
    ): Promise<{ id: number }> => {
      const listing = await createDailyTestListing({
        maxAttendees: 2,
        ...(durationDays !== undefined && { durationDays }),
      });
      await bookAttendee(listing, { date: fullDate, quantity: 2 });
      return listing;
    };

    /** One daily ticket on the cart date beside one undated standard ticket —
     * the smallest cart whose two lines a shared cap can bind together. */
    const dailyAndStandardCart = (
      dailyId: number,
      standardId: number,
    ): Promise<boolean> =>
      assertConsistent(
        [
          { date: "2026-05-01", listingId: dailyId, quantity: 1 },
          { listingId: standardId, quantity: 1 },
        ],
        "2026-05-01",
      );

    test("a mixed standard+daily dated cart agrees when the standard line is full", async () => {
      // The date must not leak into the standard line's counting: its running
      // total is what's full, on every date.
      const standard = await createTestListing({ maxAttendees: 2 });
      await bookAttendee(standard, { quantity: 2 });
      const daily = await createDailyTestListing({ maxAttendees: 5 });
      expect(await dailyAndStandardCart(daily.id, standard.id)).toBe(false);
    });

    test("daily per-date capacity agrees on a full date", async () => {
      const listing = await dailyListingFullOn("2026-05-01");
      expect(
        await assertConsistent(
          [{ date: "2026-05-01", listingId: listing.id, quantity: 1 }],
          "2026-05-01",
        ),
      ).toBe(false);
    });

    test("daily multi-day cart agrees when one day in the span is full", async () => {
      // The listing spans 3 days; day 2 of the span is already full.
      const listing = await dailyListingFullOn("2026-05-02", 3);
      expect(
        await assertConsistent(
          [
            {
              date: "2026-05-01",
              durationDays: 3,
              listingId: listing.id,
              quantity: 1,
            },
          ],
          "2026-05-01",
        ),
      ).toBe(false);
    });

    test("a date-less line on a daily member counts against the group's running total on both paths", async () => {
      // The daily member holds two booked units from another day, so its
      // running total is what tips the group cap. The write's date-less
      // statement counts every member's running total; the preflight must
      // run the same undated check beside its per-day one.
      const group = await createTestGroup({ maxAttendees: 3 });
      const daily = await createDailyTestListing({
        groupId: group.id,
        maxAttendees: 10,
      });
      const standard = await createTestListing({
        groupId: group.id,
        maxAttendees: 10,
      });
      await bookAttendee(daily, { date: "2026-05-05", quantity: 2 });

      expect(await dailyAndStandardCart(daily.id, standard.id)).toBe(false);
    });

    test("a zero-quantity line books on an over-full listing and both paths agree", async () => {
      // The no-op line demands nothing, so the preflight admits the cart and
      // the write lands every row. The listing's running total sits past its
      // cap, which today refuses the write the preflight passed.
      const listing = await createTestListing({ maxAttendees: 2 });
      await bookAttendee(listing, { quantity: 2 });
      await listingAggregates.update(listing.id, {
        booked_quantity: 5,
        tickets_count: 0,
      });
      expect(
        await assertConsistent([{ listingId: listing.id, quantity: 0 }]),
      ).toBe(true);
    });
  },
);
