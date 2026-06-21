/**
 * Admin attendee refund routes (single + bulk)
 */

import { chunk, filter } from "#fp";
import { t } from "#i18n";
import {
  withDecryptedAttendees,
  withListingAttendeesAuth,
} from "#routes/admin/actions.ts";
import { verifyOrRedirect } from "#routes/admin/confirmation.ts";
import { AUTH_FORM, type AuthSession, withAuth } from "#routes/auth.ts";
import { applyFlash } from "#routes/csrf.ts";
import { errorRedirect, htmlResponse } from "#routes/response.ts";
import { defineRoutes } from "#routes/router.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { markRefunded } from "#shared/db/attendees.ts";
import type { FormParams } from "#shared/form-data.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { getActivePaymentProvider } from "#shared/payments.ts";
import { fail, ok } from "#shared/response.ts";
import type { Attendee, ListingWithCount } from "#shared/types.ts";
import {
  adminRefundAllAttendeesPage,
  adminRefundAttendeePage,
} from "#templates/admin/attendees.tsx";
import {
  attendeeGetRoute,
  getReturnUrl,
  type ListingRouteParams,
  NO_PROVIDER_ERROR,
  verifiedAttendeeForm,
} from "./attendees-route-helpers.ts";

/** Max refunds per request to stay within Bunny Edge fetch limits */
const REFUND_BATCH_LIMIT = 30;

/** Render refund error redirect for a single attendee */
const refundError = (
  listingId: number,
  attendeeId: number,
  msg: string,
): Response =>
  errorRedirect(
    `/admin/listing/${listingId}/attendee/${attendeeId}/refund`,
    msg,
  );

/** Handle GET /admin/listing/:listingId/attendee/:attendeeId/refund */
const handleAdminAttendeeRefundGet = attendeeGetRoute(
  (data, session, request) => {
    const flash = applyFlash(request);
    const returnUrl = getReturnUrl(request);
    if (!data.attendee.payment_id) {
      return htmlResponse(
        adminRefundAttendeePage(
          data,
          session,
          t("error.no_payment_to_refund"),
          returnUrl,
        ),
        400,
      );
    }
    if (data.attendee.refunded) {
      return htmlResponse(
        adminRefundAttendeePage(
          data,
          session,
          t("error.already_refunded"),
          returnUrl,
        ),
        400,
      );
    }
    return htmlResponse(
      adminRefundAttendeePage(data, session, flash.error, returnUrl),
    );
  },
);

/** Handle POST /admin/listing/:listingId/attendee/:attendeeId/refund */
const handleAttendeeRefund = verifiedAttendeeForm(
  "refund",
  "refund",
  async (data, _form, listingId, attendeeId) => {
    if (!data.attendee.payment_id) {
      return refundError(
        listingId,
        attendeeId,
        t("error.no_payment_to_refund"),
      );
    }
    if (data.attendee.refunded) {
      return refundError(listingId, attendeeId, t("error.already_refunded"));
    }

    const provider = await getActivePaymentProvider();
    if (!provider) return refundError(listingId, attendeeId, NO_PROVIDER_ERROR);

    const refunded = await provider.refundPayment(data.attendee.payment_id);
    if (!refunded) {
      logError({
        code: ErrorCode.PAYMENT_REFUND,
        detail: `Admin refund failed for attendee ${data.attendee.id}, payment ${data.attendee.payment_id}`,
        listingId,
      });
      return refundError(listingId, attendeeId, t("error.refund_failed"));
    }

    await markRefunded(data.attendee.id, listingId);
    await logActivity(
      `Refund issued for attendee '${data.attendee.name}'`,
      listingId,
    );
    return ok(`/admin/listing/${listingId}`, t("success.refund_issued"));
  },
);

/** Filter attendees that have a payment_id and are not yet refunded */
const getRefundable = filter(
  (a: Attendee) => a.payment_id !== "" && !a.refunded,
);

