/**
 * Admin attendee refund routes (single + bulk)
 */

import { chunk, filter } from "#fp";
import { logActivity } from "#lib/db/activityLog.ts";
import { markRefunded } from "#lib/db/attendees.ts";
import type { FormParams } from "#lib/form-data.ts";
import { ErrorCode, logError } from "#lib/logger.ts";
import { getActivePaymentProvider } from "#lib/payments.ts";
import { fail, ok } from "#lib/response.ts";
import type { Attendee, EventWithCount } from "#lib/types.ts";
import {
  withDecryptedAttendees,
  withEventAttendeesAuth,
} from "#routes/admin/actions.ts";
import { verifyOrRedirect } from "#routes/admin/confirmation.ts";
import { AUTH_FORM, type AuthSession, withAuth } from "#routes/auth.ts";
import { applyFlash } from "#routes/csrf.ts";
import { errorRedirect, htmlResponse } from "#routes/response.ts";
import { defineRoutes } from "#routes/router.ts";
import {
  adminRefundAllAttendeesPage,
  adminRefundAttendeePage,
} from "#templates/admin/attendees.tsx";
import {
  attendeeGetRoute,
  type EventRouteParams,
  getReturnUrl,
  NO_PROVIDER_ERROR,
  verifiedAttendeeForm,
} from "./attendees-route-helpers.ts";

/** Refund error messages */
const NO_PAYMENT_ERROR = "This attendee has no payment to refund.";
const NO_REFUNDABLE_ERROR = "No attendees have payments to refund.";
const REFUND_FAILED_ERROR =
  "Refund failed. The payment may have already been refunded.";
const ALREADY_REFUNDED_ERROR = "This attendee has already been refunded.";

/** Max refunds per request to stay within Bunny Edge fetch limits */
const REFUND_BATCH_LIMIT = 30;

/** Render refund error redirect for a single attendee */
const refundError = (
  eventId: number,
  attendeeId: number,
  msg: string,
): Response =>
  errorRedirect(`/admin/event/${eventId}/attendee/${attendeeId}/refund`, msg);

/** Handle GET /admin/event/:eventId/attendee/:attendeeId/refund */
const handleAdminAttendeeRefundGet = attendeeGetRoute(
  (data, session, request) => {
    applyFlash(request);
    const returnUrl = getReturnUrl(request);
    if (!data.attendee.payment_id) {
      return htmlResponse(
        adminRefundAttendeePage(data, session, NO_PAYMENT_ERROR, returnUrl),
        400,
      );
    }
    if (data.attendee.refunded) {
      return htmlResponse(
        adminRefundAttendeePage(
          data,
          session,
          ALREADY_REFUNDED_ERROR,
          returnUrl,
        ),
        400,
      );
    }
    return htmlResponse(
      adminRefundAttendeePage(data, session, undefined, returnUrl),
    );
  },
);

/** Handle POST /admin/event/:eventId/attendee/:attendeeId/refund */
const handleAttendeeRefund = verifiedAttendeeForm(
  "refund",
  "refund",
  async (data, _form, eventId, attendeeId) => {
    if (!data.attendee.payment_id) {
      return refundError(eventId, attendeeId, NO_PAYMENT_ERROR);
    }
    if (data.attendee.refunded) {
      return refundError(eventId, attendeeId, ALREADY_REFUNDED_ERROR);
    }

    const provider = await getActivePaymentProvider();
    if (!provider) return refundError(eventId, attendeeId, NO_PROVIDER_ERROR);

    const refunded = await provider.refundPayment(data.attendee.payment_id);
    if (!refunded) {
      logError({
        code: ErrorCode.PAYMENT_REFUND,
        detail: `Admin refund failed for attendee ${data.attendee.id}, payment ${data.attendee.payment_id}`,
        eventId,
      });
      return refundError(eventId, attendeeId, REFUND_FAILED_ERROR);
    }

    await markRefunded(data.attendee.id, eventId);
    await logActivity(
      `Refund issued for attendee '${data.attendee.name}'`,
      eventId,
    );
    return ok(`/admin/event/${eventId}`, "Refund issued");
  },
);

/** Filter attendees that have a payment_id and are not yet refunded */
const getRefundable = filter(
  (a: Attendee) => a.payment_id !== "" && !a.refunded,
);

