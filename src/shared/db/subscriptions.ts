/** The booking rows that started a Stripe subscription. */

import * as v from "valibot";
import {
  inPlaceholders,
  queryAll,
  queryAllPrimary,
  queryOnePrimary,
  resultRows,
  type SqlStatement,
  type TxScope,
} from "#db/client.ts";
import { t } from "#i18n";
import {
  CANCELLABLE_STATUSES,
  CHECKED_STATUSES,
} from "#payment/subscription-machine-spec.ts";
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
  id: v.number(),
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

/** The subscribed booking row `id`, or null when no such row started a
 * subscription. A cancel form can name a row that is gone. The read uses the
 * primary, so the guarded status write sees the status that it compares. */
export const getSubscribedRowOrNull = async (
  id: number,
): Promise<SubscribedRow | null> => {
  const row = await queryOnePrimary(
    `SELECT ${SUBSCRIBED_COLUMNS}
       FROM listing_attendees AS booking
      WHERE booking.id = ? AND booking.subscription_id != ''`,
    [id],
  );
  return row === null ? null : v.parse(SubscribedRowSchema, row);
};

const CheckedRowSchema = v.pick(SubscribedRowSchema, [
  "attendee_id",
  "id",
  "listing_id",
  "recurring_price",
  "recurring_tax",
  "subscription_id",
  "subscription_status",
]);

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

/** A merge can replace this booking while Stripe answers. Refuse stale money
 * in the same batch as its ledger legs. */
export const renewalBookingGuard = (row: CheckedRow): SqlStatement => ({
  args: [row.id, row.attendee_id, row.listing_id, row.subscription_id],
  sql: `INSERT INTO listing_attendees (listing_id)
        SELECT NULL
         WHERE NOT EXISTS (
           SELECT 1 FROM listing_attendees AS booking
            WHERE booking.id = ? AND booking.attendee_id = ?
              AND booking.listing_id = ? AND booking.subscription_id = ?
         )`,
});

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

/** A read that finds one booking row, among the rows `where` picks, whose
 * subscription still charges. Such a row cannot be deleted. */
const liveSubscriptionStatement = (where: SqlStatement): SqlStatement => ({
  args: [...where.args, ...CANCELLABLE_STATUSES],
  sql: `SELECT booking.id
          FROM listing_attendees AS booking
         WHERE ${where.sql}
           AND booking.subscription_status IN (${inPlaceholders(CANCELLABLE_STATUSES)})
         LIMIT 1`,
});

/** The read for a live subscription among the bookings of these attendees. */
export const liveBookingOfAttendees = (
  attendeeIds: readonly number[],
): SqlStatement =>
  liveSubscriptionStatement({
    args: [...attendeeIds],
    sql: `booking.attendee_id IN (${inPlaceholders(attendeeIds)})`,
  });

/** Why one listing cannot be deleted, or null. The read joins the caller's
 * transaction when it runs inside one. */
export type ListingCheck = (
  listingId: number,
  tx?: TxScope,
) => Promise<string | null>;

/** The refusal while a booking of the listing has a subscription that still
 * charges. */
export const liveListingRefusal: ListingCheck = async (listingId, tx) => {
  const read = liveSubscriptionStatement({
    args: [listingId],
    sql: "booking.listing_id = ?",
  });
  const rows =
    tx === undefined
      ? await queryAllPrimary(read)
      : resultRows(await tx.execute(read));
  return rows.length > 0 ? t("error.subscription_live") : null;
};
