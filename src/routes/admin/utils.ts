/**
 * Shared admin utilities and types
 */

import { asString } from "#fp";
import { logActivity } from "#lib/db/activityLog.ts";
import { decryptAttendees } from "#lib/db/attendees.ts";
import { getEventWithAttendeesRaw } from "#lib/db/events.ts";
import {
  getAttendeeAnswersBatch,
  getQuestionsWithEventIds,
} from "#lib/db/questions.ts";
import { getFlash } from "#lib/flash-context.ts";
import type { FormParams } from "#lib/form-data.ts";
import type { validateForm } from "#lib/forms.tsx";
import type { Attendee, EventWithCount } from "#lib/types.ts";
import type { RouteHandlerFn } from "#routes/router.ts";
import {
  AUTH_FORM,
  AUTH_MULTIPART,
  type AuthSession,
  type EntityHandler,
  encodeBody,
  errorRedirect,
  getPrivateKey,
  htmlResponse,
  notFoundResponse,
  OWNER_FORM,
  OWNER_MULTIPART,
  redirect,
  requireOwnerOr,
  requireSessionOr,
  type SessionGuard,
  SessionKeyError,
  withAuth,
  withEntity,
} from "#routes/utils.ts";

export type { SessionGuard };

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

/**
 * Verify a JSON body confirmation field matches an expected value, or return an error message.
 * API-safe counterpart to verifyOrRedirect for JSON endpoints:
 *   const error = verifyIdentifierOrJsonError(event.name, body.confirm_identifier, "Event name");
 *   if (error) return errorResponse(error);
 */
