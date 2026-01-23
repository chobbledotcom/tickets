/**
 * Admin attendee management routes
 */

import { deleteAttendee, getAttendee } from "#lib/db/attendees.ts";
import { getEventWithCount } from "#lib/db/events.ts";
import type { EventWithCount } from "#lib/types.ts";
import {
  defineRoutes,
  type RouteHandlerFn,
  type RouteParams,
} from "#routes/router.ts";
import {
  htmlResponse,
  notFoundResponse,
  redirect,
  requireSessionOr,
  withAuthForm,
} from "#routes/utils.ts";
import { adminDeleteAttendeePage } from "#templates/admin.tsx";

/** Attendee type */
type Attendee = NonNullable<Awaited<ReturnType<typeof getAttendee>>>;

/** Attendee with event data */
type AttendeeWithEvent = { attendee: Attendee; event: EventWithCount };

/** Load attendee ensuring it belongs to the specified event */
const loadAttendeeForEvent = async (
  eventId: number,
  attendeeId: number,
): Promise<AttendeeWithEvent | null> => {
  const event = await getEventWithCount(eventId);
  if (!event) return null;

  const attendee = await getAttendee(attendeeId);
  if (!attendee || attendee.event_id !== eventId) return null;

  return { attendee, event };
};

/** Curried helper: load attendee for event, return 404 or apply handler */
const withAttendeeForEvent =
  (eventId: number, attendeeId: number) =>
  async (
    handler: (data: AttendeeWithEvent) => Response | Promise<Response>,
  ): Promise<Response> => {
    const data = await loadAttendeeForEvent(eventId, attendeeId);
    return data ? handler(data) : notFoundResponse();
  };

/** Handle GET /admin/event/:eventId/attendee/:attendeeId/delete */
const handleAdminAttendeeDeleteGet = async (
  request: Request,
  eventId: number,
  attendeeId: number,
): Promise<Response> =>
  requireSessionOr(request, (session) =>
    withAttendeeForEvent(
      eventId,
      attendeeId,
    )((data) =>
      htmlResponse(
        adminDeleteAttendeePage(data.event, data.attendee, session.csrfToken),
      ),
    ),
  );

/** Verify name matches for deletion confirmation (case-insensitive, trimmed) */
const verifyName = (expected: string, provided: string): boolean =>
  expected.trim().toLowerCase() === provided.trim().toLowerCase();

/** Handle POST /admin/event/:eventId/attendee/:attendeeId/delete with name verification */
const handleAdminAttendeeDeletePost = async (
  request: Request,
  eventId: number,
  attendeeId: number,
): Promise<Response> =>
  withAuthForm(request, (session, form) =>
    withAttendeeForEvent(
      eventId,
      attendeeId,
    )(async (data) => {
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
      return redirect(`/admin/event/${eventId}`);
    }),
  );

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
