/**
 * Admin attendee management routes
 */

import { chunk, compact, filter, uniqueBy } from "#fp";
import { logActivity } from "#lib/db/activityLog.ts";
import {
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
import { getFlash } from "#lib/flash-context.ts";
import type { FormParams } from "#lib/form-data.ts";
import { validateForm } from "#lib/forms.tsx";
/* jscpd:ignore-end */
import { ErrorCode, logError } from "#lib/logger.ts";
import { getActivePaymentProvider } from "#lib/payments.ts";
import {
  type AdminSession,
  type Attendee,
  type EventWithCount,
  isPaidEvent,
} from "#lib/types.ts";
import { logAndNotifyRegistration } from "#lib/webhook.ts";
import {
  requirePrivateKey,
  verifyIdentifier,
  withDecryptedAttendees,
  withEventAttendeesAuth,
} from "#routes/admin/utils.ts";
import { defineRoutes } from "#routes/router.ts";
import {
  type AuthSession,
  getSearchParam,
  htmlResponse,
  notFoundResponse,
  orNotFound,
  redirect,
  redirectResponse,
  requireSessionOr,
  withAuthForm,
} from "#routes/utils.ts";
import {
  adminDeleteAttendeePage,
  adminEditAttendeePage,
  adminRefundAllAttendeesPage,
  adminRefundAttendeePage,
  adminResendNotificationPage,
} from "#templates/admin/attendees.tsx";
import {
  type AddAttendeeFormValues,
  getAddAttendeeFields,
} from "#templates/fields.ts";

/** Attendee with event data */
type AttendeeWithEvent = { attendee: Attendee; event: EventWithCount };

/** Refund error messages */
const NO_PAYMENT_ERROR = "This attendee has no payment to refund.";
const NO_PROVIDER_ERROR = "No payment provider configured.";
const NO_REFUNDABLE_ERROR = "No attendees have payments to refund.";
const REFUND_FAILED_ERROR =
  "Refund failed. The payment may have already been refunded.";
const ALREADY_REFUNDED_ERROR = "This attendee has already been refunded.";

/** Max refunds per request to stay within Bunny Edge fetch limits */
const REFUND_BATCH_LIMIT = 30;

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
type EventRouteParams = { id: number };

/** Route params for attendee-scoped routes */
type AttendeeRouteParams = { eventId: number; attendeeId: number };

/** Auth + load attendee GET handler (shared by delete, refund, and resend-notification GET routes) */
const attendeeGetRoute =
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
  withAuthForm(request, (session, form) =>
    withAttendee(session, eventId, attendeeId, (data) =>
      handler(data, session, form),
    ),
  );

/** Read return_url from request query params */
const getReturnUrl = (request: Request): string =>
  getSearchParam(request, "return_url");

/** Verify confirm_name matches attendee name, returning error page on mismatch */
const verifyAttendeeName = (
  data: AttendeeWithEvent,
  session: AuthSession,
  form: FormParams,
  renderPage: (
    data: AttendeeWithEvent,
    session: AdminSession,
    error: string,
    returnUrl?: string,
  ) => string,
  errorMsg: string,
): Response | null => {
  const confirmName = form.getString("confirm_name");
  if (!verifyIdentifier(data.attendee.name, confirmName)) {
    const returnUrl = form.getString("return_url");
    return htmlResponse(renderPage(data, session, errorMsg, returnUrl), 400);
  }
  return null;
};

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

/** Handle GET /admin/event/:eventId/attendee/:attendeeId/delete */
const handleAdminAttendeeDeleteGet = attendeeGetRoute(
  (data, session, request) =>
    htmlResponse(
      adminDeleteAttendeePage(data, session, undefined, getReturnUrl(request)),
    ),
);

/** Handle POST /admin/event/:eventId/attendee/:attendeeId/delete */
const handleAttendeeDelete = attendeeFormAction(
  async (data, session, form, eventId, attendeeId) => {
    const error = verifyAttendeeName(
      data,
      session,
      form,
      adminDeleteAttendeePage,
      "Attendee name does not match. Please type the exact name to confirm deletion.",
    );
    if (error) return error;

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

/** Render refund error for a single attendee */
const refundError = (
  data: AttendeeWithEvent,
  session: AuthSession,
  msg: string,
  formOrReturnUrl: FormParams | string,
): Response => {
  const returnUrl =
    typeof formOrReturnUrl === "string"
      ? formOrReturnUrl
      : (formOrReturnUrl as FormParams).getString("return_url");
  return htmlResponse(
    adminRefundAttendeePage(data, session, msg, returnUrl),
    400,
  );
};

/** Handle GET /admin/event/:eventId/attendee/:attendeeId/refund */
const handleAdminAttendeeRefundGet = attendeeGetRoute(
  (data, session, request) => {
    if (!data.attendee.payment_id)
      return refundError(
        data,
        session,
        NO_PAYMENT_ERROR,
        getReturnUrl(request),
      );
    if (data.attendee.refunded)
      return refundError(
        data,
        session,
        ALREADY_REFUNDED_ERROR,
        getReturnUrl(request),
      );
    return htmlResponse(
      adminRefundAttendeePage(data, session, undefined, getReturnUrl(request)),
    );
  },
);

/** Handle POST /admin/event/:eventId/attendee/:attendeeId/refund */
const handleAttendeeRefund = attendeeFormAction(
  async (data, session, form, eventId) => {
    const nameError = verifyAttendeeName(
      data,
      session,
      form,
      adminRefundAttendeePage,
      "Attendee name does not match. Please type the exact name to confirm refund.",
    );
    if (nameError) return nameError;

    if (!data.attendee.payment_id)
      return refundError(data, session, NO_PAYMENT_ERROR, form);
    if (data.attendee.refunded)
      return refundError(data, session, ALREADY_REFUNDED_ERROR, form);

    const provider = await getActivePaymentProvider();
    if (!provider) return refundError(data, session, NO_PROVIDER_ERROR, form);

    const refunded = await provider.refundPayment(data.attendee.payment_id);
    if (!refunded) {
      logError({
        code: ErrorCode.PAYMENT_REFUND,
        eventId,
        detail: `Admin refund failed for attendee ${data.attendee.id}, payment ${data.attendee.payment_id}`,
      });
      return refundError(data, session, REFUND_FAILED_ERROR, form);
    }

    await markRefunded(data.attendee.id);
    await logActivity(
      `Refund issued for attendee '${data.attendee.name}'`,
      eventId,
    );
    return redirect(`/admin/event/${eventId}`, "Refund issued", true, { form });
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
    const count = getRefundable(attendees).length;
    return count === 0
      ? htmlResponse(
          adminRefundAllAttendeesPage(event, 0, session, NO_REFUNDABLE_ERROR),
          400,
        )
      : htmlResponse(adminRefundAllAttendeesPage(event, count, session));
  });

/** Validate pre-conditions for bulk refund, returning error response if invalid */
const validateRefundPreConditions = (
  event: EventWithCount,
  refundable: Attendee[],
  session: AuthSession,
  confirmName: string,
): Response | null => {
  if (!verifyIdentifier(event.name, confirmName)) {
    return htmlResponse(
      adminRefundAllAttendeesPage(
        event,
        refundable.length,
        session,
        "Event name does not match. Please type the exact name to confirm.",
      ),
      400,
    );
  }
  if (refundable.length === 0) {
    return htmlResponse(
      adminRefundAllAttendeesPage(event, 0, session, NO_REFUNDABLE_ERROR),
      400,
    );
  }
  return null;
};

/** Process refunds in chunks, returning counts of successes and failures */
const executeBulkRefunds = async (
  batch: Attendee[],
  provider: NonNullable<Awaited<ReturnType<typeof getActivePaymentProvider>>>,
  eventId: number,
): Promise<{ refundedCount: number; failedCount: number }> => {
  const REFUND_CHUNK_SIZE = 5;
  let refundedCount = 0;
  let failedCount = 0;
  for (const group of chunk(REFUND_CHUNK_SIZE)(batch)) {
    const results = await Promise.all(
      group.map(async (attendee) => {
        const refunded = await provider.refundPayment(attendee.payment_id);
        if (refunded) {
          await markRefunded(attendee.id);
          return true;
        }
        logError({
          code: ErrorCode.PAYMENT_REFUND,
          eventId,
          detail: `Admin bulk refund failed for attendee ${attendee.id}, payment ${attendee.payment_id}`,
        });
        return false;
      }),
    );
    for (const success of results) {
      if (success) refundedCount++;
      else failedCount++;
    }
  }
  return { refundedCount, failedCount };
};

/** Build the response after bulk refund execution */
const buildRefundResponse = async (
  event: EventWithCount,
  session: AuthSession,
  refundedCount: number,
  failedCount: number,
  totalRefundable: number,
  remaining: number,
): Promise<Response> => {
  if (failedCount > 0) {
    const msg =
      remaining > 0
        ? `${refundedCount} refund(s) succeeded, ${failedCount} failed. ${remaining} remaining — submit again to continue.`
        : `${refundedCount} refund(s) succeeded, ${failedCount} failed. Some payments may have already been refunded.`;
    await logActivity(
      `Bulk refund: ${refundedCount} succeeded, ${failedCount} failed for '${event.name}'`,
      event.id,
    );
    return htmlResponse(
      adminRefundAllAttendeesPage(
        event,
        totalRefundable - refundedCount,
        session,
        msg,
      ),
      400,
    );
  }
  if (remaining > 0) {
    await logActivity(
      `Bulk refund: ${refundedCount} of ${totalRefundable} refunded for '${event.name}'`,
      event.id,
    );
    return htmlResponse(
      adminRefundAllAttendeesPage(
        event,
        remaining,
        session,
        `${refundedCount} attendee(s) refunded. ${remaining} remaining — submit again to continue.`,
      ),
    );
  }
  await logActivity(
    `Bulk refund: all ${refundedCount} attendee(s) refunded for '${event.name}'`,
    event.id,
  );
  return redirect(`/admin/event/${event.id}`, "All attendees refunded", true);
};

/** Process bulk refund for all refundable attendees */
const processRefundAll = async (
  event: EventWithCount,
  attendees: Attendee[],
  session: AuthSession,
  form: FormParams,
): Promise<Response> => {
  const refundable = getRefundable(attendees);

  const preError = validateRefundPreConditions(
    event,
    refundable,
    session,
    form.getString("confirm_name"),
  );
  if (preError) return preError;

  const provider = await getActivePaymentProvider();
  if (!provider) {
    return htmlResponse(
      adminRefundAllAttendeesPage(
        event,
        refundable.length,
        session,
        NO_PROVIDER_ERROR,
      ),
      400,
    );
  }

  const batch = refundable.slice(0, REFUND_BATCH_LIMIT);
  const remaining = refundable.length - batch.length;
  const { refundedCount, failedCount } = await executeBulkRefunds(
    batch,
    provider,
    event.id,
  );

  return buildRefundResponse(
    event,
    session,
    refundedCount,
    failedCount,
    refundable.length,
    remaining,
  );
};

/** Handle POST /admin/event/:id/refund-all */
const handleAdminRefundAllPost = (
  request: Request,
  { id }: EventRouteParams,
): Promise<Response> =>
  withAuthForm(request, (session, form) =>
    withDecryptedAttendees(session, id, (event, attendees) =>
      processRefundAll(event, attendees, session, form),
    ),
  );

/** Handle a failed attendee creation: log and redirect with appropriate error */
const handleCreateAttendeeFailure = (
  reason: string,
  eventId: number,
): Response => {
  if (reason === "encryption_error") {
    logError({
      code: ErrorCode.ENCRYPT_FAILED,
      eventId,
      detail: "manual add attendee",
    });
  }
  const errorMsg =
    reason === "capacity_exceeded"
      ? "Not enough spots available"
      : "Encryption error — check that DB_ENCRYPTION_KEY is configured";
  return redirect(`/admin/event/${eventId}`, errorMsg, false);
};

/** Build attendee creation input from validated form values */
const buildAttendeeInput = (
  values: AddAttendeeFormValues,
  eventId: number,
  isDaily: boolean,
) => ({
  eventId,
  name: values.name,
  email: values.email || "",
  quantity: values.quantity,
  phone: values.phone || "",
  address: values.address || "",
  special_instructions: values.special_instructions || "",
  date: isDaily ? values.date : null,
});

/** Process add-attendee form: validate, create attendee, return response */
const processAddAttendee = async (
  form: FormParams,
  eventId: number,
): Promise<Response> => {
  const event = await getEventWithCount(eventId);
  if (!event) return notFoundResponse();

  const isDaily = event.event_type === "daily";
  const fields = getAddAttendeeFields(event.fields, isDaily);
  applyDemoOverrides(form, ATTENDEE_DEMO_FIELDS);
  const validation = validateForm<AddAttendeeFormValues>(form, fields);
  if (!validation.valid) {
    return redirect(`/admin/event/${eventId}`, validation.error, false);
  }

  const result = await createAttendeeAtomic(
    buildAttendeeInput(validation.values, eventId, isDaily),
  );

  if (!result.success)
    return handleCreateAttendeeFailure(result.reason, eventId);

  await logActivity(`Attendee '${validation.values.name}' added manually`, eventId);
  return redirect(`/admin/event/${eventId}`, `Added ${validation.values.name}`, true);
};

/** Handle POST /admin/event/:eventId/attendee (add attendee manually) */
const handleAddAttendee = (
  request: Request,
  { eventId }: { eventId: number },
): Promise<Response> =>
  withAuthForm(request, (_session, form) => processAddAttendee(form, eventId));

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
    "SELECT * FROM attendees WHERE id = ?",
    [attendeeId],
  );
  if (!attendeeRaw) return null;
  const attendee = await decryptAttendeeOrNull(attendeeRaw, pk);
  if (!attendee) return null;
  const event = await getEventWithCount(attendee.event_id);
  if (!event) return null;
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
    withEditAttendee(session, attendeeId, (data) =>
      htmlResponse(
        adminEditAttendeePage(
          data,
          session,
          undefined,
          getReturnUrl(request),
          getFlash().success,
        ),
      ),
    ),
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
    withAuthForm(request, (session, form) =>
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
/** Validate attendee edit form fields, returning error response or resolved target event */
async function validateEditFields(
  name: string,
  eventId: number,
  data: EditAttendeeData,
  editError: (msg: string) => Response,
): Promise<EventWithCount | Response> {
  if (!name.trim()) return editError("Name is required");
  if (!eventId) return editError("Event is required");
  const targetEvent =
    eventId === data.event.id ? data.event : await getEventWithCount(eventId);
  if (!targetEvent) return editError("Event not found");
  return targetEvent;
}

/** Check capacity for attendee edit (quantity increase or event change) */
async function checkEditCapacity(
  eventId: number,
  quantity: number,
  data: EditAttendeeData,
): Promise<boolean> {
  const quantityDelta = quantity - data.attendee.quantity;
  const eventChanged = eventId !== data.attendee.event_id;
  if (quantityDelta <= 0 && !eventChanged) return true;
  const spotsNeeded = eventChanged ? quantity : quantityDelta;
  return hasAvailableSpots(eventId, spotsNeeded, data.attendee.date);
}

/** Parse validated question answers from form */
function parseEditAnswers(
  form: FormParams,
  questions: QuestionWithAnswers[],
): number[] {
  const answerIds: number[] = [];
  for (const q of questions) {
    const raw = form.get(`question_${q.id}`);
    if (!raw) continue;
    const answerId = Number.parseInt(raw, 10);
    if (q.answers.some((a) => a.id === answerId)) {
      answerIds.push(answerId);
    }
  }
  return answerIds;
}

async function editAttendeeHandler(
  session: AuthSession,
  form: FormParams,
  data: EditAttendeeData,
  attendeeId: number,
): Promise<Response> {
  applyDemoOverrides(form, ATTENDEE_DEMO_FIELDS);
  const editError = (msg: string) =>
    htmlResponse(
      adminEditAttendeePage(data, session, msg, form.getString("return_url")),
      400,
    );

  const name = form.getString("name");
  const eventId = Number(form.get("event_id")) || 0;
  const resolved = await validateEditFields(name, eventId, data, editError);
  if (resolved instanceof Response) return resolved;
  const targetEvent = resolved;

  const quantity = parseQuantity(
    form.get("quantity") || "1",
    targetEvent.max_quantity,
  );
  const capacityOk = await checkEditCapacity(eventId, quantity, data);
  if (!capacityOk) return editError("Not enough spots available");

  const answerIds = parseEditAnswers(form, data.questions);

  await updateAttendee(attendeeId, {
    name,
    email: form.getString("email"),
    phone: form.getString("phone"),
    address: form.getString("address"),
    special_instructions: form.getString("special_instructions"),
    event_id: eventId,
    quantity,
    payment_id: data.attendee.payment_id,
    ticket_token: data.attendee.ticket_token,
  });

  if (data.questions.length > 0) {
    await saveAttendeeAnswers([attendeeId], answerIds);
  }

  await logActivity(`Attendee '${name}' updated`, eventId);
  return redirect(
    `/admin/event/${eventId}#attendees`,
    `Updated ${name}`,
    true,
    { form },
  );
}
const handleEditAttendeePost = editAttendeePost(editAttendeeHandler);

/** Handle GET /admin/event/:eventId/attendee/:attendeeId/resend-notification */
const handleAdminResendNotificationGet = attendeeGetRoute(
  (data, session, request) =>
    htmlResponse(
      adminResendNotificationPage(
        data,
        session,
        undefined,
        getReturnUrl(request),
      ),
    ),
);

/** Handle POST /admin/event/:eventId/attendee/:attendeeId/resend-notification */
const handleResendNotification = attendeeFormAction(
  async (data, session, form, eventId) => {
    const error = verifyAttendeeName(
      data,
      session,
      form,
      adminResendNotificationPage,
      "Attendee name does not match. Please type the exact name to confirm.",
    );
    if (error) return error;

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
  session: AuthSession,
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
    return htmlResponse(
      adminEditAttendeePage(data, session, NO_PROVIDER_ERROR),
      400,
    );
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
  "GET /admin/event/:eventId/attendee/:attendeeId/refund":
    handleAdminAttendeeRefundGet,
  "POST /admin/event/:eventId/attendee/:attendeeId/refund":
    handleAttendeeRefund,
  "GET /admin/event/:id/refund-all": handleAdminRefundAllGet,
  "POST /admin/event/:id/refund-all": handleAdminRefundAllPost,
  "GET /admin/event/:eventId/attendee/:attendeeId/resend-notification":
    handleAdminResendNotificationGet,
  "POST /admin/event/:eventId/attendee/:attendeeId/resend-notification":
    handleResendNotification,
});
