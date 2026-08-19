import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { hmacHash } from "#crypto/hashing.ts";
import { requirePublicStatusId } from "#db/attendee-statuses.ts";
import { getDb } from "#db/client.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import {
  finalizeSessionIfUnresolved,
  reserveSession,
} from "#db/processed-payments.ts";
import type { CreatedEntry } from "#routes/api/payment-processing/create.ts";
import type { ValidatedItem } from "#routes/api/payment-processing/package-pricing.ts";
import { recoverOrRefundUnexpectedCreate } from "#routes/api/payment-processing/recovery.ts";
import { placeholderBookings } from "#routes/api/payment-processing/store-refund.ts";
import type { PaymentResult } from "#routes/api/webhook-types.ts";
import type { BookingIntent } from "#shared/booking-intent.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { paidSession } from "#test-utils/payment-session.ts";
import type { ListingWithCount } from "#types";
import { bookingIntent } from "./index/helpers.ts";

const intent = (): BookingIntent => bookingIntent([{ e: 1, p: 1000, q: 1 }]);

/** The listing a test just made. It is always there; saying so here keeps
 *  every case below from repeating the check. */
const loadedListing = async (id: number): Promise<ListingWithCount> => {
  const listing = await getListingWithCount(id);
  if (listing === null) throw new Error(`Listing ${id} was not created`);
  return listing;
};

/** One checked line: the signed line and the listing it names. */
const checkedLine = (listing: ListingWithCount): ValidatedItem[] =>
  [
    { item: { e: listing.id, p: 1000, q: 1 }, listing },
  ] as unknown as ValidatedItem[];

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

/** Runs the recovery with a `complete` that records it was reached, so a test
 *  can tell "recovered and finished" from "recovered but did nothing". */
const runRecovery = async (opts: {
  error: unknown;
  sessionId: string;
  ticketToken: string;
  validatedItems: ValidatedItem[];
}): Promise<{ completed: CreatedEntry[][]; result: PaymentResult }> => {
  const completed: CreatedEntry[][] = [];
  const result = await recoverOrRefundUnexpectedCreate({
    complete: (entries) => {
      completed.push(entries);
      return Promise.resolve({
        attendee: { id: entries[0]?.attendee.id ?? 0 },
        listingId: entries[0]?.listing.id ?? 0,
        success: true,
        ticketTokens: [opts.ticketToken],
      } satisfies PaymentResult);
    },
    error: opts.error,
    intent: intent(),
    placeholders: placeholderBookings(opts.validatedItems, intent()),
    publicStatusId: await requirePublicStatusId(),
    session: paidSession(opts.sessionId),
    ticketToken: opts.ticketToken,
    validatedItems: opts.validatedItems,
  });
  return { completed, result };
};

describeWithEnv(
  "picking up a booking whose write ended in doubt",
  { db: true },
  () => {
    test("finishes the booking when the payment and ticket agree", async () => {
      // Both say the same booking, and nothing is left unresolved, so the
      // write did land — there is nothing to give back, only to finish.
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

      const { completed, result } = await runRecovery({
        error: new Error("the write went quiet"),
        sessionId: "cs_recover",
        ticketToken: await prepareTicketToken(attendee.id, "tok_recover"),
        validatedItems: checkedLine(loaded),
      });

      expect(result).toMatchObject({ success: true });
      expect(completed).toHaveLength(1);
      expect(completed[0]?.[0]?.attendee.id).toBe(attendee.id);
    });

    test("gives the money back when the write is proved to have rolled back", async () => {
      // The session is still only reserved and no ticket was ever prepared, so
      // nothing was written and the buyer is owed their money.
      const listing = await createTestListing({
        maxAttendees: 50,
        name: "Refunded",
        unitPrice: 1000,
      });
      const loaded = await loadedListing(listing.id);
      await reserveSession("cs_rollback");

      const { completed, result } = await runRecovery({
        error: new Error("the write rolled back"),
        sessionId: "cs_rollback",
        ticketToken: "tok_never_written",
        validatedItems: checkedLine(loaded),
      });

      expect(completed).toEqual([]);
      expect(result).toMatchObject({ success: false });
    });

    test("raises the original problem when nothing proves either way", async () => {
      // No reservation and no ticket: we cannot say the write landed, and we
      // cannot say it rolled back, so guessing would either double-book or
      // refund a booking that exists.
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
          sessionId: "cs_unknown",
          ticketToken: "tok_unknown",
          validatedItems: checkedLine(loaded),
        }),
      ).rejects.toThrow("nobody knows what happened");
    });

    test("raises rather than guessing when the ticket names another booking", async () => {
      // A prepared ticket with no finished payment beside it is the shape that
      // must never be refunded: the booking may well be there.
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
          sessionId: "cs_mismatch",
          ticketToken: await prepareTicketToken(attendee.id, "tok_mismatch"),
          validatedItems: checkedLine(loaded),
        }),
      ).rejects.toThrow("ticket without a finished payment");
    });
  },
);
