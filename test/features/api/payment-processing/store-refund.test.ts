/** Durable placeholder and recovery work after a paid booking cannot be kept. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { processPaymentSession } from "#routes/api/payment-processing/index.ts";
import {
  placeholderBookings,
  specForFailure,
  storeRefundedBooking,
} from "#routes/api/payment-processing/store-refund.ts";
import { decrypt } from "#shared/crypto/encryption.ts";
import type { EnvKeyEncrypted } from "#shared/crypto/sealed.ts";
import { requirePublicStatusId } from "#shared/db/attendee-statuses.ts";
import { deleteAttendee } from "#shared/db/attendees/delete.ts";
import { execute, queryOne, withTransaction } from "#shared/db/client.ts";
import {
  assertRowsFreeToMove,
  PaymentRowsBusyError,
} from "#shared/db/payment-admit-move.ts";
import { getRefundPaymentReferencesForAttendee } from "#shared/db/payment-references.ts";
import {
  markSessionFailed,
  reserveSession,
} from "#shared/db/processed-payments.ts";
import { listProviderRefundCases } from "#shared/db/provider-refund-cases.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestAttendee,
  getAttendeesRaw,
} from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { withRefundLedgerFault } from "#test-utils/refund-ledger-fault.ts";
import { refundCompletes, withRefundMock } from "#test-utils/refund-routes.ts";
import { adminGet } from "#test-utils/session.ts";
import { bookingIntent, paymentSession } from "./index/helpers.ts";
import {
  crashedPlaceholderStore,
  placeholderSpec,
  reservedPlaceholder,
  storedPlaceholder,
  storePlaceholder,
} from "./store-refund-helpers.ts";

describeWithEnv("keeping a booking we could not honour", { db: true }, () => {
  describe("when the money could be sent back", () => {
    test("fences the placeholder from merging until its refund record is complete", async () => {
      let attendeeId = 0;
      await withRefundMock(
        async (request) => {
          const payment = await queryOne<{ attendee_id: number }>(
            `SELECT attendee_id
               FROM processed_payments
              WHERE payment_reference_index != ''`,
          );
          if (payment === null) {
            throw new Error("payment anchor was not stored");
          }
          attendeeId = payment.attendee_id;
          await expect(
            withTransaction((tx) =>
              assertRowsFreeToMove(tx, [attendeeId], "merge"),
            ),
          ).rejects.toThrow(PaymentRowsBusyError);
          return await refundCompletes(request);
        },
        async () => {
          await storedPlaceholder("cs_merge_fence");
        },
      );

      await withTransaction((tx) =>
        assertRowsFreeToMove(tx, [attendeeId], "merge"),
      );
    });

    test("tells the customer their details were saved", async () => {
      await withRefundMock(refundCompletes, async () => {
        const { result } = await storedPlaceholder("cs_refunded");
        expect(result.error).toBe(
          "We couldn't complete your booking, so we've saved your details and a member of our team can help you rebook.",
        );
      });
    });

    test("records that the refund happened", async () => {
      await withRefundMock(refundCompletes, async () => {
        const { result } = await storedPlaceholder("cs_refunded_flag");
        expect(result.refunded).toBe(true);
      });
    });

    test("replays the completed refund instead of its pending placeholder", async () => {
      await withRefundMock(refundCompletes, async () => {
        const sessionId = "cs_refunded_replay";
        const { data, result } = await storedPlaceholder(sessionId);

        expect(await processPaymentSession(sessionId, data)).toEqual({
          error: result.error,
          refunded: true,
          status: 200,
          success: false,
        });
      });
    });

    test("keeps the row saying unrecorded when Money misses the return", async () => {
      await withRefundLedgerFault(() =>
        withRefundMock(refundCompletes, async () => {
          const { result } = await storedPlaceholder("cs_ledger_miss");
          // The buyer's answer stays the handled 200 — money DID come back;
          // catching the books up is operator work, not the buyer's problem.
          expect(result.refunded).toBe(true);
        }),
      );
      // The row keeps the truth the refresh route clears — money returned,
      // books not caught up — and the authority stays due and visible.
      const row = await queryOne<{ protected_state: string }>(
        `SELECT protected_state FROM processed_payments
          WHERE payment_reference_index != ''`,
      );
      expect(row?.protected_state).toBe("unrecorded");
      const charge = await queryOne<{ refund_local_state: string }>(
        "SELECT refund_local_state FROM payment_charges",
      );
      expect(charge?.refund_local_state).toBe("due");
    });

    test("a redelivery finishes the tail a crashed create left open", async () => {
      const sessionId = "cs_pending_refund_replay";
      const placeholder = await crashedPlaceholderStore(sessionId);

      // The redelivery resumes the tail from durable rows: the refund does
      // not come back here, so the payment leg lands, the operator note is
      // written, and the claim is released — the honest pending answer.
      const pendingError =
        "We couldn't complete your booking, so we've saved your details and a member of our team can help you rebook. Your refund is being arranged — please contact us if it does not arrive.";
      expect(await processPaymentSession(sessionId, placeholder.data)).toEqual({
        detail: `Resumed after a crashed delivery of session ${sessionId}`,
        error: pendingError,
        status: 200,
        success: false,
      });
      const anchor = await queryOne<{ protected_state: string }>(
        "SELECT protected_state FROM processed_payments WHERE payment_reference_index != ''",
      );
      expect(anchor?.protected_state).toBe("");
      const note = await queryOne<{ system_name: string; total: number }>(
        `SELECT system_name, COUNT(*) OVER () AS total
           FROM system_notes WHERE entity_type = 'attendee'`,
      );
      expect(note?.total).toBe(1);
      expect(note?.system_name).toContain("refund_unreturned");

      // With the claim free, the next delivery replays the stored words and
      // writes nothing new.
      expect(await processPaymentSession(sessionId, placeholder.data)).toEqual({
        error: pendingError,
        status: 200,
        success: false,
      });
      expect(
        Number(
          (
            await queryOne<{ total: number }>(
              "SELECT COUNT(*) AS total FROM system_notes WHERE entity_type = 'attendee'",
            )
          )?.total,
        ),
      ).toBe(1);
    });
  });

  describe("when the money could not be sent back", () => {
    test("tells the customer a refund is being arranged", async () => {
      const { result } = await storedPlaceholder("cs_unrefunded");
      expect(result.error).toBe(
        "We couldn't complete your booking, so we've saved your details and a member of our team can help you rebook. Your refund is being arranged — please contact us if it does not arrive.",
      );
    });

    test("does not claim the refund happened", async () => {
      const { result } = await storedPlaceholder("cs_unrefunded_flag");
      expect(result.refunded).toBeUndefined();
    });

    test("keeps only a non-sensitive explanatory note", async () => {
      const { listing } = await storedPlaceholder("cs_plain_explanation");
      const row = await queryOne<{
        note: EnvKeyEncrypted;
        system_name: string | null;
      }>(
        `SELECT note.note, note.system_name
           FROM system_notes AS note
           JOIN listing_attendees AS booking
             ON booking.attendee_id = note.entity_id
          WHERE note.entity_type = 'attendee'
            AND booking.listing_id = ?`,
        [listing.id],
      );
      if (row === null) {
        throw new Error("the refund explanation was not stored");
      }
      // The note's name is the once-only latch a resumed delivery checks; it
      // carries only the blind reference index, never the real reference.
      expect(row.system_name).toContain("refund_unreturned");
      expect(row.system_name).not.toContain("pi_cs_plain_explanation");
      expect(await decrypt(row.note)).not.toContain("pi_cs_plain_explanation");
    });

    test("keeps the unresolved refund from being deleted", async () => {
      const { listing } = await storedPlaceholder("cs_unrefunded_delete");
      const attendee = (await getAttendeesRaw(listing.id))[0];
      if (attendee === undefined) throw new Error("placeholder was not stored");

      await expect(deleteAttendee(attendee.id)).rejects.toThrow(
        PaymentRowsBusyError,
      );
    });
  });

  describe("either way", () => {
    test("rolls back when another outcome takes the session reservation", async () => {
      const sessionId = "cs_session_failure_race";
      const placeholder = await reservedPlaceholder(sessionId);
      await markSessionFailed(sessionId, {
        error: "Another request already finished",
        status: 409,
      });

      await withRefundMock(refundCompletes, async () => {
        await expect(storePlaceholder(placeholder)).rejects.toThrow(
          `Payment session lost its reservation before placeholder creation: ${sessionId}`,
        );
      });
      expect(await getAttendeesRaw(placeholder.listing.id)).toEqual([]);
      expect((await listProviderRefundCases()).cases).toEqual([]);
      expect(await processPaymentSession(sessionId, placeholder.data)).toEqual({
        error: "Another request already finished",
        status: 409,
        success: false,
      });
    });

    test("rolls back the placeholder when its payment anchor cannot be stored", async () => {
      const listing = await createTestListing({});
      const intent = bookingIntent([{ e: listing.id, p: 1000, q: 1 }]);
      const session = paymentSession("cs_anchor_failure", 1000, intent);
      const bookings = placeholderBookings(
        [{ expectedPrice: 1000, item: intent.items[0]!, listing }],
        intent,
      );
      await reserveSession(session.id);
      await execute(
        `CREATE TRIGGER fail_placeholder_payment_anchor
           BEFORE INSERT ON processed_payments
            WHEN NEW.payment_session_id LIKE 'legacy:%'
         BEGIN
           SELECT RAISE(ABORT, 'payment anchor unavailable');
         END`,
      );

      try {
        await expect(
          storeRefundedBooking(
            session,
            intent,
            bookings,
            placeholderSpec("listing full"),
            await requirePublicStatusId(),
          ),
        ).rejects.toThrow("payment anchor unavailable");
      } finally {
        await execute("DROP TRIGGER fail_placeholder_payment_anchor");
      }

      expect(await getAttendeesRaw(listing.id)).toEqual([]);
    });

    test("stores a tagged indexed reference with reachable recovery", async () => {
      const sessionId = "cs_indexed_recovery";
      const { listing } = await storedPlaceholder(sessionId);
      const attendee = (await getAttendeesRaw(listing.id))[0];
      if (attendee === undefined) throw new Error("placeholder was not stored");

      expect(
        await getRefundPaymentReferencesForAttendee(
          {
            currentPaymentId: `pi_${sessionId}`,
            id: attendee.id,
          },
          await getTestPrivateKey(),
        ),
      ).toMatchObject({
        kind: "complete",
        references: [
          {
            kind: "tagged",
            provider: "stripe",
            reference: `pi_${sessionId}`,
          },
        ],
      });

      const attendeePage = await (
        await adminGet(`/admin/attendees/${attendee.id}`)
      ).text();
      expect(attendeePage).toContain(
        `action="/admin/attendees/${attendee.id}/refresh-payment"`,
      );
    });

    test("is a handled outcome the provider should not retry", async () => {
      const { result } = await storedPlaceholder("cs_status");
      expect(result.status).toBe(200);
      expect(result.success).toBe(false);
    });

    test("carries the internal detail for the log", async () => {
      const { result } = await storedPlaceholder("cs_detail");
      expect(result.detail).toBe("listing full");
    });

    test("keeps the booking, holding no places", async () => {
      const { listing } = await storedPlaceholder("cs_kept");
      const { getAttendeesByListingIds } = await import(
        "#shared/db/listings/attendees.ts"
      );
      const rows = await getAttendeesByListingIds([listing.id]);
      expect(rows.length).toBe(1);
      expect(rows[0]?.status_id).toBe(await requirePublicStatusId());
      // Kept, but holding nothing — a quantity-1 row here would take a place
      // from a real buyer.
      expect(rows[0]?.quantity).toBe(0);
    });
  });
});

describeWithEnv(
  "a placeholder for a listing that is over capacity",
  { db: true },
  () => {
    test("is still stored, because capacity must never lose the record of a payment", async () => {
      const listing = await createTestListing({ maxAttendees: 2 });
      await createTestAttendee(
        listing.id,
        listing.slug,
        "First",
        "first@example.com",
      );
      await createTestAttendee(
        listing.id,
        listing.slug,
        "Second",
        "second@example.com",
      );
      // Shrink the listing below what is already booked. At exactly full a
      // quantity-0 row still fits (booked + 0 <= cap), so only going *over*
      // makes the capacity gate refuse it — which is what the overbook flag
      // has to override.
      const { getDb } = await import("#shared/db/client.ts");
      await getDb().execute(
        "UPDATE listings SET max_attendees = 1 WHERE id = ?",
        [listing.id],
      );

      const intent = bookingIntent([{ e: listing.id, p: 1000, q: 1 }]);
      const bookings = placeholderBookings(
        [{ expectedPrice: 1000, item: intent.items[0]!, listing }],
        intent,
      );
      const session = paymentSession("cs_full", 1000, intent);
      await reserveSession(session.id);

      const result = await storeRefundedBooking(
        session,
        intent,
        bookings,
        specForFailure({
          detail: "full",
          ok: false,
          reason: "capacity_exceeded",
        }),
        await requirePublicStatusId(),
      );

      expect(result.status).toBe(200);
      const { getAttendeesByListingIds } = await import(
        "#shared/db/listings/attendees.ts"
      );
      // The two real bookings plus the placeholder, which holds no places.
      const rows = await getAttendeesByListingIds([listing.id]);
      expect(rows.length).toBe(3);
      expect(rows.filter((row) => row.quantity === 0).length).toBe(1);
    });
  },
);
