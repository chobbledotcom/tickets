/** The Subscriptions page: who subscribed, to what, and where Stripe says each
 * subscription stands. */

import { getAttendeeNamesByIds } from "#db/attendees/queries.ts";
import { listingNames } from "#db/listings/records.ts";
import { getSubscribedRows, type SubscribedRow } from "#db/subscriptions.ts";
import { map, requiredMapValue, unique } from "#fp";
import { t } from "#i18n";
import { defineAdminRoutes } from "#routes/admin/route-tables.ts";
import { authPageAt } from "#routes/route-gates.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import {
  adminSubscriptionsPage,
  type SubscriberRow,
} from "#templates/admin/subscriptions.tsx";

const idsOf = (
  rows: SubscribedRow[],
  pick: (row: SubscribedRow) => number,
): number[] => unique(map(pick)(rows));

/** Pair each row with its subscriber and ticket names. A failed checkout can
 * retain a zero-quantity row after the ticket was removed. */
const subscriberRows = async (
  rows: SubscribedRow[],
): Promise<SubscriberRow[]> => {
  const [names, tickets] = await Promise.all([
    getAttendeeNamesByIds(
      idsOf(rows, (row) => row.attendee_id),
      await requireRequestPrivateKey(),
    ),
    listingNames.byIds(idsOf(rows, (row) => row.listing_id)),
  ]);
  return rows.map((row) => ({
    attendeeId: row.attendee_id,
    interval: row.recurring_interval,
    name: requiredMapValue(names, row.attendee_id, "Subscriber not found"),
    price: row.recurring_price,
    status: row.subscription_status,
    stripeId: row.subscription_id,
    tax: row.recurring_tax,
    ticket:
      row.quantity === 0 && !tickets.has(row.listing_id)
        ? t("subscriptions.ticket_removed")
        : requiredMapValue(tickets, row.listing_id, "Ticket not found"),
  }));
};

const handleSubscriptionsGet = authPageAt("subscriptions")(
  async (session, _request, flash) =>
    adminSubscriptionsPage({
      flash,
      session,
      subscribers: await subscriberRows(await getSubscribedRows()),
    }),
);

export const adminHandlers = defineAdminRoutes({
  "GET /admin/subscriptions": handleSubscriptionsGet,
});
