/**
 * Shared utilities for route handlers
 */

import { compact, err, map, ok, pipe, type Result, reduce } from "#fp";
import {
  generateSecureToken,
  getPrivateKeyFromSession,
} from "#lib/crypto.ts";
import { signCsrfToken, verifySignedCsrfToken } from "#lib/csrf.ts";
import { getEventWithCount, getEventWithCountBySlug } from "#lib/db/events.ts";
import { getSessionCookieName } from "#lib/cookies.ts";
import { deleteSession, getSession } from "#lib/db/sessions.ts";
import { getWrappedPrivateKey } from "#lib/db/settings.ts";
import { decryptAdminLevel, getUserById } from "#lib/db/users.ts";
import { ErrorCode, logError } from "#lib/logger.ts";
import { nowMs } from "#lib/now.ts";
import type { AdminLevel, AdminSession, EventWithCount } from "#lib/types.ts";
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
  const token = cookies.get(getSessionCookieName());
  if (!token) return null;

  const session = await getSession(token);
  if (!session) return null;

  if (session.expires < nowMs()) {
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

  const adminLevel = await decryptAdminLevel(user);
  const csrfToken = await signCsrfToken();

  return {
    token,
    csrfToken,
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
  session: { token: string; wrappedDataKey: string | null },
): Promise<CryptoKey | null> => {
  if (!session.wrappedDataKey) return null;

  const wrappedPrivateKey = await getWrappedPrivateKey();
  if (!wrappedPrivateKey) return null;

  try {
    return await getPrivateKeyFromSession(session.token, session.wrappedDataKey, wrappedPrivateKey);
  } catch {
    return null;
  }
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
  const headers: HeadersInit = {
    location: url,
    "content-type": "text/html; charset=utf-8",
  };
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
 * Extract text fields from FormData as URLSearchParams (skips File entries).
 * Handles multi-value fields (e.g. checkbox groups) via append.
 */
export const formDataToParams = (formData: FormData): URLSearchParams => {
  const params = new URLSearchParams();
  for (const [key, value] of formData.entries()) {
    if (typeof value === "string") params.append(key, value);
  }
  return params;
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
  headers.append("set-cookie", cookie);
  return new Response(response.body, { status: response.status, headers });
};

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
 * Curried event page GET handler: renderPage -> (request, { id }) -> Response.
 * Combines session auth + event fetch + HTML rendering.
 */
export const withEventPage =
  (
    renderPage: (event: EventWithCount, session: AdminSession) => string,
  ): ((request: Request, params: { id: number }) => Promise<Response>) =>
  (request, { id }) =>
    requireSessionOr(request, (session) =>
      withEvent(id, (event) =>
        htmlResponse(renderPage(event, session)),
      ),
    );

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
  event.closes_at !== null && new Date(event.closes_at).getTime() < nowMs();

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
  const diffMs = new Date(closesAt).getTime() - nowMs();
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

/** CSRF form result type */
export type CsrfFormResult =
  | { ok: true; form: URLSearchParams }
  | { ok: false; response: Response };

/**
 * Parse form with CSRF validation.
 * Verifies the form token's HMAC signature and expiry.
 */
export const requireCsrfForm = async (
  request: Request,
  onInvalid: (newToken: string) => Response,
): Promise<CsrfFormResult> => {
  const form = await parseFormData(request);
  const formCsrf = form.get("csrf_token") || "";

  if (formCsrf && await verifySignedCsrfToken(formCsrf)) {
    return { ok: true, form };
  }

  const newToken = await signCsrfToken();
  return { ok: false, response: onInvalid(newToken) };
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
  if (!await verifySignedCsrfToken(csrfToken)) {
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

/** Handler function that receives session and multipart FormData */
type MultipartFormHandler = (session: AuthSession, formData: FormData) => Response | Promise<Response>;

/**
 * Handle multipart form request with auth + CSRF validation.
 * Parses request body as FormData (multipart/form-data) instead of URLSearchParams.
 */
export const withAuthMultipartForm = async (
  request: Request,
  handler: MultipartFormHandler,
): Promise<Response> => {
  const session = await getAuthenticatedSession(request);
  if (!session) return redirect("/admin");

  const formData = await request.formData();
  const csrfToken = String(formData.get("csrf_token") ?? "");
  if (!await verifySignedCsrfToken(csrfToken)) {
    return htmlResponse("Invalid CSRF token", 403);
  }

  return handler(session, formData);
};

/** Create JSON response */
export const jsonResponse = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

type JsonHandler = (session: AuthSession, body: Record<string, unknown>) => Response | Promise<Response>;

/**
 * Handle JSON API request with auth + CSRF validation (from x-csrf-token header).
 * Mirrors withAuthForm but for JSON endpoints.
 * Content-type is already validated by middleware.
 */
export const withAuthJson = async (request: Request, handler: JsonHandler): Promise<Response> => {
  const session = await getAuthenticatedSession(request);
  if (!session) return jsonResponse({ status: "error", message: "Not authenticated" }, 401);

  const csrfHeader = request.headers.get("x-csrf-token") ?? "";
  if (!await verifySignedCsrfToken(csrfHeader)) {
    logError({ code: ErrorCode.AUTH_CSRF_MISMATCH, detail: "JSON API" });
    return jsonResponse({ status: "error", message: "Forbidden" }, 403);
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    logError({ code: ErrorCode.VALIDATION_FORM, detail: "Malformed JSON body" });
    return jsonResponse({ status: "error", message: "Invalid request body" }, 400);
  }

  return handler(session, body);
};
