/** The non-database shape of bookings kept after a paid checkout fails. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { ValidatedItem } from "#routes/api/payment-processing/package-pricing.ts";
import {
  datelessGhostBookings,
  placeholderBookings,
  specForFailure,
} from "#routes/api/payment-processing/store-refund.ts";
import type { BookingIntent, BookingItem } from "#shared/booking-intent.ts";
import { bookingIntent } from "#test/features/api/payment-processing/index/helpers.ts";
import { testListingWithCount } from "#test-utils/factories.ts";

/** A signed cart line: `e` is the listing, `k`/`r` mark a package path. */
const line = (listingId: number, groupId?: number): BookingItem =>
  (groupId === undefined
    ? { e: listingId, p: 500, q: 1 }
    : { e: listingId, k: "p", p: 500, q: 1, r: groupId }) as BookingItem;

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
    // Collapsing these paths would reject the duplicate slot and lose the paid
    // booking record this placeholder exists to preserve.
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
