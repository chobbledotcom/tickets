/** The booking rows that started a Stripe subscription. */

import * as v from "valibot";
import { readRows } from "#db/read.ts";
import { desc, greaterThan, not, notEqual } from "#db/select/expression.ts";
import { from } from "#db/select/query.ts";
import { type RowOf, tables } from "#db/select/tables.ts";
import { type SqlStatement, sql, sqlList } from "#db/sql.ts";
import { LIVE_STATUSES } from "#payment/subscription-machine-spec.ts";
import {
  RecurringIntervalSchema,
  SUBSCRIPTION_NODE_OF,
  type SubscriptionStatus,
  SubscriptionStatusSchema,
} from "#shared/subscriptions/plan.ts";

/** The words that a blank column cannot hold on a subscribed row: the booking
 * path writes the plan, the id and the status together. */
const LIVE_WORDS = {
  subscription_id: v.pipe(v.string(), v.minLength(1)),
  subscription_status: SubscriptionStatusSchema,
};
const LiveWordsSchema = v.object(LIVE_WORDS);
const SubscribedWordsSchema = v.object({
  ...LIVE_WORDS,
  recurring_interval: RecurringIntervalSchema,
});

/** The columns that each read of a subscribed row needs. */
const LIVE_COLUMNS = [
  "id",
  "attendee_id",
  "listing_id",
  "recurring_price",
  "recurring_tax",
  "subscription_id",
  "subscription_status",
] as const;
const SUBSCRIBED_COLUMNS = [
  ...LIVE_COLUMNS,
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

/** A live row, as a Stripe read sees it: the plan it read, and where it
 * lives. */
export type LiveRow = Proved<
  (typeof LIVE_COLUMNS)[number],
  v.InferOutput<typeof LiveWordsSchema>
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
): Promise<LiveRow[]> =>
  (
    await readRows(
      bookings()
        .where({ subscription_status: LIVE_STATUSES })
        .where((booking) => greaterThan(booking.id, afterId))
        .sortedBy("id")
        .limit(limit)
        .pick(...LIVE_COLUMNS),
    )
  ).map(provedBy(LiveWordsSchema));

/** The live row of one Stripe subscription, or null when this site holds no
 * live row for it. A delivery can name a subscription of another site on a
 * shared Stripe account, or one whose row already ended. Neither owes work. */
export const getLiveRowBySubscriptionIdOrNull = async (
  subscriptionId: string,
): Promise<LiveRow | null> => {
  const [row] = await readRows(
    bookings()
      .where({
        subscription_id: subscriptionId,
        subscription_status: LIVE_STATUSES,
      })
      .limit(1)
      .pick(...LIVE_COLUMNS),
  );
  return row === undefined ? null : provedBy(LiveWordsSchema)(row);
};

/** A merge can replace this booking while Stripe answers. Refuse stale money
 * in the same batch as its ledger legs. */
export const renewalBookingGuard = (row: LiveRow): SqlStatement =>
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
  row: LiveRow,
  status: SubscriptionStatus,
): readonly SubscriptionStatus[] =>
  SUBSCRIPTION_NODE_OF[status] === "ended"
    ? LIVE_STATUSES
    : [row.subscription_status];

/** Write the status Stripe reported over the status that `row` held. */
export const statusWrite = (
  row: LiveRow,
  status: SubscriptionStatus,
): SqlStatement =>
  sql`UPDATE listing_attendees
             SET subscription_status = ${status}
           WHERE id = ${row.id} AND subscription_status IN (${sqlList(
             replaceableBy(row, status),
           )})`;
