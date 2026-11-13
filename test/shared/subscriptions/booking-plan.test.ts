import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { ListingBooking } from "#db/attendee-types.ts";
import { withSubscriptionPlan } from "#shared/subscriptions/booking-plan.ts";
import type { SubscriptionStart } from "#shared/subscriptions/plan.ts";
import { NO_TAX } from "#shared/tax/types.ts";

const start: SubscriptionStart = {
  amount: 1200,
  id: "sub_1",
  interval: "month",
  listingId: 4,
  status: "trialing",
};
const plan = {
  amount: 1200,
  id: "sub_1",
  interval: "month",
  status: "trialing",
  tax: 0,
} as const;

describe("subscription plan on the booking row", () => {
  test("leaves an order without a subscription unchanged", () => {
    const bookings: ListingBooking[] = [{ listingId: 4 }];
    expect(withSubscriptionPlan(bookings, undefined, NO_TAX)).toBe(bookings);
  });

  test("puts the plan only on the row booked on its own", () => {
    const bookings: ListingBooking[] = [
      { listingId: 4, packageGroupId: 9 },
      { listingId: 4, parentListingId: 2 },
      { listingId: 2 },
      { listingId: 4, quantity: 2 },
    ];
    expect(withSubscriptionPlan(bookings, start, NO_TAX)).toEqual([
      { listingId: 4, packageGroupId: 9 },
      { listingId: 4, parentListingId: 2 },
      { listingId: 2 },
      { listingId: 4, quantity: 2, subscription: plan },
    ]);
  });

  test("refuses a subscription for a listing the order does not book on its own", () => {
    expect(() =>
      withSubscriptionPlan(
        [{ listingId: 4, packageGroupId: 9 }, { listingId: 2 }],
        start,
        NO_TAX,
      ),
    ).toThrow(
      "Subscription sub_1 names listing 4, which the order does not book on its own",
    );
  });
});
