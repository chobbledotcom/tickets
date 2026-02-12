/**
 * Admin attendee management routes
 */

import { filter } from "#fp";
import { logActivity } from "#lib/db/activityLog.ts";
import {
  clearPaymentId,
  decryptAttendeeOrNull,
  deleteAttendee,
  updateCheckedIn,
} from "#lib/db/attendees.ts";
import { getEventWithAttendeeRaw } from "#lib/db/events.ts";
import { ErrorCode, logError } from "#lib/logger.ts";
import { getActivePaymentProvider } from "#lib/payments.ts";
import type { AdminSession, Attendee, EventWithCount } from "#lib/types.ts";
import { defineRoutes } from "#routes/router.ts";
import { requirePrivateKey, verifyIdentifier, withDecryptedAttendees, withEventAttendeesAuth } from "#routes/admin/utils.ts";
import {
  type AuthSession,
  htmlResponse,
  notFoundResponse,
  redirect,
  requireSessionOr,
  withAuthForm,
} from "#routes/utils.ts";
import {
  adminDeleteAttendeePage,
  adminRefundAllAttendeesPage,
  adminRefundAttendeePage,
} from "#templates/admin/attendees.tsx";

/** Attendee with event data */
type AttendeeWithEvent = { attendee: Attendee; event: EventWithCount };

/** Refund error messages */
const NO_PAYMENT_ERROR = "This attendee has no payment to refund.";
const NO_PROVIDER_ERROR = "No payment provider configured.";
const NO_REFUNDABLE_ERROR = "No attendees have payments to refund.";
const REFUND_FAILED_ERROR = "Refund failed. The payment may have already been refunded.";

/**
 * Load attendee ensuring it belongs to the specified event.
 * Uses batched query to fetch event + attendee in a single DB round-trip.
 * Decrypts attendee PII using the admin private key.
 */
const loadAttendeeForEvent = async (
  session: AuthSession,
  eventId: number,
  attendeeId: number,
): Promise<AttendeeWithEvent | null> => {
  const pk = await requirePrivateKey(session);
  const result = await getEventWithAttendeeRaw(eventId, attendeeId);
  if (!result) return null;

  const attendee = await decryptAttendeeOrNull(result.attendeeRaw, pk);
  if (!attendee || attendee.event_id !== eventId) return null;

  return { attendee, event: result.event };
};

/** Load attendee with auth, returning 404 if not found */
const withAttendee = async (
  session: AuthSession,
  eventId: number,
  attendeeId: number,
  handler: (data: AttendeeWithEvent) => Response | Promise<Response>,
): Promise<Response> => {
  const data = await loadAttendeeForEvent(session, eventId, attendeeId);
  return data ? handler(data) : notFoundResponse();
};

/** Auth + load attendee GET handler (shared by delete and refund GET routes) */
const attendeeGetRoute = (
  handler: (data: AttendeeWithEvent, session: AuthSession) => Response | Promise<Response>,
) =>
  (request: Request, eventId: number, attendeeId: number): Promise<Response> =>
    requireSessionOr(request, (session) =>
      withAttendee(session, eventId, attendeeId, (data) => handler(data, session)));

/** Auth + load attendee from form handler */
const withAttendeeForm = (
  request: Request,
  eventId: number,
  attendeeId: number,
  handler: (data: AttendeeWithEvent, session: AuthSession, form: URLSearchParams) => Response | Promise<Response>,
): Promise<Response> =>
  withAuthForm(request, (session, form) =>
    withAttendee(session, eventId, attendeeId, (data) =>
      handler(data, session, form)));


/** Map return_filter form value to URL suffix */
const filterSuffix = (returnFilter: string | null): string => {
  if (returnFilter === "in") return "/in";
  if (returnFilter === "out") return "/out";
  return "";
};

/** Verify confirm_name matches attendee name, returning error page on mismatch */
const verifyAttendeeName = (
  data: AttendeeWithEvent,
  session: AuthSession,
  form: URLSearchParams,
  renderPage: (event: EventWithCount, attendee: Attendee, session: AdminSession, error: string) => string,
  errorMsg: string,
): Response | null => {
  const confirmName = form.get("confirm_name") ?? "";
  if (!verifyIdentifier(data.attendee.name, confirmName)) {
    return htmlResponse(renderPage(data.event, data.attendee, session, errorMsg), 400);
  }
  return null;
};

