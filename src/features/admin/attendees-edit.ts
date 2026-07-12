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
import type { ListingAttendeeRow } from "#shared/db/attendee-types.ts";
import { ATTENDEE_KIND } from "#shared/db/attendees/kind.ts";
import { decryptAttendeeOrNull } from "#shared/db/attendees/pii.ts";
import {
  ATTENDEE_LEFT_JOIN_SELECT,
  LISTING_ATTENDEE_ROW_COLS,
} from "#shared/db/attendees/queries.ts";
import { queryAll, queryOne } from "#shared/db/client.ts";
import { getListingWithCount } from "#shared/db/listings/records.ts";
import {
  getRefundPaymentReferences,
  markPaymentReferencesProviderRefunded,
  type RefundPaymentReference,
} from "#shared/db/payment-references.ts";
import type { FormParams } from "#shared/form-data.ts";
import {
  getActivePaymentProvider,
  type PaymentProvider,
} from "#shared/payments.ts";
import { recordAttendeeRefund } from "#shared/refund-ledger.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import type { Attendee, ListingWithCount } from "#shared/types.ts";
import { NO_PROVIDER_ERROR } from "./attendees-route-helpers.ts";
import { PROVIDER_REFUND_CONCURRENCY } from "./refunds/provider.ts";

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
  const attendeeRaw = await queryOne<Attendee>(
    `SELECT ${ATTENDEE_LEFT_JOIN_SELECT}
     FROM attendees AS attendee
     LEFT JOIN listing_attendees AS listingAttendee ON listingAttendee.attendee_id = attendee.id
     WHERE attendee.id = ? AND attendee.kind = '${ATTENDEE_KIND}'`,
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

const refreshProviderRefunds = async (
  provider: Pick<PaymentProvider, "isPaymentRefunded">,
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
                providerRefunded: await provider.isPaymentRefunded(
                  reference.reference,
                ),
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

    const provider = await getActivePaymentProvider();
    if (!provider) {
      return errorRedirect(`/admin/attendees/${attendeeId}`, NO_PROVIDER_ERROR);
    }

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
