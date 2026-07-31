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
  settleBalanceSession,
  specForFailure,
  storeRefundedBooking,
} from "#routes/api/payment-processing/store-refund.ts";
import type { PaymentWork } from "#routes/api/webhook-types.ts";
import { processBooking } from "#shared/booking.ts";
import type { BookingIntent, BookingItem } from "#shared/booking-intent.ts";
import {
  applyPaymentSessionClaim,
  requirePaymentSessionClaim,
} from "#shared/db/payments/claims.ts";
import { bookingCompletion } from "#shared/payment-completion.ts";
import {
  CHARGE_RESOURCE,
  PAYMENT_TIME,
  paymentSessionInput,
  READY_RESULT,
  SESSION_RESOURCE,
  sessionProgress,
} from "#test/shared/db/payments/fixtures.ts";
import { createPendingPayment } from "#test/shared/payment-runtime/fixtures.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { testListingWithCount } from "#test-utils/factories.ts";
import { savePaymentCharges } from "#test-utils/payment-aggregate.ts";
import { withRefundMock } from "#test-utils/refund-routes.ts";
import { required } from "#test-utils/required.ts";
import { setupStripe } from "#test-utils/settings.ts";
import { bookingIntent, paymentSession } from "./index/helpers.ts";

/** A stored payment that has been paid for, ready to finish a booking against.
 *  These stories only read the payment's id, the money it took and the order it
 *  was for, so everything else comes from the shared paid-payment fixture. */
const workFor = async (
  id: string,
  amountTotal: number,
  intent: BookingIntent,
): Promise<PaymentWork> => {
  // The stored payment has to be for the same order the story finishes, or
  // the booking it writes names a listing that was never made.
  await createPendingPayment({
    ...paymentSessionInput(id),
    bookingIntent: intent,
  });
  // The payment has to have started being worked on: the writes that finish
  // one are fenced on its lease and its state, so a payment still sitting at
  // pending matches no rows and the booking quietly fails to store.
  const started = await applyPaymentSessionClaim(
    await requirePaymentSessionClaim(id, 60_000),
    sessionProgress({ state: "processing" }),
  );
  // Money really was taken: a refused booking hands a charge back, and a
  // payment with no charge has nothing to give.
  await savePaymentCharges(
    id,
    SESSION_RESOURCE,
    [
      {
        captured: { amount: amountTotal, currency: "GBP" },
        confirmedRefunded: { amount: 0, currency: "GBP" },
        refunds: [],
        resource: CHARGE_RESOURCE,
      },
    ],
    PAYMENT_TIME,
  );
  const claim = await requirePaymentSessionClaim(id, 60_000);
  return {
    claim,
    intent,
    payment: started,
    resolution: READY_RESULT,
    session: paymentSession(id, amountTotal),
  };
};

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

/** One place bought on this listing, refused for `spec`, with the provider
 *  standing in and saying whether it hands the money back. Answers with what
 *  was stored. */
const storeWithRefund = async (
  listing: Awaited<ReturnType<typeof createTestListing>>,
  id: string,
  spec: Parameters<typeof storeRefundedBooking>[2],
  moneyComesBack = true,
): Promise<Awaited<ReturnType<typeof storeRefundedBooking>>> => {
  const intent = bookingIntent([{ e: listing.id, p: 1000, q: 1 }]);
  const bookings = placeholderBookings(
    [{ expectedPrice: 1000, item: intent.items[0]!, listing }],
    intent,
  );
  const work = await workFor(id, 1000, intent);
  let stored: Awaited<ReturnType<typeof storeRefundedBooking>> | undefined;
  await withRefundMock(moneyComesBack, async () => {
    stored = await storeRefundedBooking(work, bookings, spec);
  });
  return required(stored, "the stored refund result");
};

