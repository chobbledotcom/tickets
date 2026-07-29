/**
 * The ghost rows and refund reasons used when a payment went through but the
 * booking could not be honoured. The money is already taken at this point, so
 * the placeholder must record what was paid for without holding any places.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  datelessGhostBookings,
  placeholderBookings,
  settleBalanceSession,
  specForFailure,
  storeRefundedBooking,
} from "#routes/api/payment-processing/store-refund.ts";
import type { BookingItem } from "#shared/booking/signed-metadata.ts";
import { processBooking } from "#shared/booking.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { setupStripe } from "#test-utils/settings.ts";
import { bookingIntent, paymentSession } from "./index/helpers.ts";

/** A signed cart line: `e` is the listing, `k`/`r` mark a package path. */
const line = (listingId: number, groupId?: number): BookingItem =>
  (groupId === undefined
    ? { e: listingId, p: 500, q: 1 }
    : { e: listingId, k: "p", p: 500, q: 1, r: groupId }) as BookingItem;

// deno-lint-ignore no-explicit-any
const listingOf = (id: number): any => ({ id, listing_type: "one_off" });

// deno-lint-ignore no-explicit-any
const itemsFor = (items: BookingItem[]): any =>
  items.map((item) => ({ item, listing: listingOf(item.e) }));

// deno-lint-ignore no-explicit-any
const INTENT: any = { date: null, dayCount: null };

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
      [{ item: intent.items[0], listing }] as never,
      intent,
    );
    const result = await storeRefundedBooking(
      session,
      intent,
      bookings as never,
      specFor("listing full"),
    );
    return { listing, result };
  };

  describe("when the money could be sent back", () => {
    test("tells the customer their details were saved", async () => {
      await setupStripe();
      const { result } = await storeFor("cs_refunded");
      expect(result.error).toBe(
        "We couldn't complete your booking, so we've saved your details and a member of our team can help you rebook.",
      );
    });

    test("records that the refund happened", async () => {
      await setupStripe();
      const { result } = await storeFor("cs_refunded_flag");
      expect(result.refunded).toBe(true);
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
      const session = paymentSession(sessionId, amount, intent);
      return await settleBalanceSession(sessionId, session, intent);
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
  "a placeholder for a listing with no room left",
  { db: true },
  () => {
    test("is still stored, because capacity must never lose the record of a payment", async () => {
      const listing = await createTestListing({ maxAttendees: 1 });
      // Fill the listing, so a capacity-gated insert would refuse.
      await createTestAttendee(
        listing.id,
        listing.slug,
        "Took The Last Place",
        "full@example.com",
      );
      const intent = bookingIntent([{ e: listing.id, p: 1000, q: 1 }]);
      const bookings = placeholderBookings(
        [{ item: intent.items[0], listing }] as never,
        intent,
      );

      const result = await storeRefundedBooking(
        paymentSession("cs_full", 1000, intent),
        intent,
        bookings as never,
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
      // Both the real booking and the quantity-0 placeholder.
      expect((await getAttendeesByListingIds([listing.id])).length).toBe(2);
    });
  },
);