/** Handle GET /admin/event/:id/refund-all */
const handleAdminRefundAllGet = (
  request: Request,
  { id }: EventRouteParams,
): Promise<Response> =>
  withEventAttendeesAuth(request, id, (event, attendees, session) => {
    applyFlash(request);
    const count = getRefundable(attendees).length;
    return count === 0
      ? htmlResponse(
          adminRefundAllAttendeesPage(event, 0, session, NO_REFUNDABLE_ERROR),
          400,
        )
      : htmlResponse(adminRefundAllAttendeesPage(event, count, session));
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
  eventId: number,
): Promise<RefundResult> => {
  try {
    const refunded = await provider.refundPayment(attendee.payment_id);
    if (refunded) {
      await markRefunded(attendee.id, eventId);
      return "ok";
    }
    logError({
      code: ErrorCode.PAYMENT_REFUND,
      detail: `Admin bulk refund failed for attendee ${attendee.id}, payment ${attendee.payment_id}`,
      eventId,
    });
    return "failed";
  } catch (err) {
    const msg = String(err);
    logError({
      code: ErrorCode.PAYMENT_REFUND,
      detail: `Admin bulk refund errored for attendee ${attendee.id}, payment ${attendee.payment_id}: ${msg}`,
      eventId,
    });
    return "errored";
  }
};

/** Process a batch of refundable attendees and tally results. */
const processRefundBatch = async (
  provider: NonNullable<Awaited<ReturnType<typeof getActivePaymentProvider>>>,
  batch: Attendee[],
  eventId: number,
): Promise<RefundCounts> => {
  const REFUND_CHUNK_SIZE = 5;
  const counts: RefundCounts = {
    errorCount: 0,
    failedCount: 0,
    refundedCount: 0,
  };
  for (const group of chunk(REFUND_CHUNK_SIZE)(batch)) {
    const results = await Promise.all(
      group.map((attendee) => refundOneAttendee(provider, attendee, eventId)),
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
  event: EventWithCount;
  refundAllUrl: string;
  counts: RefundCounts;
  remaining: number;
};

/** Build the error response branch of a bulk refund (some refunds failed). */
const buildRefundProblemResponse = async (
  ctx: RefundResponseCtx,
): Promise<Response> => {
  const { event, refundAllUrl, counts, remaining } = ctx;
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
    `Bulk refund: ${refundedCount} succeeded, ${problemCount} failed for '${event.name}'`,
    event.id,
  );
  return fail(refundAllUrl, msg);
};

/** Build the final response for a bulk refund based on tallied results. */
const buildRefundAllResponse = async (
  ctx: RefundResponseCtx & { totalRefundable: number },
): Promise<Response> => {
  const { counts, event, refundAllUrl, totalRefundable, remaining } = ctx;
  const refundedCount = counts.refundedCount;
  const hasProblems = counts.failedCount + counts.errorCount > 0;

  if (hasProblems) {
    return buildRefundProblemResponse({
      counts,
      event,
      refundAllUrl,
      remaining,
    });
  }

  if (remaining > 0) {
    await logActivity(
      `Bulk refund: ${refundedCount} of ${totalRefundable} refunded for '${event.name}'`,
      event.id,
    );
    return ok(
      refundAllUrl,
      `${refundedCount} attendee(s) refunded. ${remaining} remaining — submit again to continue.`,
    );
  }

  await logActivity(
    `Bulk refund: all ${refundedCount} attendee(s) refunded for '${event.name}'`,
    event.id,
  );
  return ok(`/admin/event/${event.id}`, "All attendees refunded");
};

/** Process bulk refund for all refundable attendees */
const processRefundAll = async (
  event: EventWithCount,
  attendees: Attendee[],
  _session: AuthSession,
  form: FormParams,
): Promise<Response> => {
  const refundAllUrl = `/admin/event/${event.id}/refund-all`;
  const refundable = getRefundable(attendees);
  const error = verifyOrRedirect(form, event.name, refundAllUrl, "Event name");
  if (error) return error;

  if (refundable.length === 0) {
    return fail(refundAllUrl, NO_REFUNDABLE_ERROR);
  }

  const provider = await getActivePaymentProvider();
  if (!provider) {
    return fail(refundAllUrl, NO_PROVIDER_ERROR);
  }

  const batch = refundable.slice(0, REFUND_BATCH_LIMIT);
  const remaining = refundable.length - batch.length;
  const counts = await processRefundBatch(provider, batch, event.id);
  return buildRefundAllResponse({
    counts,
    event,
    refundAllUrl,
    remaining,
    totalRefundable: refundable.length,
  });
};

/** Handle POST /admin/event/:id/refund-all */
const handleAdminRefundAllPost = (
  request: Request,
  { id }: EventRouteParams,
): Promise<Response> =>
  withAuth(request, AUTH_FORM, (session, form) =>
    withDecryptedAttendees(session, id, (event, attendees) =>
      processRefundAll(event, attendees, session, form),
    ),
  );

/** Attendee refund routes */
export const attendeeRefundRoutes = defineRoutes({
  "GET /admin/event/:eventId/attendee/:attendeeId/refund":
    handleAdminAttendeeRefundGet,
  "GET /admin/event/:id/refund-all": handleAdminRefundAllGet,
  "POST /admin/event/:eventId/attendee/:attendeeId/refund":
    handleAttendeeRefund,
  "POST /admin/event/:id/refund-all": handleAdminRefundAllPost,
});
