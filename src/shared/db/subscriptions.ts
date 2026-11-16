/** The booking rows that started a Stripe subscription. */

import * as v from "valibot";
import { queryAll } from "#db/client.ts";
import { type SqlStatement, sql, sqlList, sqlNames } from "#db/sql.ts";
import { CHECKED_STATUSES } from "#payment/subscription-machine-spec.ts";
import {
  RecurringIntervalSchema,
  SUBSCRIPTION_NODE_OF,
  type SubscriptionStatus,
  SubscriptionStatusSchema,
} from "#shared/subscriptions/plan.ts";

/** The columns that each read of a subscribed row needs. */
const PLAN_ENTRIES = {
  attendee_id: v.number(),
  listing_id: v.number(),
  recurring_price: v.number(),
  recurring_tax: v.number(),
  subscription_id: v.pipe(v.string(), v.minLength(1)),
  subscription_status: SubscriptionStatusSchema,
};

/** A subscribed row always holds its whole plan: the booking path writes the
 * plan, the id and the status together. */
const SubscribedRowSchema = v.object({
  ...PLAN_ENTRIES,
  quantity: v.number(),
  recurring_interval: RecurringIntervalSchema,
});

export type SubscribedRow = v.InferOutput<typeof SubscribedRowSchema>;

/** The subscribed columns, each named for its booking alias. */
const SUBSCRIBED_COLUMNS = Object.keys(SubscribedRowSchema.entries).map(
  (column) => `booking.${column}`,
);

/** Every subscribed booking row, newest first. */
export const getSubscribedRows = async (): Promise<SubscribedRow[]> =>
  v.parse(
    v.array(SubscribedRowSchema),
    await queryAll(
      sql`SELECT ${sqlNames(SUBSCRIBED_COLUMNS)}
         FROM listing_attendees AS booking
        WHERE booking.subscription_id != ''
        ORDER BY booking.id DESC`,
    ),
  );

/** A row the scheduled check watches: the plan it read, and where it lives. */
const CheckedRowSchema = v.object({ ...PLAN_ENTRIES, id: v.number() });

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
      sql`SELECT booking.id, booking.attendee_id, booking.listing_id,
              booking.recurring_price, booking.recurring_tax,
              booking.subscription_id, booking.subscription_status
         FROM listing_attendees AS booking
        WHERE booking.subscription_status IN (${sqlList(CHECKED_STATUSES)})
          AND booking.id > ${afterId}
        ORDER BY booking.id
        LIMIT ${limit}`,
    ),
  );

/** A merge can replace this booking while Stripe answers. Refuse stale money
 * in the same batch as its ledger legs. */
export const renewalBookingGuard = (row: CheckedRow): SqlStatement =>
  sql`INSERT INTO listing_attendees (listing_id)
        SELECT NULL
         WHERE NOT EXISTS (
           SELECT 1 FROM listing_attendees AS booking
            WHERE booking.id = ${row.id} AND booking.attendee_id = ${row.attendee_id}
              AND booking.listing_id = ${row.listing_id} AND booking.subscription_id = ${row.subscription_id}
         )`;

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
): SqlStatement =>
  sql`UPDATE listing_attendees
             SET subscription_status = ${status}
           WHERE id = ${row.id} AND subscription_status IN (${sqlList(
             replaceableBy(row, status),
           )})`;
