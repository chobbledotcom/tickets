/**
 * Action handlers and data loading utilities for admin routes
 */

import { logActivity } from "#lib/db/activityLog.ts";
import { decryptAttendees } from "#lib/db/attendees.ts";
import { getEventWithAttendeesRaw } from "#lib/db/events.ts";
import {
  getAttendeeAnswersBatch,
  getQuestionsWithEventIds,
} from "#lib/db/questions.ts";
import type { FormParams } from "#lib/form-data.ts";
import type { Attendee, EventWithCount } from "#lib/types.ts";
import type { AuthSession } from "#routes/auth.ts";
import {
  AUTH_FORM,
  AUTH_MULTIPART,
  getPrivateKey,
  OWNER_FORM,
  OWNER_MULTIPART,
  requireSessionOr,
  SessionKeyError,
  withAuth,
} from "#routes/auth.ts";
import {
  encodeBody,
  errorRedirect,
  notFoundResponse,
  redirect,
} from "#routes/response.ts";
import type { TableQuestionData } from "#templates/attendee-table.tsx";

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
      "content-disposition": `attachment; filename="${filename}"`,
      "content-type": "text/csv; charset=utf-8",
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

/** Curried: require auth then load event with decrypted attendees */
export const eventAttendeesLoader =
  (request: Request, eventId: number) =>
  (handler: EventAttendeesHandler): Promise<Response> =>
    withEventAttendeesAuth(request, eventId, handler);

/** Error mapping: convert an Error into a redirect response */
export type ErrorMapper = (error: Error) => Response;

/** Configuration for createActionHandler */
export type ActionHandlerConfig<TSession = AuthSession> = {
  /** Auth mode: "owner" requires owner role, "any" allows any authenticated user */
  auth: "owner" | "any";
  /** CSRF body mode: "form" (default) or "multipart" */
  bodyMode?: "form" | "multipart";
  /** Executor: receives session and parsed form, returns nothing on success */
  execute: (session: TSession, form: FormParams) => Promise<void>;
  /** Optional event/resource id for activity logging context */
  eventId?: number | ((form: FormParams) => number | undefined);
  /** Message used for both flash and activity log */
  message:
    | string
    | ((session: TSession, form: FormParams) => string | Promise<string>);
  /** Redirect URL on success */
  successRedirect: string | ((session: TSession, form: FormParams) => string);
  /** Optional custom error mapping (falls back to errorRedirect with message) */
  onError?: ErrorMapper;
  /** Secret to redact from the activity log (e.g. API key shown in flash but not logged) */
  redactedSecret?:
    | string
    | ((session: TSession, form: FormParams) => string | undefined);
};

/**
 * Composable factory for POST action handlers.
 * Encapsulates the common lifecycle: auth + CSRF, execute, log activity, redirect.
 */
export const createActionHandler = <TSession = AuthSession>(
  config: ActionHandlerConfig<TSession>,
): ((request: Request) => Promise<Response>) => {
  const policy =
    config.bodyMode === "multipart"
      ? config.auth === "owner"
        ? OWNER_MULTIPART
        : AUTH_MULTIPART
      : config.auth === "owner"
        ? OWNER_FORM
        : AUTH_FORM;

  const resolveEventId = (form: FormParams): number | undefined => {
    if (config.eventId === undefined) return undefined;
    return typeof config.eventId === "function"
      ? config.eventId(form)
      : config.eventId;
  };

  const resolveString = async (
    value:
      | string
      | ((session: TSession, form: FormParams) => string | Promise<string>),
    session: TSession,
    form: FormParams,
  ): Promise<string> =>
    typeof value === "function" ? await value(session, form) : value;

  const resolveOptionalString = async (
    value:
      | string
      | ((session: TSession, form: FormParams) => string | undefined)
      | undefined,
    session: TSession,
    form: FormParams,
  ): Promise<string | undefined> =>
    !value
      ? undefined
      : typeof value === "function"
        ? await value(session, form)
        : value;

  return (request: Request) =>
    withAuth(request, policy, async (session, body) => {
      const form = body as FormParams;
      try {
        await config.execute(session as TSession, form);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (config.onError) {
          return config.onError(error);
        }
        const redirectUrl = await resolveString(
          config.successRedirect,
          session as TSession,
          form,
        );
        return errorRedirect(redirectUrl, error.message);
      }

      const msg = await resolveString(
        config.message,
        session as TSession,
        form,
      );
      const secret = await resolveOptionalString(
        config.redactedSecret,
        session as TSession,
        form,
      );
      const logMsg = secret ? msg.replaceAll(secret, "***") : msg;
      await logActivity(logMsg, resolveEventId(form));

      const redirectUrl = await resolveString(
        config.successRedirect,
        session as TSession,
        form,
      );
      return redirect(redirectUrl, msg, true);
    });
};

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
  return questions.length > 0 ? { attendeeAnswerMap, questions } : undefined;
};
