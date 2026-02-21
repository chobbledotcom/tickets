/**
 * Shared admin utilities and types
 */

import { decryptAttendees, decryptAttendeesForTable } from "#lib/db/attendees.ts";
import { getEventWithAttendeesRaw } from "#lib/db/events.ts";
import type { Attendee, EventWithCount } from "#lib/types.ts";
import type { validateForm } from "#lib/forms.tsx";
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

/** Get the admin private key from session, throwing if unavailable */
export const requirePrivateKey = async (session: AuthSession): Promise<CryptoKey> => {
  const key = await getPrivateKey(session);
  if (!key) throw new Error("Private key unavailable for session");
  return key;
};

/** Handler that receives a decrypted event with its attendees */
export type EventAttendeesHandler = (event: EventWithCount, attendees: Attendee[], session: AuthSession) => Response | Promise<Response>;

/** Decrypt strategy: full decrypts all fields, table skips unused contact fields */
export type DecryptMode = "full" | "table";

/**
 * Load event with decrypted attendees, returning 404 if not found.
 * Mode "full" decrypts all fields; "table" skips contact fields not in event config,
 * saving expensive RSA decryption operations per attendee.
 */
export const withDecryptedAttendees = async (
  session: AuthSession,
  eventId: number,
  handler: EventAttendeesHandler,
  mode: DecryptMode = "full",
): Promise<Response> => {
  const pk = await requirePrivateKey(session);
  const result = await getEventWithAttendeesRaw(eventId);
  if (!result) return notFoundResponse();
  const attendees = mode === "table"
    ? await decryptAttendeesForTable(result.attendeesRaw, pk, result.event.fields, result.event.unit_price !== null)
    : await decryptAttendees(result.attendeesRaw, pk);
  return handler(result.event, attendees, session);
};

/** Require auth then load event with decrypted attendees */
export const withEventAttendeesAuth = (
  request: Request,
  eventId: number,
  handler: EventAttendeesHandler,
  mode: DecryptMode = "full",
): Promise<Response> =>
  requireSessionOr(request, (session) => withDecryptedAttendees(session, eventId, handler, mode));
