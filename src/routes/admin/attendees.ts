/**
 * Admin attendee management routes
 */

import { filter } from "#fp";
import { logActivity } from "#lib/db/activityLog.ts";
import {
  createAttendeeAtomic,
  decryptAttendeeOrNull,
  deleteAttendee,
  markRefunded,
  updateAttendee,
  updateCheckedIn,
} from "#lib/db/attendees.ts";
import { queryOne } from "#lib/db/client.ts";
import { getAllEvents, getEventWithAttendeeRaw, getEventWithCount } from "#lib/db/events.ts";
import { validateForm } from "#lib/forms.tsx";
import { ErrorCode, logError } from "#lib/logger.ts";
import { getActivePaymentProvider } from "#lib/payments.ts";
import type { AdminSession, Attendee, EventWithCount } from "#lib/types.ts";
import { logAndNotifyRegistration } from "#lib/webhook.ts";
import { getCurrencyCode } from "#lib/config.ts";
import { defineRoutes } from "#routes/router.ts";
import { requirePrivateKey, verifyIdentifier, withDecryptedAttendees, withEventAttendeesAuth } from "#routes/admin/utils.ts";
import {
  type AuthSession,
  getSearchParam,
  htmlResponse,
  notFoundResponse,
  redirect,
  requireSessionOr,
  withAuthForm,
} from "#routes/utils.ts";
import {
  adminDeleteAttendeePage,
  adminEditAttendeePage,
  adminRefundAllAttendeesPage,
  adminRefundAttendeePage,
  adminResendWebhookPage,
} from "#templates/admin/attendees.tsx";
import { type AddAttendeeFormValues, getAddAttendeeFields } from "#templates/fields.ts";

/** Attendee with event data */
type AttendeeWithEvent = { attendee: Attendee; event: EventWithCount };

/** Refund error messages */
const NO_PAYMENT_ERROR = "This attendee has no payment to refund.";
const NO_PROVIDER_ERROR = "No payment provider configured.";
const NO_REFUNDABLE_ERROR = "No attendees have payments to refund.";
const REFUND_FAILED_ERROR = "Refund failed. The payment may have already been refunded.";
const ALREADY_REFUNDED_ERROR = "This attendee has already been refunded.";

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

/** Route params for event-scoped routes */
type EventRouteParams = { id: number };

/** Route params for attendee-scoped routes */
type AttendeeRouteParams = { eventId: number; attendeeId: number };

/** Auth + load attendee GET handler (shared by delete, refund, and resend-webhook GET routes) */
const attendeeGetRoute = (
  handler: (data: AttendeeWithEvent, session: AuthSession, request: Request) => Response | Promise<Response>,
) =>
  (request: Request, { eventId, attendeeId }: AttendeeRouteParams): Promise<Response> =>
    requireSessionOr(request, (session) =>
      withAttendee(session, eventId, attendeeId, (data) => handler(data, session, request)));

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


/** Read return_url from request query params */
const getReturnUrl = (request: Request): string =>
  getSearchParam(request, "return_url");

/** Read return_url from form data */
const getReturnUrlFromForm = (form: URLSearchParams): string =>
  form.get("return_url") ?? "";

/** Redirect to return_url from form if present, otherwise redirect to fallback */
const redirectOrReturn = (form: URLSearchParams, fallback: string): Response => {
  const returnUrl = getReturnUrlFromForm(form);
  return redirect(returnUrl || fallback);
};

