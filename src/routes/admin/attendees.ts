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
import {
  getAuthenticatedSession,
  getPrivateKey,
  htmlResponse,
  notFoundResponse,
  redirect,
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

/** Handle GET /admin/event/:eventId/attendee/:attendeeId/delete */
const handleAdminAttendeeDeleteGet = async (
  request: Request,
  eventId: number,
  attendeeId: number,
): Promise<Response> => {
  const session = await getAuthenticatedSession(request);
  if (!session) {
    return redirect("/admin");
  }

  const privateKey = (await getPrivateKey(session.token, session.wrappedDataKey))!;

  const data = await loadAttendeeForEvent(eventId, attendeeId, privateKey);
  if (!data) {
    return notFoundResponse();
  }

  return htmlResponse(
    adminDeleteAttendeePage(data.event, data.attendee, session),
  );
};

/** Verify name matches for deletion confirmation (case-insensitive, trimmed) */
const verifyName = (expected: string, provided: string): boolean =>
  expected.trim().toLowerCase() === provided.trim().toLowerCase();

/** Handle POST /admin/event/:eventId/attendee/:attendeeId/delete with name verification */
const handleAdminAttendeeDeletePost = (
  request: Request,
  eventId: number,
  attendeeId: number,
): Promise<Response> =>
  withAuthForm(request, async (session, form) => {
    const privateKey = (await getPrivateKey(session.token, session.wrappedDataKey))!;

    const data = await loadAttendeeForEvent(eventId, attendeeId, privateKey);
    if (!data) {
      return notFoundResponse();
    }

    const confirmName = form.get("confirm_name") ?? "";
    if (!verifyName(data.attendee.name, confirmName)) {
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

/** Parse event and attendee IDs from params */
const parseAttendeeIds = (
  params: RouteParams,
): { eventId: number; attendeeId: number } => ({
  eventId: Number.parseInt(params.eventId as string, 10),
  attendeeId: Number.parseInt(params.attendeeId as string, 10),
});

/** Route handler for POST/DELETE attendee delete */
const attendeeDeleteHandler: RouteHandlerFn = (request, params) => {
  const ids = parseAttendeeIds(params);
  return handleAdminAttendeeDeletePost(request, ids.eventId, ids.attendeeId);
};

/** Map return_filter form value to URL suffix */
const filterSuffix = (returnFilter: string | null): string => {
  if (returnFilter === "in") return "/in";
  if (returnFilter === "out") return "/out";
  return "";
};

/** Handle POST /admin/event/:eventId/attendee/:attendeeId/checkin (toggle check-in) */
const handleAdminAttendeeCheckinPost = (
  request: Request,
  eventId: number,
  attendeeId: number,
): Promise<Response> =>
  withAuthForm(request, async (session, form) => {
    const privateKey = (await getPrivateKey(session.token, session.wrappedDataKey))!;

    const data = await loadAttendeeForEvent(eventId, attendeeId, privateKey);
    if (!data) {
      return notFoundResponse();
    }

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

/** Attendee routes */
export const attendeesRoutes = defineRoutes({
  "GET /admin/event/:eventId/attendee/:attendeeId/delete": (
    request,
    params,
  ) => {
    const ids = parseAttendeeIds(params);
    return handleAdminAttendeeDeleteGet(request, ids.eventId, ids.attendeeId);
  },
  "POST /admin/event/:eventId/attendee/:attendeeId/delete":
    attendeeDeleteHandler,
  "DELETE /admin/event/:eventId/attendee/:attendeeId/delete":
    attendeeDeleteHandler,
  "POST /admin/event/:eventId/attendee/:attendeeId/checkin": (
    request,
    params,
  ) => {
    const ids = parseAttendeeIds(params);
    return handleAdminAttendeeCheckinPost(request, ids.eventId, ids.attendeeId);
  },
});