/** Attendee form handler that receives typed IDs */
type AttendeeFormAction = (
  data: AttendeeWithEvent, session: AuthSession, form: URLSearchParams,
  eventId: number, attendeeId: number,
) => Response | Promise<Response>;

/** Create an attendee form handler with typed IDs */
const attendeeFormAction = (handler: AttendeeFormAction) =>
  (request: Request, eventId: number, attendeeId: number): Promise<Response> =>
    withAttendeeForm(request, eventId, attendeeId, (data, session, form) =>
      handler(data, session, form, eventId, attendeeId));


/** Handle GET /admin/event/:eventId/attendee/:attendeeId/delete */
const handleAdminAttendeeDeleteGet = attendeeGetRoute((data, session) =>
  htmlResponse(adminDeleteAttendeePage(data.event, data.attendee, session)));

/** Handle POST /admin/event/:eventId/attendee/:attendeeId/delete */
const handleAttendeeDelete = attendeeFormAction(async (data, session, form, eventId, attendeeId) => {
  const error = verifyAttendeeName(data, session, form, adminDeleteAttendeePage,
    "Attendee name does not match. Please type the exact name to confirm deletion.");
  if (error) return error;

  await deleteAttendee(attendeeId);
  await logActivity(`Attendee deleted from '${data.event.name}'`, eventId);
  return redirect(`/admin/event/${eventId}`);
});

/** Handle POST /admin/event/:eventId/attendee/:attendeeId/checkin */
const handleAttendeeCheckin = attendeeFormAction(async (data, _session, form, eventId, attendeeId) => {
  const wasCheckedIn = data.attendee.checked_in === "true";
  const nowCheckedIn = !wasCheckedIn;

  await updateCheckedIn(attendeeId, nowCheckedIn);

  const action = nowCheckedIn ? "checked in" : "checked out";
  await logActivity(`Attendee ${action}`, eventId);

  const name = encodeURIComponent(data.attendee.name);
  const status = nowCheckedIn ? "in" : "out";
  const suffix = filterSuffix(form.get("return_filter"));
  return redirect(
    `/admin/event/${eventId}${suffix}?checkin_name=${name}&checkin_status=${status}#message`,
  );
});

/** Render refund error for a single attendee */
const refundError = (data: AttendeeWithEvent, session: AuthSession, msg: string): Response =>
  htmlResponse(adminRefundAttendeePage(data.event, data.attendee, session, msg), 400);

/** Handle GET /admin/event/:eventId/attendee/:attendeeId/refund */
const handleAdminAttendeeRefundGet = attendeeGetRoute((data, session) =>
  data.attendee.payment_id
    ? htmlResponse(adminRefundAttendeePage(data.event, data.attendee, session))
    : refundError(data, session, NO_PAYMENT_ERROR));

/** Handle POST /admin/event/:eventId/attendee/:attendeeId/refund */
const handleAttendeeRefund = attendeeFormAction(async (data, session, form, eventId) => {
  const nameError = verifyAttendeeName(data, session, form, adminRefundAttendeePage,
    "Attendee name does not match. Please type the exact name to confirm refund.");
  if (nameError) return nameError;

  if (!data.attendee.payment_id) return refundError(data, session, NO_PAYMENT_ERROR);

  const provider = await getActivePaymentProvider();
  if (!provider) return refundError(data, session, NO_PROVIDER_ERROR);

  const refunded = await provider.refundPayment(data.attendee.payment_id);
  if (!refunded) {
    logError({
      code: ErrorCode.PAYMENT_REFUND,
      detail: `Admin refund failed for attendee ${data.attendee.id}, payment ${data.attendee.payment_id}`,
    });
    return refundError(data, session, REFUND_FAILED_ERROR);
  }

  await clearPaymentId(data.attendee.id);
  await logActivity(`Refund issued for attendee '${data.attendee.name}'`, eventId);
  return redirect(`/admin/event/${eventId}`);
});

/** Filter attendees that have a payment_id (refundable) */
const getRefundable = filter((a: Attendee) => a.payment_id !== null);

