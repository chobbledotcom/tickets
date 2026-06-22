import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  attendeeAccount,
  revenueAccount,
  WORLD,
} from "#shared/accounting/accounts.ts";
import {
  accountBalance,
  allTransfers,
  transfersByAccount,
} from "#shared/accounting/queries.ts";
import { postTransfersTx } from "#shared/accounting/store.ts";
import { createAttendeeAtomic, getAttendeesRaw } from "#shared/db/attendees.ts";
import type { TxScope } from "#shared/db/client.ts";
import type { TransferInput } from "#shared/ledger/types.ts";
import { createTestListing, describeWithEnv } from "#test-utils";

const saleAndPayment = (
  listingId: number,
  attendeeId: number,
): TransferInput[] => [
  {
    amount: 5000,
    currency: "GBP",
    destination: revenueAccount(listingId),
    eventGroup: "evt-1",
    occurredAt: "2026-06-21T00:00:00.000Z",
    reference: "sale",
    source: attendeeAccount(attendeeId),
  },
  {
    amount: 5000,
    currency: "GBP",
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

      const result = await createAttendeeAtomic(
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
        createAttendeeAtomic(
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

    test("returns capacity_exceeded without posting when no booking fits", async () => {
      const listing = await createTestListing({ maxAttendees: 1 });
      let posted = false;
      const postLedger = async (
        tx: TxScope,
        attendeeId: number,
      ): Promise<void> => {
        posted = true;
        await postTransfersTx(tx, saleAndPayment(listing.id, attendeeId));
      };

      const result = await createAttendeeAtomic(
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
      expect(posted).toBe(false);
      expect((await getAttendeesRaw(listing.id)).length).toBe(0);
      expect((await allTransfers()).length).toBe(0);
    });
  },
);
