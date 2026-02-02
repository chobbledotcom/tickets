/**
 * Shared utilities for route handlers
 */

import { compact, err, map, ok, pipe, type Result, reduce } from "#fp";
import {
  constantTimeEqual,
  generateSecureToken,
  getPrivateKeyFromSession,
} from "#lib/crypto.ts";
import { getEventWithCount, getEventWithCountBySlug } from "#lib/db/events.ts";
import { deleteSession, getSession } from "#lib/db/sessions.ts";
import { getWrappedPrivateKey } from "#lib/db/settings.ts";
import { decryptAdminLevel, getUserById } from "#lib/db/users.ts";
import { ErrorCode, logError } from "#lib/logger.ts";
import type { AdminLevel, EventWithCount } from "#lib/types.ts";
import type { ServerContext } from "#routes/types.ts";
import { paymentErrorPage } from "#templates/payment.tsx";
import { notFoundPage } from "#templates/public.tsx";

// Re-export for use by other route modules
export { generateSecureToken };

/**
 * Get client IP from request
 * Note: This server runs directly on edge, not behind a proxy,
 * so we use the direct connection IP from the server context.
 */
export const getClientIp = (
  request: Request,
  server?: ServerContext,
): string => {
  // Use server.requestIP() if available
  if (server?.requestIP) {
    const info = server.requestIP(request);
    if (info?.address) {
      return info.address;
    }
  }
  // Fallback for testing or when server context not available
  return "direct";
};

/**
 * Parse cookies from request
 */
export const parseCookies = (request: Request): Map<string, string> => {
  const header = request.headers.get("cookie");
  if (!header) return new Map<string, string>();

  type CookiePair = [string, string];
  const toPair = (part: string): CookiePair | null => {
    const [key, value] = part.trim().split("=");
    return key && value ? [key, value] : null;
  };

  return pipe(
    map(toPair),
    compact,
    reduce((acc, [key, value]) => {
      acc.set(key, value);
      return acc;
    }, new Map<string, string>()),
  )(header.split(";"));
};

/**
 * Get authenticated session if valid
 * Returns null if not authenticated
 * Includes wrapped_data_key for deriving the private key when needed
 * Loads user info and decrypts admin_level for role checking
 *
 * Validates that wrapped_data_key can be unwrapped with current DB_ENCRYPTION_KEY.
 * If unwrapping fails (e.g., after key rotation), the session is invalidated.
 */
export const getAuthenticatedSession = async (
  request: Request,
): Promise<AuthSession | null> => {
  const cookies = parseCookies(request);
  const token = cookies.get("__Host-session");
  if (!token) return null;

  const session = await getSession(token);
  if (!session) return null;

  if (session.expires < Date.now()) {
    await deleteSession(token);
    return null;
  }

  // Load user and decrypt admin level
  const user = await getUserById(session.user_id);
  if (!user) {
    logError({
      code: ErrorCode.AUTH_INVALID_SESSION,
      detail: "Session references non-existent user, invalidating",
    });
    await deleteSession(token);
    return null;
  }

  const adminLevel = await decryptAdminLevel(user) as AdminLevel;

  return {
    token,
    csrfToken: session.csrf_token,
    wrappedDataKey: session.wrapped_data_key,
    userId: session.user_id,
    adminLevel,
  };
};

/**
 * Get private key for decrypting attendee PII from an authenticated session
 * Returns null if session doesn't have wrapped_data_key
 */
export const getPrivateKey = async (
  token: string,
  wrappedDataKey: string | null,
): Promise<CryptoKey | null> => {
  if (!wrappedDataKey) return null;

  const wrappedPrivateKey = await getWrappedPrivateKey();
  if (!wrappedPrivateKey) return null;

  try {
    return await getPrivateKeyFromSession(token, wrappedDataKey, wrappedPrivateKey);
  } catch {
    return null;
  }
};

/**
 * Validate CSRF token using constant-time comparison
 */
export const validateCsrfToken = (
  expected: string,
  actual: string,
): boolean => {
  return constantTimeEqual(expected, actual);
};

/**
 * Create HTML response
 */
export const htmlResponse = (html: string, status = 200): Response =>
  new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });

/**
 * Create 404 not found response
 */
export const notFoundResponse = (): Response =>
  htmlResponse(notFoundPage(), 404);

/**
 * Create payment error response
 */
export const paymentErrorResponse = (message: string, status = 400): Response =>
  htmlResponse(paymentErrorPage(message), status);

/**
 * Create redirect response
 */
export const redirect = (url: string, cookie?: string): Response => {
  const headers: HeadersInit = { location: url };
  if (cookie) {
    headers["set-cookie"] = cookie;
  }
  return new Response(null, { status: 302, headers });
};

/**
 * Create redirect response with a success message as query parameter (PRG pattern)
 */
