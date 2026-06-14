/**
 * Admin attendee refresh-payment route.
 *
 * The unified add/edit attendee page lives in `attendee-form-routes.ts`.
 * This module keeps the smaller refresh-payment handler that polls the
 * payment provider for an updated refund status and flips the booking's
 * `refunded` flag when the provider says it has been refunded.
 */

import { requirePrivateKey } from "#routes/admin/actions.ts";
import { ATTENDEE_LEFT_JOIN_SELECT, decryptAttendeeOrNull, markRefunded } from "#shared/db/attendees.ts";
import { queryAll, queryOne } from "#shared/db/client.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { getActivePaymentProvider } from "#shared/payments.ts";
import type { FormParams } from "#shared/form-data.ts";
import type { EventAttendeeRow } from "#shared/db/attendee-types.ts";
import {
  AUTH_FORM,
  type AuthSession,
  withAuth,
} from "#routes/auth.ts";
import { errorRedirect, htmlResponse, redirect } from "#routes/response.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import type { Attendee, EventWithCount } from "#shared/types.ts";
import { getEventWithCount } from "#shared/db/events.ts";
import { NO_PROVIDER_ERROR } from "./attendees-route-helpers.ts";

/** Minimal context needed by the refresh-payment flow. */
type RefreshPaymentContext = {
  attendee: Attendee;
  /** First event the attendee is registered for — used for activity log. */
  event: EventWithCount;
};

/** Load the attendee + its first event for the refresh-payment flow. */
const loadRefreshContext = async (
  session: AuthSession,
  attendeeId: number,
): Promise<RefreshPaymentContext | null> => {
  const pk = await requirePrivateKey(session);
  const attendeeRaw = await queryOne<Attendee>(
    `SELECT ${ATTENDEE_LEFT_JOIN_SELECT}
     FROM attendees a
     LEFT JOIN event_attendees ea ON ea.attendee_id = a.id
     WHERE a.id = ?`,
    [attendeeId],
  );
  if (!attendeeRaw) return null;
  const attendee = (await decryptAttendeeOrNull(attendeeRaw, pk))!;
  const bookings = await queryAll<EventAttendeeRow>(
    "SELECT event_id, start_at, end_at, quantity, checked_in, refunded, price_paid, attachment_downloads FROM event_attendees WHERE attendee_id = ? ORDER BY start_at, event_id LIMIT 1",
    [attendeeId],
  );
  const firstEventId = bookings[0]?.event_id ?? attendee.event_id;
  const event = await getEventWithCount(firstEventId);
  if (!event) return null;
  return { attendee, event };
};

/** Handle POST /admin/attendees/:attendeeId/refresh-payment */
export const handleRefreshPayment: TypedRouteHandler<
  "POST /admin/attendees/:attendeeId/refresh-payment"
> = (request, { attendeeId }) =>
  withAuth(request, AUTH_FORM, async (session, _form) => {
    const ctx = await loadRefreshContext(session, attendeeId);
    if (!ctx) return htmlResponse("", 404);

    const { attendee, event } = ctx;
    const form = _form as FormParams;

    if (!attendee.payment_id) {
      return redirect(
        `/admin/attendees/${attendeeId}`,
        "No payment to refresh",
        false,
        { form },
      );
    }

    const provider = await getActivePaymentProvider();
    if (!provider) {
      return errorRedirect(
        `/admin/attendees/${attendeeId}`,
        NO_PROVIDER_ERROR,
      );
    }

    const isRefunded = await provider.isPaymentRefunded(attendee.payment_id);
    if (isRefunded && !attendee.refunded) {
      await markRefunded(attendeeId, event.id);
      await logActivity(
        `Payment marked as refunded for attendee '${attendee.name}'`,
        event.id,
      );
      return redirect(
        `/admin/attendees/${attendeeId}`,
        "Payment status updated: refunded",
        true,
        { form },
      );
    }

    return redirect(
      `/admin/attendees/${attendeeId}`,
      "Payment status is up to date",
      true,
      { form },
    );
  });
