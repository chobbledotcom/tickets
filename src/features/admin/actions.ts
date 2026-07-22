/**
 * Action handlers and data loading utilities for admin routes
 */

/* jscpd:ignore-start */
import type { AuthSession } from "#routes/auth.ts";
import {
  AUTH_FORM,
  AUTH_MULTIPART,
  OWNER_FORM,
  OWNER_MULTIPART,
  requireSessionOr,
  withAuth,
} from "#routes/auth.ts";
import {
  encodeBody,
  errorRedirect,
  notFoundResponse,
  redirect,
} from "#routes/response.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { decryptAttendees } from "#shared/db/attendees/pii.ts";
import {
  getAttendeeKindsByIds,
  getAttendeeNamesByIds,
} from "#shared/db/attendees/queries.ts";
import { getListingWithAttendeesRaw } from "#shared/db/listings/attendees.ts";
import { errorMessage } from "#shared/error-message.ts";
import type { FormParams } from "#shared/form-data.ts";
import type { ResponseHandler } from "#shared/response-steps.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import type { Attendee, ListingWithCount } from "#shared/types.ts";
import { isIsoDate, isIsoMonth } from "#shared/validation/date.ts";
/* jscpd:ignore-end */

/** Extract and validate ?date= query parameter. Returns null if absent or invalid. */
export const getDateFilter = (request: Request): string | null => {
  const date = new URL(request.url).searchParams.get("date");
  return date && isIsoDate(date) ? date : null;
};

/** Extract and validate ?cal= month parameter (YYYY-MM). Returns null if absent or invalid. */
export const getMonthFilter = (request: Request): string | null => {
  const month = new URL(request.url).searchParams.get("cal");
  return month && isIsoMonth(month) ? month : null;
};

/** Build a CSV file download response */
export const csvResponse = (csv: string, filename: string): Response =>
  new Response(encodeBody(csv), {
    headers: {
      "content-disposition": `attachment; filename="${filename}"`,
      "content-type": "text/csv; charset=utf-8",
    },
  });

/**
 * Bounded attendee id → name lookup for link labels (activity log, ledger). The
 * current request's private key is unwrapped only when at least one attendee is
 * actually referenced, so a system-only page never forces a key derivation. A
 * deleted attendee's id simply has no entry — it renders as plain text, no link.
 */
export const loadAttendeeNames = async (
  attendeeIds: number[],
): Promise<Map<number, string>> => {
  if (attendeeIds.length === 0) return new Map();
  const key = await requireRequestPrivateKey();
  return getAttendeeNamesByIds(attendeeIds, key);
};

export type AttendeeLinkRefs = {
  kinds: Map<number, string>;
  names: Map<number, string>;
};

export const loadAttendeeLinkRefs = async (
  attendeeIds: number[],
): Promise<AttendeeLinkRefs> => {
  if (attendeeIds.length === 0) {
    return { kinds: new Map(), names: new Map() };
  }
  const key = await requireRequestPrivateKey();
  const [names, kinds] = await Promise.all([
    getAttendeeNamesByIds(attendeeIds, key),
    getAttendeeKindsByIds(attendeeIds),
  ]);
  return { kinds, names };
};

/** Handler that receives a decrypted listing with its attendees */
export type ListingAttendeesHandler = ResponseHandler<
  [listing: ListingWithCount, attendees: Attendee[], session: AuthSession]
>;

/**
 * Load listing with decrypted attendees, returning 404 if not found.
 */
export const withDecryptedAttendees = async (
  session: AuthSession,
  listingId: number,
  handler: ListingAttendeesHandler,
): Promise<Response> => {
  const pk = await requireRequestPrivateKey();
  const result = await getListingWithAttendeesRaw(listingId);
  if (!result) return notFoundResponse();
  const attendees = await decryptAttendees(result.attendeesRaw, pk);
  return handler(result.listing, attendees, session);
};

/** Require auth then load listing with decrypted attendees */
export const withListingAttendeesAuth = (
  request: Request,
  listingId: number,
  handler: ListingAttendeesHandler,
): Promise<Response> =>
  requireSessionOr(request, (session) =>
    withDecryptedAttendees(session, listingId, handler),
  );

/** Curried: require auth then load listing with decrypted attendees */
export const listingAttendeesLoader =
  (request: Request, listingId: number) =>
  (handler: ListingAttendeesHandler): Promise<Response> =>
    withListingAttendeesAuth(request, listingId, handler);

/** Error mapping: convert an Error into a redirect response */
export type ErrorMapper = (error: Error) => Response;