describeWithEnv("keeping a booking we could not honour", { db: true }, () => {
  const specFor = (detail: string) =>
    specForFailure({ detail, ok: false, reason: "capacity_exceeded" });

  /** Store a placeholder for a paid-for booking on a real listing, saying
   *  whether the provider hands the money back. Making a payment to work from
   *  configures a provider, so whether the money comes back is said here
   *  rather than left to whether one happens to be set up. */
  const storeFor = async (id: string, moneyComesBack = true) => {
    const listing = await createTestListing({});
    const result = await storeWithRefund(
      listing,
      id,
      specFor("listing full"),
      moneyComesBack,
    );
    return { listing, result };
  };

  describe("when the money could be sent back", () => {
    test("tells the customer their details were saved", async () => {
      await setupStripe();
      const { result } = await storeFor("cs_refunded");
      expect(result.error).toBe(
        "We could not complete your booking. We saved your details so the organiser can help you book again.",
      );
    });

    test("records that the refund happened", async () => {
      await setupStripe();
      const { result } = await storeFor("cs_refunded_flag");
      expect(result.refund?.status).toBe("completed");
    });
  });

  describe("when the money could not be sent back", () => {
    test("tells the customer a refund is being arranged", async () => {
      const { result } = await storeFor("cs_unrefunded", false);
      expect(result.error).toBe(
        "We could not complete your booking. We saved your details so the organiser can help you book again. Your refund is being arranged. Contact the organiser if it does not arrive.",
      );
    });

    test("does not claim the refund happened", async () => {
      const { result } = await storeFor("cs_unrefunded_flag", false);
      expect(result.refund?.status).toBe("failed");
    });
  });

  describe("either way", () => {
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
      // Kept, but holding nothing — a quantity-1 row here would take a place
      // from a real buyer.
      expect(rows[0]?.quantity).toBe(0);
    });
  });
});

describeWithEnv(
  "settling a booking's outstanding balance",
  { db: true },
  () => {
    /** A reservation that still owes money, and the balance checkout for it. */
    const owing = async (owed: number) => {
      const listing = await createTestListing({
        maxAttendees: 10,
        unitPrice: owed,
      });
      const result = await processBooking(
        listing,
        {
          address: "",
          email: "owes@example.com",
          name: "Owes Money",
          phone: "",
          special_instructions: "",
        },
        1,
        null,
        "http://localhost",
      );
      if (result.type !== "success") throw new Error("booking failed");
      return { attendee: result.attendee, listing };
    };

    const settleFor = async (
      sessionId: string,
      attendeeId: number,
      listingId: number,
      amount: number,
    ) => {
      const intent = bookingIntent([{ e: listingId, p: amount, q: 1 }], {
        balanceAttendeeId: attendeeId,
      });
      const work = await workFor(sessionId, amount, intent);
      let settled: Awaited<ReturnType<typeof settleBalanceSession>> | undefined;
      await withRefundMock(true, async () => {
        settled = await settleBalanceSession(
          work,
          bookingCompletion(
            intent,
            {
              flow: "balance",
              listingId,
              occurredAt: "2026-07-26T12:00:00.000Z",
              promos: [],
            },
            ["ticket-one"],
          ),
        );
      });
      return required(settled, "the settled balance result");
    };

    describe("when the balance changed while they were paying", () => {
      test("does not settle for the wrong figure", async () => {
        const { attendee, listing } = await owing(1500);
        // The checkout was made for a balance that no longer stands.
        const result = await settleFor(
          "cs_stale",
          attendee.id,
          listing.id,
          900,
        );
        expect(result.success).toBe(false);
      });

      test("tells the customer the balance changed", async () => {
        const { attendee, listing } = await owing(1500);
        const result = await settleFor(
          "cs_stale_msg",
          attendee.id,
          listing.id,
          900,
        );
        expect((result as { error: string }).error).toBe(
          "The outstanding balance for this booking changed while you were paying.",
        );
      });

      test("asks the provider to try again later rather than acking", async () => {
        const { attendee, listing } = await owing(1500);
        const result = await settleFor(
          "cs_stale_status",
          attendee.id,
          listing.id,
          900,
        );
        expect((result as { status: number }).status).toBe(409);
      });

      test("leaves the balance untouched", async () => {
        const { attendee, listing } = await owing(1500);
        await settleFor("cs_stale_keep", attendee.id, listing.id, 900);
        const { getAttendeeBalanceState } = await import(
          "#shared/db/attendees/balance.ts"
        );
        const state = await getAttendeeBalanceState(attendee.id);
        expect(state?.remainingBalance).toBe(1500);
      });
    });
  },
);

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

      const result = await storeWithRefund(
        listing,
        "cs_full",
        specForFailure({
          detail: "full",
          ok: false,
          reason: "capacity_exceeded",
        }),
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
