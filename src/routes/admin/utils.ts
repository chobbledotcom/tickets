/**
 * Shared admin utilities and types
 */

import { decryptAttendees } from "#lib/db/attendees.ts";
import { getEventWithAttendeesRaw } from "#lib/db/events.ts";
import {
  getAttendeeAnswersBatch,
  getQuestionsWithEventIds,
} from "#lib/db/questions.ts";
import type { FormParams } from "#lib/form-data.ts";
import type { validateForm } from "#lib/forms.tsx";
import type { Attendee, EventWithCount } from "#lib/types.ts";
import {
  type AuthSession,
  encodeBody,
  errorRedirect,
  getPrivateKey,
  notFoundResponse,
  requireSessionOr,
  SessionKeyError,
} from "#routes/utils.ts";
import type { TableQuestionData } from "#templates/attendee-table.tsx";

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

/**
 * Verify a form confirmation field matches an expected value, or return an error redirect.
 * One function to handle all confirmation flows consistently:
 *   const error = verifyOrRedirect(form, event.name, "/admin/event/1/delete", "Event name", "deletion");
 *   if (error) return error;
 */
export const verifyOrRedirect = (
  form: FormParams,
  expected: string,
  redirectUrl: string,
  label = "Name",
  action?: string,
): Response | null => {
  if (!verifyIdentifier(expected, form.getString("confirm_identifier"))) {
    const suffix = action ? ` ${action}` : "";
    return errorRedirect(
      redirectUrl,
      `${label} does not match. Please type the exact ${label.toLowerCase()} to confirm${suffix}.`,
    );
  }
  return null;
};

/** Extract and validate ?date= query parameter. Returns null if absent or invalid. */
export const getDateFilter = (request: Request): string | null => {
  const date = new URL(request.url).searchParams.get("date");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return date;
};

/** Build a CSV file download response */
export const csvResponse = (csv: string, filename: string): Response =>
  new Response(encodeBody(csv), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });

/** Get the admin private key from session, throwing if unavailable */
export const requirePrivateKey = async (
  session: AuthSession,
): Promise<CryptoKey> => {
  const key = await getPrivateKey(session);
  if (!key) throw new SessionKeyError();
  return key;
};

/** Handler that receives a decrypted event with its attendees */
export type EventAttendeesHandler = (
  event: EventWithCount,
  attendees: Attendee[],
  session: AuthSession,
) => Response | Promise<Response>;

/**
 * Load event with decrypted attendees, returning 404 if not found.
 */
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

/** Require auth then load event with decrypted attendees */
export const withEventAttendeesAuth = (
  request: Request,
  eventId: number,
  handler: EventAttendeesHandler,
): Promise<Response> =>
  requireSessionOr(request, (session) =>
    withDecryptedAttendees(session, eventId, handler),
  );

/** Load question data for attendees across multiple events */
export const loadQuestionData = async (
  eventIds: number[],
  attendeeIds: number[],
): Promise<TableQuestionData | undefined> => {
  if (attendeeIds.length === 0 || eventIds.length === 0) return undefined;
  const [{ questions }, attendeeAnswerMap] = await Promise.all([
    getQuestionsWithEventIds(eventIds),
    getAttendeeAnswersBatch(attendeeIds),
  ]);
  return questions.length > 0 ? { questions, attendeeAnswerMap } : undefined;
};
