/**
 * Admin attendee management routes
 */

import { compact, filter, uniqueBy } from "#fp";
import { getAvailableDates } from "#lib/dates.ts";
import { logActivity } from "#lib/db/activityLog.ts";
import {
  ATTENDEE_LEFT_JOIN_SELECT,
  addEventLink,
  createAttendeeAtomic,
  decryptAttendeeOrNull,
  decryptAttendees,
  deleteAttendee,
  type EventAttendeeRow,
  getAttendeesByTokens,
  markRefunded,
  unlinkAttendeeFromEvent,
  updateAttendeePII,
  updateCheckedIn,
  updateEventLink,
} from "#lib/db/attendees.ts";
import { queryAll, queryOne } from "#lib/db/client.ts";
import {
  getAllEvents,
  getEventWithAttendeeRaw,
  getEventWithCount,
} from "#lib/db/events.ts";
import { getActiveHolidays } from "#lib/db/holidays.ts";
import type { QuestionWithAnswers } from "#lib/db/questions.ts";
import {
  getAttendeeAnswersBatch,
  getQuestionsForEvent,
  getQuestionsWithEventIds,
  saveAttendeeAnswers,
} from "#lib/db/questions.ts";
import { ATTENDEE_DEMO_FIELDS, applyDemoOverrides } from "#lib/demo.ts";
/* jscpd:ignore-start */
import type { FormParams } from "#lib/form-data.ts";
import { validateForm } from "#lib/forms.tsx";
/* jscpd:ignore-end */
import { ErrorCode, logError } from "#lib/logger.ts";
import {
  applyAttendeeMerge,
  bookingKey,
  buildAttendeeMergeDiff,
  validateAttendeeMergeDecision,
} from "#lib/merge/attendee-merge.ts";
import type {
  AttendeeMergeDecisionInput,
  AttendeeMergeDiff,
  MergeAnswerChoice,
  MergeBookingChoice,
  MergeValueChoice,
} from "#lib/merge/attendee-merge-types.ts";
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
  adminMergeAttendeePage,
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
    const flash = applyFlash(request);
    return htmlResponse(
      adminDeleteAttendeePage(
        data,
        session,
        getReturnUrl(request),
        flash.error,
      ),
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

    await updateCheckedIn(attendeeId, eventId, nowCheckedIn);

    const status = nowCheckedIn ? "in" : "out";
    await logActivity(
      `Attendee checked ${status} for '${data.event.name}'`,
      eventId,
    );

    const returnUrl = form.getString("return_url");
    if (returnUrl)
      return redirect(
        returnUrl,
        `Checked ${data.attendee.name} ${status}`,
        true,
      );

    const name = encodeURIComponent(data.attendee.name);
    const filterValue = form.getString("return_filter");
    const suffix =
      filterValue === "in" ? "/in" : filterValue === "out" ? "/out" : "";
    return redirectResponse(
      `/admin/event/${eventId}${suffix}?checkin_name=${name}&checkin_status=${status}#message`,
    );
  },
);

/** Build create-attendee input from validated form values */
const buildCreateAttendeeInput = (
  values: AddAttendeeFormValues,
  eventId: number,
  isDaily: boolean,
) => {
  const { name, email, phone, address, special_instructions, quantity, date } =
    values;
  return {
    address: address || "",
    bookings: [{ date: isDaily ? date : null, eventId, quantity }],
    email: email || "",
    name,
    phone: phone || "",
    special_instructions: special_instructions || "",
  };
};

