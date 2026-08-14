/**
 * The ghost rows and refund reasons used when a payment went through but the
 * booking could not be honoured. The money is already taken at this point, so
 * the placeholder must record what was paid for without holding any places.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { ValidatedItem } from "#routes/api/payment-processing/package-pricing.ts";
import {
  datelessGhostBookings,
  placeholderBookings,
  specForFailure,
  storeRefundedBooking,
} from "#routes/api/payment-processing/store-refund.ts";
import type { BookingIntent, BookingItem } from "#shared/booking-intent.ts";
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
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestAttendee,
  getAttendeesRaw,
} from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { testListingWithCount } from "#test-utils/factories.ts";
import { refundCompletes, withRefundMock } from "#test-utils/refund-routes.ts";
import { adminGet } from "#test-utils/session.ts";
import { bookingIntent, paymentSession } from "./index/helpers.ts";

/** A signed cart line: `e` is the listing, `k`/`r` mark a package path. */
const line = (listingId: number, groupId?: number): BookingItem =>
  (groupId === undefined
    ? { e: listingId, p: 500, q: 1 }
    : { e: listingId, k: "p", p: 500, q: 1, r: groupId }) as BookingItem;

/** The validated cart lines `placeholderBookings` works from. */
const itemsFor = (items: BookingItem[]): ValidatedItem[] =>
  items.map((item) => ({
    expectedPrice: item.p,
    item,
    listing: testListingWithCount({ id: item.e }),
  }));

const INTENT: BookingIntent = bookingIntent([]);

describe("placeholder bookings for a payment we could not honour", () => {
  describe("what each ghost row holds", () => {
    test("holds no places, so it cannot take capacity from anyone", () => {
      const rows = placeholderBookings(itemsFor([line(1)]), INTENT);
      expect(rows[0]?.quantity).toBe(0);
    });

    test("records no money against the listing", () => {
      const rows = placeholderBookings(itemsFor([line(1)]), INTENT);
      expect(rows[0]?.pricePaid).toBe(0);
    });

    test("names the listing that was paid for", () => {
      const rows = placeholderBookings(itemsFor([line(42)]), INTENT);
      expect(rows[0]?.listingId).toBe(42);
    });
  });

  test("keeps one row per line, so nothing paid for is lost", () => {
    const rows = placeholderBookings(itemsFor([line(1), line(2)]), INTENT);
    expect(rows.length).toBe(2);
    expect(rows.map((row) => row.listingId)).toEqual([1, 2]);
  });

  test("keeps the two paths apart when one listing was booked through both", () => {
    // Identical slots would be refused as duplicates and the store-and-refund
    // would crash, losing the record of a payment already taken.
    const rows = placeholderBookings(
      itemsFor([line(7, 1), line(7, 2)]),
      INTENT,
    );
    expect(rows.map((row) => row.packageGroupId)).toEqual([1, 2]);
  });

  test("treats a line booked on its own as belonging to no package", () => {
    const rows = placeholderBookings(itemsFor([line(7)]), INTENT);
    expect(rows[0]?.packageGroupId).toBe(0);
  });

  test("has nothing to record when the cart was empty", () => {
    expect(placeholderBookings(itemsFor([]), INTENT)).toEqual([]);
  });
});

describe("ghost bookings for a listing that has since been deleted", () => {
  test("hold no places and no money, like any other ghost", () => {
    const rows = datelessGhostBookings([line(1)]);
    expect(rows[0]?.quantity).toBe(0);
    expect(rows[0]?.pricePaid).toBe(0);
  });

  test("carry no dates, because the listing they came from is gone", () => {
    const rows = datelessGhostBookings([line(1)]);
    expect(rows[0]).not.toHaveProperty("date");
  });

  test("keep one row per line, each with its own package path", () => {
    const rows = datelessGhostBookings([line(7, 1), line(7, 2)]);
    expect(rows.map((row) => row.packageGroupId)).toEqual([1, 2]);
  });

  test("have nothing to record for an empty cart", () => {
    expect(datelessGhostBookings([])).toEqual([]);
  });
});