export const redirectWithSuccess = (basePath: string, message: string): Response =>
  redirect(`${basePath}?success=${encodeURIComponent(message)}`);

/**
 * Parse form data from request
 */
export const parseFormData = async (
  request: Request,
): Promise<URLSearchParams> => {
  const text = await request.text();
  return new URLSearchParams(text);
};

/**
 * Get base URL from request
 */
export const getBaseUrl = (request: Request): string => {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
};

/**
 * Normalize path by stripping trailing slashes (except root "/")
 * This allows consistent path comparisons like "/admin" instead of checking both "/admin" and "/admin/"
 */
export const normalizePath = (path: string): string =>
  path !== "/" && path.endsWith("/") ? path.slice(0, -1) : path;

/**
 * Parse request URL and extract path/method
 * Paths are normalized to strip trailing slashes
 */
export const parseRequest = (
  request: Request,
): { url: URL; path: string; method: string } => {
  const url = new URL(request.url);
  return { url, path: normalizePath(url.pathname), method: request.method };
};

/**
 * Get search param from request URL
 */
export const getSearchParam = (
  request: Request,
  key: string,
): string | null => {
  const url = new URL(request.url);
  return url.searchParams.get(key);
};

/**
 * Add cookie header to response
 */
export const withCookie = (response: Response, cookie: string): Response => {
  const headers = new Headers(response.headers);
  headers.set("set-cookie", cookie);
  return new Response(response.body, { status: response.status, headers });
};

/**
 * Create HTML response with cookie - curried composition of withCookie and htmlResponse
 * Usage: htmlResponseWithCookie(cookie)(html, status)
 */
export const htmlResponseWithCookie =
  (cookie: string) =>
  (html: string, status = 200): Response =>
    withCookie(htmlResponse(html, status), cookie);

/** Handler function that takes a value and returns a Response */
type EventHandler = (event: EventWithCount) => Response | Promise<Response>;

/**
 * Unwrap Result with handler - returns error response or applies handler to value
 */
const unwrapResult = (
  result: Result<EventWithCount>,
  handler: EventHandler,
): Promise<Response> | Response =>
  result.ok ? handler(result.value) : result.response;

/**
 * Fetch event or return 404 response
 */
export const fetchEventOr404 = async (
  eventId: number,
): Promise<Result<EventWithCount>> => {
  const event = await getEventWithCount(eventId);
  return event ? ok(event) : err(notFoundResponse());
};

/**
 * Handle event with Result - unwrap to Response
 */
export const withEvent = async (
  eventId: number,
  handler: EventHandler,
): Promise<Response> => unwrapResult(await fetchEventOr404(eventId), handler);

/**
 * Fetch event by slug or return 404 response.
 */
export const fetchEventBySlugOr404 = async (
  slug: string,
): Promise<Result<EventWithCount>> => {
  const event = await getEventWithCountBySlug(slug);
  return event ? ok(event) : err(notFoundResponse());
};

/**
 * Handle event by slug with Result - unwrap to Response
 */
export const withEventBySlug = async (
  slug: string,
  handler: EventHandler,
): Promise<Response> =>
  unwrapResult(await fetchEventBySlugOr404(slug), handler);

/** Check if event is active, return 404 if not */
const requireActiveEvent =
  (handler: (event: EventWithCount) => Response | Promise<Response>) =>
  (event: EventWithCount): Response | Promise<Response> =>
    event.active === 1 ? handler(event) : notFoundResponse();

/** Handle event by slug with active check - return 404 if not found or inactive */
export const withActiveEventBySlug = (
  slug: string,
  fn: (event: EventWithCount) => Response | Promise<Response>,
): Promise<Response> => withEventBySlug(slug, requireActiveEvent(fn));

/** Check if an event's registration period has closed */
export const isRegistrationClosed = (event: { closes_at: string | null }): boolean =>
  event.closes_at !== null && new Date(event.closes_at).getTime() < Date.now();

/** Create a formatter for attendee creation failures (capacity_exceeded / encryption_error) */
export const formatCreationError =
  (
    capacityMsg: string,
    capacityMsgWithName: (name: string) => string,
    fallbackMsg: string,
  ) =>
  (reason: "capacity_exceeded" | "encryption_error", eventName?: string): string =>
    reason === "capacity_exceeded"
      ? eventName ? capacityMsgWithName(eventName) : capacityMsg
      : fallbackMsg;

/** Format a countdown from now to a future closes_at date, e.g. "3 days and 5 hours from now" */
export const formatCountdown = (closesAt: string): string => {
  const diffMs = new Date(closesAt).getTime() - Date.now();
  if (diffMs <= 0) return "closed";
  const totalHours = Math.floor(diffMs / (1000 * 60 * 60));
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const pl = (n: number, unit: string) => `${n} ${unit}${n !== 1 ? "s" : ""}`;
  if (days > 0 && hours > 0) return `${pl(days, "day")} and ${pl(hours, "hour")} from now`;
  if (days > 0) return `${pl(days, "day")} from now`;
  if (hours > 0) return `${pl(hours, "hour")} from now`;
  return `${pl(Math.max(1, Math.floor(diffMs / (1000 * 60))), "minute")} from now`;
};