/** A string given directly, or computed from the session and the submitted form
 * (and allowed to be async). Used for the flash/log message. */
/** A value that is either a ready `string`, or a `(session, form)` function
 * that computes one. `Result` is what the function returns — a bare/awaitable
 * string for a required value, or `string | undefined` when it may supply
 * nothing. The ready form is always a plain `string`. */
type SessionFormValue<TSession, Result> =
  | string
  | ((session: TSession, form: FormParams) => Result);

type SessionFormString<TSession> = SessionFormValue<
  TSession,
  string | Promise<string>
>;

type SessionFormOptionalString<TSession> = SessionFormValue<
  TSession,
  string | undefined
>;

/** Configuration for createActionHandler */
export type ActionHandlerConfig<TSession = AuthSession> = {
  /** Auth mode: "owner" requires owner role, "any" allows any authenticated user */
  auth: "owner" | "any";
  /** CSRF body mode: "form" (default) or "multipart" */
  bodyMode?: "form" | "multipart";
  /** Executor: receives session and parsed form, returns nothing on success */
  execute: (session: TSession, form: FormParams) => Promise<void>;
  /** Optional listing/resource id for activity logging context */
  listingId?: number | ((form: FormParams) => number | undefined);
  /** Message used for both flash and activity log */
  message: SessionFormString<TSession>;
  /** Redirect URL on success */
  successRedirect: string | ((session: TSession, form: FormParams) => string);
  /** Optional custom error mapping (falls back to errorRedirect with message) */
  onError?: ErrorMapper;
  /** Thunk returning a Set-Cookie header for the success redirect, evaluated per request (e.g. clearSessionCookie) */
  cookie?: () => string;
  /** Secret to redact from the activity log (e.g. API key shown in flash but not logged) */
  redactedSecret?: SessionFormOptionalString<TSession>;
};

/** Run the configured action and turn only its failure into the route's error
 * response. Later message and activity-log failures still propagate. */
const executeActionOrError = async <TSession>(
  execute: ActionHandlerConfig<TSession>["execute"],
  onError: ErrorMapper | undefined,
  session: TSession,
  form: FormParams,
  redirectUrl: string,
): Promise<Response | null> => {
  try {
    await execute(session, form);
    return null;
  } catch (caught) {
    const error =
      caught instanceof Error ? caught : new Error(errorMessage(caught));
    return onError ? onError(error) : errorRedirect(redirectUrl, error.message);
  }
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

  const resolveListingId = (form: FormParams): number | undefined => {
    if (config.listingId === undefined) return;
    return typeof config.listingId === "function"
      ? config.listingId(form)
      : config.listingId;
  };

  // A field on the config is either a ready value or a function of the session
  // and form (possibly async). Resolving one means: call it when it's a
  // function, otherwise use it as-is.
  type Resolvable<T> =
    | T
    | ((session: TSession, form: FormParams) => T | Promise<T>);

  const resolveValue = async <T>(
    value: Resolvable<T>,
    session: TSession,
    form: FormParams,
  ): Promise<T> =>
    typeof value === "function"
      ? await (
          value as (session: TSession, form: FormParams) => T | Promise<T>
        )(session, form)
      : value;

  const resolveString = (
    value: SessionFormString<TSession>,
    session: TSession,
    form: FormParams,
  ): Promise<string> => resolveValue<string>(value, session, form);

  const resolveOptionalString = (
    value: SessionFormOptionalString<TSession> | undefined,
    session: TSession,
    form: FormParams,
  ): Promise<string | undefined> =>
    // A blank string or an absent value both mean "no secret to redact".
    value
      ? resolveValue<string | undefined>(value, session, form)
      : Promise.resolve(undefined);

  return (request: Request) => {
    // Evaluate the cookie thunk per request so domain-dependent state (e.g.
    // __Host- prefix) is resolved at request time, not module load time.
    const successOpts = config.cookie ? { cookie: config.cookie() } : undefined;
    return withAuth(request, policy, async (session, body) => {
      const form = body as FormParams;
      // The success redirect depends only on the session and form (never on
      // what execute did), so resolve it once and reuse it on both the error
      // and success paths.
      const redirectUrl = await resolveString(
        config.successRedirect,
        session as TSession,
        form,
      );
      const errorResponse = await executeActionOrError(
        config.execute,
        config.onError,
        session as TSession,
        form,
        redirectUrl,
      );
      if (errorResponse) return errorResponse;

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
      await logActivity(logMsg, resolveListingId(form));

      return redirect(redirectUrl, msg, true, successOpts);
    });
  };
};
