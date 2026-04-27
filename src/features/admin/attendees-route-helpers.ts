/**
 * Shared utilities for admin attendee route handlers
 */

import { requirePrivateKey } from "#routes/admin/actions.ts";
import { verifyOrRedirect } from "#routes/admin/confirmation.ts";
import { withEntityLoader } from "#routes/admin/entity-handlers.ts";
import {
  AUTH_FORM,
  type AuthSession,
  requireSessionOr,
  withAuth,
} from "#routes/auth.ts";
import { getSearchParam } from "#routes/url.ts";
import { decryptAttendeeOrNull } from "#shared/db/attendees.ts";
import { getEventWithAttendeeRaw } from "#shared/db/events.ts";
import type { FormParams } from "#shared/form-data.ts";
import type { Attendee, EventWithCount } from "#shared/types.ts";

/** Attendee with event data */
export type AttendeeWithEvent = { attendee: Attendee; event: EventWithCount };

/** No payment provider configured error (shared with attendee-refunds) */
export const NO_PROVIDER_ERROR = "No payment provider configured.";

/**
 * Load attendee ensuring it belongs to the specified event.
 * Uses batched query to fetch event + attendee in a single DB round-trip.
 * Decrypts attendee PII using the admin private key.
 */
const loadAttendeeForEvent = async (
  session: AuthSession,
  eventId: number,
  attendeeId: number,
): Promise<AttendeeWithEvent | null> => {
  const pk = await requirePrivateKey(session);
  const result = await getEventWithAttendeeRaw(eventId, attendeeId);
  if (!result) return null;

  const attendee = await decryptAttendeeOrNull(result.attendeeRaw, pk);
  if (!attendee || attendee.event_id !== eventId) return null;

  return { attendee, event: result.event };
};

/** Load attendee with auth, returning 404 if not found */
const withAttendee = withEntityLoader(loadAttendeeForEvent);

/** Route params for event-scoped routes */
export type EventRouteParams = { id: number };

/** Route params for attendee-scoped routes */
type AttendeeRouteParams = { eventId: number; attendeeId: number };

/** Auth + load attendee GET handler (shared by delete, refund, and resend-notification GET routes) */
export const attendeeGetRoute =
  (
    handler: (
      data: AttendeeWithEvent,
      session: AuthSession,
      request: Request,
    ) => Response | Promise<Response>,
  ) =>
  (
    request: Request,
    { eventId, attendeeId }: AttendeeRouteParams,
  ): Promise<Response> =>
    requireSessionOr(request, (session) =>
      withAttendee(
        session,
        eventId,
        attendeeId,
      )((data) => handler(data, session, request)),
    );

/** Auth + load attendee from form handler */
const withAttendeeForm = (
  request: Request,
  eventId: number,
  attendeeId: number,
  handler: (
    data: AttendeeWithEvent,
    session: AuthSession,
    form: FormParams,
  ) => Response | Promise<Response>,
): Promise<Response> =>
  withAuth(request, AUTH_FORM, (session, form) =>
    withAttendee(
      session,
      eventId,
      attendeeId,
    )((data) => handler(data, session, form)),
  );

/** Read return_url from request query params */
export const getReturnUrl = (request: Request): string =>
  getSearchParam(request, "return_url");

/** Attendee form handler that receives typed IDs */
type AttendeeFormAction = (
  data: AttendeeWithEvent,
  session: AuthSession,
  form: FormParams,
  eventId: number,
  attendeeId: number,
) => Response | Promise<Response>;

/** Create an attendee form handler with typed IDs */
export const attendeeFormAction =
  (handler: AttendeeFormAction) =>
  (
    request: Request,
    { eventId, attendeeId }: AttendeeRouteParams,
  ): Promise<Response> =>
    withAttendeeForm(request, eventId, attendeeId, (data, session, form) =>
      handler(data, session, form, eventId, attendeeId),
    );

/** Attendee form handler that first verifies the attendee name */
export const verifiedAttendeeForm = (
  action: string,
  actionLabel: string | undefined,
  handler: (
    data: AttendeeWithEvent,
    form: FormParams,
    eventId: number,
    attendeeId: number,
  ) => Response | Promise<Response>,
) =>
  attendeeFormAction((data, _session, form, eventId, attendeeId) => {
    const error = verifyOrRedirect(
      form,
      data.attendee.name,
      `/admin/event/${eventId}/attendee/${attendeeId}/${action}`,
      "Attendee name",
      actionLabel,
    );
    if (error) return error;
    return handler(data, form, eventId, attendeeId);
  });