/** Verify confirm_name matches attendee name, returning error page on mismatch */
const verifyAttendeeName = (
  data: AttendeeWithEvent,
  session: AuthSession,
  form: URLSearchParams,
  renderPage: (
    data: AttendeeWithEvent,
    session: AdminSession,
    error: string,
    returnUrl?: string,
  ) => string,
  errorMsg: string,
): Response | null => {
  const confirmName = form.get("confirm_name") ?? "";
  if (!verifyIdentifier(data.attendee.name, confirmName)) {
    const returnUrl = getReturnUrlFromForm(form);
    return htmlResponse(renderPage(data, session, errorMsg, returnUrl), 400);
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
  (request: Request, { eventId, attendeeId }: AttendeeRouteParams): Promise<Response> =>
    withAttendeeForm(request, eventId, attendeeId, (data, session, form) =>
      handler(data, session, form, eventId, attendeeId));

/** Handle GET /admin/event/:eventId/attendee/:attendeeId/delete */
const handleAdminAttendeeDeleteGet = attendeeGetRoute((data, session, request) =>
  htmlResponse(adminDeleteAttendeePage(data, session, undefined, getReturnUrl(request))));

/** Handle POST /admin/event/:eventId/attendee/:attendeeId/delete */
const handleAttendeeDelete = attendeeFormAction(async (data, session, form, eventId, attendeeId) => {
  const error = verifyAttendeeName(data, session, form, adminDeleteAttendeePage,
    "Attendee name does not match. Please type the exact name to confirm deletion.");
  if (error) return error;

  await deleteAttendee(attendeeId);
  await logActivity(`Attendee deleted from '${data.event.name}'`, eventId);
  return redirectOrReturn(form, `/admin/event/${eventId}`);
});

/** Handle POST /admin/event/:eventId/attendee/:attendeeId/checkin */
const handleAttendeeCheckin = attendeeFormAction(async (data, _session, form, eventId, attendeeId) => {
  const wasCheckedIn = data.attendee.checked_in === "true";
  const nowCheckedIn = !wasCheckedIn;

  await updateCheckedIn(attendeeId, nowCheckedIn);

  const action = nowCheckedIn ? "checked in" : "checked out";
  await logActivity(`Attendee ${action} for '${data.event.name}'`, eventId);

  const returnUrl = getReturnUrlFromForm(form);
  if (returnUrl) return redirect(returnUrl);

  const name = encodeURIComponent(data.attendee.name);
  const status = nowCheckedIn ? "in" : "out";
  const filterValue = form.get("return_filter") ?? "";
  const suffix = filterValue === "in" ? "/in" : filterValue === "out" ? "/out" : "";
  return redirect(
    `/admin/event/${eventId}${suffix}?checkin_name=${name}&checkin_status=${status}#message`,
  );
});

/** Render refund error for a single attendee */
const refundError = (
  data: AttendeeWithEvent,
  session: AuthSession,
  msg: string,
  returnUrl: string,
): Response =>
  htmlResponse(adminRefundAttendeePage(data, session, msg, returnUrl), 400);

/** Handle GET /admin/event/:eventId/attendee/:attendeeId/refund */
const handleAdminAttendeeRefundGet = attendeeGetRoute((data, session, request) => {
  if (!data.attendee.payment_id) return refundError(data, session, NO_PAYMENT_ERROR, getReturnUrl(request));
  if (data.attendee.refunded === "true") return refundError(data, session, ALREADY_REFUNDED_ERROR, getReturnUrl(request));
  return htmlResponse(adminRefundAttendeePage(data, session, undefined, getReturnUrl(request)));
});

/** Handle POST /admin/event/:eventId/attendee/:attendeeId/refund */
const handleAttendeeRefund = attendeeFormAction(async (data, session, form, eventId) => {
  const nameError = verifyAttendeeName(data, session, form, adminRefundAttendeePage,
    "Attendee name does not match. Please type the exact name to confirm refund.");
  if (nameError) return nameError;

  const returnUrl = getReturnUrlFromForm(form);
  if (!data.attendee.payment_id) return refundError(data, session, NO_PAYMENT_ERROR, returnUrl);
  if (data.attendee.refunded === "true") return refundError(data, session, ALREADY_REFUNDED_ERROR, returnUrl);

  const provider = await getActivePaymentProvider();
  if (!provider) return refundError(data, session, NO_PROVIDER_ERROR, returnUrl);

  const refunded = await provider.refundPayment(data.attendee.payment_id);
  if (!refunded) {
    logError({
      code: ErrorCode.PAYMENT_REFUND,
      detail: `Admin refund failed for attendee ${data.attendee.id}, payment ${data.attendee.payment_id}`,
    });
    return refundError(data, session, REFUND_FAILED_ERROR, returnUrl);
  }

  await markRefunded(data.attendee.id);
  await logActivity(`Refund issued for attendee '${data.attendee.name}'`, eventId);
  return redirectOrReturn(form, `/admin/event/${eventId}`);
});

/** Filter attendees that have a payment_id and are not yet refunded */
const getRefundable = filter((a: Attendee) => a.payment_id !== "" && a.refunded !== "true");

/** Handle GET /admin/event/:id/refund-all */
const handleAdminRefundAllGet = (
  request: Request,
  { id }: EventRouteParams,
): Promise<Response> =>
  withEventAttendeesAuth(request, id, (event, attendees, session) => {
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
    const refunded = await provider.refundPayment(attendee.payment_id);
    if (refunded) {
      await markRefunded(attendee.id);
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
  { id }: EventRouteParams,
): Promise<Response> =>
  withAuthForm(request, (session, form) =>
    withDecryptedAttendees(session, id, (event, attendees) =>
      processRefundAll(event, attendees, session, form)));

/** Handle POST /admin/event/:eventId/attendee (add attendee manually) */
const handleAddAttendee = (
  request: Request,
  { eventId }: { eventId: number },
): Promise<Response> =>
  withAuthForm(request, async (_session, form) => {
    const event = await getEventWithCount(eventId);
    if (!event) return notFoundResponse();

    const isDaily = event.event_type === "daily";
    const fields = getAddAttendeeFields(event.fields, isDaily);
    const validation = validateForm<AddAttendeeFormValues>(form, fields);

    if (!validation.valid) {
      return redirect(
        `/admin/event/${eventId}?add_error=${encodeURIComponent(validation.error)}#add-attendee`,
      );
    }

    const { name, email, phone, address, special_instructions, quantity, date } = validation.values;

    const result = await createAttendeeAtomic({
      eventId,
      name,
      email: email || "",
      quantity,
      phone: phone || "",
      address: address || "",
      special_instructions: special_instructions || "",
      date: isDaily ? date : null,
    });

    if (!result.success) {
      if (result.reason === "encryption_error") {
        logError({ code: ErrorCode.ENCRYPT_FAILED, eventId, detail: "manual add attendee" });
      }
      const errorMsg = result.reason === "capacity_exceeded"
        ? "Not enough spots available"
        : "Encryption error — check that DB_ENCRYPTION_KEY is configured";
      return redirect(
        `/admin/event/${eventId}?add_error=${encodeURIComponent(errorMsg)}#add-attendee`,
      );
    }

    await logActivity(`Attendee '${name}' added manually`, eventId);
    return redirect(
      `/admin/event/${eventId}?added=${encodeURIComponent(name)}#add-attendee`,
    );
  });

/** Get all events (active + the current event), uniquified */
const getEventsForSelector = async (currentEventId: number): Promise<EventWithCount[]> => {
  const allEvents = await getAllEvents();
  const currentEvent = allEvents.find((e) => e.id === currentEventId);
  const activeEvents = filter((e: EventWithCount) => e.active)(allEvents);

  // Build unique list: current event + active events
  const eventIds = new Set<number>();
  const uniqueEvents: EventWithCount[] = [];

  if (currentEvent) {
    eventIds.add(currentEvent.id);
    uniqueEvents.push(currentEvent);
  }

  for (const event of activeEvents) {
    if (!eventIds.has(event.id)) {
      eventIds.add(event.id);
      uniqueEvents.push(event);
    }
  }

  return uniqueEvents;
};

/** Load attendee with all events for edit page */
const loadAttendeeForEdit = async (
  session: AuthSession,
  attendeeId: number,
): Promise<{ attendee: Attendee; event: EventWithCount; allEvents: EventWithCount[] } | null> => {
  const pk = await requirePrivateKey(session);
  const attendeeRaw = await queryOne<Attendee>("SELECT * FROM attendees WHERE id = ?", [attendeeId]);
  if (!attendeeRaw) return null;
  const attendee = (await decryptAttendeeOrNull(attendeeRaw, pk))!;
  const event = (await getEventWithCount(attendee.event_id))!;
  const allEvents = await getEventsForSelector(event.id);

  return { attendee, event, allEvents };
};

type EditAttendeeData = NonNullable<Awaited<ReturnType<typeof loadAttendeeForEdit>>>;

/** Load attendee for edit, returning 404 if not found */
const withEditAttendee = async (
  session: AuthSession,
  attendeeId: number,
  handler: (data: EditAttendeeData) => Response | Promise<Response>,
): Promise<Response> => {
  const data = await loadAttendeeForEdit(session, attendeeId);
  return data ? handler(data) : notFoundResponse();
};

/** Handle GET /admin/attendees/:attendeeId */
const handleEditAttendeeGet = (
  request: Request,
  { attendeeId }: { attendeeId: number },
): Promise<Response> =>
  requireSessionOr(request, (session) =>
    withEditAttendee(session, attendeeId, (data) =>
      htmlResponse(adminEditAttendeePage(
        data,
        session,
        undefined,
        getReturnUrl(request),
        getSearchParam(request, "success") || undefined,
      ))));

/** Create a POST handler for /admin/attendees/:attendeeId/* routes */
const editAttendeePost = (
  handler: (session: AuthSession, form: URLSearchParams, data: EditAttendeeData, attendeeId: number) => Response | Promise<Response>,
) =>
  (request: Request, { attendeeId }: { attendeeId: number }): Promise<Response> =>
    withAuthForm(request, (session, form) =>
      withEditAttendee(session, attendeeId, (data) => handler(session, form, data, attendeeId)));

/** Handle POST /admin/attendees/:attendeeId */
async function editAttendeeHandler(
  session: AuthSession, form: URLSearchParams, data: EditAttendeeData, attendeeId: number,
): Promise<Response> {
  const returnUrl = getReturnUrlFromForm(form);
  const name = form.get("name") || "";
  const email = form.get("email") || "";
  const phone = form.get("phone") || "";
  const address = form.get("address") || "";
  const special_instructions = form.get("special_instructions") || "";
  const event_id = Number(form.get("event_id")) || 0;

  if (!name.trim()) {
    return htmlResponse(adminEditAttendeePage(data, session, "Name is required", returnUrl), 400);
  }

  if (!event_id) {
    return htmlResponse(adminEditAttendeePage(data, session, "Event is required", returnUrl), 400);
  }

  await updateAttendee(attendeeId, { name, email, phone, address, special_instructions, event_id });
  await logActivity(`Attendee '${name}' updated`, event_id);

  return redirectOrReturn(form, `/admin/event/${event_id}?edited=${encodeURIComponent(name)}#attendees`);
}
const handleEditAttendeePost = editAttendeePost(editAttendeeHandler);

/** Handle GET /admin/event/:eventId/attendee/:attendeeId/resend-webhook */
const handleAdminResendWebhookGet = attendeeGetRoute((data, session, request) =>
  htmlResponse(adminResendWebhookPage(data, session, undefined, getReturnUrl(request))));

/** Handle POST /admin/event/:eventId/attendee/:attendeeId/resend-webhook */
const handleResendWebhook = attendeeFormAction(async (data, session, form, eventId) => {
  const error = verifyAttendeeName(data, session, form, adminResendWebhookPage,
    "Attendee name does not match. Please type the exact name to confirm.");
  if (error) return error;

  const currency = await getCurrencyCode();
  await Promise.all([
    logAndNotifyRegistration(data.event, data.attendee, currency),
    logActivity(`Webhook re-sent for attendee '${data.attendee.name}'`, eventId),
  ]);
  return redirectOrReturn(form, `/admin/event/${eventId}`);
});

/** Handle POST /admin/attendees/:attendeeId/refresh-payment */
async function refreshPaymentHandler(
  session: AuthSession, _form: URLSearchParams, data: EditAttendeeData, attendeeId: number,
): Promise<Response> {
  if (!data.attendee.payment_id) {
    return redirect(`/admin/attendees/${attendeeId}`);
  }

  const provider = await getActivePaymentProvider();
  if (!provider) {
    return htmlResponse(adminEditAttendeePage(data, session, NO_PROVIDER_ERROR), 400);
  }

  const isRefunded = await provider.isPaymentRefunded(data.attendee.payment_id);
  if (isRefunded && data.attendee.refunded !== "true") {
    await markRefunded(attendeeId);
    await logActivity(`Payment marked as refunded for attendee '${data.attendee.name}'`, data.event.id);
    return redirect(`/admin/attendees/${attendeeId}?success=${encodeURIComponent("Payment status updated: refunded")}`);
  }

  return redirect(`/admin/attendees/${attendeeId}?success=${encodeURIComponent("Payment status is up to date")}`);
}
const handleRefreshPayment = editAttendeePost(refreshPaymentHandler);

/** Attendee routes */
export const attendeesRoutes = defineRoutes({
  "GET /admin/attendees/:attendeeId": handleEditAttendeeGet,
  "POST /admin/attendees/:attendeeId": handleEditAttendeePost,
  "POST /admin/attendees/:attendeeId/refresh-payment": handleRefreshPayment,
  "GET /admin/event/:eventId/attendee/:attendeeId/delete": handleAdminAttendeeDeleteGet,
  "POST /admin/event/:eventId/attendee": handleAddAttendee,
  "POST /admin/event/:eventId/attendee/:attendeeId/delete": handleAttendeeDelete,
  "DELETE /admin/event/:eventId/attendee/:attendeeId/delete": handleAttendeeDelete,
  "POST /admin/event/:eventId/attendee/:attendeeId/checkin": handleAttendeeCheckin,
  "GET /admin/event/:eventId/attendee/:attendeeId/refund": handleAdminAttendeeRefundGet,
  "POST /admin/event/:eventId/attendee/:attendeeId/refund": handleAttendeeRefund,
  "GET /admin/event/:id/refund-all": handleAdminRefundAllGet,
  "POST /admin/event/:id/refund-all": handleAdminRefundAllPost,
  "GET /admin/event/:eventId/attendee/:attendeeId/resend-webhook": handleAdminResendWebhookGet,
  "POST /admin/event/:eventId/attendee/:attendeeId/resend-webhook": handleResendWebhook,
});
