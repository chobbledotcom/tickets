/** Paid-booking behavior for attendee merges. */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  attendeeAccount,
  revenueAccount,
  WRITEOFF,
} from "#accounting/accounts.ts";
import { transfersByAccount } from "#accounting/queries.ts";
import { getDb } from "#db/client.ts";
import { bookingKey } from "#shared/merge/attendee-merge.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { runAndCountRoundTrips } from "#test-utils/query-log.ts";
import {
  applyMerge,
  buildMergeDiff,
  createAttendee,
  createAttendeeOn,
  pii,
  postPaidSale,
  runMerge,
} from "./helpers.ts";

const mergePaidSourceConflict = async (
  eventGroup: string,
  moneyChoice: "credit" | "writeoff",
  amount?: number,
) => {
  const listing = await createTestListing({ maxAttendees: 10 });
  const target = await createAttendee(listing.id, "Alice", "a@test.com");
  const source = await createAttendee(listing.id, "Bob", "b@test.com");
  await postPaidSale({
    ...(amount === undefined ? {} : { amount }),
    attendeeId: source.id,
    eventGroup,
    listingId: listing.id,
  });
  await getDb().execute({
    args: [eventGroup, source.id, listing.id],
    sql: "UPDATE listing_attendees SET ledger_event_group = ? WHERE attendee_id = ? AND listing_id = ?",
  });
  const key = bookingKey(listing.id, null, 0, 0);
  const { result } = await runMerge({
    decide: () => ({
      answers: {},
      bookings: { [key]: "keep_target" },
      money: { [key]: moneyChoice },
      pii: {},
    }),
    source,
    sourcePii: pii("Bob", "b@test.com"),
    target,
    targetPii: pii("Alice", "a@test.com"),
  });
  return { listing, result, target };
};

describeWithEnv("attendee merge service", { db: true }, () => {
  describe("applyAttendeeMerge money", () => {
    test("merges many paid duplicate bookings in a bounded number of round-trips", async () => {
      const bookingCount = 12;
      const listings: Awaited<ReturnType<typeof createTestListing>>[] = [];
      // Listing setup creates sessions, so it must stay sequential.
      for (let i = 0; i < bookingCount; i++) {
        listings.push(await createTestListing({ maxAttendees: 10 }));
      }
      const listingIds = listings.map(({ id }) => id);
      const target = await createAttendeeOn(
        listingIds,
        "Alice",
        "alice@test.com",
      );
      const source = await createAttendeeOn(listingIds, "Bob", "bob@test.com");
      for (const [index, listing] of listings.entries()) {
        const eventGroup = `evt${index}`;
        await postPaidSale({
          attendeeId: source.id,
          eventGroup,
          listingId: listing.id,
        });
        await getDb().execute({
          args: [eventGroup, source.id, listing.id],
          sql: "UPDATE listing_attendees SET ledger_event_group = ? WHERE attendee_id = ? AND listing_id = ?",
        });
      }

      const sourcePii = pii("Bob", "bob@test.com");
      const targetPii = pii("Alice", "alice@test.com");
      const diff = await buildMergeDiff({
        source,
        sourcePii,
        target,
        targetPii,
      });
      const bookings = Object.fromEntries(
        listings.map(({ id }) => [bookingKey(id, null, 0, 0), "keep_target"]),
      ) as Record<string, "keep_target">;
      const money = Object.fromEntries(
        listings.map(({ id }) => [bookingKey(id, null, 0, 0), "writeoff"]),
      ) as Record<string, "writeoff">;

      const { value: result, roundTrips } = await runAndCountRoundTrips(() =>
        applyMerge({
          decision: {
            answers: {},
            bookings,
            money,
            pii: {},
            version: diff.version,
          },
          diff,
          source,
          sourcePii,
          target,
          targetPii,
        }),
      );

      expect(result.summary.bookingsWrittenOff).toBe(bookingCount);
      expect(result.summary.bookingsCredited).toBe(0);
      expect(result.summary.bookingsSkipped).toBe(bookingCount);
      expect(roundTrips).toBeLessThanOrEqual(10);
    });

    test("credits the over-collected cash when a paid conflict is decided credit", async () => {
      const { listing, result, target } = await mergePaidSourceConflict(
        "credit-grp",
        "credit",
      );

      expect(result.summary.bookingsCredited).toBe(1);
      expect(result.summary.bookingsWrittenOff).toBe(0);
      const attendeeAdjustments = (
        await transfersByAccount(attendeeAccount(target.id))
      ).filter(({ kind }) => kind === "adjustment");
      expect(
        attendeeAdjustments.map(({ amount, destination, kind, source }) => ({
          amount,
          destination,
          kind,
          source,
        })),
      ).toEqual([
        {
          amount: 5000,
          destination: attendeeAccount(target.id),
          kind: "adjustment",
          source: WRITEOFF,
        },
      ]);
      const revenueAdjustments = (
        await transfersByAccount(revenueAccount(listing.id))
      ).filter(({ kind }) => kind === "adjustment");
      expect(
        revenueAdjustments.map(({ amount, destination, kind, source }) => ({
          amount,
          destination,
          kind,
          source,
        })),
      ).toEqual([
        {
          amount: 5000,
          destination: WRITEOFF,
          kind: "adjustment",
          source: revenueAccount(listing.id),
        },
      ]);
    });

    test("writes off a discarded booking whose sale is one minor unit", async () => {
      const { listing, result } = await mergePaidSourceConflict(
        "evt-1p",
        "writeoff",
        1,
      );

      expect(result.summary.bookingsWrittenOff).toBe(1);
      expect(result.summary.bookingsCredited).toBe(0);
      const adjustments = (
        await transfersByAccount(revenueAccount(listing.id))
      ).filter(({ kind }) => kind === "adjustment");
      expect(
        adjustments.map(({ amount, destination, source }) => ({
          amount,
          destination,
          source,
        })),
      ).toEqual([
        {
          amount: 1,
          destination: WRITEOFF,
          source: revenueAccount(listing.id),
        },
      ]);
    });
  });
});