/** Handle GET /admin/listing/:id/refund-all */
const handleAdminRefundAllGet = (
  request: Request,
  { id }: ListingRouteParams,
): Promise<Response> =>
  withListingAttendeesAuth(request, id, (listing, attendees, session) => {
    const flash = applyFlash(request);
    const count = getRefundable(attendees).length;
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

type RefundResult = "ok" | "failed" | "errored";
type RefundCounts = {
  refundedCount: number;
  failedCount: number;
  errorCount: number;
};

/** Refund a single attendee, returning a typed result. */
const refundOneAttendee = async (
  provider: NonNullable<Awaited<ReturnType<typeof getActivePaymentProvider>>>,
  attendee: Attendee,
  listingId: number,
): Promise<RefundResult> => {
  try {
    const refunded = await provider.refundPayment(attendee.payment_id);
    if (refunded) {
      await markRefunded(attendee.id, listingId);
      return "ok";
    }
    logError({
      code: ErrorCode.PAYMENT_REFUND,
      detail: `Admin bulk refund failed for attendee ${attendee.id}, payment ${attendee.payment_id}`,
      listingId,
    });
    return "failed";
  } catch (err) {
    const msg = String(err);
    logError({
      code: ErrorCode.PAYMENT_REFUND,
      detail: `Admin bulk refund errored for attendee ${attendee.id}, payment ${attendee.payment_id}: ${msg}`,
      listingId,
    });
    return "errored";
  }
};

/** Process a batch of refundable attendees and tally results. */
const processRefundBatch = async (
  provider: NonNullable<Awaited<ReturnType<typeof getActivePaymentProvider>>>,
  batch: Attendee[],
  listingId: number,
): Promise<RefundCounts> => {
  const REFUND_CHUNK_SIZE = 5;
  const counts: RefundCounts = {
    errorCount: 0,
    failedCount: 0,
    refundedCount: 0,
  };
  for (const group of chunk(REFUND_CHUNK_SIZE)(batch)) {
    const results = await Promise.all(
      group.map((attendee) => refundOneAttendee(provider, attendee, listingId)),
    );
    for (const result of results) {
      if (result === "ok") counts.refundedCount++;
      else if (result === "errored") counts.errorCount++;
      else counts.failedCount++;
    }
  }
  return counts;
};

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
  const errorNote =
    errorCount > 0
      ? ` (${errorCount} errored — check the activity log for details)`
      : "";
  const msg =
    remaining > 0
      ? `${refundedCount} refund(s) succeeded, ${problemCount} failed${errorNote}. ${remaining} remaining — submit again to continue.`
      : `${refundedCount} refund(s) succeeded, ${problemCount} failed${errorNote}. Some payments may have already been refunded.`;
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
      `${refundedCount} attendee(s) refunded. ${remaining} remaining — submit again to continue.`,
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
  const refundable = getRefundable(attendees);
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

  const provider = await getActivePaymentProvider();
  if (!provider) {
    return fail(refundAllUrl, NO_PROVIDER_ERROR);
  }

  const batch = refundable.slice(0, REFUND_BATCH_LIMIT);
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
const handleAdminRefundAllPost = (
  request: Request,
  { id }: ListingRouteParams,
): Promise<Response> =>
  withAuth(request, AUTH_FORM, (session, form) =>
    withDecryptedAttendees(session, id, (listing, attendees) =>
      processRefundAll(listing, attendees, session, form),
    ),
  );

/** Attendee refund routes */
export const attendeeRefundRoutes = defineRoutes({
  "GET /admin/listing/:id/refund-all": handleAdminRefundAllGet,
  "GET /admin/listing/:listingId/attendee/:attendeeId/refund":
    handleAdminAttendeeRefundGet,
  "POST /admin/listing/:id/refund-all": handleAdminRefundAllPost,
  "POST /admin/listing/:listingId/attendee/:attendeeId/refund":
    handleAttendeeRefund,
});
