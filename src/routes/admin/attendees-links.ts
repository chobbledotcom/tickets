/**
 * Admin attendee event-link management routes (add, unlink, update)
 */

import { logActivity } from "#lib/db/activityLog.ts";
import {
  addEventLink,
  unlinkAttendeeFromEvent,
  updateEventLink,
} from "#lib/db/attendees.ts";
import { queryOne } from "#lib/db/client.ts";
import { getEventWithCount } from "#lib/db/events.ts";
import { linkEventForm, linkEventUpdateForm } from "#lib/form-schemas.ts";
import type { EventWithCount } from "#lib/types.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import {
  AUTH_FORM,
  errorRedirect,
  formRouteRedirect,
  redirect,
  withAuth,
} from "#routes/utils.ts";

/** Parse a quantity value from a form field, clamping to [1, max] */
export const parseQuantity = (value: string, max: number): number => {
  const parsed = Math.floor(Number(value));
  return Math.max(1, Math.min(max, Number.isNaN(parsed) ? 1 : parsed));
};

/** Parse quantity and date from form for an event link operation */
const parseLinkFormFields = (
  values: {
    quantity: number;
    date: string | null;
  },
  event: EventWithCount,
): { quantity: number; date: string | null } => ({
  date: event.event_type === "daily" ? values.date : null,
  quantity: parseQuantity(String(values.quantity), event.max_quantity),
});

/** Resolve event, parse form fields, run op, check capacity, redirect on success */
const applyLinkOp = async (
  attendeeId: number,
  eventId: number,
  values: {
    quantity: number;
    date: string | null;
  },
  operate: (fields: {
    quantity: number;
    date: string | null;
  }) => ReturnType<typeof addEventLink>,
  onSuccess: (event: EventWithCount) => Promise<Response>,
): Promise<Response> => {
  const event = await getEventWithCount(eventId);
  if (!event)
    return errorRedirect(`/admin/attendees/${attendeeId}`, "Event not found");
  const result = await operate(parseLinkFormFields(values, event));
  return result.success
    ? onSuccess(event)
    : errorRedirect(
        `/admin/attendees/${attendeeId}`,
        "Not enough spots available",
      );
};

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

/** Handle POST /admin/attendees/:attendeeId/event/:eventId — update per-event link */
export const handleUpdateEventLink: TypedRouteHandler<"POST /admin/attendees/:attendeeId/event/:eventId"> =
  formRouteRedirect(
    linkEventUpdateForm.validate,
    (params) => `/admin/attendees/${params.attendeeId}`,
    (params, values) =>
      applyLinkOp(
        params.attendeeId,
        params.eventId,
        values,
        (fields) => updateEventLink(params.attendeeId, params.eventId, fields),
        (event) =>
          Promise.resolve(
            redirect(
              `/admin/attendees/${params.attendeeId}`,
              `Updated ${event.name}`,
              true,
            ),
          ),
      ),
  );

/** Handle POST /admin/attendees/:attendeeId/link — add event link */
export const handleAddEventLink: TypedRouteHandler<"POST /admin/attendees/:attendeeId/link"> =
  formRouteRedirect(
    linkEventForm.validate,
    (params) => `/admin/attendees/${params.attendeeId}`,
    (params, values) => {
      const eventId = values.event_id;
      return applyLinkOp(
        params.attendeeId,
        eventId,
        values,
        (fields) => addEventLink(params.attendeeId, { eventId, ...fields }),
        async (event) => {
          await logActivity(`Attendee linked to '${event.name}'`, eventId);
          return redirect(
            `/admin/attendees/${params.attendeeId}`,
            `Added to ${event.name}`,
            true,
          );
        },
      );
    },
  );
