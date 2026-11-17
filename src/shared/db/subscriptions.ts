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
import { type SqlStatement, sql } from "#db/sql.ts";
import { update } from "#db/write.ts";
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

/** The words that a blank column cannot hold on a subscribed row: the booking
 * path writes the plan, the id and the status together. */
const CHECKED_WORDS = {
  subscriptionId: v.pipe(v.string(), v.minLength(1)),
  subscriptionStatus: SubscriptionStatusSchema,
};
const CheckedWordsSchema = v.object(CHECKED_WORDS);
const SubscribedWordsSchema = v.object({
  ...CHECKED_WORDS,
  recurringInterval: RecurringIntervalSchema,
});

/** The columns that each read of a subscribed row needs. */
const CHECKED_COLUMNS = [
  "id",
  "attendeeId",
  "listingId",
  "recurringPrice",
  "recurringTax",
  "subscriptionId",
  "subscriptionStatus",
] as const;
const SUBSCRIBED_COLUMNS = [
  ...CHECKED_COLUMNS,
  "quantity",
  "recurringInterval",
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

/** The booking rows that started a subscription. */
const subscribedBookings = () =>
  bookings().where((booking) => notEqual(booking.subscriptionId, ""));

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
): Promise<CheckedRow[]> =>
  (
    await readRows(
      bookings()
        .where({ subscriptionStatus: CHECKED_STATUSES })
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
               attendeeId: row.attendeeId,
               id: row.id,
               listingId: row.listingId,
               subscriptionId: row.subscriptionId,
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
    : [row.subscriptionStatus];

/** Write the status Stripe reported over the status that `row` held. */
export const statusWrite = (
  row: CheckedRow,
  status: SubscriptionStatus,
): SqlStatement =>
  update(tables.listing_attendees, { subscriptionStatus: status }).where({
    id: row.id,
    subscriptionStatus: replaceableBy(row, status),
  });

/** The booking rows whose subscription still charges. Such a row cannot be
 * deleted. */
const liveBookings = () =>
  bookings().where({ subscriptionStatus: CANCELLABLE_STATUSES });

/** The read for a live subscription among the bookings of these attendees. */
export const liveBookingOfAttendees = (
  attendeeIds: readonly number[],
): SqlStatement => liveBookings().where({ attendeeId: attendeeIds }).probe();

/** Why one listing cannot be deleted, or null. The read joins the caller's
 * transaction when it runs inside one. */
export type ListingCheck = (
  listingId: number,
  tx?: TxScope,
) => Promise<string | null>;

/** The refusal while a booking of the listing has a subscription that still
 * charges. */
export const liveListingRefusal: ListingCheck = async (listingId, tx) => {
  const read = liveBookings().where({ listingId }).probe();
  const rows =
    tx === undefined
      ? await queryAllPrimary(read)
      : resultRows(await tx.execute(read));
  return rows.length > 0 ? t("error.subscription_live") : null;
};