/** Convert a failed createAttendeeAtomic result into a redirect response */
const handleCreateAttendeeFailure = (
  result: { success: false; reason: string },
  eventId: number,
): Response => {
  if (result.reason === "encryption_error") {
    logError({
      code: ErrorCode.ENCRYPT_FAILED,
      detail: "manual add attendee",
      eventId,
    });
  }
  const errorMsg =
    result.reason === "capacity_exceeded"
      ? "Not enough spots available"
      : "Encryption error — check that DB_ENCRYPTION_KEY is configured";
  return redirect(`/admin/event/${eventId}`, errorMsg, false);
};

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

    const result = await createAttendeeAtomic(
      buildCreateAttendeeInput(validation.values, eventId, isDaily),
    );

    if (!result.success) {
      return handleCreateAttendeeFailure(result, eventId);
    }

    const { name } = validation.values;
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
/** A resolved event link for display in the edit page */
type EventLinkData = {
  event: EventWithCount;
  booking: EventAttendeeRow;
  date: string | null;
};

const loadAttendeeForEdit = async (
  session: AuthSession,
  attendeeId: number,
): Promise<{
  attendee: Attendee;
  event: EventWithCount;
  eventLinks: EventLinkData[];
  allEvents: EventWithCount[];
  questions: QuestionWithAnswers[];
  selectedAnswerIds: number[];
  /** Available dates per daily event (for date picker) */
  availableDatesByEvent: Record<number, string[]>;
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

  // Load all event bookings for this attendee
  const bookingRows = await queryAll<EventAttendeeRow>(
    `SELECT event_id, start_at, end_at, quantity, checked_in, refunded, price_paid, attachment_downloads
     FROM event_attendees WHERE attendee_id = ?
     ORDER BY start_at, event_id`,
    [attendeeId],
  );

  // Resolve events for each booking
  const eventLinks: EventLinkData[] = [];
  for (const booking of bookingRows) {
    const event = await getEventWithCount(booking.event_id);
    if (event) {
      eventLinks.push({
        booking,
        date: booking.start_at ? booking.start_at.slice(0, 10) : null,
        event,
      });
    }
  }

  // Attendees always have at least one event link (enforced by createAttendeeAtomic)
  const firstEvent = eventLinks[0]!.event;
  const allEvents = await getEventsForSelector(firstEvent.id);
  const questions = await getQuestionsForEvent(firstEvent.id);
  const answersMap = await getAttendeeAnswersBatch([attendeeId]);
  const holidays = await getActiveHolidays();
  const selectedAnswerIds = answersMap.get(attendeeId) ?? [];

  // Build available dates for each daily event
  const availableDatesByEvent: Record<number, string[]> = {};
  for (const evt of allEvents) {
    if (evt.event_type === "daily") {
      availableDatesByEvent[evt.id] = getAvailableDates(evt, holidays);
    }
  }

  return {
    allEvents,
    attendee,
    availableDatesByEvent,
    event: firstEvent,
    eventLinks,
    questions,
    selectedAnswerIds,
  };
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
          flash.error,
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

  if (!name.trim()) return editError("Name is required");

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

  // Update PII (shared across events)
  await updateAttendeePII(attendeeId, {
    address,
    email,
    name,
    payment_id: data.attendee.payment_id,
    phone,
    special_instructions,
    ticket_token: data.attendee.ticket_token,
  });

  // Update answers (atomic delete + insert)
  if (data.questions.length > 0) {
    await saveAttendeeAnswers([attendeeId], answerIds);
  }

  await logActivity(`Attendee '${name}' updated`, data.event.id);

  return redirect(
    `/admin/event/${data.event.id}#attendees`,
    `Updated ${name}`,
    true,
    { form },
  );
}
const handleEditAttendeePost = editAttendeePost(editAttendeeHandler);

