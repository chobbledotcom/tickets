import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { hmacHash } from "#crypto/hashing.ts";
import { getDb } from "#db/client.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import {
  finalizeSessionIfUnresolved,
  reserveSession,
} from "#db/processed-payments.ts";
import { recoverOrRefundUnexpectedCreate } from "#routes/api/payment-processing/recovery.ts";
import type { PaymentResult } from "#routes/api/webhook-types.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { paidSession } from "#test-utils/payment-session.ts";
import type { ListingWithCount } from "#types";

/** The listing a test just made. It is always there; saying so here keeps
 *  every case below from repeating the check. */
const loadedListing = async (id: number): Promise<ListingWithCount> => {
  const listing = await getListingWithCount(id);
  if (listing === null) throw new Error(`Listing ${id} was not created`);
  return listing;
};

/** Prepare a booking under a ticket token we choose, so the test can hand the
 *  same token to the recovery. Only the token's one-way code is stored, which
 *  is what the recovery looks the booking up by. */
const prepareTicketToken = async (
  attendeeId: number,
  token: string,
): Promise<string> => {
  await getDb().execute({
    args: [await hmacHash(token), attendeeId],
    sql: "UPDATE attendees SET ticket_token_index = ? WHERE id = ?",
  });
  return token;
};

/** Runs the recovery with the answer it owes: success over the committed
 * booking, or the original error after the retry's reservation release. */
const runRecovery = async (opts: {
  error: unknown;
  listingId: number;
  sessionId: string;
  ticketToken: string;
}): Promise<PaymentResult> =>
  recoverOrRefundUnexpectedCreate({
    error: opts.error,
    listingId: opts.listingId,
    session: paidSession(opts.sessionId),
    ticketToken: opts.ticketToken,
  });

describeWithEnv(
  "picking up a booking whose write ended in doubt",
  { db: true },
  () => {
    test("answers success without re-running the tail when the payment and ticket agree", async () => {
      // Both say the same booking, and nothing is left unresolved, so the
      // write did land — its answers, activity lines, and flags committed in
      // the same batch, so the recovery runs nothing again.
      const listing = await createTestListing({
        maxAttendees: 50,
        name: "Recovered",
        unitPrice: 1000,
      });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "Recovered Buyer",
        "recovered@example.com",
      );
      const loaded = await loadedListing(listing.id);
      await reserveSession("cs_recover");
      await finalizeSessionIfUnresolved("cs_recover", attendee.id, null);

      const result = await runRecovery({
        error: new Error("the write went quiet"),
        listingId: loaded.id,
        sessionId: "cs_recover",
        ticketToken: await prepareTicketToken(attendee.id, "tok_recover"),
      });

      expect(result).toEqual({
        attendee: { id: attendee.id },
        listingId: loaded.id,
        success: true,
        ticketTokens: [],
      });
    });

    test("releases the reservation and rethrows when the write is proved to have rolled back", async () => {
      // The session is still only reserved and no ticket was ever prepared,
      // so the batch rolled back: nothing was written, and answering 500 lets
      // the provider redeliver the whole booking from the start.
      const listing = await createTestListing({
        maxAttendees: 50,
        name: "Retried",
        unitPrice: 1000,
      });
      const loaded = await loadedListing(listing.id);
      await reserveSession("cs_rollback");

      await expect(
        runRecovery({
          error: new Error("the write rolled back"),
          listingId: loaded.id,
          sessionId: "cs_rollback",
          ticketToken: "tok_never_written",
        }),
      ).rejects.toThrow("the write rolled back");

      // The reservation is gone, so the redelivery starts fresh instead of
      // stalling behind the old lock.
      const row = await getDb().execute({
        args: ["cs_rollback"],
        sql: "SELECT 1 AS present FROM processed_payments WHERE payment_session_id = ?",
      });
      expect(row.rows).toHaveLength(0);
    });

    test("raises the original problem when nothing proves either way", async () => {
      // No reservation and no ticket: we cannot say the write landed, and we
      // cannot say it rolled back, so guessing would either double-book or
      // release a lock a live writer still holds.
      const listing = await createTestListing({
        maxAttendees: 50,
        name: "Unknown",
        unitPrice: 1000,
      });
      const loaded = await loadedListing(listing.id);
      const original = new Error("nobody knows what happened");

      await expect(
        runRecovery({
          error: original,
          listingId: loaded.id,
          sessionId: "cs_unknown",
          ticketToken: "tok_unknown",
        }),
      ).rejects.toThrow("nobody knows what happened");
    });

    test("raises rather than guessing when the ticket names another booking", async () => {
      // A prepared ticket with no finished payment beside it is the shape that
      // must never be answered success: the booking may well be there, mid-write.
      const listing = await createTestListing({
        maxAttendees: 50,
        name: "Mismatched",
        unitPrice: 1000,
      });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "Mismatched Buyer",
        "mismatched@example.com",
      );
      const loaded = await loadedListing(listing.id);
      await reserveSession("cs_mismatch");

      await expect(
        runRecovery({
          error: new Error("ticket without a finished payment"),
          listingId: loaded.id,
          sessionId: "cs_mismatch",
          ticketToken: await prepareTicketToken(attendee.id, "tok_mismatch"),
        }),
      ).rejects.toThrow("ticket without a finished payment");
    });
  },
);