export const verifyIdentifierOrJsonError = (
  expected: string,
  provided: unknown,
  label = "Name",
): string | null => {
  if (!verifyIdentifier(expected, asString(provided))) {
    return `${label} does not match. Please provide the exact ${label.toLowerCase()} in confirm_identifier.`;
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

/** Form guard: require auth + CSRF, call handler with session and form */
export type FormGuard<TSession> = (
  request: Request,
  handler: (
    session: TSession,
    form: FormParams,
  ) => Response | Promise<Response>,
) => Promise<Response>;

/** Auth option: string shorthand or explicit guard pair */
type AuthOption<TSession> =
  | "owner"
  | "any"
  | {
      requireSession: SessionGuard<TSession>;
      withForm: FormGuard<TSession>;
    };

/** Configuration for creating confirmed-action GET/POST handler pair */
export type ConfirmedHandlerConfig<T, TSession = AuthSession> = {
  /** Auth guards: "owner" | "any" shorthand, or explicit { requireSession, withForm } */
  auth?: AuthOption<TSession>;
  /** Route path pattern, e.g. "/admin/users/:id/delete" */
  path: string;
  /** Load the entity by ID (return null if not found) */
  load: (id: number, session: TSession) => Promise<T | null>;
  /** Render the confirmation page HTML */
  render: (
    model: T,
    session: TSession,
    error?: string,
  ) => string | Promise<string>;
  /** Extract the identifier the user must type to confirm */
  identifier: (model: T) => string | Promise<string>;
  /** Perform the confirmed action (e.g. deletion, deactivation) */
  onConfirm: (model: T, id: number, session: TSession) => Promise<void>;
  /** Where to redirect after success (string or function of model + id) */
  successRedirect: string | ((model: T, id: number) => string);
  /** Flash message shown after success */
  successMessage: string;
  /** Human-readable label for the identifier field (e.g. "Username") */
  identifierLabel: string;
  /** Action label for the verification prompt (default "deletion") */
  actionLabel?: string;
  /** Optional pre-validation before loading (e.g. self-delete check) */
  preValidate?: (
    id: number,
    session: TSession,
  ) => Response | null | Promise<Response | null>;
  /** Optional custom not-found handler (defaults to 404 page) */
  onNotFound?: (id: number, session: TSession) => Response | Promise<Response>;
};

/** Return type of createConfirmedHandlers */
export type ConfirmedHandlers = {
  get: (request: Request, id: number) => Promise<Response>;
  post: (request: Request, id: number) => Promise<Response>;
  /** Pre-built route entries ready to spread into a route definition */
  routes: Record<string, RouteHandlerFn>;
};

/** Resolve auth option to concrete guard functions */
const resolveAuth = <TSession>(
  auth: AuthOption<TSession> | undefined,
): {
  requireSession: SessionGuard<TSession>;
  withForm: FormGuard<TSession>;
} => {
  if (typeof auth === "object") return auth;
  const isOwner = auth !== "any";
  return {
    requireSession: (isOwner
      ? requireOwnerOr
      : requireSessionOr) as SessionGuard<TSession>,
    withForm: ((
      r: Request,
      h: (...args: never[]) => Response | Promise<Response>,
    ) =>
      withAuth(
        r,
        isOwner ? OWNER_FORM : AUTH_FORM,
        h as Parameters<typeof withAuth>[2],
      )) as FormGuard<TSession>,
  };
};

/**
 * Create a pair of GET (confirmation page) and POST (execute action) handlers
 * for resources that need typed-identifier confirmation.
 */
export const createConfirmedHandlers = <T, TSession = AuthSession>(
  config: ConfirmedHandlerConfig<T, TSession>,
): ConfirmedHandlers => {
  const notFound = (id: number, session: TSession) =>
    config.onNotFound ? config.onNotFound(id, session) : notFoundResponse();
  const { requireSession, withForm } = resolveAuth(config.auth);
  const actionLabel = config.actionLabel ?? "deletion";
  const resolveRedirect = (model: T, id: number) =>
    typeof config.successRedirect === "function"
      ? config.successRedirect(model, id)
      : config.successRedirect;
  const confirmPath = (id: number) => config.path.replace(/:(\w+)/, String(id));

  const validate = (id: number, session: TSession) =>
    config.preValidate ? config.preValidate(id, session) : null;

  const loadOrNotFound = async (id: number, session: TSession) => {
    const model = await config.load(id, session);
    return model ?? notFound(id, session);
  };

  const get = (request: Request, id: number): Promise<Response> =>
    requireSession(request, async (session) => {
      const rejection = await validate(id, session);
      if (rejection) return rejection;
      const result = await loadOrNotFound(id, session);
      if (result instanceof Response) return result;
      const flash = getFlash();
      return htmlResponse(await config.render(result, session, flash.error));
    });

  const post = (request: Request, id: number): Promise<Response> =>
    withForm(request, async (session, form) => {
      const result = await loadOrNotFound(id, session);
      if (result instanceof Response) return result;

      const rejection = await validate(id, session);
      if (rejection) return rejection;

      const expected = await config.identifier(result);
      const error = verifyOrRedirect(
        form,
        expected,
        confirmPath(id),
        config.identifierLabel,
        actionLabel,
      );
      if (error) return error;

      await config.onConfirm(result, id, session);
      return redirect(resolveRedirect(result, id), config.successMessage, true);
    });

  // Extract param name from path pattern for route handlers
  const paramName = config.path.match(/:(\w+)/)!.at(1)!;
  const toRoute =
    (fn: (req: Request, id: number) => Promise<Response>): RouteHandlerFn =>
    (req, params) =>
      fn(req, params[paramName] as number);

  return {
    get,
    post,
    routes: {
      [`GET ${config.path}`]: toRoute(get),
      [`POST ${config.path}`]: toRoute(post),
    },
  };
};

/**
 * Curried factory: creates a wrapper that takes load params, then a handler.
 * Eliminates the boilerplate of writing `(params, handler) => withEntity(handler)(() => loadFn(params))`.
 */
export const withEntityLoader =
  <T, P extends unknown[]>(load: (...args: P) => Promise<T | null>) =>
  (...args: P) =>
  (handler: EntityHandler<T>): Promise<Response> =>
    withEntity(handler)(() => load(...args));

/**
 * Generic wrapper for typed route params: parse param as number, load entity,
 * return 404 if missing, otherwise call handler.
 */
export const withEntityFromParam = <T>(
  paramValue: string | number | undefined,
  load: (id: number) => Promise<T | null>,
  handler: EntityHandler<T>,
): Promise<Response> => {
  const id =
    typeof paramValue === "string"
      ? Number.parseInt(paramValue, 10)
      : paramValue;
  if (id === undefined || Number.isNaN(id))
    return Promise.resolve(notFoundResponse());
  return withEntity(handler)(() => load(id!));
};

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
