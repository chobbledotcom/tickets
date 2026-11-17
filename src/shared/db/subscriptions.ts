/** The booking rows that started a Stripe subscription. */

import * as v from "valibot";
import {
  queryAllPrimary,
  queryOnePrimary,
  resultRows,
  type TxScope,
} from "#db/client.ts";
import { readRows } from "#db/read.ts";
import { desc, greaterThan, not, notEqual } from "#db/select/expression.ts";
import { from } from "#db/select/query.ts";
import { type RowOf, tables } from "#db/select/tables.ts";
import { type SqlStatement, sql, sqlList } from "#db/sql.ts";
import { t } from "#i18n";
import {
  CANCELLABLE_STATUSES,
  LIVE_STATUSES,
} from "#payment/subscription-machine-spec.ts";
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

/** The booking rows that started a subscription. */
const subscribedBookings = () =>
  bookings().where((booking) => notEqual(booking.subscription_id, ""));

/** Every subscribed booking row, newest first. */
export const getSubscribedRows = async (): Promise<SubscribedRow[]> =>
  (
    await readRows(
      subscribedBookings()
        .orderBy((booking) => [desc(booking.id)])
        .pick(...SUBSCRIBED_COLUMNS),
    )
  ).map(provedBy(SubscribedWordsSchema));

/** The subscribed booking row `id`, or null when no such row started a
 * subscription. A cancel form can name a row that is gone. The read uses the
 * primary, so the guarded status write sees the status that it compares. */
export const getSubscribedRowOrNull = async (
  id: number,
): Promise<SubscribedRow | null> => {
  const row = await queryOnePrimary(
    subscribedBookings()
      .where({ id })
      .pick(...SUBSCRIBED_COLUMNS),
  );
  return row === null ? null : provedBy(SubscribedWordsSchema)(row);
};

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

/** The booking rows whose subscription still charges. Such a row cannot be
 * deleted. */
const liveBookings = () =>
  bookings().where({ subscription_status: CANCELLABLE_STATUSES });

/** The read for a live subscription among the bookings of these attendees. */
export const liveBookingOfAttendees = (
  attendeeIds: readonly number[],
): SqlStatement => liveBookings().where({ attendee_id: attendeeIds }).probe();

/** Why one listing cannot be deleted, or null. The read joins the caller's
 * transaction when it runs inside one. */
export type ListingCheck = (
  listingId: number,
  tx?: TxScope,
) => Promise<string | null>;

/** The refusal while a booking of the listing has a subscription that still
 * charges. */
export const liveListingRefusal: ListingCheck = async (listingId, tx) => {
  const read = liveBookings().where({ listing_id: listingId }).probe();
  const rows =
    tx === undefined
      ? await queryAllPrimary(read)
      : resultRows(await tx.execute(read));
  return rows.length > 0 ? t("error.subscription_live") : null;
};
