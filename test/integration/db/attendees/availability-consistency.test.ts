import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type {
  BatchAvailabilityItem,
  ListingBooking,
} from "#db/attendee-types.ts";
import { checkBatchAvailabilityImpl as checkBatchAvailability } from "#db/attendees/capacity/checks.ts";
import { createAttendeeAtomicImpl as createAttendeeAtomic } from "#db/attendees/create.ts";
import { execute, queryAll } from "#db/client.ts";
import { sql } from "#db/sql.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import {
  dailyListingBesideBookedStandard,
  dailyListingBooked,
  groupWithDailyAndStandardMember,
  groupWithMembers,
  setStoredBookedQuantity,
} from "#test-utils/db-helpers/capacity-fixtures.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { expectWriteRefused } from "#test-utils/db-helpers/refused-booking.ts";

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
    /** Run the cart through both paths and assert they agree on `fits`: every
     * line books when the cart fits, and the write lands nothing when it does
     * not. */
    const expectConsistent = async (
      bookings: ListingBooking[],
      fits: boolean,
      date?: string | null,
    ): Promise<void> => {
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
          sql`SELECT COUNT(*) AS c FROM listing_attendees WHERE attendee_id = ${write.attendees[0]!.id}`,
        );
        fullyBooked = rows[0]!.c === bookings.length;
      }
      expect(preflight).toBe(fits);
      expect(fullyBooked).toBe(fits);
    };

    /** One line on a listing that no group caps, so the listing cap alone
     * decides. */
    for (const { cap, fits, name, quantity } of [
      {
        cap: 5,
        fits: true,
        name: "a simple in-capacity cart is admitted and books",
        quantity: 2,
      },
      {
        cap: 3,
        fits: false,
        name: "a single line over the listing cap is rejected and fails to book",
        quantity: 4,
      },
    ]) {
      test(name, async () => {
        const listing = await createTestListing({ maxAttendees: cap });
        await expectConsistent([{ listingId: listing.id, quantity }], fits);
      });
    }

    /** Two standard members of one capped group, each individually roomy at
     * 10, so only the SHARED group cap can constrain a cross-listing cart. */
    for (const { demand, fits, name } of [
      {
        demand: [2, 2],
        fits: true,
        name: "cross-listing demand on a shared group cap that fits exactly",
      },
      {
        demand: [2, 3],
        fits: false,
        name: "cross-listing demand exceeding a shared group cap is rejected by BOTH",
      },
    ]) {
      test(name, async () => {
        const { members } = await groupWithMembers({ cap: 4, count: 2 });
        const [a, b] = members;
        // Each line fits its OWN listing cap; only the combined group demand
        // overflows the cap of 4 — the case a per-line check would miss but
        // the aggregated preflight and the sequential write catch.
        await expectConsistent(
          [
            { listingId: a!.id, quantity: demand[0]! },
            { listingId: b!.id, quantity: demand[1]! },
          ],
          fits,
        );
      });
    }

    test("a shared group already partly full, combined cart tips it over", async () => {
      const { members } = await groupWithMembers({ cap: 6, count: 2 });
      const [a, b] = members;
      await bookAttendee(a!, { quantity: 3 });
      // 3 already booked + a cart of 2 + 2 = 7 > 6.
      await expectConsistent(
        [
          { listingId: a!.id, quantity: 2 },
          { listingId: b!.id, quantity: 2 },
        ],
        false,
      );
    });

    /** One daily ticket on the cart date beside one undated standard ticket —
     * the smallest cart whose two lines a shared cap can bind together. */
    const expectDailyAndStandardCart = (
      dailyId: number,
      standardId: number,
      fits: boolean,
    ): Promise<void> =>
      expectConsistent(
        [
          { date: "2026-05-01", listingId: dailyId, quantity: 1 },
          { listingId: standardId, quantity: 1 },
        ],
        fits,
        "2026-05-01",
      );

    test("a mixed standard+daily dated cart agrees when the standard line is full", async () => {
      // The date must not leak into the standard line's counting: its running
      // total is what's full, on every date.
      const { daily, standard } = await dailyListingBesideBookedStandard({
        booked: 2,
        standardCap: 2,
      });
      await expectDailyAndStandardCart(daily.id, standard.id, false);
    });

    test("daily per-date capacity agrees on a full date", async () => {
      const listing = await dailyListingBooked({
        booked: [{ day: "2026-05-01", quantity: 2 }],
        maxAttendees: 2,
      });
      await expectConsistent(
        [{ date: "2026-05-01", listingId: listing.id, quantity: 1 }],
        false,
        "2026-05-01",
      );
    });

    test("daily multi-day cart agrees when one day in the span is full", async () => {
      // The listing spans 3 days; day 2 of the span is already full.
      const listing = await dailyListingBooked({
        booked: [{ day: "2026-05-02", quantity: 2 }],
        durationDays: 3,
        maxAttendees: 2,
      });
      await expectConsistent(
        [
          {
            date: "2026-05-01",
            durationDays: 3,
            listingId: listing.id,
            quantity: 1,
          },
        ],
        false,
        "2026-05-01",
      );
    });

    test("a date-less line on a daily member counts against the group's running total on both paths", async () => {
      // The daily member holds two booked units from another day, so its
      // running total is what tips the group cap. The write's date-less
      // statement counts every member's running total; the preflight must
      // run the same undated check beside its per-day one.
      const { daily, standard } = await groupWithDailyAndStandardMember(3);
      await bookAttendee(daily, { date: "2026-05-05", quantity: 2 });

      await expectDailyAndStandardCart(daily.id, standard.id, false);
    });

    test("a zero-quantity line books on an over-full listing and both paths agree", async () => {
      // The no-op line demands nothing, so the preflight admits the cart and
      // the write lands every row, however far past its cap the running
      // total sits.
      const listing = await createTestListing({ maxAttendees: 2 });
      await bookAttendee(listing, { quantity: 2 });
      await setStoredBookedQuantity(listing.id, 5);
      await expectConsistent([{ listingId: listing.id, quantity: 0 }], true);
    });

    test("a multi-day dated daily line beside a standard line counts the dated units once on both paths", async () => {
      // The two-day daily line bumps the group's running total once; the
      // standard line's undated guard reads one unit from it, not one per
      // occupied day. Both lines write against a group cap of 2.
      const { daily, standard } = await groupWithDailyAndStandardMember(2);
      await expectConsistent(
        [
          {
            date: "2026-05-01",
            durationDays: 2,
            listingId: daily.id,
            quantity: 1,
          },
          { listingId: standard.id, quantity: 1 },
        ],
        true,
        "2026-05-01",
      );
    });

    test("a zero-quantity line refuses when its listing row is gone", async () => {
      // The no-op line demands no places, but it still names a listing that
      // must exist: listing_attendees has no foreign key, so an unconditional
      // insert would commit an orphan row when a listing is deleted between
      // validation and the write. The preflight refuses a missing listing
      // outright, so this pins the write side alone.
      const listing = await createTestListing({ maxAttendees: 2 });
      await execute(sql`DELETE FROM listings WHERE id = ${listing.id}`);
      await expectWriteRefused({ listingId: listing.id, quantity: 0 });
    });
  },
);
