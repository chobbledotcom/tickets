import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { bookingFactsFromOrder } from "#shared/checkout-ledger.ts";
import { pricedLine as line, pricedOrder as order } from "#test-utils";

const ctx = {
  attendeeId: 42,
  eventId: "cs_test_1",
  occurredAt: "2026-06-21T00:00:00.000Z",
};

describe("bookingFactsFromOrder", () => {
  test("maps listings, modifiers, fee, and cash taken now", () => {
    const facts = bookingFactsFromOrder(
      order({
        extras: [{ amount: 300, key: "fee", name: "Booking fee", quantity: 1 }],
        lines: [line(1, 5000, 2)],
        modifierApplications: [
          {
            amountApplied: 500,
            delta: -500,
            modifierId: 7,
            name: "10% off",
            quantity: 1,
            scopedSubtotal: 10000,
          },
        ],
        total: 9800,
      }),
      ctx,
    );
    expect(facts).toEqual({
      amountPaid: 9800,
      attendeeId: 42,
      bookingFee: 300,
      eventId: "cs_test_1",
      lines: [{ gross: 10000, listingId: 1 }],
      modifiers: [{ delta: -500, modifierId: 7 }],
      occurredAt: "2026-06-21T00:00:00.000Z",
    });
  });

  test("gross is the full list price, not the deposit charged now", () => {
    const facts = bookingFactsFromOrder(
      order({ lines: [line(1, 10000, 1, 3000)], total: 3000 }),
      ctx,
    );
    expect(facts.lines).toEqual([{ gross: 10000, listingId: 1 }]);
    expect(facts.amountPaid).toBe(3000);
  });

  test("sums discount-split lines of one listing; no fee means zero", () => {
    const facts = bookingFactsFromOrder(
      order({
        lines: [line(1, 5000, 3, 5000), line(1, 5000, 2, 4500)],
        total: 24000,
      }),
      ctx,
    );
    expect(facts.lines).toEqual([{ gross: 25000, listingId: 1 }]);
    expect(facts.bookingFee).toBe(0);
  });
});
