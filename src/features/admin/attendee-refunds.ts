import { defineRoutes } from "#routes/router.ts";
/**
 * Admin attendee refund routes (single + bulk)
 */

/* jscpd:ignore-start */
import { compact } from "#fp";
import { t } from "#i18n";
import {
  withDecryptedAttendees,
  withListingAttendeesAuth,
} from "#routes/admin/actions.ts";
import { verifyOrRedirect } from "#routes/admin/confirmation.ts";
import type { AuthSession } from "#routes/auth.ts";
import { applyFlash } from "#routes/csrf.ts";
import { errorRedirect, htmlResponse, redirect } from "#routes/response.ts";
import { createAuthedHandler } from "#shared/app-forms.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { hasActiveBookingLine } from "#shared/db/attendees/queries.ts";
import {
  getRefundPaymentReferences,
  hasRefundPaymentReference,
} from "#shared/db/payment-references.ts";
import type { FormParams } from "#shared/form-data.ts";
import { recordAttendeeRefund } from "#shared/refund-ledger.ts";
import { fail, ok } from "#shared/response.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import { BULK_REFUND_LIMIT } from "#shared/subrequest-budget.ts";
import type { Attendee, ListingWithCount } from "#shared/types.ts";
import {
  adminRefundAllAttendeesPage,
  adminRefundAttendeePage,
} from "#templates/admin/attendees.tsx";
import {
  attendeeActionPage,
  attendeeActionUrlWithReturn,
  type ListingRouteParams,
  NO_PROVIDER_ERROR,
  verifiedAttendeeAction,
} from "./attendees-route-helpers.ts";
import { getRefundCandidates } from "./refunds/candidates.ts";
import {
  processRefundBatch,
  type RefundCounts,
  refundCandidateAtProvider,
} from "./refunds/provider.ts";
import { requirePaymentProvider } from "./require-provider.ts";

/* jscpd:ignore-end */

/** Render refund error redirect for a single attendee, keeping the caller's
 * return_url threaded through so a retry still lands back where it started. */
const refundError = (
  attendeeId: number,
  msg: string,
  returnUrl: string,
): Response =>
  errorRedirect(
    attendeeActionUrlWithReturn(attendeeId, "refund", returnUrl),
    msg,
  );

/** Handle GET /admin/attendees/:attendeeId/refund. The guard blocks (no
 * payment, already refunded, or a no-quantity ghost home line) render the
 * page with a message at 400; the clean GET renders the flashed error (if
 * any) at 200 — attendeeActionPage supplies exactly that shape. */
const handleAdminAttendeeRefundGet = attendeeActionPage(
  adminRefundAttendeePage,
  async (data) => {
    // The no-payment branch also covers a no-quantity ghost home line: the
    // guard runs against the exact (attendee, home listing) row, so a refund
    // can't fire for a non-booking.
    if (!(await hasActiveBookingLine(data.attendee.id, data.listing.id))) {
      return t("error.no_payment_to_refund");
    }
    if (data.attendee.refunded) {
      return t("error.already_refunded");
    }
    if (
      !(await hasRefundPaymentReference(
        data.attendee,
        await requireRequestPrivateKey(),
      ))
    ) {
      return t("error.no_payment_to_refund");
    }
    return null;
  },
);

/** Handle POST /admin/attendees/:attendeeId/refund */
const handleAttendeeRefund = verifiedAttendeeAction(
  "refund",
  "refund",
  async (data, form) => {
    const attendeeId = data.attendee.id;
    const listingId = data.listing.id;
    const returnUrl = form.getString("return_url");
    // Refuse a refund on a no-quantity ghost home line (checked against the
    // exact (attendee, home listing) pair) rather than refunding the payment
    // for a non-booking.
    if (!(await hasActiveBookingLine(attendeeId, listingId))) {
      return refundError(
        attendeeId,
        t("error.no_payment_to_refund"),
        returnUrl,
      );
    }
    if (data.attendee.refunded) {
      return refundError(attendeeId, t("error.already_refunded"), returnUrl);
    }
    const references = (
      await getRefundPaymentReferences(
        [data.attendee],
        await requireRequestPrivateKey(),
      )
    ).get(attendeeId)!;
    if (references.length === 0) {
      return refundError(
        attendeeId,
        t("error.no_payment_to_refund"),
        returnUrl,
      );
    }

    const provider = await requirePaymentProvider(() =>
      refundError(attendeeId, NO_PROVIDER_ERROR, returnUrl),
    );
    if (provider instanceof Response) return provider;

    const refunded = await refundCandidateAtProvider(
      provider,
      { attendee: data.attendee, references },
      listingId,
    );
    if (refunded.outcome !== "refunded") {
      return refundError(attendeeId, t("error.refund_failed"), returnUrl);
    }

    const { posted } = await recordAttendeeRefund(attendeeId, references);
    await logActivity(
      `Refund issued for attendee '${data.attendee.name}'`,
      listingId,
      attendeeId,
    );
    // The provider refund succeeded; if the ledger post missed (refund status is
    // now ledger-only), surface it so the admin makes a manual adjustment rather
    // than re-refunding an already-refunded payment.
    if (!posted) {
      return refundError(attendeeId, t("error.refund_not_recorded"), returnUrl);
    }
    // Honor the caller's return_url (e.g. the attendee page's Actions tab);
    // fall back to that tab otherwise.
    return redirect(
      `/admin/attendees/${attendeeId}/actions`,
      t("success.refund_issued"),
      true,
      { form },
    );
  },
);

