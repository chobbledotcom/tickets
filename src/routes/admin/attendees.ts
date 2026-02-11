/**
 * Admin attendee management routes
 */

import { logActivity } from "#lib/db/activityLog.ts";
import {
  decryptAttendeeOrNull,
  deleteAttendee,
  updateCheckedIn,
} from "#lib/db/attendees.ts";
import { getEventWithAttendeeRaw } from "#lib/db/events.ts";
import type { Attendee, EventWithCount } from "#lib/types.ts";
import {
  defineRoutes,
  type RouteHandlerFn,
  type RouteParams,
} from "#routes/router.ts";
import { verifyIdentifier } from "#routes/admin/utils.ts";
import {
  type AuthSession,
  getPrivateKey,
  htmlResponse,
  notFoundResponse,
  redirect,
  requireSessionOr,
  withAuthForm,
} from "#routes/utils.ts";
import { adminDeleteAttendeePage } from "#templates/admin/attendees.tsx";

/** Attendee with event data */
type AttendeeWithEvent = { attendee: Attendee; event: EventWithCount };

/**
 * Load attendee ensuring it belongs to the specified event.
 * Uses batched query to fetch event + attendee in a single DB round-trip.
 */
const loadAttendeeForEvent = async (
  eventId: number,
  attendeeId: number,
  privateKey: CryptoKey,
): Promise<AttendeeWithEvent | null> => {
  // Fetch event and attendee in single DB round-trip
  const result = await getEventWithAttendeeRaw(eventId, attendeeId);
  if (!result) return null;

  const attendee = await decryptAttendeeOrNull(result.attendeeRaw, privateKey);
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
  const privateKey = (await getPrivateKey(session))!;
  const data = await loadAttendeeForEvent(eventId, attendeeId, privateKey);
  return data ? handler(data) : notFoundResponse();
};

/** Handle GET /admin/event/:eventId/attendee/:attendeeId/delete */
const handleAdminAttendeeDeleteGet = (
  request: Request,
  eventId: number,
  attendeeId: number,
): Promise<Response> =>
  requireSessionOr(request, (session) =>
    withAttendee(session, eventId, attendeeId, (data) =>
      htmlResponse(adminDeleteAttendeePage(data.event, data.attendee, session)),
    ),
  );

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

/** Parse event and attendee IDs from params (route pattern guarantees both exist as \d+) */
const parseAttendeeIds = (
  params: RouteParams,
): { eventId: number; attendeeId: number } => ({
  eventId: Number.parseInt(params.eventId!, 10),
  attendeeId: Number.parseInt(params.attendeeId!, 10),
});

/** Map return_filter form value to URL suffix */
const filterSuffix = (returnFilter: string | null): string => {
  if (returnFilter === "in") return "/in";
  if (returnFilter === "out") return "/out";
  return "";
};

/** Delete attendee handler with name verification */
const attendeeDeleteHandler: RouteHandlerFn = (request, params) => {
  const { eventId, attendeeId } = parseAttendeeIds(params);
  return withAttendeeForm(request, eventId, attendeeId, async (data, session, form) => {
    const confirmName = form.get("confirm_name") ?? "";
    if (!verifyIdentifier(data.attendee.name, confirmName)) {
      return htmlResponse(
        adminDeleteAttendeePage(
          data.event,
          data.attendee,
          session,
          "Attendee name does not match. Please type the exact name to confirm deletion.",
        ),
        400,
      );
    }

    await deleteAttendee(attendeeId);
    await logActivity(`Attendee deleted from '${data.event.name}'`, eventId);
    return redirect(`/admin/event/${eventId}`);
  });
};

/** Checkin toggle handler */
const attendeeCheckinHandler: RouteHandlerFn = (request, params) => {
  const { eventId, attendeeId } = parseAttendeeIds(params);
  return withAttendeeForm(request, eventId, attendeeId, async (data, _session, form) => {
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
};

/** Attendee routes */
export const attendeesRoutes = defineRoutes({
  "GET /admin/event/:eventId/attendee/:attendeeId/delete": (
    request,
    params,
  ) => {
    const ids = parseAttendeeIds(params);
    return handleAdminAttendeeDeleteGet(request, ids.eventId, ids.attendeeId);
  },
  "POST /admin/event/:eventId/attendee/:attendeeId/delete": attendeeDeleteHandler,
  "DELETE /admin/event/:eventId/attendee/:attendeeId/delete": attendeeDeleteHandler,
  "POST /admin/event/:eventId/attendee/:attendeeId/checkin": attendeeCheckinHandler,
});
