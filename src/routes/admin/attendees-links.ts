/**
 * Admin attendee event-link management routes (add, unlink, update)
 */

import {
  addEventLink,
  unlinkAttendeeFromEvent,
  updateEventLink,
} from "#lib/db/attendees.ts";
import { queryOne } from "#lib/db/client.ts";
import { getEventWithCount } from "#lib/db/events.ts";
import type { FormParams } from "#lib/form-data.ts";
import type { EventWithCount } from "#lib/types.ts";
import { createActionHandler } from "#routes/admin/utils.ts";


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

/** Handle POST /admin/attendees/:attendeeId/unlink/:eventId — remove event link */
export const handleUnlinkEvent = (
  request: Request,
  { attendeeId, eventId }: { attendeeId: number; eventId: number },
): Promise<Response> =>
  createActionHandler({
    auth: "any",
    execute: async () => {
      const linkCount = await queryOne<{ count: number }>(
        "SELECT COUNT(*) as count FROM event_attendees WHERE attendee_id = ?",
        [attendeeId],
      );
      if (linkCount && linkCount.count <= 1) {
        throw new Error(
          "Cannot remove the last event — delete the attendee instead",
        );
      }

      await unlinkAttendeeFromEvent(attendeeId, eventId);
    },
    eventId,
    message: async () => {
      const event = await getEventWithCount(eventId);
      return `Attendee unlinked from '${event!.name}'`;
    },
    successRedirect: `/admin/attendees/${attendeeId}`,
  })(request);

/** Handle POST /admin/attendees/:attendeeId/event/:eventId — update per-event link */
export const handleUpdateEventLink = (
  request: Request,
  { attendeeId, eventId }: { attendeeId: number; eventId: number },
): Promise<Response> =>
  createActionHandler({
    auth: "any",
    execute: async (_session, form) => {
      const event = await getEventWithCount(eventId);
      if (!event) throw new Error("Event not found");
      const result = await updateEventLink(
        attendeeId,
        eventId,
        parseLinkFormFields(form, event),
      );
      if (!result.success) throw new Error("Not enough spots available");
    },
    eventId,
    message: async () => {
      const event = await getEventWithCount(eventId);
      return `Attendee booking updated for '${event!.name}'`;
    },
    successRedirect: `/admin/attendees/${attendeeId}`,
  })(request);

/** Handle POST /admin/attendees/:attendeeId/link — add event link */
export const handleAddEventLink = (
  request: Request,
  { attendeeId }: { attendeeId: number },
): Promise<Response> =>
  createActionHandler({
    auth: "any",
    execute: async (_session, form) => {
      const eventId = Number(form.get("event_id")) || 0;
      if (!eventId) throw new Error("Event is required");
      const event = await getEventWithCount(eventId);
      if (!event) throw new Error("Event not found");
      const result = await addEventLink(attendeeId, {
        eventId,
        ...parseLinkFormFields(form, event),
      });
      if (!result.success) throw new Error("Not enough spots available");
      (form as unknown as Record<string, unknown>).eventName = event.name;
    },
    eventId: (form) => Number(form.get("event_id")) || undefined,
    message: (_session, form) => {
      const eventName = (form as unknown as Record<string, unknown>).eventName as
        | string
        | undefined;
      return `Attendee linked to '${eventName ?? "event"}'`;
    },
    successRedirect: `/admin/attendees/${attendeeId}`,
  })(request);
