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
import {
  type LinkEventUpdateValues,
  type LinkEventValues,
  linkEventForm,
  linkEventUpdateForm,
} from "#lib/form-schemas.ts";
import type { EventWithCount } from "#lib/types.ts";
import { AUTH_FORM, errorRedirect, redirect, withAuth } from "#routes/utils.ts";

/** Parse a quantity value from a form field, clamping to [1, max] */
const parseQuantity = (value: string, max: number): number => {
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

/* jscpd:ignore-start — route factories; inner signature matches editAttendeePost in attendees-edit.ts */
type FormSchema<TValues> = {
  validate: (
    form: FormParams,
  ) => { valid: true; values: TValues } | { valid: false; error: string };
};

const attendeeRouteWithForm =
  <TValues>(
    schema: FormSchema<TValues>,
    fn: (attendeeId: number, values: TValues) => Response | Promise<Response>,
  ) =>
  (
    request: Request,
    { attendeeId }: { attendeeId: number },
  ): Promise<Response> =>
    withAuth(request, AUTH_FORM, (_session, form) => {
      const validation = schema.validate(form);
      if (!validation.valid)
        return errorRedirect(
          `/admin/attendees/${attendeeId}`,
          validation.error,
        );
      return fn(attendeeId, validation.values);
    });

const eventLinkRouteWithForm =
  <TValues>(
    schema: FormSchema<TValues>,
    fn: (
      attendeeId: number,
      eventId: number,
      values: TValues,
    ) => Promise<Response>,
  ) =>
  (
    request: Request,
    { attendeeId, eventId }: { attendeeId: number; eventId: number },
  ): Promise<Response> =>
    withAuth(request, AUTH_FORM, (_session, form) => {
      const validation = schema.validate(form);
      if (!validation.valid)
        return errorRedirect(
          `/admin/attendees/${attendeeId}`,
          validation.error,
        );
      return fn(attendeeId, eventId, validation.values);
    });

/** Route handler factory for /admin/attendees/:attendeeId/…/:eventId operations */
const eventLinkRoute =
  (fn: (attendeeId: number, eventId: number) => Response | Promise<Response>) =>
  (
    request: Request,
    { attendeeId, eventId }: { attendeeId: number; eventId: number },
  ): Promise<Response> =>
    withAuth(request, AUTH_FORM, () => fn(attendeeId, eventId));

/** Handle POST /admin/attendees/:attendeeId/unlink/:eventId — remove event link */
export const handleUnlinkEvent = eventLinkRoute(async (attendeeId, eventId) => {
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
});

/** Handle POST /admin/attendees/:attendeeId/event/:eventId — update per-event link */
export const handleUpdateEventLink =
  eventLinkRouteWithForm<LinkEventUpdateValues>(
    linkEventUpdateForm,
    (attendeeId, eventId, values) =>
      applyLinkOp(
        attendeeId,
        eventId,
        values,
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
export const handleAddEventLink = attendeeRouteWithForm<LinkEventValues>(
  linkEventForm,
  (attendeeId, values) => {
    const eventId = values.event_id;
    return applyLinkOp(
      attendeeId,
      eventId,
      values,
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
  },
);
