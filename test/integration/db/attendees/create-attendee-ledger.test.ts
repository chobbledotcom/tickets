import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  attendeeAccount,
  revenueAccount,
  WORLD,
} from "#accounting/accounts.ts";
import { mapBooking } from "#accounting/mappers.ts";
import {
  accountBalance,
  allTransfers,
  transfersByAccount,
} from "#accounting/queries.ts";
import { postTransfersTx } from "#accounting/store.ts";
import { attendeesApi } from "#db/attendees/api.ts";
import { loadExistingLines } from "#db/attendees/atomic-update.ts";
import { getAttendeesRaw } from "#db/attendees/queries.ts";
import { type TxScope, withTransaction } from "#db/client.ts";
import { postBookingLegsTx } from "#shared/checkout-complete.ts";
import type { TransferInput } from "#shared/ledger/types.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

const saleAndPayment = (
  listingId: number,
  attendeeId: number,
): TransferInput[] => [
  {
    amount: 5000,
    destination: revenueAccount(listingId),
    eventGroup: "evt-1",
    occurredAt: "2026-06-21T00:00:00.000Z",
    reference: "sale",
    source: attendeeAccount(attendeeId),
  },
  {
    amount: 5000,
    destination: attendeeAccount(attendeeId),
    eventGroup: "evt-1",
    occurredAt: "2026-06-21T00:00:00.000Z",
    reference: "pay",
    source: WORLD,
  },
];

describeWithEnv(
  "db > attendees > createAttendeeAtomic + ledger",
  { db: true },
  () => {
    test("posts the ledger legs atomically with the booking", async () => {
      const listing = await createTestListing({ maxAttendees: 5 });
      const postLedger = async (
        tx: TxScope,
        attendeeId: number,
      ): Promise<void> => {
        await postTransfersTx(tx, saleAndPayment(listing.id, attendeeId));
      };

      const result = await attendeesApi.createAttendeeAtomic(
        {
          bookings: [{ listingId: listing.id, quantity: 1 }],
          email: "a@b.c",
          name: "A",
        },
        postLedger,
      );

      expect(result.success).toBe(true);
      if (!result.success) return;
      const attendeeId = result.attendees[0]!.id;
      expect(await accountBalance(revenueAccount(listing.id))).toBe(5000);
      // Sale (-5000) plus payment (+5000) nets to nothing owed.
      expect(await accountBalance(attendeeAccount(attendeeId))).toBe(0);
      expect(
        (await transfersByAccount(attendeeAccount(attendeeId))).length,
      ).toBe(2);
    });

    test("rolls back the attendee and bookings when the ledger post throws", async () => {
      const listing = await createTestListing({ maxAttendees: 5 });
      const failingPost = (): Promise<void> => {
        throw new Error("ledger boom");
      };

      await expect(
        attendeesApi.createAttendeeAtomic(
          {
            bookings: [{ listingId: listing.id, quantity: 1 }],
            email: "a@b.c",
            name: "A",
          },
          failingPost,
        ),
      ).rejects.toThrow("ledger boom");

      expect((await getAttendeesRaw(listing.id)).length).toBe(0);
      expect((await allTransfers()).length).toBe(0);
    });

    const makeTrackingPostLedger = (
      listingId: number,
    ): {
      posted: { value: boolean };
      postLedger: (tx: TxScope, attendeeId: number) => Promise<void>;
    } => {
      const posted = { value: false };
      const postLedger = async (
        tx: TxScope,
        attendeeId: number,
      ): Promise<void> => {
        posted.value = true;
        await postTransfersTx(tx, saleAndPayment(listingId, attendeeId));
      };
      return { posted, postLedger };
    };

    test("rolls back the whole order (and posts nothing) on a partial create", async () => {
      // Two listings, one already full: the paid path is all-or-nothing, so the
      // create must roll back rather than post legs for the line that did book.
      const open = await createTestListing({ maxAttendees: 5 });
      const full = await createTestListing({ maxAttendees: 1 });
      const { posted, postLedger } = makeTrackingPostLedger(open.id);

      const result = await attendeesApi.createAttendeeAtomic(
        {
          bookings: [
            { listingId: open.id, quantity: 1 },
            { listingId: full.id, quantity: 2 },
          ],
          email: "a@b.c",
          name: "A",
        },
        postLedger,
      );

      expect(result.success).toBe(false);
      expect(posted.value).toBe(false);
      expect((await getAttendeesRaw(open.id)).length).toBe(0);
      expect((await allTransfers()).length).toBe(0);
    });

    test("returns capacity_exceeded without posting when no booking fits", async () => {
      const listing = await createTestListing({ maxAttendees: 1 });
      const { posted, postLedger } = makeTrackingPostLedger(listing.id);

      const result = await attendeesApi.createAttendeeAtomic(
        {
          bookings: [{ listingId: listing.id, quantity: 2 }],
          email: "a@b.c",
          name: "A",
        },
        postLedger,
      );

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.reason).toBe("capacity_exceeded");
      expect(posted.value).toBe(false);
      expect((await getAttendeesRaw(listing.id)).length).toBe(0);
      expect((await allTransfers()).length).toBe(0);
    });

    // A booking row's `ledger_event_group` must name ITS order. An attendee
    // who already holds an order (the state a merge leaves) must keep that
    // order's rows pointing at its legs when a later order posts: the stamp
    // fills only rows still carrying no order, never overwrites one.
    test("stamps only rows the order created, never an earlier order's rows", async () => {
      const listing = await createTestListing({ maxAttendees: 5 });
      const made = await attendeesApi.createAttendeeAtomic({
        bookings: [{ listingId: listing.id, quantity: 1 }],
        email: "stamps@example.com",
        name: "Stamps",
      });
      expect(made.success).toBe(true);
      if (!made.success) return;
      const attendeeId = made.attendees[0]!.id;
      const orderLegs = (gross: number, eventId: string) =>
        mapBooking({
          amountPaid: gross,
          attendeeId,
          bookingFee: 0,
          eventId,
          lines: [{ gross, listingId: listing.id }],
          modifiers: [],
          occurredAt: "2026-06-21T00:00:00.000Z",
        });
      const first = await orderLegs(100, "stamp-order-one");
      await withTransaction((tx) => postBookingLegsTx(tx, attendeeId, first));

      const second = await orderLegs(200, "stamp-order-two");
      await withTransaction((tx) => postBookingLegsTx(tx, attendeeId, second));

      const lines = await loadExistingLines(attendeeId);
      expect(lines[0]!.booking.ledger_event_group).toBe(first[0]!.eventGroup);
    });
  },
);
