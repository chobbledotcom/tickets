/** Booking rows with and without a Stripe subscription plan. */

import { execute } from "#db/client.ts";
import { invalidateListingsCache } from "#db/listings/records.ts";
import { sql } from "#db/sql.ts";

/** The plan a subscribed booking row keeps. */
export type TestPlan = {
  interval: string;
  price: number;
  status: string;
  tax: number;
};

export const MONTHLY: TestPlan = {
  interval: "month",
  price: 600,
  status: "trialing",
  tax: 100,
};

/** Give every booking of `attendeeId` the Stripe subscription `subscriptionId`
 * on `plan`. */
export const givePlan = async (
  attendeeId: number,
  subscriptionId: string,
  plan: TestPlan,
): Promise<void> => {
  await execute(sql`UPDATE listing_attendees
        SET recurring_interval = ${plan.interval}, recurring_price = ${plan.price}, recurring_tax = ${plan.tax},
            subscription_id = ${subscriptionId}, subscription_status = ${plan.status}
      WHERE attendee_id = ${attendeeId}`);
};

/** `listing`, now charging 5.00 each month after its ticket price. The plan
 * is written straight to the row, so the test needs no payment provider. */
export const withMonthlyPlan = async <Listing extends { id: number }>(
  listing: Listing,
): Promise<
  Listing & { recurring_interval: "month"; recurring_price: number }
> => {
  await execute(
    sql`UPDATE listings SET recurring_price = 500, recurring_interval = 'month' WHERE id = ${listing.id}`,
  );
  invalidateListingsCache();
  return { ...listing, recurring_interval: "month", recurring_price: 500 };
};
