/**
 * Admin attendee management routes
 */

import { compact, filter, uniqueBy } from "#fp";
import { logActivity } from "#lib/db/activityLog.ts";
import {
  ATTENDEE_LEFT_JOIN_SELECT,
  createAttendeeAtomic,
  decryptAttendeeOrNull,
  deleteAttendee,
  hasAvailableSpots,
  markRefunded,
  updateAttendee,
  updateCheckedIn,
} from "#lib/db/attendees.ts";
import { queryOne } from "#lib/db/client.ts";
import {
  getAllEvents,
  getEventWithAttendeeRaw,
  getEventWithCount,
} from "#lib/db/events.ts";
import type { QuestionWithAnswers } from "#lib/db/questions.ts";
import {
  getAttendeeAnswersBatch,
  getQuestionsForEvent,
  saveAttendeeAnswers,
} from "#lib/db/questions.ts";
import { ATTENDEE_DEMO_FIELDS, applyDemoOverrides } from "#lib/demo.ts";
/* jscpd:ignore-start */
import type { FormParams } from "#lib/form-data.ts";
import { validateForm } from "#lib/forms.tsx";
/* jscpd:ignore-end */
import { ErrorCode, logError } from "#lib/logger.ts";
import { getActivePaymentProvider } from "#lib/payments.ts";
import { type Attendee, type EventWithCount, isPaidEvent } from "#lib/types.ts";
import { logAndNotifyRegistration } from "#lib/webhook.ts";
import { requirePrivateKey, verifyOrRedirect } from "#routes/admin/utils.ts";
import { defineRoutes } from "#routes/router.ts";
import {
  AUTH_FORM,
  type AuthSession,
  applyFlash,
  errorRedirect,
  getSearchParam,
  htmlResponse,
  notFoundResponse,
  orNotFound,
  redirect,
  redirectResponse,
  requireSessionOr,
  withAuth,
} from "#routes/utils.ts";
import {
  adminDeleteAttendeePage,
  adminEditAttendeePage,
  adminResendNotificationPage,
} from "#templates/admin/attendees.tsx";
import {
  type AddAttendeeFormValues,
  getAddAttendeeFields,
} from "#templates/fields.ts";

/** Attendee with event data */
export type AttendeeWithEvent = { attendee: Attendee; event: EventWithCount };

/** No payment provider configured error (shared with attendee-refunds) */
export const NO_PROVIDER_ERROR = "No payment provider configured.";

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
const withAttendee = (
  session: AuthSession,
  eventId: number,
  attendeeId: number,
  handler: (data: AttendeeWithEvent) => Response | Promise<Response>,
): Promise<Response> =>
  orNotFound(loadAttendeeForEvent(session, eventId, attendeeId), handler);

/** Route params for event-scoped routes */
export type EventRouteParams = { id: number };

/** Route params for attendee-scoped routes */
type AttendeeRouteParams = { eventId: number; attendeeId: number };

/** Auth + load attendee GET handler (shared by delete, refund, and resend-notification GET routes) */
export const attendeeGetRoute =
  (
    handler: (
      data: AttendeeWithEvent,
      session: AuthSession,
      request: Request,
    ) => Response | Promise<Response>,
  ) =>
  (
    request: Request,
    { eventId, attendeeId }: AttendeeRouteParams,
  ): Promise<Response> =>
    requireSessionOr(request, (session) =>
      withAttendee(session, eventId, attendeeId, (data) =>
        handler(data, session, request),
      ),
    );

/** Auth + load attendee from form handler */
const withAttendeeForm = (
  request: Request,
  eventId: number,
  attendeeId: number,
  handler: (
    data: AttendeeWithEvent,
    session: AuthSession,
    form: FormParams,
  ) => Response | Promise<Response>,
): Promise<Response> =>
  withAuth(request, AUTH_FORM, (session, form) =>
    withAttendee(session, eventId, attendeeId, (data) =>
      handler(data, session, form),
    ),
  );

/** Read return_url from request query params */
export const getReturnUrl = (request: Request): string =>
  getSearchParam(request, "return_url");

/** Attendee form handler that receives typed IDs */
type AttendeeFormAction = (
  data: AttendeeWithEvent,
  session: AuthSession,
  form: FormParams,
  eventId: number,
  attendeeId: number,
) => Response | Promise<Response>;

/** Create an attendee form handler with typed IDs */
const attendeeFormAction =
  (handler: AttendeeFormAction) =>
  (
    request: Request,
    { eventId, attendeeId }: AttendeeRouteParams,
  ): Promise<Response> =>
    withAttendeeForm(request, eventId, attendeeId, (data, session, form) =>
      handler(data, session, form, eventId, attendeeId),
    );