/** Handle GET /admin/listing/:id/refund-all */
const handleAdminRefundAllGet = (
  request: Request,
  { id }: ListingRouteParams,
): Promise<Response> =>
  withListingAttendeesAuth(request, id, async (listing, attendees, session) => {
    const flash = applyFlash(request);
    const count = (
      await getRefundCandidates(attendees, await requireRequestPrivateKey())
    ).length;
    return count === 0
      ? htmlResponse(
          adminRefundAllAttendeesPage(
            listing,
            0,
            session,
            flash.error ?? t("error.no_attendees_to_refund"),
          ),
          400,
        )
      : htmlResponse(
          adminRefundAllAttendeesPage(listing, count, session, flash.error),
        );
  });

type RefundResponseCtx = {
  listing: ListingWithCount;
  refundAllUrl: string;
  counts: RefundCounts;
  remaining: number;
};

/** Build the error response branch of a bulk refund (some refunds failed). */
const buildRefundProblemResponse = async (
  ctx: RefundResponseCtx,
): Promise<Response> => {
  const { listing, refundAllUrl, counts, remaining } = ctx;
  const { refundedCount, failedCount, errorCount } = counts;
  const problemCount = failedCount + errorCount;
  const msg = compact([
    t("admin.attendees.refund_all_result_refunds", {
      count: refundedCount,
    }),
    t("admin.attendees.refund_all_result_failures", {
      count: problemCount,
    }),
    errorCount > 0
      ? t("admin.attendees.refund_all_result_errors", { count: errorCount })
      : null,
    t(
      remaining > 0
        ? "admin.attendees.refund_all_result_remaining"
        : "admin.attendees.refund_all_result_complete",
      { count: remaining },
    ),
  ]).join(" ");
  await logActivity(
    `Bulk refund: ${refundedCount} succeeded, ${problemCount} failed for '${listing.name}'`,
    listing.id,
  );
  return fail(refundAllUrl, msg);
};

/** Build the final response for a bulk refund based on tallied results. */
const buildRefundAllResponse = async (
  ctx: RefundResponseCtx & { totalRefundable: number },
): Promise<Response> => {
  const { counts, listing, refundAllUrl, totalRefundable, remaining } = ctx;
  const refundedCount = counts.refundedCount;
  const hasProblems = counts.failedCount + counts.errorCount > 0;

  if (hasProblems) {
    return buildRefundProblemResponse({
      counts,
      listing,
      refundAllUrl,
      remaining,
    });
  }

  if (remaining > 0) {
    await logActivity(
      `Bulk refund: ${refundedCount} of ${totalRefundable} refunded for '${listing.name}'`,
      listing.id,
    );
    return ok(
      refundAllUrl,
      [
        t("admin.attendees.refund_all_result_refunds", {
          count: refundedCount,
        }),
        t("admin.attendees.refund_all_result_remaining", {
          count: remaining,
        }),
      ].join(" "),
    );
  }

  await logActivity(
    `Bulk refund: all ${refundedCount} attendee(s) refunded for '${listing.name}'`,
    listing.id,
  );
  return ok(`/admin/listing/${listing.id}`, t("success.all_refunded"));
};

/** Process bulk refund for all refundable attendees */
const processRefundAll = async (
  listing: ListingWithCount,
  attendees: Attendee[],
  _session: AuthSession,
  form: FormParams,
): Promise<Response> => {
  const refundAllUrl = `/admin/listing/${listing.id}/refund-all`;
  const refundable = await getRefundCandidates(
    attendees,
    await requireRequestPrivateKey(),
  );
  const error = verifyOrRedirect(
    form,
    listing.name,
    refundAllUrl,
    "Listing name",
  );
  if (error) return error;

  if (refundable.length === 0) {
    return fail(refundAllUrl, t("error.no_attendees_to_refund"));
  }

  const provider = await requirePaymentProvider(() =>
    fail(refundAllUrl, NO_PROVIDER_ERROR),
  );
  if (provider instanceof Response) return provider;

  const batch = refundable.slice(0, BULK_REFUND_LIMIT);
  const remaining = refundable.length - batch.length;
  const counts = await processRefundBatch(provider, batch, listing.id);
  return buildRefundAllResponse({
    counts,
    listing,
    refundAllUrl,
    remaining,
    totalRefundable: refundable.length,
  });
};

/** Handle POST /admin/listing/:id/refund-all */
const handleAdminRefundAllPost = createAuthedHandler<ListingRouteParams>({
  handle: ({ form, params, session }) =>
    withDecryptedAttendees(session, params.id, (listing, attendees) =>
      processRefundAll(listing, attendees, session, form),
    ),
});

/** Attendee refund routes */
export const adminHandlers = defineRoutes({
  "GET /admin/attendees/:attendeeId/refund": handleAdminAttendeeRefundGet,
  "GET /admin/listing/:id/refund-all": handleAdminRefundAllGet,
  "POST /admin/attendees/:attendeeId/refund": handleAttendeeRefund,
  "POST /admin/listing/:id/refund-all": handleAdminRefundAllPost,
});