/** Handle GET /admin/event/:id/refund-all */
const handleAdminRefundAllGet = (
  request: Request,
  eventId: number,
): Promise<Response> =>
  withEventAttendeesAuth(request, eventId, (event, attendees, session) => {
    const count = getRefundable(attendees).length;
    return count === 0
      ? htmlResponse(adminRefundAllAttendeesPage(event, 0, session, NO_REFUNDABLE_ERROR), 400)
      : htmlResponse(adminRefundAllAttendeesPage(event, count, session));
  });

/** Process bulk refund for all refundable attendees */
const processRefundAll = async (
  event: EventWithCount,
  attendees: Attendee[],
  session: AuthSession,
  form: URLSearchParams,
): Promise<Response> => {
  const refundable = getRefundable(attendees);
  const nameConfirmed = verifyIdentifier(event.name, form.get("confirm_name") ?? "");
  if (!nameConfirmed) {
    return htmlResponse(
      adminRefundAllAttendeesPage(event, refundable.length, session,
        "Event name does not match. Please type the exact name to confirm."),
      400,
    );
  }

  if (refundable.length === 0) {
    return htmlResponse(adminRefundAllAttendeesPage(event, 0, session, NO_REFUNDABLE_ERROR), 400);
  }

  const provider = await getActivePaymentProvider();
  if (!provider) {
    return htmlResponse(
      adminRefundAllAttendeesPage(event, refundable.length, session, NO_PROVIDER_ERROR), 400);
  }

  // TODO: Refunds are sequential to avoid overwhelming payment providers.
  // For large events, consider batching with Promise.all in chunks.
  let refundedCount = 0;
  let failedCount = 0;
  for (const attendee of refundable) {
    const refunded = await provider.refundPayment(attendee.payment_id!);
    if (refunded) {
      await clearPaymentId(attendee.id);
      refundedCount++;
    } else {
      failedCount++;
      logError({
        code: ErrorCode.PAYMENT_REFUND,
        detail: `Admin bulk refund failed for attendee ${attendee.id}, payment ${attendee.payment_id}`,
      });
    }
  }

  if (failedCount > 0) {
    await logActivity(`Bulk refund: ${refundedCount} succeeded, ${failedCount} failed for '${event.name}'`, event.id);
    return htmlResponse(
      adminRefundAllAttendeesPage(event, refundable.length, session,
        `${refundedCount} refund(s) succeeded, ${failedCount} failed. Some payments may have already been refunded.`),
      400,
    );
  }

  await logActivity(`Bulk refund: all ${refundedCount} attendee(s) refunded for '${event.name}'`, event.id);
  return redirect(`/admin/event/${event.id}`);
};

/** Handle POST /admin/event/:id/refund-all */
const handleAdminRefundAllPost = (
  request: Request,
  eventId: number,
): Promise<Response> =>
  withAuthForm(request, (session, form) =>
    withDecryptedAttendees(session, eventId, (event, attendees) =>
      processRefundAll(event, attendees, session, form)));

/** Attendee routes */
export const attendeesRoutes = defineRoutes({
  "GET /admin/event/:eventId/attendee/:attendeeId/delete": (request, { eventId, attendeeId }) =>
    handleAdminAttendeeDeleteGet(request, eventId, attendeeId),
  "POST /admin/event/:eventId/attendee/:attendeeId/delete": (request, { eventId, attendeeId }) =>
    handleAttendeeDelete(request, eventId, attendeeId),
  "DELETE /admin/event/:eventId/attendee/:attendeeId/delete": (request, { eventId, attendeeId }) =>
    handleAttendeeDelete(request, eventId, attendeeId),
  "POST /admin/event/:eventId/attendee/:attendeeId/checkin": (request, { eventId, attendeeId }) =>
    handleAttendeeCheckin(request, eventId, attendeeId),
  "GET /admin/event/:eventId/attendee/:attendeeId/refund": (request, { eventId, attendeeId }) =>
    handleAdminAttendeeRefundGet(request, eventId, attendeeId),
  "POST /admin/event/:eventId/attendee/:attendeeId/refund": (request, { eventId, attendeeId }) =>
    handleAttendeeRefund(request, eventId, attendeeId),
  "GET /admin/event/:eventId/refund-all": (request, { eventId }) =>
    handleAdminRefundAllGet(request, eventId),
  "POST /admin/event/:eventId/refund-all": (request, { eventId }) =>
    handleAdminRefundAllPost(request, eventId),
});
