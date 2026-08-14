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
import { getFirstBooking } from "#shared/db/attendees/queries.ts";
/* jscpd:ignore-end */
import {
  getRefundPaymentReferencesForAttendee,
  type TaggedRefundPaymentReference,
} from "#shared/db/payment-references.ts";
import type { FormParams } from "#shared/form-data.ts";
import { reportRefundNotRecorded } from "#shared/invariant-errors.ts";
/* jscpd:ignore-start */
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import type { Attendee } from "#shared/types.ts";
/* jscpd:ignore-end */
import { attendeeActions } from "./attendees-route-helpers.ts";
import {
  type RefreshPaymentResult,
  refreshClaimedPayment,
} from "./refunds/refresh.ts";

/** Minimal context needed by the refresh-payment flow. */
type RefreshPaymentContext = {
  attendee: Attendee;
  /** The attendee keeps its original listing id even after listing deletion. */
  listingId: number;
};

/** Load the attendee without requiring a surviving booking. */
const loadRefreshContext = async (
  attendeeId: number,
): Promise<RefreshPaymentContext | null> => {
  const data = await attendeeActions["refresh-payment"].load(attendeeId);
  if (data === null) return null;
  const { attendee } = data;
  const firstBooking = await getFirstBooking(attendee.id);
  return {
    attendee,
    listingId: firstBooking?.listingId ?? attendee.listing_id,
  };
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
      references: readonly TaggedRefundPaymentReference[];
    }
> => {
  const ctx = await loadRefreshContext(attendeeId);
  if (!ctx) return htmlResponse("", 404);
  const { attendee, listingId } = ctx;
  const privateKey = await requireRequestPrivateKey();
  const referenceSet = await getRefundPaymentReferencesForAttendee(
    { currentPaymentId: attendee.payment_id, id: attendee.id },
    privateKey,
  );
  if (referenceSet.kind !== "complete") {
    return redirect(
      `/admin/attendees/${attendeeId}`,
      t(
        {
          legacy_unindexed: "error.payment_history_incomplete",
          provider_unknown: "error.payment_provider_unknown",
          too_many_references: "error.payment_history_too_large",
        }[referenceSet.kind],
      ),
      false,
      { form },
    );
  }
  const references = referenceSet.references;
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

const refreshPaymentResponse = (
  attendeeId: number,
  listingId: number,
  form: FormParams,
  result: RefreshPaymentResult,
): Response => {
  const attendeeUrl = `/admin/attendees/${attendeeId}`;
  if (result.kind === "blocked") {
    return errorRedirect(attendeeUrl, t("error.refund_pending"));
  }
  if (result.kind === "not_ready" || result.kind === "needs_review") {
    return errorRedirect(attendeeUrl, result.message);
  }
  if (result.kind === "current") {
    return redirect(attendeeUrl, t("success.payment_status_current"), true, {
      form,
    });
  }
  if (!result.posted) {
    return errorRedirect(
      attendeeUrl,
      reportRefundNotRecorded({ attendeeId, listingId }),
    );
  }
  return redirect(
    attendeeUrl,
    result.confirmation === "current"
      ? t("success.payment_status_current")
      : t("success.payment_status_refunded"),
    true,
    { form },
  );
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
    return refreshPaymentResponse(attendeeId, listingId, form, result);
  });
