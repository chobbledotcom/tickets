import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { refundSpec } from "#routes/api/payment-processing/refunds.ts";
import {
  datelessGhostBookings,
  specForFailure,
} from "#routes/api/payment-processing/store-refund.ts";
import type { BookingItem } from "#shared/booking-intent.ts";

describe("keeping a booking nobody can honour", () => {
  // Quantity 0 is what keeps the customer and their refund findable when the
  // booking itself cannot stand. A price of 0 goes with it: the money is
  // recorded in the ledger, not on the row.
  test("keeps a row per signed line, at no quantity and no price", () => {
    const items: BookingItem[] = [
      { e: 1, p: 100, q: 2 },
      { e: 5, p: 250, q: 1 },
    ];

    expect(datelessGhostBookings(items)).toEqual([
      { listingId: 1, packageGroupId: 0, pricePaid: 0, quantity: 0 },
      { listingId: 5, packageGroupId: 0, pricePaid: 0, quantity: 0 },
    ]);
  });

  test("keeps the path a line was booked through, not just its listing", () => {
    // The same listing booked two ways must keep two separate slots, or they
    // read as the same slot twice and the whole keep-and-refund falls over.
    const items: BookingItem[] = [
      { e: 1, k: "p", p: 100, q: 1, r: 9 },
      { e: 1, p: 100, q: 1 },
    ];

    expect(datelessGhostBookings(items)).toEqual([
      { listingId: 1, packageGroupId: 9, pricePaid: 0, quantity: 0 },
      { listingId: 1, packageGroupId: 0, pricePaid: 0, quantity: 0 },
    ]);
  });

  test("keeps nothing when there were no lines", () => {
    expect(datelessGhostBookings([])).toEqual([]);
  });
});

describe("why a booking we tried could not be honoured", () => {
  for (const [reason, code] of [
    ["capacity_exceeded", "capacity_full"],
    ["sold_out", "sold_out"],
    ["unexpected_error", "unexpected_error"],
  ] as const) {
    test(`turns ${reason} into the ${code} refund reason`, () => {
      // The whole spec, not just its code: this is the one place that decides
      // which refund a failed booking gets, so it has to hand back exactly
      // what that refund is, wording and all. What each code says to the
      // operator is pinned in refunds.test.ts.
      expect(specForFailure({ detail: "why", ok: false, reason })).toEqual(
        refundSpec(code)("why"),
      );
    });
  }
});
