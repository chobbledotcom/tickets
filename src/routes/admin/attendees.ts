/**
 * Admin attendee management routes
 */

import { logActivity } from "#lib/db/activityLog.ts";
import { deleteAttendee, getAttendee } from "#lib/db/attendees.ts";
import { getEventWithCount } from "#lib/db/events.ts";
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

/** Load attendee ensuring it belongs to the specified event */
const loadAttendeeForEvent = async (
  eventId: number,
  attendeeId: number,
  privateKey: CryptoKey,
): Promise<AttendeeWithEvent | null> => {
  const event = await getEventWithCount(eventId);
  if (!event) return null;

  const attendee = await getAttendee(attendeeId, privateKey);
  if (!attendee || attendee.event_id !== eventId) return null;

  return { attendee, event };
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

  const privateKey = await getPrivateKey(session.token, session.wrappedDataKey);
  if (!privateKey) {
    return redirect("/admin");
  }

  const data = await loadAttendeeForEvent(eventId, attendeeId, privateKey);
  if (!data) {
    return notFoundResponse();
  }

  return htmlResponse(
    adminDeleteAttendeePage(data.event, data.attendee, session.csrfToken),
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
    const privateKey = await getPrivateKey(
      session.token,
      session.wrappedDataKey,
    );
    if (!privateKey) {
      return redirect("/admin");
    }

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
          session.csrfToken,
          "Attendee name does not match. Please type the exact name to confirm deletion.",
        ),
        400,
      );
    }

    await deleteAttendee(attendeeId);
    await logActivity(
      `Deleted an attendee from event '${data.event.name}'`,
      eventId,
    );
    return redirect(`/admin/event/${eventId}`);
  });

/** Parse event and attendee IDs from params */
const parseAttendeeIds = (
  params: RouteParams,
): { eventId: number; attendeeId: number } => ({
  eventId: Number.parseInt(params.eventId ?? "0", 10),
  attendeeId: Number.parseInt(params.attendeeId ?? "0", 10),
});

/** Route handler for POST/DELETE attendee delete */
const attendeeDeleteHandler: RouteHandlerFn = (request, params) => {
  const ids = parseAttendeeIds(params);
  return handleAdminAttendeeDeletePost(request, ids.eventId, ids.attendeeId);
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
  "POST /admin/event/:eventId/attendee/:attendeeId/delete":
    attendeeDeleteHandler,
  "DELETE /admin/event/:eventId/attendee/:attendeeId/delete":
    attendeeDeleteHandler,
});
