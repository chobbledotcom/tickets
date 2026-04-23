/**
 * Admin attendee edit routes (edit page, refresh payment)
 */

/* jscpd:ignore-start */
import { compact, filter, map, uniqueBy } from "#fp";
import { getAvailableDates } from "#lib/dates.ts";
import { logActivity } from "#lib/db/activityLog.ts";
import {
  ATTENDEE_LEFT_JOIN_SELECT,
  decryptAttendeeOrNull,
  type EventAttendeeRow,
  markRefunded,
  updateAttendeePII,
} from "#lib/db/attendees.ts";
import { queryAll, queryOne } from "#lib/db/client.ts";
import { getAllEvents, getEventWithCount } from "#lib/db/events.ts";
import { getActiveHolidays } from "#lib/db/holidays.ts";
import {
  getAttendeeAnswersBatch,
  getQuestionsForEvent,
  type QuestionWithAnswers,
  saveAttendeeAnswers,
} from "#lib/db/questions.ts";
import { ATTENDEE_DEMO_FIELDS, applyDemoOverrides } from "#lib/demo.ts";
import type { FormParams } from "#lib/form-data.ts";
import { getActivePaymentProvider } from "#lib/payments.ts";
import type { Attendee, EventWithCount } from "#lib/types.ts";
import { createEntityRouteHandlers } from "#routes/admin/entity-handlers.ts";
import { requirePrivateKey } from "#routes/admin/actions.ts";
import { type AttendeeRouteParams } from "#routes/entity.ts";
import { type AuthSession } from "#routes/auth.ts";
import { applyFlash } from "#routes/csrf.ts";
import { errorRedirect, htmlResponse, redirect } from "#routes/response.ts";
import { adminEditAttendeePage } from "#templates/admin/attendees.tsx";
import { getReturnUrl, NO_PROVIDER_ERROR } from "./attendees-route-helpers.ts";

/* jscpd:ignore-end */

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

  // Resolve events for each booking in parallel (event always exists — referential integrity)
  const eventLinks = await Promise.all(
    map(
      async (booking: EventAttendeeRow): Promise<EventLinkData> => ({
        booking,
        date: booking.start_at?.slice(0, 10) ?? null,
        event: (await getEventWithCount(booking.event_id))!,
      }),
    )(bookingRows),
  );

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

/** Curried: load edit attendee data then render with flash */
const editAttendeePage =
  (request: Request, session: AuthSession) =>
  (data: EditAttendeeData): Response => {
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
  };

const handlers = createEntityRouteHandlers(
  loadAttendeeForEdit,
  ({ attendeeId }: AttendeeRouteParams) => attendeeId,
);

/** Handle GET /admin/attendees/:attendeeId */
export const handleEditAttendeeGet = handlers.get((request, session, data) =>
  editAttendeePage(request, session)(data),
);

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
export const handleEditAttendeePost = handlers.post((session, form, data) =>
  editAttendeeHandler(session, form, data, data.attendee.id),
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
export const handleRefreshPayment = handlers.post((session, form, data) =>
  refreshPaymentHandler(session, form, data, data.attendee.id),
);