describe("the refund reason for a booking we could not honour", () => {
  test("says the event filled up when capacity ran out", () => {
    const spec = specForFailure({
      detail: "listing 1 full",
      ok: false,
      reason: "capacity_exceeded",
    });
    expect(spec.code).toBe("capacity_full");
    expect(spec.reason).toBe("the event filled up while they were paying");
  });

  test("names the add-on when an extra sold out", () => {
    const spec = specForFailure({
      detail: "addon gone",
      ok: false,
      reason: "sold_out",
    });
    expect(spec.code).toBe("sold_out");
    expect(spec.reason).toBe(
      "an add-on or extra they chose sold out while they were paying",
    );
  });

  test("falls back to the unexpected-error reason for anything else", () => {
    const spec = specForFailure({
      detail: "boom",
      ok: false,
      reason: "unexpected_error",
    });
    expect(spec.code).toBe("unexpected_error");
    expect(spec.reason).toBe(
      "an unexpected error stopped the booking being completed",
    );
  });

  test("carries the internal detail through for the log", () => {
    const spec = specForFailure({
      detail: "listing 9 oversold by 2",
      ok: false,
      reason: "capacity_exceeded",
    });
    expect(spec.detail).toBe("listing 9 oversold by 2");
  });
});

describeWithEnv("keeping a booking we could not honour", { db: true }, () => {
  const specFor = (detail: string) =>
    specForFailure({ detail, ok: false, reason: "capacity_exceeded" });

  /** Store a placeholder for a paid-for booking on a real listing. */
  const storeFor = async (id: string) => {
    const listing = await createTestListing({});
    const intent = bookingIntent([{ e: listing.id, p: 1000, q: 1 }]);
    const session = paymentSession(id, 1000, intent);
    const bookings = placeholderBookings(
      [{ expectedPrice: 1000, item: intent.items[0]!, listing }],
      intent,
    );
    const result = await storeRefundedBooking(
      session,
      intent,
      bookings,
      specFor("listing full"),
      await requirePublicStatusId(),
    );
    return { listing, result };
  };

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
          if (payment === null)
            throw new Error("payment anchor was not stored");
          attendeeId = payment.attendee_id;
          await expect(
            withTransaction((tx) =>
              assertRowsFreeToMove(tx, [attendeeId], "merge"),
            ),
          ).rejects.toThrow(PaymentRowsBusyError);
          return await refundCompletes(request);
        },
        async () => {
          await storeFor("cs_merge_fence");
        },
      );

      await withTransaction((tx) =>
        assertRowsFreeToMove(tx, [attendeeId], "merge"),
      );
    });

    test("tells the customer their details were saved", async () => {
      await withRefundMock(refundCompletes, async () => {
        const { result } = await storeFor("cs_refunded");
        expect(result.error).toBe(
          "We couldn't complete your booking, so we've saved your details and a member of our team can help you rebook.",
        );
      });
    });

    test("records that the refund happened", async () => {
      await withRefundMock(refundCompletes, async () => {
        const { result } = await storeFor("cs_refunded_flag");
        expect(result.refunded).toBe(true);
      });
    });
  });

  describe("when the money could not be sent back", () => {
    test("tells the customer a refund is being arranged", async () => {
      const { result } = await storeFor("cs_unrefunded");
      expect(result.error).toBe(
        "We couldn't complete your booking, so we've saved your details and a member of our team can help you rebook. Your refund is being arranged — please contact us if it does not arrive.",
      );
    });

    test("does not claim the refund happened", async () => {
      const { result } = await storeFor("cs_unrefunded_flag");
      expect(result.refunded).toBeUndefined();
    });

    test("keeps only a non-sensitive explanatory note", async () => {
      const { listing } = await storeFor("cs_plain_explanation");
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
      expect(row.system_name).toBeNull();
      expect(await decrypt(row.note)).not.toContain("pi_cs_plain_explanation");
    });

    test("keeps the unresolved refund from being deleted", async () => {
      const { listing } = await storeFor("cs_unrefunded_delete");
      const attendee = (await getAttendeesRaw(listing.id))[0];
      if (attendee === undefined) throw new Error("placeholder was not stored");

      await expect(deleteAttendee(attendee.id)).rejects.toThrow(
        PaymentRowsBusyError,
      );
    });
  });

  describe("either way", () => {
    test("rolls back the placeholder when its payment anchor cannot be stored", async () => {
      const listing = await createTestListing({});
      const intent = bookingIntent([{ e: listing.id, p: 1000, q: 1 }]);
      const session = paymentSession("cs_anchor_failure", 1000, intent);
      const bookings = placeholderBookings(
        [{ expectedPrice: 1000, item: intent.items[0]!, listing }],
        intent,
      );
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
            specFor("listing full"),
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
      const { listing } = await storeFor(sessionId);
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
      const { result } = await storeFor("cs_status");
      expect(result.status).toBe(200);
      expect(result.success).toBe(false);
    });

    test("carries the internal detail for the log", async () => {
      const { result } = await storeFor("cs_detail");
      expect(result.detail).toBe("listing full");
    });

    test("keeps the booking, holding no places", async () => {
      const { listing } = await storeFor("cs_kept");
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

      const result = await storeRefundedBooking(
        paymentSession("cs_full", 1000, intent),
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
