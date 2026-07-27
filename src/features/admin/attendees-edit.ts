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
import { attendeeAccount, WORLD } from "#shared/accounting/accounts.ts";
import { KIND } from "#shared/accounting/kinds.ts";
import { transfersByAccount } from "#shared/accounting/queries.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { decryptAttendeeOrNull } from "#shared/db/attendees/pii.ts";
import { getAttendeeRaw } from "#shared/db/attendees/queries.ts";
import { queryOne } from "#shared/db/client.ts";
import {
  createSystemNote,
  deleteAttendeeNote,
  getNotesForAttendee,
} from "#shared/db/system-notes.ts";
import type { FormParams } from "#shared/form-data.ts";
import { legMatches } from "#shared/ledger/legs.ts";
import type { RefundPaymentReference } from "#shared/payment-refund-reference.ts";
import { refundPaymentTargets } from "#shared/payment-runtime/refund.ts";
import {
  getAttendeePaymentRefundOrNull,
  type PaymentRefundTarget,
} from "#shared/payment-runtime/refund-targets.ts";
import { recordAttendeeRefund } from "#shared/refund-ledger.ts";
/* jscpd:ignore-start */
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import type { Attendee } from "#shared/types.ts";

/* jscpd:ignore-end */

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

/** After the provider confirms the refund, record it in the ledger and add a
 *  resolving note if the attendee is a quantity-0 placeholder. Returns null on
 *  success (caller redirects), or a Response for the error redirect paths. */
const recordConfirmedRefund = async (
  attendee: Attendee,
  attendeeId: number,
  listingId: number,
  references: readonly RefundPaymentReference[],
  privateKey: CryptoKey,
): Promise<Response | null> => {
  // Check if this is a payment-only placeholder BEFORE posting the refund —
  // afterward the new refund_cash leg would make the "only payment legs" check
  // fail. A placeholder has ONLY provider-payment legs (from world, kind =
  // payment), no sale/fee/adjustment. A surcharge-only order (payment + fee)
  // is NOT a placeholder, so the note is not created for it. This matches the
  // isPaymentOnlyPlaceholder check in refund-ledger.ts.
  const legsBeforeRefund = await transfersByAccount(
    attendeeAccount(attendeeId),
  );
  const isProviderPayment = legMatches({ from: WORLD, kind: KIND.payment });
  const isPlaceholder =
    legsBeforeRefund.length > 0 && legsBeforeRefund.every(isProviderPayment);

  const { posted } = await recordAttendeeRefund(attendeeId, references);
  if (!attendee.refunded) {
    await logActivity(
      `Payment marked as refunded for attendee '${attendee.name}'`,
      listingId,
      attendeeId,
    );
  }
  if (!posted) {
    return errorRedirect(
      `/admin/attendees/${attendeeId}`,
      t("error.refund_not_recorded"),
    );
  }
  // Always delete the stale "could NOT be refunded" note when the refund is
  // confirmed, even when isPlaceholder is false (after the first refresh the
  // account has a refund_cash leg, so isPlaceholder becomes false — but the
  // stale note could still be there if the previous cleanup failed).
  await cleanupStaleManualRefundNote(attendeeId, privateKey);
  if (isPlaceholder) {
    await createSystemNote(attendeeId, t("note.placeholder_refund_confirmed"));
  }
  return null;
};

/** Delete any stale "could NOT be refunded" system notes left by
 *  storeRefundedBooking. Retryable on every refresh — even when the ledger
 *  was already posted — so a failed note cleanup on a previous refresh does
 *  not strand the stale manual-refund instruction forever. */
const cleanupStaleManualRefundNote = async (
  attendeeId: number,
  privateKey: CryptoKey,
): Promise<void> => {
  const notes = await getNotesForAttendee(attendeeId, privateKey);
  for (const note of notes) {
    if (note.type === "system" && note.note.includes("could NOT be refunded")) {
      await deleteAttendeeNote(attendeeId, note.id);
    }
  }
};

/** Load the attendee, listing, and payment references for a refresh. Returns
 *  either a Redirect (for the error paths: not found, no references, no
 *  provider) or the context the handler needs. */
const loadRefreshState = async (
  attendeeId: number,
  form: FormParams,
): Promise<
  | Response
  | {
      attendee: Attendee;
      listingId: number;
      privateKey: CryptoKey;
      targets: PaymentRefundTarget[];
      references: readonly RefundPaymentReference[];
    }
> => {
  const ctx = await loadRefreshContext(attendeeId);
  if (!ctx) return htmlResponse("", 404);
  const { attendee, listingId } = ctx;
  const privateKey = await requireRequestPrivateKey();
  const refund = await getAttendeePaymentRefundOrNull(attendeeId);
  return refund === null
    ? redirect(
        `/admin/attendees/${attendeeId}`,
        t("error.no_payment_to_refresh"),
        false,
        { form },
      )
    : { attendee, listingId, privateKey, ...refund };
};

type LoadedRefreshState = Exclude<
  Awaited<ReturnType<typeof loadRefreshState>>,
  Response
>;

const refreshLoadedPayment = async (
  attendeeId: number,
  form: FormParams,
  state: LoadedRefreshState,
): Promise<Response> => {
  const { attendee, listingId, privateKey, references, targets } = state;
  const incomplete = targets.filter((target) =>
    target.charges.some((charge) => charge.refundState !== "none"),
  );
  const outcomes = await refundPaymentTargets(incomplete);
  const allRefunded =
    outcomes.length > 0 &&
    outcomes.every((outcome) => outcome.status === "completed");
  if (!allRefunded) {
    return redirect(
      `/admin/attendees/${attendeeId}`,
      t("success.payment_status_current"),
      true,
      { form },
    );
  }
  const error = await recordConfirmedRefund(
    attendee,
    attendeeId,
    listingId,
    references,
    privateKey,
  );
  if (error) return error;
  return redirect(
    `/admin/attendees/${attendeeId}`,
    attendee.refunded
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
    return refreshLoadedPayment(attendeeId, form, state);
  });
