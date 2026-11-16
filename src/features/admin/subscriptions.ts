/** The Subscriptions page: who subscribed, to what, and where Stripe says each
 * subscription stands. Only an owner can cancel a subscription. */

import { logActivity } from "#db/activity-log.ts";
import { getAttendeeNamesByIds } from "#db/attendees/queries.ts";
import { listingNames } from "#db/listings/records.ts";
import {
  getSubscribedRowOrNull,
  getSubscribedRows,
  type SubscribedRow,
} from "#db/subscriptions.ts";
import { map, requiredMapValue, unique } from "#fp";
import { t } from "#i18n";
import { defineAdminRoutes } from "#routes/admin/route-tables.ts";
import { createIdEntityHandler } from "#routes/entity.ts";
import { adminRedirect, errorRedirect } from "#routes/response.ts";
import { authPageAt, formGuardAt } from "#routes/route-gates.ts";
import { adminPath } from "#shared/admin-surface.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import {
  cancelOwnerSubscription,
  type OwnerCancel,
} from "#shared/subscriptions/cancellation.ts";
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
    bookingId: row.id,
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

/** What the owner reads after each cancel result, and whether this request
 * stopped the subscription at Stripe. */
const CANCEL_ANSWERS: Record<
  OwnerCancel,
  { message: string; stopped: boolean }
> = {
  behind: { message: "subscriptions.success.cancelled_behind", stopped: true },
  cancelled: { message: "subscriptions.success.cancelled", stopped: true },
  ended: { message: "subscriptions.error.ended", stopped: false },
  not_cancelled: {
    message: "subscriptions.error.not_cancelled",
    stopped: false,
  },
};

const handleSubscriptionCancelPost = createIdEntityHandler(
  getSubscribedRowOrNull,
)(formGuardAt("/admin/subscriptions/:id/cancel"))(async (row) => {
  const answer = CANCEL_ANSWERS[await cancelOwnerSubscription(row)];
  if (!answer.stopped) {
    return errorRedirect(adminPath("subscriptions", {}), t(answer.message));
  }
  await logActivity(
    `Subscription ${row.subscription_id} cancelled`,
    row.listing_id,
    row.attendee_id,
  );
  return adminRedirect("subscriptions", {}, t(answer.message), true);
});

export const adminHandlers = defineAdminRoutes({
  "GET /admin/subscriptions": handleSubscriptionsGet,
  "POST /admin/subscriptions/:id/cancel": handleSubscriptionCancelPost,
});