/** Handle GET /admin/event/:eventId/attendee/:attendeeId/resend-notification */
const handleAdminResendNotificationGet = attendeeGetRoute(
  (data, session, request) => {
    const flash = applyFlash(request);
    return htmlResponse(
      adminResendNotificationPage(
        data,
        session,
        getReturnUrl(request),
        flash.error,
      ),
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
        { attendee: data.attendee, event: data.event },
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
    await markRefunded(attendeeId, data.event.id);
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

/* jscpd:ignore-start — route handlers share structural patterns (withAuth, errorRedirect) */
/** Handle POST /admin/attendees/:attendeeId/link — add event link */
const handleAddEventLink = (
  request: Request,
  { attendeeId }: { attendeeId: number },
): Promise<Response> =>
  withAuth(request, AUTH_FORM, async (_session, form) => {
    const eventId = Number(form.get("event_id")) || 0;
    if (!eventId) {
      return errorRedirect(
        `/admin/attendees/${attendeeId}`,
        "Event is required",
      );
    }

    const targetEvent = await getEventWithCount(eventId);
    if (!targetEvent) {
      return errorRedirect(`/admin/attendees/${attendeeId}`, "Event not found");
    }

    const quantity = parseQuantity(
      form.get("quantity") || "1",
      targetEvent.max_quantity,
    );

    // Date for daily events
    const date =
      targetEvent.event_type === "daily"
        ? form.getString("date") || null
        : null;

    const result = await addEventLink(attendeeId, {
      date,
      eventId,
      quantity,
    });

    if (!result.success) {
      return errorRedirect(
        `/admin/attendees/${attendeeId}`,
        "Not enough spots available",
      );
    }

    await logActivity(`Attendee linked to '${targetEvent.name}'`, eventId);
    return redirect(
      `/admin/attendees/${attendeeId}`,
      `Added to ${targetEvent.name}`,
      true,
    );
  });

/** Handle POST /admin/attendees/:attendeeId/unlink/:eventId — remove event link */
const handleUnlinkEvent = (
  request: Request,
  { attendeeId, eventId }: { attendeeId: number; eventId: number },
): Promise<Response> =>
  withAuth(request, AUTH_FORM, async () => {
    // Don't allow removing the last event link — would orphan the attendee
    const linkCount = await queryOne<{ count: number }>(
      "SELECT COUNT(*) as count FROM event_attendees WHERE attendee_id = ?",
      [attendeeId],
    );
    if (linkCount && linkCount.count <= 1) {
      return errorRedirect(
        `/admin/attendees/${attendeeId}`,
        "Cannot remove the last event — delete the attendee instead",
      );
    }

    const event = await getEventWithCount(eventId);
    const eventName = event!.name;

    await unlinkAttendeeFromEvent(attendeeId, eventId);
    await logActivity(`Attendee unlinked from '${eventName}'`, eventId);

    return redirect(
      `/admin/attendees/${attendeeId}`,
      `Removed from ${eventName}`,
      true,
    );
  });

/** Handle POST /admin/attendees/:attendeeId/event/:eventId — update per-event link */
const handleUpdateEventLink = (
  request: Request,
  { attendeeId, eventId }: { attendeeId: number; eventId: number },
): Promise<Response> =>
  withAuth(request, AUTH_FORM, async (_session, form) => {
    const event = await getEventWithCount(eventId);
    if (!event) {
      return errorRedirect(`/admin/attendees/${attendeeId}`, "Event not found");
    }

    const quantity = parseQuantity(
      form.get("quantity") || "1",
      event.max_quantity,
    );

    const date =
      event.event_type === "daily" ? form.getString("date") || null : null;

    const result = await updateEventLink(attendeeId, eventId, {
      date,
      quantity,
    });

    if (!result.success) {
      return errorRedirect(
        `/admin/attendees/${attendeeId}`,
        "Not enough spots available",
      );
    }

    return redirect(
      `/admin/attendees/${attendeeId}`,
      `Updated ${event.name}`,
      true,
    );
  });

/* jscpd:ignore-end */

/** Load and decrypt a target attendee by ID for merge operations */
const loadMergeTarget = async (
  session: AuthSession,
  attendeeId: number,
): Promise<Attendee | null> => {
  const pk = await requirePrivateKey(session);
  const raw = await queryOne<Attendee>(
    `SELECT ${ATTENDEE_LEFT_JOIN_SELECT}
     FROM attendees a
     LEFT JOIN event_attendees ea ON ea.attendee_id = a.id
     WHERE a.id = ?`,
    [attendeeId],
  );
  return decryptAttendeeOrNull(raw, pk);
};

/** Look up and decrypt a source attendee by ticket token */
const loadMergeSource = async (
  token: string,
  session: AuthSession,
): Promise<{
  id: number;
  name: string;
  email: string;
  phone: string;
  address: string;
  special_instructions: string;
  ticket_token: string;
  bookings: EventAttendeeRow[];
} | null> => {
  const pk = await requirePrivateKey(session);
  const results = await getAttendeesByTokens([token]);
  const raw = results[0];
  if (!raw) return null;
  // Cast to Attendee for decryption — only pii_blob is used by decryptAttendees
  // decryptAttendees always returns the same-length array — safe to index directly
  const decrypted = (
    await decryptAttendees([raw as unknown as Attendee], pk)
  )[0]!;
  return {
    address: decrypted.address,
    bookings: raw.bookings,
    email: decrypted.email,
    id: raw.id,
    name: decrypted.name,
    phone: decrypted.phone,
    special_instructions: decrypted.special_instructions,
    ticket_token: decrypted.ticket_token,
  };
};

/** Load target attendee and call handler, returning 404 if not found */
const withMergeTarget = (
  session: AuthSession,
  attendeeId: number,
  handler: (target: Attendee) => Response | Promise<Response>,
): Promise<Response> =>
  orNotFound(loadMergeTarget(session, attendeeId), handler);

/** Load all event_attendees rows for an attendee */
const loadAttendeeBookings = (
  attendeeId: number,
): Promise<EventAttendeeRow[]> =>
  queryAll<EventAttendeeRow>(
    `SELECT event_id, start_at, end_at, quantity, checked_in, refunded, price_paid, attachment_downloads
     FROM event_attendees WHERE attendee_id = ? ORDER BY start_at, event_id`,
    [attendeeId],
  );

/** Collect unique event IDs from two sets of bookings */
const collectEventIds = (
  targetBookings: EventAttendeeRow[],
  sourceBookings: EventAttendeeRow[],
): number[] => {
  const ids = new Set<number>();
  for (const b of targetBookings) ids.add(b.event_id);
  for (const b of sourceBookings) ids.add(b.event_id);
  return [...ids];
};

/** Parse PII decisions from form (each field: "source" or "target") */
const parsePiiDecisions = (
  form: FormParams,
  diff: AttendeeMergeDiff,
): Record<string, MergeValueChoice> => {
  const pii: Record<string, MergeValueChoice> = {};
  for (const field of diff.piiFields) {
    const val = form.getString(`pii_${field.field}`);
    pii[field.field] = val === "source" ? "source" : "target";
  }
  return pii;
};

/** Normalize a raw answer choice string into a MergeAnswerChoice */
const toAnswerChoice = (raw: string): MergeAnswerChoice => {
  if (raw === "source") return "source";
  if (raw === "clear") return "clear";
  return "target";
};

/** Parse answer decisions from form (only conflicting items) */
const parseAnswerDecisions = (
  form: FormParams,
  diff: AttendeeMergeDiff,
): Record<string, MergeAnswerChoice> => {
  const answers: Record<string, MergeAnswerChoice> = {};
  for (const item of diff.answerItems) {
    if (item.conflict) {
      const val = form.getString(`answer_${item.questionId}`);
      answers[String(item.questionId)] = toAnswerChoice(val);
    }
  }
  return answers;
};

/** Normalize a raw booking choice string into a MergeBookingChoice */
const toBookingChoice = (raw: string): MergeBookingChoice => {
  if (raw === "take_source") return "take_source";
  if (raw === "skip_source") return "skip_source";
  return "keep_target";
};

/** Parse booking decisions from form (only non-moveable items) */
const parseBookingDecisions = (
  form: FormParams,
  diff: AttendeeMergeDiff,
): Record<string, MergeBookingChoice> => {
  const bookings: Record<string, MergeBookingChoice> = {};
  for (const item of diff.bookingItems) {
    if (item.conflictClass !== "moveable") {
      const key = bookingKey(item.eventId, item.startAt);
      const val = form.getString(`booking_${key}`);
      bookings[key] = toBookingChoice(val);
    }
  }
  return bookings;
};

/** Parse merge decision form data into AttendeeMergeDecisionInput */
const parseMergeDecisionForm = (
  form: FormParams,
  diff: AttendeeMergeDiff,
): AttendeeMergeDecisionInput => ({
  answers: parseAnswerDecisions(form, diff),
  bookings: parseBookingDecisions(form, diff),
  pii: parsePiiDecisions(form, diff),
  version: form.getString("merge_version"),
});

/* jscpd:ignore-start — merge handlers share structural patterns with other route handlers */
/** Handle GET /admin/attendees/:attendeeId/merge — analyze + render decisions */
const handleMergeGet = (
  request: Request,
  { attendeeId }: { attendeeId: number },
): Promise<Response> =>
  requireSessionOr(request, (session) =>
    withMergeTarget(session, attendeeId, async (target) => {
      const token = getSearchParam(request, "token");
      const flash = applyFlash(request);

      if (!token) {
        return htmlResponse(
          adminMergeAttendeePage(target, null, null, session, flash.error),
        );
      }

      const source = await loadMergeSource(token, session);

      if (!source) {
        return htmlResponse(
          adminMergeAttendeePage(
            target,
            null,
            token,
            session,
            "Ticket token not found",
          ),
        );
      }

      if (source.id === attendeeId) {
        return htmlResponse(
          adminMergeAttendeePage(
            target,
            null,
            token,
            session,
            "Cannot merge an attendee with themselves",
          ),
        );
      }

      // Load target bookings and compute merge diff
      const targetBookings = await loadAttendeeBookings(attendeeId);
      const allEventIds = collectEventIds(targetBookings, source.bookings);
      const { questions } = await getQuestionsWithEventIds(allEventIds);

      const diff = await buildAttendeeMergeDiff(
        {
          sourceBookings: source.bookings,
          sourceId: source.id,
          sourcePii: {
            address: source.address,
            email: source.email,
            name: source.name,
            phone: source.phone,
            special_instructions: source.special_instructions,
          },
          targetBookings,
          targetId: attendeeId,
          targetPii: {
            address: target.address,
            email: target.email,
            name: target.name,
            phone: target.phone,
            special_instructions: target.special_instructions,
          },
        },
        questions,
      );

      return htmlResponse(
        adminMergeAttendeePage(
          target,
          source,
          token,
          session,
          flash.error,
          diff,
        ),
      );
    }),
  );

type MergeSource = NonNullable<Awaited<ReturnType<typeof loadMergeSource>>>;
type MergeSummary = Awaited<ReturnType<typeof applyAttendeeMerge>>["summary"];

/** Extract PII subset for merge diff/apply input */
const extractSourcePii = (source: MergeSource) => ({
  address: source.address,
  email: source.email,
  name: source.name,
  phone: source.phone,
  special_instructions: source.special_instructions,
});

const extractTargetPii = (target: Attendee) => ({
  address: target.address,
  email: target.email,
  name: target.name,
  phone: target.phone,
  special_instructions: target.special_instructions,
});

/** Build merge diff from source + target */
const buildMergeDiffFor = async (
  target: Attendee,
  source: MergeSource,
  attendeeId: number,
): Promise<AttendeeMergeDiff> => {
  const targetBookings = await loadAttendeeBookings(attendeeId);
  const allEventIds = collectEventIds(targetBookings, source.bookings);
  const { questions } = await getQuestionsWithEventIds(allEventIds);

  return buildAttendeeMergeDiff(
    {
      sourceBookings: source.bookings,
      sourceId: source.id,
      sourcePii: extractSourcePii(source),
      targetBookings,
      targetId: attendeeId,
      targetPii: extractTargetPii(target),
    },
    questions,
  );
};

/** Resolve the (possibly-source) value of a PII field based on decision */
const pickPiiField = <K extends keyof MergeSource>(
  decision: AttendeeMergeDecisionInput,
  field: K & string,
  source: MergeSource,
  target: Attendee,
): string => {
  const decisionChoice = decision.pii[field];
  const sourceVal = source[field] as unknown as string;
  const targetVal = target[field as keyof Attendee] as unknown as string;
  return decisionChoice === "source" ? sourceVal : targetVal;
};

/** Update target attendee PII based on merge decisions */
const updateTargetPiiFromDecision = (
  attendeeId: number,
  decision: AttendeeMergeDecisionInput,
  source: MergeSource,
  target: Attendee,
): Promise<unknown> =>
  updateAttendeePII(attendeeId, {
    address: pickPiiField(decision, "address", source, target),
    email: pickPiiField(decision, "email", source, target),
    name: pickPiiField(decision, "name", source, target),
    payment_id: target.payment_id,
    phone: pickPiiField(decision, "phone", source, target),
    special_instructions: pickPiiField(
      decision,
      "special_instructions",
      source,
      target,
    ),
    ticket_token: target.ticket_token,
  });

/** Build activity log message parts for a merge summary */
const buildMergeLogParts = (
  summary: MergeSummary,
  sourceName: string,
  mergedPiiName: string,
): string[] =>
  compact([
    `Attendee '${sourceName}' merged into '${mergedPiiName}'`,
    summary.bookingsMoved > 0
      ? `${summary.bookingsMoved} booking(s) moved`
      : null,
    summary.bookingsSkipped > 0
      ? `${summary.bookingsSkipped} booking(s) skipped`
      : null,
    summary.bookingsReplacedTarget > 0
      ? `${summary.bookingsReplacedTarget} booking(s) replaced`
      : null,
    summary.answersTakenFromSource > 0
      ? `${summary.answersTakenFromSource} answer(s) from source`
      : null,
    summary.answersCleared > 0
      ? `${summary.answersCleared} answer(s) cleared`
      : null,
  ]);

/** Build flash message parts for a merge */
const buildMergeFlashParts = (
  summary: MergeSummary,
  sourceName: string,
  mergedPiiName: string,
): string[] => {
  const parts = [`Merged ${sourceName} into ${mergedPiiName}`];
  if (summary.bookingsMoved > 0) {
    parts.push(`${summary.bookingsMoved} booking(s) moved`);
  }
  if (summary.bookingsSkipped > 0) {
    parts.push(`${summary.bookingsSkipped} booking(s) skipped`);
  }
  return parts;
};

/** Validate merge POST preconditions, returning an error Response or the source */
const validateMergePostInput = async (
  attendeeId: number,
  form: FormParams,
  session: AuthSession,
): Promise<
  | { ok: true; source: MergeSource; sourceToken: string }
  | { ok: false; response: Response }
> => {
  const sourceToken = form.getString("source_token");
  if (!sourceToken) {
    return {
      ok: false,
      response: errorRedirect(
        `/admin/attendees/${attendeeId}/merge`,
        "Source token is required",
      ),
    };
  }

  const source = await loadMergeSource(sourceToken, session);
  if (!source) {
    return {
      ok: false,
      response: errorRedirect(
        `/admin/attendees/${attendeeId}/merge?token=${encodeURIComponent(sourceToken)}`,
        "Ticket token not found",
      ),
    };
  }

  if (source.id === attendeeId) {
    return {
      ok: false,
      response: errorRedirect(
        `/admin/attendees/${attendeeId}/merge`,
        "Cannot merge an attendee with themselves",
      ),
    };
  }

  return { ok: true, source, sourceToken };
};

/** Apply merge decisions and return the success redirect response */
const applyMergeDecisions = async (
  attendeeId: number,
  target: Attendee,
  source: MergeSource,
  diff: AttendeeMergeDiff,
  decision: AttendeeMergeDecisionInput,
): Promise<Response> => {
  const result = await applyAttendeeMerge({
    decision,
    diff,
    sourceId: source.id,
    sourcePii: extractSourcePii(source),
    targetId: attendeeId,
    targetPii: {
      ...extractTargetPii(target),
      payment_id: target.payment_id,
      ticket_token: target.ticket_token,
    },
  });

  const mergedPiiName =
    decision.pii.name === "source" ? source.name : target.name;
  await updateTargetPiiFromDecision(attendeeId, decision, source, target);

  const { summary } = result;
  await logActivity(
    buildMergeLogParts(summary, source.name, mergedPiiName).join(". "),
    target.event_id,
  );

  return redirect(
    `/admin/attendees/${attendeeId}`,
    buildMergeFlashParts(summary, source.name, mergedPiiName).join(". "),
    true,
  );
};

/** Handle POST /admin/attendees/:attendeeId/merge — validate + apply decisions */
const handleMergePost = (
  request: Request,
  { attendeeId }: { attendeeId: number },
): Promise<Response> =>
  withAuth(request, AUTH_FORM, (session, form) =>
    withMergeTarget(session, attendeeId, async (target) => {
      const input = await validateMergePostInput(attendeeId, form, session);
      if (!input.ok) return input.response;
      const { source, sourceToken } = input;

      const diff = await buildMergeDiffFor(target, source, attendeeId);
      const decision = parseMergeDecisionForm(form, diff);
      const validation = validateAttendeeMergeDecision(diff, decision);

      if (!validation.valid) {
        return htmlResponse(
          adminMergeAttendeePage(
            target,
            source,
            sourceToken,
            session,
            validation.errors.join("; "),
            diff,
          ),
        );
      }

      return applyMergeDecisions(attendeeId, target, source, diff, decision);
    }),
  );
/* jscpd:ignore-end */

/** Attendee routes */
export const attendeesRoutes = defineRoutes({
  "DELETE /admin/event/:eventId/attendee/:attendeeId/delete":
    handleAttendeeDelete,
  "GET /admin/attendees/:attendeeId": handleEditAttendeeGet,
  "GET /admin/attendees/:attendeeId/merge": handleMergeGet,
  "GET /admin/event/:eventId/attendee/:attendeeId/delete":
    handleAdminAttendeeDeleteGet,
  "GET /admin/event/:eventId/attendee/:attendeeId/resend-notification":
    handleAdminResendNotificationGet,
  "POST /admin/attendees/:attendeeId": handleEditAttendeePost,
  "POST /admin/attendees/:attendeeId/event/:eventId": handleUpdateEventLink,
  "POST /admin/attendees/:attendeeId/link": handleAddEventLink,
  "POST /admin/attendees/:attendeeId/merge": handleMergePost,
  "POST /admin/attendees/:attendeeId/refresh-payment": handleRefreshPayment,
  "POST /admin/attendees/:attendeeId/unlink/:eventId": handleUnlinkEvent,
  "POST /admin/event/:eventId/attendee": handleAddAttendee,
  "POST /admin/event/:eventId/attendee/:attendeeId/checkin":
    handleAttendeeCheckin,
  "POST /admin/event/:eventId/attendee/:attendeeId/delete":
    handleAttendeeDelete,
  "POST /admin/event/:eventId/attendee/:attendeeId/delete-incomplete":
    handleDeleteIncomplete,
  "POST /admin/event/:eventId/attendee/:attendeeId/resend-notification":
    handleResendNotification,
});
