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
import {
  type ActionHandlerConfig,
  createActionHandler,
} from "#routes/admin/utils.ts";
import type {
  AttendeeEventRouteParams,
  AttendeeRouteParams,
} from "#routes/utils.ts";

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

const eventMessage =
  (eventId: number, prefix: string): () => Promise<string> => async () => {
    const event = await getEventWithCount(eventId);
    return `${prefix} '${event!.name}'`;
  };

/** Execute wrapper: fetch event, validate, run operation */
const withEventExecute = (
  eventId: number,
  op: (event: EventWithCount, form: FormParams) => Promise<void>,
): ActionHandlerConfig["execute"] =>
async (_session, form) => {
  const event = await getEventWithCount(eventId);
  if (!event) throw new Error("Event not found");
  await op(event, form);
};

/** Common config for attendee event-link actions */
const attendeeActionConfig = (
  attendeeId: number,
): Pick<ActionHandlerConfig, "auth" | "successRedirect"> => ({
  auth: "any",
  successRedirect: `/admin/attendees/${attendeeId}`,
});

/** Curried factory: params → config → route handler */
const attendeeAction = <T extends AttendeeRouteParams>(
  config: (
    params: T,
  ) => Omit<ActionHandlerConfig, "auth" | "successRedirect">,
) =>
(request: Request, params: T): Promise<Response> =>
  createActionHandler({
    ...attendeeActionConfig(params.attendeeId),
    ...config(params),
  })(request);

/** Handle POST /admin/attendees/:attendeeId/unlink/:eventId — remove event link */
export const handleUnlinkEvent = attendeeAction(
  ({ attendeeId, eventId }: AttendeeEventRouteParams) => ({
    eventId,
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
    message: eventMessage(eventId, "Attendee unlinked from"),
  }),
);

/** Handle POST /admin/attendees/:attendeeId/event/:eventId — update per-event link */
export const handleUpdateEventLink = attendeeAction(
  ({ attendeeId, eventId }: AttendeeEventRouteParams) => ({
    eventId,
    execute: withEventExecute(eventId, async (event, form) => {
      const result = await updateEventLink(
        attendeeId,
        eventId,
        parseLinkFormFields(form, event),
      );
      if (!result.success) throw new Error("Not enough spots available");
    }),
    message: eventMessage(eventId, "Attendee booking updated for"),
  }),
);

/** Handle POST /admin/attendees/:attendeeId/link — add event link */
export const handleAddEventLink = attendeeAction(
  ({ attendeeId }: AttendeeRouteParams) => ({
    eventId: (form) => Number(form.get("event_id")),
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
    message: (_session, form) => {
      const eventName = (form as unknown as Record<string, unknown>)
        .eventName as string;
      return `Attendee linked to '${eventName}'`;
    },
  }),
);
