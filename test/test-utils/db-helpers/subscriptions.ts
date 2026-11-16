/** Booking rows with and without a Stripe subscription plan. */

import { eventGroup } from "#accounting/refs.ts";
import { selectByEventGroup } from "#accounting/rows.ts";
import { execute, queryBatch, queryOne } from "#db/client.ts";
import { invalidateListingsCache } from "#db/listings/records.ts";
import { sql } from "#db/sql.ts";
import { requireValue } from "#shared/required-value.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

/** The ids of one booking on a listing of its own. */
export type TestBooking = { attendeeId: number; listingId: number };

/** A booking for `name` on a new listing of its own. */
export const bookOwnListing = async (name: string): Promise<TestBooking> => {
  const listing = await createTestListing({
    maxAttendees: 10,
    name: `${name} Club`,
    unitPrice: 1000,
  });
  const attendee = await createTestAttendee(
    listing.id,
    listing.slug,
    name,
    `${name.toLowerCase()}@example.com`,
  );
  return { attendeeId: attendee.id, listingId: listing.id };
};

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

/** A booking for `name` that carries the Stripe subscription `sub_<name>`. */
export const subscribe = async (
  name: string,
  plan: TestPlan,
): Promise<TestBooking> => {
  const booking = await bookOwnListing(name);
  await givePlan(booking.attendeeId, `sub_${name.toLowerCase()}`, plan);
  return booking;
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

/** The legs one invoice posted, as kind, from, to, amount and time. */
export const renewalLegs = async (invoiceId: string) =>
  (
    await selectByEventGroup(
      queryBatch,
      await eventGroup(["renewal", invoiceId]),
    )
  )
    .map((leg) => ({
      amount: leg.amount,
      from: `${leg.source.type}:${leg.source.id}`,
      kind: leg.kind,
      occurredAt: leg.occurredAt,
      to: `${leg.destination.type}:${leg.destination.id}`,
    }))
    .sort((a, b) => String(a.kind).localeCompare(String(b.kind)));

/** The status column of one booking. */
export const statusOf = async (booking: TestBooking): Promise<string> =>
  requireValue(
    await queryOne<{ subscription_status: string }>(
      sql`SELECT subscription_status FROM listing_attendees WHERE attendee_id = ${booking.attendeeId}`,
    ),
    `Booking ${booking.attendeeId} has no row`,
  ).subscription_status;
