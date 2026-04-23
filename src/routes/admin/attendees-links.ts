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
import type { FormParams } from "#lib/form-data.ts";
import type { EventWithCount } from "#lib/types.ts";
import { AUTH_FORM, errorRedirect, redirect, withAuth } from "#routes/utils.ts";

/** Parse a quantity value from a form field, clamping to [1, max] */
const parseQuantity = (value: string, max: number): number => {
  const parsed = Math.floor(Number(value));
  return Math.max(1, Math.min(max, Number.isNaN(parsed) ? 1 : parsed));
};

/** Parse quantity and date from form for an event link operation */
const parseLinkFormFields = (
  form: FormParams,
  event: EventWithCount,
): { quantity: number; date: string | null } => ({
  date: event.event_type === "daily" ? form.getString("date") || null : null,
  quantity: parseQuantity(form.get("quantity") || "1", event.max_quantity),
});

/** Resolve event, parse form fields, run op, check capacity, redirect on success */
const applyLinkOp = async (
  attendeeId: number,
  eventId: number,
  form: FormParams,
  operate: (fields: {
    quantity: number;
    date: string | null;
  }) => Promise<{ success: boolean }>,
  onSuccess: (event: EventWithCount) => Promise<Response>,
): Promise<Response> => {
  const event = await getEventWithCount(eventId);
  if (!event) {
    return errorRedirect(`/admin/attendees/${attendeeId}`, "Event not found");
  }
  const result = await operate(parseLinkFormFields(form, event));
  return result.success
    ? onSuccess(event)
    : errorRedirect(
        `/admin/attendees/${attendeeId}`,
        "Not enough spots available",
      );
};

/* jscpd:ignore-start — route factories; inner signature matches editAttendeePost in attendees-edit.ts */
/** Route handler factory for /admin/attendees/:attendeeId operations */
const attendeeRoute =
  (
    fn: (attendeeId: number, form: FormParams) => Response | Promise<Response>,
  ) =>
  (
    request: Request,
    { attendeeId }: { attendeeId: number },
  ): Promise<Response> =>
    withAuth(request, AUTH_FORM, (_session, form) => fn(attendeeId, form));

/** Route handler factory for /admin/attendees/:attendeeId/…/:eventId operations */
const eventLinkRoute =
  (
    fn: (
      attendeeId: number,
      eventId: number,
      form: FormParams,
    ) => Promise<Response>,
  ) =>
  (
    request: Request,
    { attendeeId, eventId }: { attendeeId: number; eventId: number },
  ): Promise<Response> =>
    withAuth(request, AUTH_FORM, (_session, form) =>
      fn(attendeeId, eventId, form),
    );
/* jscpd:ignore-end */

/** Handle POST /admin/attendees/:attendeeId/unlink/:eventId — remove event link */
export const handleUnlinkEvent = eventLinkRoute(async (attendeeId, eventId) => {
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
export const handleUpdateEventLink = eventLinkRoute(
  (attendeeId, eventId, form) =>
    applyLinkOp(
      attendeeId,
      eventId,
      form,
      (fields) => updateEventLink(attendeeId, eventId, fields),
      (event) =>
        Promise.resolve(
          redirect(
            `/admin/attendees/${attendeeId}`,
            `Updated ${event.name}`,
            true,
          ),
        ),
    ),
);

/** Handle POST /admin/attendees/:attendeeId/link — add event link */
export const handleAddEventLink = attendeeRoute((attendeeId, form) => {
  const eventId = Number(form.get("event_id")) || 0;
  if (!eventId) {
    return errorRedirect(`/admin/attendees/${attendeeId}`, "Event is required");
  }
  return applyLinkOp(
    attendeeId,
    eventId,
    form,
    (fields) => addEventLink(attendeeId, { eventId, ...fields }),
    async (event) => {
      await logActivity(`Attendee linked to '${event.name}'`, eventId);
      return redirect(
        `/admin/attendees/${attendeeId}`,
        `Added to ${event.name}`,
        true,
      );
    },
  );
});
