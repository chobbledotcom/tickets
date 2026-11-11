/** The booking rows that started a Stripe subscription. */

import * as v from "valibot";
import { queryAll } from "#db/client.ts";
import {
  RecurringIntervalSchema,
  SubscriptionStatusSchema,
} from "#shared/subscriptions/plan.ts";

/** A subscribed row always holds its whole plan: the booking path writes the
 * plan, the id and the status together. */
const SubscribedRowSchema = v.object({
  attendee_id: v.number(),
  listing_id: v.number(),
  recurring_interval: RecurringIntervalSchema,
  recurring_price: v.number(),
  recurring_tax: v.number(),
  subscription_id: v.pipe(v.string(), v.minLength(1)),
  subscription_status: SubscriptionStatusSchema,
});

export type SubscribedRow = v.InferOutput<typeof SubscribedRowSchema>;

/** Every subscribed booking row, newest first. */
export const getSubscribedRows = async (): Promise<SubscribedRow[]> =>
  v.parse(
    v.array(SubscribedRowSchema),
    await queryAll(
      `SELECT booking.attendee_id, booking.listing_id,
              booking.recurring_interval, booking.recurring_price,
              booking.recurring_tax, booking.subscription_id,
              booking.subscription_status
         FROM listing_attendees AS booking
        WHERE booking.subscription_id != ''
        ORDER BY booking.id DESC`,
    ),
  );