/** Attendee form handler that first verifies the attendee name */
export const verifiedAttendeeForm = (
  action: string,
  actionLabel: string | undefined,
  handler: (
    data: AttendeeWithEvent,
    form: FormParams,
    eventId: number,
    attendeeId: number,
  ) => Response | Promise<Response>,
) =>
  attendeeFormAction((data, _session, form, eventId, attendeeId) => {
    const error = verifyOrRedirect(
      form,
      data.attendee.name,
      `/admin/event/${eventId}/attendee/${attendeeId}/${action}`,
      "Attendee name",
      actionLabel,
    );
    if (error) return error;
    return handler(data, form, eventId, attendeeId);
  });

/** Handle GET /admin/event/:eventId/attendee/:attendeeId/delete */
const handleAdminAttendeeDeleteGet = attendeeGetRoute(
  (data, session, request) => {
    applyFlash(request);
    return htmlResponse(
      adminDeleteAttendeePage(data, session, getReturnUrl(request)),
    );
  },
);

/** Handle POST /admin/event/:eventId/attendee/:attendeeId/delete */
const handleAttendeeDelete = verifiedAttendeeForm(
  "delete",
  "deletion",
  async (data, form, eventId, attendeeId) => {
    await deleteAttendee(attendeeId);
    await logActivity(`Attendee deleted from '${data.event.name}'`, eventId);
    return redirect(`/admin/event/${eventId}`, "Attendee deleted", true, {
      form,
    });
  },
);

/**
 * Handle POST /admin/event/:eventId/attendee/:attendeeId/delete-incomplete
 * Deletes an attendee with an incomplete payment without requiring name confirmation.
 * Verifies the attendee is actually incomplete before deleting.
 */
const handleDeleteIncomplete = attendeeFormAction(
  async (data, _session, _form, eventId, attendeeId) => {
    const hasPaidEvent = isPaidEvent(data.event);
    const isIncomplete =
      hasPaidEvent &&
      !data.attendee.payment_id &&
      Number.parseInt(data.attendee.price_paid, 10) > 0;

    if (!isIncomplete) {
      return redirect(
        `/admin/event/${eventId}`,
        "Attendee does not have an incomplete payment",
        false,
      );
    }

    await deleteAttendee(attendeeId);
    await logActivity(
      `Incomplete attendee deleted from '${data.event.name}'`,
      eventId,
    );
    return redirect(
      `/admin/event/${eventId}`,
      "Incomplete registration removed",
      true,
    );
  },
);

/** Handle POST /admin/event/:eventId/attendee/:attendeeId/checkin */
const handleAttendeeCheckin = attendeeFormAction(
  async (data, _session, form, eventId, attendeeId) => {
    const wasCheckedIn = data.attendee.checked_in;
    const nowCheckedIn = !wasCheckedIn;

    await updateCheckedIn(attendeeId, nowCheckedIn);

    const action = nowCheckedIn ? "checked in" : "checked out";
    await logActivity(`Attendee ${action} for '${data.event.name}'`, eventId);

    const returnUrl = form.getString("return_url");
    if (returnUrl)
      return redirect(returnUrl, `${data.attendee.name} ${action}`, true);

    const name = encodeURIComponent(data.attendee.name);
    const status = nowCheckedIn ? "in" : "out";
    const filterValue = form.getString("return_filter");
    const suffix =
      filterValue === "in" ? "/in" : filterValue === "out" ? "/out" : "";
    return redirectResponse(
      `/admin/event/${eventId}${suffix}?checkin_name=${name}&checkin_status=${status}#message`,
    );
  },
);

/** Handle POST /admin/event/:eventId/attendee (add attendee manually) */
const handleAddAttendee = (
  request: Request,
  { eventId }: { eventId: number },
): Promise<Response> =>
  withAuth(request, AUTH_FORM, async (_session, form) => {
    const event = await getEventWithCount(eventId);
    if (!event) return notFoundResponse();

    const isDaily = event.event_type === "daily";
    const fields = getAddAttendeeFields(event.fields, isDaily);
    applyDemoOverrides(form, ATTENDEE_DEMO_FIELDS);
    const validation = validateForm<AddAttendeeFormValues>(form, fields);

    if (!validation.valid) {
      return redirect(`/admin/event/${eventId}`, validation.error, false);
    }

    const {
      name,
      email,
      phone,
      address,
      special_instructions,
      quantity,
      date,
    } = validation.values;

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
        logError({
          code: ErrorCode.ENCRYPT_FAILED,
          eventId,
          detail: "manual add attendee",
        });
      }
      const errorMsg =
        result.reason === "capacity_exceeded"
          ? "Not enough spots available"
          : "Encryption error — check that DB_ENCRYPTION_KEY is configured";
      return redirect(`/admin/event/${eventId}`, errorMsg, false);
    }

    await logActivity(`Attendee '${name}' added manually`, eventId);
    return redirect(`/admin/event/${eventId}`, `Added ${name}`, true);
  });

