/** The booking rows that started a Stripe subscription. */

import * as v from "valibot";
import { inPlaceholders, queryAll, type SqlStatement } from "#db/client.ts";
import { CHECKED_STATUSES } from "#payment/subscription-machine-spec.ts";
import {
  RecurringIntervalSchema,
  SUBSCRIPTION_NODE_OF,
  type SubscriptionStatus,
  SubscriptionStatusSchema,
} from "#shared/subscriptions/plan.ts";

/** A subscribed row always holds its whole plan: the booking path writes the
 * plan, the id and the status together. */
const SubscribedRowSchema = v.object({
  attendee_id: v.number(),
  listing_id: v.number(),
  quantity: v.number(),
  recurring_interval: RecurringIntervalSchema,
  recurring_price: v.number(),
  recurring_tax: v.number(),
  subscription_id: v.pipe(v.string(), v.minLength(1)),
  subscription_status: SubscriptionStatusSchema,
});

export type SubscribedRow = v.InferOutput<typeof SubscribedRowSchema>;

const SUBSCRIBED_COLUMNS = Object.keys(SubscribedRowSchema.entries)
  .map((column) => `booking.${column}`)
  .join(", ");

/** Every subscribed booking row, newest first. */
export const getSubscribedRows = async (): Promise<SubscribedRow[]> =>
  v.parse(
    v.array(SubscribedRowSchema),
    await queryAll(
      `SELECT ${SUBSCRIBED_COLUMNS}
         FROM listing_attendees AS booking
        WHERE booking.subscription_id != ''
        ORDER BY booking.id DESC`,
    ),
  );


const CheckedRowSchema = v.object({
  ...v.pick(SubscribedRowSchema, [
    "attendee_id",
    "listing_id",
    "recurring_price",
    "recurring_tax",
    "subscription_id",
    "subscription_status",
  ]).entries,
  id: v.number(),
});

export type CheckedRow = v.InferOutput<typeof CheckedRowSchema>;

/** The next rows the scheduled check asks Stripe about, in id order after
 * the row `afterId`. */
export const getCheckedRows = async (
  afterId: number,
  limit: number,
): Promise<CheckedRow[]> =>
  v.parse(
    v.array(CheckedRowSchema),
    await queryAll(
      `SELECT booking.id, booking.attendee_id, booking.listing_id,
              booking.recurring_price, booking.recurring_tax,
              booking.subscription_id, booking.subscription_status
         FROM listing_attendees AS booking
        WHERE booking.subscription_status IN (${inPlaceholders(CHECKED_STATUSES)})
          AND booking.id > ?
        ORDER BY booking.id
        LIMIT ?`,
      [...CHECKED_STATUSES, afterId, limit],
    ),
  );

/** The stored words that a write of `status` can replace. An ended status is
 * final, so it replaces any live one. A live status needs the row to hold the
 * status that was read, so a cancel that landed first stays. */
const replaceableBy = (
  row: CheckedRow,
  status: SubscriptionStatus,
): readonly SubscriptionStatus[] =>
  SUBSCRIPTION_NODE_OF[status] === "ended"
    ? CHECKED_STATUSES
    : [row.subscription_status];

/** Write the status Stripe reported over the status that `row` held. */
export const statusWrite = (
  row: CheckedRow,
  status: SubscriptionStatus,
): SqlStatement => {
  const replaceable = replaceableBy(row, status);
  return {
    args: [status, row.id, ...replaceable],
    sql: `UPDATE listing_attendees
             SET subscription_status = ?
           WHERE id = ? AND subscription_status IN (${inPlaceholders(replaceable)})`,
  };
};

