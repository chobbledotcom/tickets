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
/* jscpd:ignore-end */
import { attendeeAccount } from "#shared/accounting/accounts.ts";
import { KIND } from "#shared/accounting/kinds.ts";
import { transfersByAccount } from "#shared/accounting/queries.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { decryptAttendeeOrNull } from "#shared/db/attendees/pii.ts";
import { getAttendeeRaw } from "#shared/db/attendees/queries.ts";
import { queryOne } from "#shared/db/client.ts";
import {
  getRefundPaymentReferences,
  markPaymentReferencesProviderRefunded,
  type RefundPaymentReference,
} from "#shared/db/payment-references.ts";
import { createSystemNote } from "#shared/db/system-notes.ts";
import type { FormParams } from "#shared/form-data.ts";
import type { PaymentProvider } from "#shared/payments.ts";
import { recordAttendeeRefund } from "#shared/refund-ledger.ts";
/* jscpd:ignore-start */
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import type { Attendee } from "#shared/types.ts";
/* jscpd:ignore-end */
import { NO_PROVIDER_ERROR } from "./attendees-route-helpers.ts";
import { PROVIDER_REFUND_CONCURRENCY } from "./refunds/provider.ts";
import { requirePaymentProvider } from "./require-provider.ts";

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

/** After the provider confirms the refund, record it in the ledger and add a
 *  resolving note if the attendee is a quantity-0 placeholder. Returns null on
 *  success (caller redirects), or a Response for the error redirect paths. */
const recordConfirmedRefund = async (
  attendee: Attendee,
  attendeeId: number,
  listingId: number,
  references: readonly RefundPaymentReference[],
): Promise<Response | null> => {
  const { posted } = await recordAttendeeRefund(attendeeId, references);
  await logActivity(
    `Payment marked as refunded for attendee '${attendee.name}'`,
    listingId,
    attendeeId,
  );
  if (!posted) {
    return errorRedirect(
      `/admin/attendees/${attendeeId}`,
      t("error.refund_not_recorded"),
    );
  }
  // Only add the resolving note for a placeholder — one whose ledger has NO
  // sale legs (only payment legs, the signature of a storeRefundedBooking
  // placeholder). A normal attendee (or one that gained a real booking after
  // the placeholder was created) has sale legs, so the note is not created;
  // this checks the authoritative ledger state, not the booking quantities.
  const legs = await transfersByAccount(attendeeAccount(attendeeId));
  const hasSaleLeg = legs.some((leg) => leg.kind === KIND.sale);
  if (!hasSaleLeg) {
    await createSystemNote(attendeeId, t("note.placeholder_refund_confirmed"));
  }
  return null;
};

/** Handle POST /admin/attendees/:attendeeId/refresh-payment */
export const handleRefreshPayment: TypedRouteHandler<
  "POST /admin/attendees/:attendeeId/refresh-payment"
> = (request, { attendeeId }) =>
  withAuth(request, AUTH_FORM, async (_session, _form) => {
    const ctx = await loadRefreshContext(attendeeId);
    if (!ctx) return htmlResponse("", 404);

    const { attendee, listingId } = ctx;
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
      const error = await recordConfirmedRefund(
        attendee,
        attendeeId,
        listingId,
        refreshedReferences,
      );
      if (error) return error;
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