/** Get all events (active + the current event), uniquified */
const getEventsForSelector = async (
  currentEventId: number,
): Promise<EventWithCount[]> => {
  const allEvents = await getAllEvents();
  const currentEvent = allEvents.find((e) => e.id === currentEventId);
  const activeEvents = filter((e: EventWithCount) => e.active)(allEvents);
  return uniqueBy((e: EventWithCount) => e.id)(
    compact([currentEvent, ...activeEvents]),
  );
};

/** Load attendee with all events for edit page */
const loadAttendeeForEdit = async (
  session: AuthSession,
  attendeeId: number,
): Promise<{
  attendee: Attendee;
  event: EventWithCount;
  allEvents: EventWithCount[];
  questions: QuestionWithAnswers[];
  selectedAnswerIds: number[];
} | null> => {
  const pk = await requirePrivateKey(session);
  const attendeeRaw = await queryOne<Attendee>(
    `SELECT ${ATTENDEE_LEFT_JOIN_SELECT}
     FROM attendees a
     LEFT JOIN event_attendees ea ON ea.attendee_id = a.id
     WHERE a.id = ?`,
    [attendeeId],
  );
  if (!attendeeRaw) return null;
  const attendee = (await decryptAttendeeOrNull(attendeeRaw, pk))!;
  const event = (await getEventWithCount(attendee.event_id))!;
  const [allEvents, questions, answersMap] = await Promise.all([
    getEventsForSelector(event.id),
    getQuestionsForEvent(event.id),
    getAttendeeAnswersBatch([attendeeId]),
  ]);
  const selectedAnswerIds = answersMap.get(attendeeId) ?? [];

  return { attendee, event, allEvents, questions, selectedAnswerIds };
};

type EditAttendeeData = NonNullable<
  Awaited<ReturnType<typeof loadAttendeeForEdit>>
>;

/** Load attendee for edit, returning 404 if not found */
const withEditAttendee = (
  session: AuthSession,
  attendeeId: number,
  handler: (data: EditAttendeeData) => Response | Promise<Response>,
): Promise<Response> =>
  orNotFound(loadAttendeeForEdit(session, attendeeId), handler);

/** Handle GET /admin/attendees/:attendeeId */
const handleEditAttendeeGet = (
  request: Request,
  { attendeeId }: { attendeeId: number },
): Promise<Response> =>
  requireSessionOr(request, (session) =>
    withEditAttendee(session, attendeeId, (data) => {
      const flash = applyFlash(request);
      return htmlResponse(
        adminEditAttendeePage(
          data,
          session,
          getReturnUrl(request),
          flash.success,
        ),
      );
    }),
  );

/** Create a POST handler for /admin/attendees/:attendeeId/* routes */
const editAttendeePost =
  (
    handler: (
      session: AuthSession,
      form: FormParams,
      data: EditAttendeeData,
      attendeeId: number,
    ) => Response | Promise<Response>,
  ) =>
  (
    request: Request,
    { attendeeId }: { attendeeId: number },
  ): Promise<Response> =>
    withAuth(request, AUTH_FORM, (session, form) =>
      withEditAttendee(session, attendeeId, (data) =>
        handler(session, form, data, attendeeId),
      ),
    );

/** Parse a quantity value from a form field, clamping to [1, max] */
function parseQuantity(value: string, max: number): number {
  const parsed = Math.floor(Number(value));
  return Math.max(1, Math.min(max, Number.isNaN(parsed) ? 1 : parsed));
}

