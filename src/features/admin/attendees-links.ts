/**
 * Admin attendee event-link management routes (add, unlink, update)
 */

import { unlinkAttendeeFromEvent } from "#lib/db/attendees.ts";
import { queryOne } from "#lib/db/client.ts";
import { getEventWithCount } from "#lib/db/events.ts";

export {
  handleAddEventLink,
  handleUpdateEventLink,
  parseQuantity,
} from "#routes/admin/attendees-link-form.ts";

import { AUTH_FORM, withAuth } from "#routes/auth.ts";
import { errorRedirect, redirect } from "#routes/response.ts";
import type { TypedRouteHandler } from "#routes/router.ts";

/** Handle POST /admin/attendees/:attendeeId/unlink/:eventId — remove event link */
export const handleUnlinkEvent: TypedRouteHandler<
  "POST /admin/attendees/:attendeeId/unlink/:eventId"
> = (request, params) =>
  withAuth(request, AUTH_FORM, () =>
    handleUnlinkEventAction(params.attendeeId, params.eventId),
  );

const handleUnlinkEventAction = async (
  attendeeId: number,
  eventId: number,
): Promise<Response> => {
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

  await unlinkAttendeeFromEvent(attendeeId, eventId);
  const event = await getEventWithCount(eventId);
  return redirect(
    `/admin/attendees/${attendeeId}`,
    `Attendee unlinked from '${event!.name}'`,
    true,
  );
};
