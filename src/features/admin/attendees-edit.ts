/**
 * Admin attendee refresh-payment route.
 *
 * The unified add/edit attendee page lives in `attendee-form-routes.ts`.
 * This module keeps the smaller refresh-payment handler that polls the
 * payment provider for an updated refund status and posts the refund to the
 * transfers ledger when the provider says it has been refunded — the ledger's
 * `refund_cash` leg is what the per-row `refunded` projection now reads.
 */

import { t } from "#i18n";
import { requirePrivateKey } from "#routes/admin/actions.ts";
import { AUTH_FORM, type AuthSession, withAuth } from "#routes/auth.ts";
import { errorRedirect, htmlResponse, redirect } from "#routes/response.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import type { ListingAttendeeRow } from "#shared/db/attendee-types.ts";
import {
  ATTENDEE_LEFT_JOIN_SELECT,
  decryptAttendeeOrNull,
  LISTING_ATTENDEE_ROW_COLS,
} from "#shared/db/attendees.ts";
import { queryAll, queryOne } from "#shared/db/client.ts";
import { getListingWithCount } from "#shared/db/listings.ts";
import type { FormParams } from "#shared/form-data.ts";
import { getActivePaymentProvider } from "#shared/payments.ts";
import { recordAttendeeRefund } from "#shared/refund-ledger.ts";
import type { Attendee, ListingWithCount } from "#shared/types.ts";
import { NO_PROVIDER_ERROR } from "./attendees-route-helpers.ts";

/** Minimal context needed by the refresh-payment flow. */
type RefreshPaymentContext = {
  attendee: Attendee;
  /** First listing the attendee is registered for — used for activity log. */
  listing: ListingWithCount;
};

/** Load the attendee + its first listing for the refresh-payment flow. */
const loadRefreshContext = async (
  session: AuthSession,
  attendeeId: number,
): Promise<RefreshPaymentContext | null> => {
  const pk = await requirePrivateKey(session);
  const attendeeRaw = await queryOne<Attendee>(
    `SELECT ${ATTENDEE_LEFT_JOIN_SELECT}
     FROM attendees a
     LEFT JOIN listing_attendees ea ON ea.attendee_id = a.id
     WHERE a.id = ?`,
    [attendeeId],
  );
  if (!attendeeRaw) return null;
  const attendee = (await decryptAttendeeOrNull(attendeeRaw, pk))!;
  const bookings = await queryAll<ListingAttendeeRow>(
    // quantity > 0: refresh-payment refunds the picked row's (attendee, listing)
    // pair, so it must target a real line — never a lower-id no-quantity ghost.
    // LISTING_ATTENDEE_ROW_COLS projects refunded/price_paid from the ledger.
    `SELECT ${LISTING_ATTENDEE_ROW_COLS} FROM listing_attendees WHERE attendee_id = ? AND quantity > 0 ORDER BY start_at, listing_id LIMIT 1`,
    [attendeeId],
  );
  const firstListingId = bookings[0]?.listing_id ?? attendee.listing_id;
  const listing = await getListingWithCount(firstListingId);
  if (!listing) return null;
  return { attendee, listing };
};

/** Handle POST /admin/attendees/:attendeeId/refresh-payment */
export const handleRefreshPayment: TypedRouteHandler<
  "POST /admin/attendees/:attendeeId/refresh-payment"
> = (request, { attendeeId }) =>
  withAuth(request, AUTH_FORM, async (session, _form) => {
    const ctx = await loadRefreshContext(session, attendeeId);
    if (!ctx) return htmlResponse("", 404);

    const { attendee, listing } = ctx;
    const form = _form as FormParams;

    if (!attendee.payment_id) {
      return redirect(
        `/admin/attendees/${attendeeId}`,
        t("error.no_payment_to_refresh"),
        false,
        { form },
      );
    }

    const provider = await getActivePaymentProvider();
    if (!provider) {
      return errorRedirect(`/admin/attendees/${attendeeId}`, NO_PROVIDER_ERROR);
    }

    const isRefunded = await provider.isPaymentRefunded(attendee.payment_id);
    if (isRefunded && !attendee.refunded) {
      const { posted } = await recordAttendeeRefund(attendeeId);
      await logActivity(
        `Payment marked as refunded for attendee '${attendee.name}'`,
        listing.id,
        attendeeId,
      );
      // Refund status is ledger-only now; if the post missed, surface it for a
      // manual adjustment instead of leaving the payment looking un-refunded.
      if (!posted) {
        return errorRedirect(
          `/admin/attendees/${attendeeId}`,
          t("error.refund_not_recorded"),
        );
      }
      return redirect(
        `/admin/attendees/${attendeeId}`,
        t("success.payment_status_refunded"),
        true,
        { form },
      );
    }

    return redirect(
      `/admin/attendees/${attendeeId}`,
      t("success.payment_status_current"),
      true,
      { form },
    );
  });