/** Session with CSRF token, wrapped data key for private key derivation, and user role */
export type AuthSession = {
  token: string;
  csrfToken: string;
  wrappedDataKey: string | null;
  userId: number;
  adminLevel: AdminLevel;
};

/**
 * Handle request with authenticated session
 */
export const withSession = async (
  request: Request,
  handler: (session: AuthSession) => Response | Promise<Response>,
  onNoSession: () => Response | Promise<Response>,
): Promise<Response> => {
  const session = await getAuthenticatedSession(request);
  return session ? handler(session) : onNoSession();
};

/**
 * Handle request requiring session - redirect to /admin/ if not authenticated
 */
export const requireSessionOr = (
  request: Request,
  handler: (session: AuthSession) => Response | Promise<Response>,
): Promise<Response> => withSession(request, handler, () => redirect("/admin"));

/** Check owner role, return 403 if not owner */
const requireOwnerRole = (
  session: AuthSession,
  handler: (session: AuthSession) => Response | Promise<Response>,
): Response | Promise<Response> =>
  session.adminLevel === "owner" ? handler(session) : htmlResponse("Forbidden", 403);

/** CSRF form result type (for public forms using double-submit cookie) */
export type CsrfFormResult =
  | { ok: true; form: URLSearchParams }
  | { ok: false; response: Response };

/** Default cookie name for public form CSRF tokens */
const DEFAULT_CSRF_COOKIE = "csrf_token";

/** Generate CSRF cookie string */
export const csrfCookie = (token: string, path: string, cookieName = DEFAULT_CSRF_COOKIE): string =>
  `${cookieName}=${token}; HttpOnly; Secure; SameSite=Strict; Path=${path}; Max-Age=3600`;

/**
 * Parse form with CSRF validation (double-submit cookie pattern)
 * This is the integral CSRF check - you cannot get form data without validating CSRF
 */
export const requireCsrfForm = async (
  request: Request,
  onInvalid: (newToken: string) => Response,
  cookieName = DEFAULT_CSRF_COOKIE,
): Promise<CsrfFormResult> => {
  const cookies = parseCookies(request);
  const cookieCsrf = cookies.get(cookieName) || "";
  const form = await parseFormData(request);
  const formCsrf = form.get("csrf_token") || "";

  if (!cookieCsrf || !formCsrf || !validateCsrfToken(cookieCsrf, formCsrf)) {
    const newToken = generateSecureToken();
    return { ok: false, response: onInvalid(newToken) };
  }

  return { ok: true, form };
};

/** Auth form result type */
export type AuthFormResult =
  | { ok: true; session: AuthSession; form: URLSearchParams }
  | { ok: false; response: Response };

/**
 * Require authenticated session with parsed form and validated CSRF
 */
export const requireAuthForm = async (
  request: Request,
): Promise<AuthFormResult> => {
  const session = await getAuthenticatedSession(request);
  if (!session) {
    return { ok: false, response: redirect("/admin") };
  }

  const form = await parseFormData(request);
  const csrfToken = form.get("csrf_token") || "";
  if (!validateCsrfToken(session.csrfToken, csrfToken)) {
    return { ok: false, response: htmlResponse("Invalid CSRF token", 403) };
  }

  return { ok: true, session, form };
};

type FormHandler = (session: AuthSession, form: URLSearchParams) => Response | Promise<Response>;
type SessionHandler = (session: AuthSession) => Response | Promise<Response>;

/** Unwrap an AuthFormResult, optionally checking role */
const handleAuthForm = async (
  request: Request,
  requiredRole: AdminLevel | null,
  handler: FormHandler,
): Promise<Response> => {
  const auth = await requireAuthForm(request);
  if (!auth.ok) return auth.response;
  if (requiredRole && auth.session.adminLevel !== requiredRole) {
    return htmlResponse("Forbidden", 403);
  }
  return handler(auth.session, auth.form);
};

/** Handle request with auth form - unwrap AuthFormResult */
export const withAuthForm = (request: Request, handler: FormHandler): Promise<Response> =>
  handleAuthForm(request, null, handler);

/** Require owner role - returns 403 if not owner, redirect if not authenticated */
export const requireOwnerOr = (request: Request, handler: SessionHandler): Promise<Response> =>
  requireSessionOr(request, (session) => requireOwnerRole(session, handler));

/** Handle request with owner auth form - requires owner role + CSRF validation */
export const withOwnerAuthForm = (request: Request, handler: FormHandler): Promise<Response> =>
  handleAuthForm(request, "owner", handler);
