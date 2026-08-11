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
import { AUTH_FORM, withAuth } from "#routes/auth.ts";
/* jscpd:ignore-start */
import { errorRedirect, htmlResponse, redirect } from "#routes/response.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
/* jscpd:ignore-end */
import { decryptAttendeeOrNull } from "#shared/db/attendees/pii.ts";
import { getAttendeeRaw } from "#shared/db/attendees/queries.ts";
import { queryOne } from "#shared/db/client.ts";
import {
  getRefundPaymentReferencesForAttendee,
  type RefundPaymentReference,
} from "#shared/db/payment-references.ts";
import type { FormParams } from "#shared/form-data.ts";
import { reportRefundNotRecorded } from "#shared/invariant-errors.ts";
/* jscpd:ignore-start */
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import type { Attendee } from "#shared/types.ts";
/* jscpd:ignore-end */
import { refreshClaimedPayment } from "./refunds/refresh.ts";

/** Minimal context needed by the refresh-payment flow. */
type RefreshPaymentContext = {
  attendee: Attendee;
  /** Listing id for the activity log — from the booking row, so it works even
   * for a quantity-0 placeholder whose listing was since deleted. */
  listingId: number;
};

/** Load the attendee + its first listing id for the refresh-payment flow.
 * Prefers a real booking (quantity > 0) but falls back to a quantity-0
 * placeholder, so a stored-but-unrefunded placeholder can be refreshed when
 * its Square refund later settles. */
const loadRefreshContext = async (
  attendeeId: number,
): Promise<RefreshPaymentContext | null> => {
  const pk = await requireRequestPrivateKey();
  const attendeeRaw = await getAttendeeRaw(attendeeId);
  if (!attendeeRaw) return null;
  const attendee = (await decryptAttendeeOrNull(attendeeRaw, pk))!;
  const firstBooking = await queryOne<{ listing_id: number }>(
    `SELECT listingAttendee.listing_id
       FROM listing_attendees AS listingAttendee
      WHERE listingAttendee.attendee_id = ?
      ORDER BY (listingAttendee.quantity > 0) DESC,
               listingAttendee.start_at, listingAttendee.listing_id
      LIMIT 1`,
    [attendeeId],
  );
  if (!firstBooking) return null;
  return { attendee, listingId: firstBooking.listing_id };
};

/** Load the attendee, listing, and payment references for a refresh. Returns
 *  either a Redirect (for the error paths: not found or no references) or the
 *  context the handler needs. */
const loadRefreshState = async (
  attendeeId: number,
  form: FormParams,
): Promise<
  | Response
  | {
    attendee: Attendee;
    listingId: number;
    references: readonly RefundPaymentReference[];
  }
> => {
  const ctx = await loadRefreshContext(attendeeId);
  if (!ctx) return htmlResponse("", 404);
  const { attendee, listingId } = ctx;
  const privateKey = await requireRequestPrivateKey();
  const references = await getRefundPaymentReferencesForAttendee(
    attendee,
    privateKey,
  );
  if (references.length === 0) {
    return redirect(
      `/admin/attendees/${attendeeId}`,
      t("error.no_payment_to_refresh"),
      false,
      { form },
    );
  }
  return { attendee, listingId, references };
};

/** Handle POST /admin/attendees/:attendeeId/refresh-payment */
export const handleRefreshPayment: TypedRouteHandler<
  "POST /admin/attendees/:attendeeId/refresh-payment"
> = (request, { attendeeId }) =>
  withAuth(request, AUTH_FORM, async (_session, _form) => {
    const form = _form as FormParams;
    const state = await loadRefreshState(attendeeId, form);
    if (state instanceof Response) return state;
    const { attendee, listingId, references } = state;
    const result = await refreshClaimedPayment(
      { attendee, references: [...references] },
      listingId,
    );
    if (result.kind === "blocked") {
      return errorRedirect(
        `/admin/attendees/${attendeeId}`,
        t("error.refund_pending"),
      );
    }
    if (result.kind === "not_ready" || result.kind === "needs_review") {
      return errorRedirect(
        `/admin/attendees/${attendeeId}`,
        result.message,
      );
    }
    if (result.kind === "returned") {
      if (!result.posted) {
        return errorRedirect(
          `/admin/attendees/${attendeeId}`,
          reportRefundNotRecorded({ attendeeId, listingId }),
        );
      }
      return redirect(
        `/admin/attendees/${attendeeId}`,
        result.confirmation === "current"
          ? t("success.payment_status_current")
          : t("success.payment_status_refunded"),
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
