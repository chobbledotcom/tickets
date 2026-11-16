/** The booking rows that started a Stripe subscription. */

import * as v from "valibot";
import { readRows } from "#db/read.ts";
import { desc, greaterThan, not, notEqual } from "#db/select/expression.ts";
import { from } from "#db/select/query.ts";
import { type RowOf, tables } from "#db/select/tables.ts";
import { type SqlStatement, sql, sqlList } from "#db/sql.ts";
import { CHECKED_STATUSES } from "#payment/subscription-machine-spec.ts";
import {
  RecurringIntervalSchema,
  SUBSCRIPTION_NODE_OF,
  type SubscriptionStatus,
  SubscriptionStatusSchema,
} from "#shared/subscriptions/plan.ts";

/** The words that a blank column cannot hold on a subscribed row: the booking
 * path writes the plan, the id and the status together. */
const CHECKED_WORDS = {
  subscription_id: v.pipe(v.string(), v.minLength(1)),
  subscription_status: SubscriptionStatusSchema,
};
const CheckedWordsSchema = v.object(CHECKED_WORDS);
const SubscribedWordsSchema = v.object({
  ...CHECKED_WORDS,
  recurring_interval: RecurringIntervalSchema,
});

/** The columns that each read of a subscribed row needs. */
const CHECKED_COLUMNS = [
  "id",
  "attendee_id",
  "listing_id",
  "recurring_price",
  "recurring_tax",
  "subscription_id",
  "subscription_status",
] as const;
const SUBSCRIBED_COLUMNS = [
  ...CHECKED_COLUMNS,
  "quantity",
  "recurring_interval",
] as const;

type Booking = RowOf<"listing_attendees">;

/** A row of a read, with the words that its schema proved. */
type Proved<Column extends keyof Booking, Words> = Omit<
  Pick<Booking, Column>,
  keyof Words
> &
  Words;

/** A row the scheduled check watches: the plan it read, and where it lives. */
export type CheckedRow = Proved<
  (typeof CHECKED_COLUMNS)[number],
  v.InferOutput<typeof CheckedWordsSchema>
>;

export type SubscribedRow = Proved<
  (typeof SUBSCRIBED_COLUMNS)[number],
  v.InferOutput<typeof SubscribedWordsSchema>
>;

/** Each row with its plan words checked. A blank word on a subscribed row is
 * an error. */
const provedBy =
  <Words extends Record<string, unknown>>(
    schema: v.GenericSchema<unknown, Words>,
  ) =>
  <Row extends Record<string, unknown>>(
    row: Row,
  ): Omit<Row, keyof Words> & Words => ({
    ...row,
    ...v.parse(schema, row),
  });

const bookings = () => from(tables.listing_attendees);

/** Every subscribed booking row, newest first. */
export const getSubscribedRows = async (): Promise<SubscribedRow[]> =>
  (
    await readRows(
      bookings()
        .where((booking) => notEqual(booking.subscription_id, ""))
        .orderBy((booking) => [desc(booking.id)])
        .pick(...SUBSCRIBED_COLUMNS),
    )
  ).map(provedBy(SubscribedWordsSchema));

/** The next rows the scheduled check asks Stripe about, in id order after
 * the row `afterId`. */
export const getCheckedRows = async (
  afterId: number,
  limit: number,
): Promise<CheckedRow[]> =>
  (
    await readRows(
      bookings()
        .where({ subscription_status: CHECKED_STATUSES })
        .where((booking) => greaterThan(booking.id, afterId))
        .sortedBy("id")
        .limit(limit)
        .pick(...CHECKED_COLUMNS),
    )
  ).map(provedBy(CheckedWordsSchema));

/** A merge can replace this booking while Stripe answers. Refuse stale money
 * in the same batch as its ledger legs. */
export const renewalBookingGuard = (row: CheckedRow): SqlStatement =>
  sql`INSERT INTO listing_attendees (listing_id)
        SELECT NULL
         WHERE ${not(
           bookings()
             .where({
               attendee_id: row.attendee_id,
               id: row.id,
               listing_id: row.listing_id,
               subscription_id: row.subscription_id,
             })
             .exists(),
         )}`;

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
