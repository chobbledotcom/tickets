/**
 * Admin attendee refresh-payment route.
 *
 * The unified add/edit attendee page lives in `attendee-form-routes.ts`.
 * This module keeps the smaller refresh-payment handler that polls the
 * payment provider for an updated refund status and posts the refund to the
 * transfers ledger when the provider says it has been refunded — the ledger's
 * `refund_cash` leg is what the per-row `refunded` projection now reads.
 */

import { chunk } from "#fp";
import { t } from "#i18n";
import { AUTH_FORM, withAuth } from "#routes/auth.ts";
/* jscpd:ignore-start */
import { errorRedirect, htmlResponse, redirect } from "#routes/response.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import { logActivity } from "#shared/db/activityLog.ts";
/* jscpd:ignore-end */
import { decryptAttendeeOrNull } from "#shared/db/attendees/pii.ts";
import { getAttendeeRaw } from "#shared/db/attendees/queries.ts";
import { queryOne } from "#shared/db/client.ts";
import { requireListingWithCount } from "#shared/db/listings/records.ts";
import {
  getRefundPaymentReferences,
  markPaymentReferencesProviderRefunded,
  type RefundPaymentReference,
} from "#shared/db/payment-references.ts";
import type { FormParams } from "#shared/form-data.ts";
import type { PaymentProvider } from "#shared/payments.ts";
import { recordAttendeeRefund } from "#shared/refund-ledger.ts";
/* jscpd:ignore-start */
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import type { Attendee, ListingWithCount } from "#shared/types.ts";
/* jscpd:ignore-end */
import { NO_PROVIDER_ERROR } from "./attendees-route-helpers.ts";
import { PROVIDER_REFUND_CONCURRENCY } from "./refunds/provider.ts";
import { requirePaymentProvider } from "./require-provider.ts";

/** Minimal context needed by the refresh-payment flow. */
type RefreshPaymentContext = {
  attendee: Attendee;
  /** First listing the attendee is registered for — used for activity log. */
  listing: ListingWithCount;
};

/** Load the attendee + its first listing for the refresh-payment flow. */
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
        AND listingAttendee.quantity > 0
      ORDER BY listingAttendee.start_at, listingAttendee.listing_id
      LIMIT 1`,
    [attendeeId],
  );
  if (!firstBooking) return null;
  const listing = await requireListingWithCount(firstBooking.listing_id);
  return { attendee, listing };
};

const refreshProviderRefunds = async (
  provider: Pick<PaymentProvider, "inspectPaymentRefund">,
  references: readonly RefundPaymentReference[],
): Promise<RefundPaymentReference[]> => {
  const refreshed: RefundPaymentReference[] = [];
  // Chunk the provider status checks by charge-reference count — a merged
  // attendee can carry many charges, and an unbounded fan-out would blow the
  // edge subrequest budget before the ledger is marked. Same bound the
  // bulk-refund path uses.
  for (const group of chunk(PROVIDER_REFUND_CONCURRENCY)([...references])) {
    refreshed.push(
      ...(await Promise.all(
        group.map(async (reference) =>
          reference.providerRefunded
            ? reference
            : {
                ...reference,
                providerRefunded:
                  (await provider.inspectPaymentRefund(reference.reference)) ===
                  "refunded",
              },
        ),
      )),
    );
  }
  return refreshed;
};

const hasProviderRefund = (
  reference: Pick<RefundPaymentReference, "providerRefunded">,
): boolean => reference.providerRefunded;

/** Handle POST /admin/attendees/:attendeeId/refresh-payment */
export const handleRefreshPayment: TypedRouteHandler<
  "POST /admin/attendees/:attendeeId/refresh-payment"
> = (request, { attendeeId }) =>
  withAuth(request, AUTH_FORM, async (_session, _form) => {
    const ctx = await loadRefreshContext(attendeeId);
    if (!ctx) return htmlResponse("", 404);

    const { attendee, listing } = ctx;
    const form = _form as FormParams;

    const references = (
      await getRefundPaymentReferences(
        [attendee],
        await requireRequestPrivateKey(),
      )
    ).get(attendee.id)!;
    if (references.length === 0) {
      return redirect(
        `/admin/attendees/${attendeeId}`,
        t("error.no_payment_to_refresh"),
        false,
        { form },
      );
    }

    const provider = await requirePaymentProvider(() =>
      errorRedirect(`/admin/attendees/${attendeeId}`, NO_PROVIDER_ERROR),
    );
    if (provider instanceof Response) return provider;

    const refreshedReferences = await refreshProviderRefunds(
      provider,
      references,
    );
    await markPaymentReferencesProviderRefunded(
      refreshedReferences.filter(hasProviderRefund),
    );
    if (refreshedReferences.every(hasProviderRefund) && !attendee.refunded) {
      const { posted } = await recordAttendeeRefund(
        attendeeId,
        refreshedReferences,
      );
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
