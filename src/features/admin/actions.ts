/**
 * Action handlers and data loading utilities for admin routes
 */

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
import {
  decryptAttendees,
  getAttendeeKindsByIds,
  getAttendeeNamesByIds,
} from "#shared/db/attendees.ts";
import { getListingWithAttendeesRaw } from "#shared/db/listings.ts";
import type { FormParams } from "#shared/form-data.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import type { Attendee, ListingWithCount } from "#shared/types.ts";
import { isIsoDate } from "#shared/validation/date.ts";

/** Extract and validate ?date= query parameter. Returns null if absent or invalid. */
export const getDateFilter = (request: Request): string | null => {
  const date = new URL(request.url).searchParams.get("date");
  return date && isIsoDate(date) ? date : null;
};

/** Extract and validate ?cal= month parameter (YYYY-MM). Returns null if absent or invalid. */
export const getMonthFilter = (request: Request): string | null => {
  const month = new URL(request.url).searchParams.get("cal");
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return null;
  return month;
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
export type ListingAttendeesHandler = (
  listing: ListingWithCount,
  attendees: Attendee[],
  session: AuthSession,
) => Response | Promise<Response>;

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

  const resolveListingId = (form: FormParams): number | undefined => {
    if (config.listingId === undefined) return undefined;
    return typeof config.listingId === "function"
      ? config.listingId(form)
      : config.listingId;
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
      await logActivity(logMsg, resolveListingId(form));

      const redirectUrl = await resolveString(
        config.successRedirect,
        session as TSession,
        form,
      );
      return redirect(redirectUrl, msg, true);
    });
};
