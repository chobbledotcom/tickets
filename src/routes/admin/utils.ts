/**
 * Shared admin utilities and types
 */

import { decryptAttendees } from "#lib/db/attendees.ts";
import { getEventWithAttendeesRaw } from "#lib/db/events.ts";
import type { Attendee, EventWithCount } from "#lib/types.ts";
import type { validateForm } from "#lib/forms.tsx";
import type { RouteParams } from "#routes/router.ts";
import { type AuthSession, getPrivateKey, notFoundResponse, requireSessionOr } from "#routes/utils.ts";

/** Form field definition type */
export type FormFields = Parameters<typeof validateForm>[1];

/** Result of form validation with typed values */
export type ValidatedForm = ReturnType<typeof validateForm> & { valid: true };

/** Auth + form + validation result */
export type AuthValidationResult =
  | { ok: true; session: AuthSession; validation: ValidatedForm }
  | { ok: false; response: Response };

/** Cookie to clear admin session */
export const clearSessionCookie =
  "__Host-session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0";

/** Verify identifier matches for confirmation (case-insensitive, trimmed) */
export const verifyIdentifier = (expected: string, provided: string): boolean =>
  expected.trim().toLowerCase() === provided.trim().toLowerCase();

/** Extract and validate ?date= query parameter. Returns null if absent or invalid. */
export const getDateFilter = (request: Request): string | null => {
  const date = new URL(request.url).searchParams.get("date");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return date;
};

/** Build a CSV file download response */
export const csvResponse = (csv: string, filename: string): Response =>
  new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });

/** Parse event ID from params (route pattern guarantees :id exists as \d+) */
export const parseEventId = (params: RouteParams): number =>
  Number.parseInt(params.id!, 10);

/** Get the admin private key from session (non-null assertion — callers are inside authenticated handlers) */
export const requirePrivateKey = async (session: AuthSession): Promise<CryptoKey> =>
  (await getPrivateKey(session))!;

/** Handler that receives a decrypted event with its attendees */
type EventAttendeesHandler = (event: EventWithCount, attendees: Attendee[], session: AuthSession) => Response | Promise<Response>;

/** Load event with all decrypted attendees, returning 404 response if not found */
export const withDecryptedAttendees = async (
  session: AuthSession,
  eventId: number,
  handler: EventAttendeesHandler,
): Promise<Response> => {
  const pk = await requirePrivateKey(session);
  const result = await getEventWithAttendeesRaw(eventId);
  if (!result) return notFoundResponse();
  const attendees = await decryptAttendees(result.attendeesRaw, pk);
  return handler(result.event, attendees, session);
};

/** Require auth then load event with all decrypted attendees */
export const withEventAttendeesAuth = (
  request: Request,
  eventId: number,
  handler: EventAttendeesHandler,
): Promise<Response> =>
  requireSessionOr(request, (session) =>
    withDecryptedAttendees(session, eventId, handler));