/** Handle POST /admin/attendees/:attendeeId */
async function editAttendeeHandler(
  _session: AuthSession,
  form: FormParams,
  data: EditAttendeeData,
  attendeeId: number,
): Promise<Response> {
  applyDemoOverrides(form, ATTENDEE_DEMO_FIELDS);
  const editError = (msg: string) =>
    errorRedirect(`/admin/attendees/${attendeeId}`, msg);
  const name = form.getString("name");
  const email = form.getString("email");
  const phone = form.getString("phone");
  const address = form.getString("address");
  const special_instructions = form.getString("special_instructions");
  const event_id = Number(form.get("event_id")) || 0;

  if (!name.trim()) return editError("Name is required");
  if (!event_id) return editError("Event is required");

  const targetEvent =
    event_id === data.event.id ? data.event : await getEventWithCount(event_id);
  if (!targetEvent) return editError("Event not found");

  const quantity = parseQuantity(
    form.get("quantity") || "1",
    targetEvent.max_quantity,
  );

  // Check capacity when quantity increases or event changes
  const quantityDelta = quantity - data.attendee.quantity;
  const eventChanged = event_id !== data.attendee.event_id;
  if (quantityDelta > 0 || eventChanged) {
    // For event change, check full quantity against new event; for same event, check only the delta
    const spotsNeeded = eventChanged ? quantity : quantityDelta;
    const available = await hasAvailableSpots(
      event_id,
      spotsNeeded,
      data.attendee.date,
    );
    if (!available) return editError("Not enough spots available");
  }

  // Parse question answers
  const answerIds: number[] = [];
  for (const q of data.questions) {
    const raw = form.get(`question_${q.id}`);
    if (raw) {
      const answerId = Number.parseInt(raw, 10);
      if (q.answers.some((a) => a.id === answerId)) {
        answerIds.push(answerId);
      }
    }
  }

  await updateAttendee(attendeeId, {
    name,
    email,
    phone,
    address,
    special_instructions,
    event_id,
    quantity,
    payment_id: data.attendee.payment_id,
    ticket_token: data.attendee.ticket_token,
  });

  // Update answers (atomic delete + insert)
  if (data.questions.length > 0) {
    await saveAttendeeAnswers([attendeeId], answerIds);
  }

  await logActivity(`Attendee '${name}' updated`, event_id);

  return redirect(
    `/admin/event/${event_id}#attendees`,
    `Updated ${name}`,
    true,
    { form },
  );
}
const handleEditAttendeePost = editAttendeePost(editAttendeeHandler);

/** Handle GET /admin/event/:eventId/attendee/:attendeeId/resend-notification */
const handleAdminResendNotificationGet = attendeeGetRoute(
  (data, session, request) => {
    applyFlash(request);
    return htmlResponse(
      adminResendNotificationPage(data, session, getReturnUrl(request)),
    );
  },
);

/** Handle POST /admin/event/:eventId/attendee/:attendeeId/resend-notification */
const handleResendNotification = verifiedAttendeeForm(
  "resend-notification",
  undefined,
  async (data, form, eventId, _attendeeId) => {
    await Promise.all([
      logAndNotifyRegistration([
        { event: data.event, attendee: data.attendee },
      ]),
      logActivity(
        `Notification re-sent for attendee '${data.attendee.name}'`,
        eventId,
      ),
    ]);
    return redirect(`/admin/event/${eventId}`, "Notification re-sent", true, {
      form,
    });
  },
);

/** Handle POST /admin/attendees/:attendeeId/refresh-payment */
async function refreshPaymentHandler(
  _session: AuthSession,
  _form: FormParams,
  data: EditAttendeeData,
  attendeeId: number,
): Promise<Response> {
  if (!data.attendee.payment_id) {
    return redirect(
      `/admin/attendees/${attendeeId}`,
      "No payment to refresh",
      false,
    );
  }

  const provider = await getActivePaymentProvider();
  if (!provider) {
    return errorRedirect(`/admin/attendees/${attendeeId}`, NO_PROVIDER_ERROR);
  }

  const isRefunded = await provider.isPaymentRefunded(data.attendee.payment_id);
  if (isRefunded && !data.attendee.refunded) {
    await markRefunded(attendeeId);
    await logActivity(
      `Payment marked as refunded for attendee '${data.attendee.name}'`,
      data.event.id,
    );
    return redirect(
      `/admin/attendees/${attendeeId}`,
      "Payment status updated: refunded",
      true,
    );
  }

  return redirect(
    `/admin/attendees/${attendeeId}`,
    "Payment status is up to date",
    true,
  );
}
const handleRefreshPayment = editAttendeePost(refreshPaymentHandler);

/** Attendee routes */
export const attendeesRoutes = defineRoutes({
  "GET /admin/attendees/:attendeeId": handleEditAttendeeGet,
  "POST /admin/attendees/:attendeeId": handleEditAttendeePost,
  "POST /admin/attendees/:attendeeId/refresh-payment": handleRefreshPayment,
  "GET /admin/event/:eventId/attendee/:attendeeId/delete":
    handleAdminAttendeeDeleteGet,
  "POST /admin/event/:eventId/attendee": handleAddAttendee,
  "POST /admin/event/:eventId/attendee/:attendeeId/delete":
    handleAttendeeDelete,
  "DELETE /admin/event/:eventId/attendee/:attendeeId/delete":
    handleAttendeeDelete,
  "POST /admin/event/:eventId/attendee/:attendeeId/delete-incomplete":
    handleDeleteIncomplete,
  "POST /admin/event/:eventId/attendee/:attendeeId/checkin":
    handleAttendeeCheckin,
  "GET /admin/event/:eventId/attendee/:attendeeId/resend-notification":
    handleAdminResendNotificationGet,
  "POST /admin/event/:eventId/attendee/:attendeeId/resend-notification":
    handleResendNotification,
});
