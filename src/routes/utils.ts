/**
 * Shared utilities for route handlers
 */

import { buildFlashCookie, getSessionCookieName } from "#lib/cookies.ts";
import {
  getPrivateKeyFromSession,
  unwrapKeyWithToken,
} from "#lib/crypto/keys.ts";
import { generateSecureToken } from "#lib/crypto/utils.ts";
import {
  CSRF_INVALID_FORM_MESSAGE,
  signCsrfToken,
  verifySignedCsrfToken,
} from "#lib/csrf.ts";
import { getApiKeyByToken, touchApiKeyLastUsed } from "#lib/db/api-keys.ts";
import { getEventWithCount } from "#lib/db/events.ts";
import { deleteSession, getSession } from "#lib/db/sessions.ts";
import { settings } from "#lib/db/settings.ts";
import { decryptAdminLevel, getUserById } from "#lib/db/users.ts";
import { getFlash } from "#lib/flash-context.ts";
import { FormParams } from "#lib/form-data.ts";
import { setFormError, setFormSuccess, setSavedFormData } from "#lib/forms.tsx";
import { appendIframeParam, getIframeMode } from "#lib/iframe.ts";
import { ErrorCode, getRequestId, logError } from "#lib/logger.ts";
import { nowMs } from "#lib/now.ts";
import { getCachedSession, setCachedSession } from "#lib/session-context.ts";
import type { AdminLevel, AdminSession, EventWithCount } from "#lib/types.ts";
import type { ServerContext } from "#routes/types.ts";
import { checkoutPopupPage, paymentErrorPage } from "#templates/payment.tsx";
import {
  notFoundPage,
  rateLimitedPage,
  temporaryErrorPage,
} from "#templates/public.tsx";

// Re-export for use by other route modules
export { generateSecureToken };

/** Thrown when a session's private key cannot be derived (e.g. wrappedDataKey missing or unwrap failure) */
export class SessionKeyError extends Error {
  constructor() {
    super("Private key unavailable for session");
  }
}

/**
 * Shared TextEncoder for pre-encoding string response bodies to Uint8Array.
 * Bunny Edge's runtime intermittently fails to decode JS string bodies
 * ("Unknown: error decoding response body"). Pre-encoding to bytes
 * bypasses the runtime's string-to-UTF8 path entirely.
 */
const encoder = new TextEncoder();
export const encodeBody = (text: string): ArrayBuffer =>
  encoder.encode(text).buffer as ArrayBuffer;

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

  const jar = new Map<string, string>();
  for (const part of header.split(";")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) continue;
    const key = part.slice(0, eqIdx).trim();
    const value = part.slice(eqIdx + 1).trim();
    if (key && value) jar.set(key, value);
  }
  return jar;
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
  const cached = getCachedSession();
  if (cached !== undefined) return cached;

  const cookies = parseCookies(request);
  const token = cookies.get(getSessionCookieName());
  if (!token) {
    setCachedSession(null);
    return null;
  }

  const session = await getSession(token);
  if (!session) {
    setCachedSession(null);
    return null;
  }

  if (session.expires < nowMs()) {
    await deleteSession(token);
    setCachedSession(null);
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
    setCachedSession(null);
    return null;
  }

  const adminLevel = await decryptAdminLevel(user);
  await signCsrfToken();

  const result: AuthSession = {
    adminLevel,
    token,
    userId: session.user_id,
    wrappedDataKey: session.wrapped_data_key,
  };
  setCachedSession(result);
  return result;
};

/**
 * Extract Bearer token from Authorization header.
 */
const getBearerToken = (request: Request): string | null => {
  const auth = request.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  return auth.slice(7);
};

/**
 * Authenticate via API key (Bearer token).
 * Returns an AuthSession (compatible with session-based auth) or null.
 * API key auth bypasses CSRF since the key itself is the secret.
 */
export const getAuthenticatedApiKey = async (
  request: Request,
): Promise<AuthSession | null> => {
  const token = getBearerToken(request);
  if (!token) return null;

  const apiKeyRow = await getApiKeyByToken(token);
  if (!apiKeyRow) {
    logError({
      code: ErrorCode.AUTH_INVALID_SESSION,
      detail: "Bearer token does not match any API key",
    });
    return null;
  }

  const user = await getUserById(apiKeyRow.user_id);
  if (!user) {
    logError({
      code: ErrorCode.AUTH_INVALID_SESSION,
      detail: "API key references non-existent user",
    });
    return null;
  }

  try {
    await unwrapKeyWithToken(apiKeyRow.wrapped_data_key, token);
  } catch {
    logError({
      code: ErrorCode.AUTH_INVALID_SESSION,
      detail: "API key wrapped data key corrupted",
    });
    return null;
  }

  // Re-wrap DATA_KEY with the token so getPrivateKey() works
  // (it expects token + wrappedDataKey in the same format as sessions)
  const wrappedDataKey = apiKeyRow.wrapped_data_key;

  const adminLevel = await decryptAdminLevel(user);

  // Fire-and-forget last_used update
  touchApiKeyLastUsed(apiKeyRow.id).catch(() => {});

  const result: AuthSession = {
    adminLevel,
    token,
    userId: apiKeyRow.user_id,
    wrappedDataKey,
  };
  setCachedSession(result);
  return result;
};

/**
 * Get private key for decrypting attendee PII from an authenticated session
 * Returns null if session doesn't have wrapped_data_key
 */
export const getPrivateKey = async (session: {
  token: string;
  wrappedDataKey: string | null;
}): Promise<CryptoKey | null> => {
  if (!session.wrappedDataKey) return null;

  if (!settings.wrappedPrivateKey) return null;

  try {
    return await getPrivateKeyFromSession(
      session.token,
      session.wrappedDataKey,
      settings.wrappedPrivateKey,
    );
  } catch {
    return null;
  }
};

/**
 * Create HTML response
 */
export const htmlResponse = (html: string, status = 200): Response =>
  new Response(encodeBody(html), {
    headers: { "content-type": "text/html; charset=utf-8" },
    status,
  });

/**
 * Create 404 not found response
 */
export const notFoundResponse = (): Response =>
  htmlResponse(notFoundPage(), 404);

/**
 * Create 429 rate limited response for token URLs
 */
export const rateLimitedResponse = (): Response =>
  htmlResponse(rateLimitedPage(), 429);

/**
 * Create payment error response
 */
export const paymentErrorResponse = (message: string, status = 400): Response =>
  htmlResponse(paymentErrorPage(message), status);

/**
 * Create temporary error response (e.g. transient CDN failures)
 * Returns a styled page with auto-refresh so the user retries automatically
 */
export const temporaryErrorResponse = (): Response =>
  htmlResponse(temporaryErrorPage(), 503);

/**
 * Respond with checkout: popup page in iframe mode, 302 redirect otherwise.
 * Stripe Checkout cannot run inside iframes, so we show a page that opens
 * the checkout URL in a popup window instead.
 * Reads iframe mode from the per-request store (set by detectIframeMode).
 */
export const checkoutResponse = (checkoutUrl: string): Response =>
  getIframeMode()
    ? htmlResponse(checkoutPopupPage(checkoutUrl))
    : redirectResponse(checkoutUrl);

/**
 * Create bare 302 redirect response (no message).
 * Use for external URLs, setup flow, public pages, and other cases
 * where the target page doesn't render success/error banners.
 * For admin redirects that should show a message, use `redirect` instead.
 * Automatically appends ?iframe=true when the current request is in iframe mode.
 */
export const redirectResponse = (url: string, cookie?: string): Response => {
  const headers: HeadersInit = {
    "content-type": "text/html; charset=utf-8",
    location: appendIframeParam(url),
  };
  if (cookie) {
    headers["set-cookie"] = cookie;
  }
  return new Response(null, { headers, status: 302 });
};

/** Options for redirect */
type RedirectOpts = {
  formId?: string;
  cookie?: string;
  form?: URLSearchParams;
  result?: string;
};

/**
 * Redirect with a success or error message (PRG pattern).
 * Stores the message in a flash cookie instead of the query string
 * to avoid leaking potentially sensitive data in URLs, browser history,
 * and referrer headers.
 * When formId is provided, adds a `form` param and `#formId` anchor so the
 * browser scrolls to the form that was just submitted.
 */
export const redirect = (
  url: string,
  message: string,
  succeeded: boolean,
  opts?: RedirectOpts,
): Response => {
  const target = opts?.form?.get("return_url") || url;
  const u = new URL(target, "http://localhost");
  const flashId = getRequestId();
  u.searchParams.set("flash", flashId);
  if (opts?.formId) {
    u.searchParams.set("form", opts.formId);
    u.hash = opts.formId;
  }
  const flash = buildFlashCookie(flashId, message, succeeded, opts?.result);
  const response = redirectResponse(u.pathname + u.search + u.hash, flash);
  if (opts?.cookie) withCookie(response, opts.cookie);
  return response;
};

/**
 * Redirect with an error message (PRG pattern).
 * Shorthand for `redirect(url, message, false, { formId })`.
 */
export const errorRedirect = (
  url: string,
  message: string,
  formId?: string,
): Response => redirect(url, message, false, formId ? { formId } : undefined);

/**
 * Apply flash message from cookie to form stores for the current request.
 * Call before rendering any page that displays form messages.
 * Reads the flash cookie (set by a previous redirect) and populates the
 * per-request success/error stores so CsrfForm can display them.
 * Returns the flash object for callers that need additional logic.
 */
export const applyFlash = (
  request: Request,
): { success?: string; error?: string; result?: string } => {
  const flash = getFlash();
  const formId = getSearchParam(request, "form");
  if (flash.success) setFormSuccess(formId, flash.success);
  if (flash.error) setFormError(formId, flash.error);
  return flash;
};

/**
 * Parse form data from request
 */
export const parseFormData = async (request: Request): Promise<FormParams> => {
  const text = await request.text();
  return new FormParams(text);
};

/**
 * Extract text fields from FormData as FormParams (skips File entries).
 * Handles multi-value fields (e.g. checkbox groups) via append.
 */
export const formDataToParams = (formData: FormData): FormParams => {
  const params = new FormParams();
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
  return { method: request.method, path: normalizePath(url.pathname), url };
};

/**
 * Get search param from request URL
 */
export const getSearchParam = (request: Request, key: string): string => {
  const url = new URL(request.url);
  return url.searchParams.get(key) ?? "";
};

export { FormParams } from "#lib/form-data.ts";

/**
 * Add cookie header to response.
 * Mutates headers in-place to avoid re-reading the response body.
 */
export const withCookie = (response: Response, cookie: string): Response => {
  response.headers.append("set-cookie", cookie);
  return response;
};

/**
 * Resolve a nullable promise, calling handler if found or returning 404.
 * Use for any route that loads a model and should 404 when missing.
 */
export const orNotFound = async <T>(
  load: Promise<T | null>,
  handler: (data: T) => Response | Promise<Response>,
): Promise<Response> => {
  const data = await load;
  return data ? handler(data) : notFoundResponse();
};

/** Route handler that takes request + { id } params */
export type IdRouteHandler = (
  request: Request,
  params: { id: number },
) => Promise<Response>;

export const withEventPage = (
  renderPage: (event: EventWithCount, session: AdminSession) => string,
): IdRouteHandler =>
  authenticatedGetById(null)(getEventWithCount, (event, session) =>
    htmlResponse(renderPage(event, session)),
  );

/** Check if an event's registration period has closed */
export const isRegistrationClosed = (event: {
  closes_at: string | null;
}): boolean =>
  event.closes_at !== null && new Date(event.closes_at).getTime() < nowMs();

/** Format an attendee creation failure (capacity_exceeded / encryption_error).
 * Dispatches on reason and optional eventName. */
export const formatCreationError = (
  capacityMsg: string,
  capacityMsgWithName: (name: string) => string,
  fallbackMsg: string,
  reason: "capacity_exceeded" | "encryption_error",
  eventName: string,
): string => {
  if (reason !== "capacity_exceeded") return fallbackMsg;
  if (eventName) return capacityMsgWithName(eventName);
  return capacityMsg;
};

/** Format a countdown from now to a future closes_at date, e.g. "3 days and 5 hours from now" */
export const formatCountdown = (closesAt: string): string => {
  const diffMs = new Date(closesAt).getTime() - nowMs();
  if (diffMs <= 0) return "closed";
  const totalHours = Math.floor(diffMs / (1000 * 60 * 60));
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const pl = (n: number, unit: string) => `${n} ${unit}${n !== 1 ? "s" : ""}`;
  if (days > 0 && hours > 0)
    return `${pl(days, "day")} and ${pl(hours, "hour")} from now`;
  if (days > 0) return `${pl(days, "day")} from now`;
  if (hours > 0) return `${pl(hours, "hour")} from now`;
  return `${pl(Math.max(1, Math.floor(diffMs / (1000 * 60))), "minute")} from now`;
};

/** Session with wrapped data key for private key derivation, and user role */
export type AuthSession = {
  token: string;
  wrappedDataKey: string | null;
  userId: number;
  adminLevel: AdminLevel;
};

/** How the request was authenticated */
type AuthKind = "cookie" | "apiKey";

/** Body parsing mode for authenticated requests */
type BodyMode = "form" | "multipart" | "json";

/** Maps body mode to the parsed body type */
type ParsedBody<T extends BodyMode> = T extends "form"
  ? FormParams
  : T extends "multipart"
    ? FormData
    : Record<string, unknown>;

/** Policy controlling authentication, CSRF, role, and body parsing */
type AuthPolicy<T extends BodyMode = BodyMode> = {
  body: T;
  role?: AdminLevel;
  allowApiKey?: boolean;
};

/** Auth policy presets — use with withAuth to avoid repeating policy objects */
export const OWNER_FORM: AuthPolicy<"form"> = { body: "form", role: "owner" };
export const AUTH_FORM: AuthPolicy<"form"> = { body: "form" };
export const AUTH_MULTIPART: AuthPolicy<"multipart"> = { body: "multipart" };
export const OWNER_MULTIPART: AuthPolicy<"multipart"> = {
  body: "multipart",
  role: "owner",
};
export const AUTH_JSON: AuthPolicy<"json"> = { body: "json" };
export const ADMIN_API: AuthPolicy<"json"> = {
  allowApiKey: true,
  body: "json",
};

/**
 * Core session + role gate. Returns the session on success, or a
 * channel-appropriate failure Response.
 */
const requireSessionFor = async (
  request: Request,
  channel: AuthChannel,
  role?: AdminLevel,
): Promise<AuthSession | Response> => {
  const session = await getAuthenticatedSession(request);
  if (!session) return authFailure(channel, "not-authenticated");
  if (role && session.adminLevel !== role)
    return authFailure(channel, "forbidden");
  return session;
};

const isResponse = (v: unknown): v is Response => v instanceof Response;

type SessionHandler = (session: AuthSession) => Response | Promise<Response>;

/**
 * Low-level session gate with custom no-session fallback (used by dashboard login page).
 * Only checks cookie-based auth. API key auth is intentionally excluded —
 * Bearer tokens should only authenticate /api/* endpoints via withAuth + ADMIN_API.
 */
export const withSession = async (
  request: Request,
  handler: SessionHandler,
  onNoSession: () => Response | Promise<Response>,
): Promise<Response> => {
  const session = await getAuthenticatedSession(request);
  return session ? handler(session) : onNoSession();
};

/** Require session — redirect if not authenticated, 403 if role check fails */
export const requireSessionOr = async (
  request: Request,
  handler: SessionHandler,
  role?: AdminLevel,
): Promise<Response> => {
  const result = await requireSessionFor(request, "html", role);
  return isResponse(result) ? result : handler(result);
};

/** Require owner session — shorthand for requireSessionOr with owner role */
export const requireOwnerOr = (
  request: Request,
  handler: SessionHandler,
): Promise<Response> => requireSessionOr(request, handler, "owner");

/** CSRF form result type */
export type CsrfFormResult =
  | { ok: true; form: FormParams }
  | { ok: false; response: Response };

/**
 * Parse form with CSRF validation.
 * Verifies the form token's HMAC signature and expiry.
 * On failure, generates a fresh token (stored for CsrfForm) before calling onInvalid.
 */
export const requireCsrfForm = async (
  request: Request,
  onInvalid: () => Response,
): Promise<CsrfFormResult> => {
  const form = await parseFormData(request);
  const formCsrf = form.getString("csrf_token");

  // Always save form data so validation errors can restore user input.
  // This clears any stale data from a prior request and makes the current
  // submission available to renderFields/getSavedValue during re-rendering.
  setSavedFormData(form);

  if (formCsrf && (await verifySignedCsrfToken(formCsrf))) {
    return { form, ok: true };
  }

  await signCsrfToken();
  return { ok: false, response: onInvalid() };
};

/**
 * Parse a CSRF-protected form, re-rendering the form on invalid CSRF.
 * Centralizes the default invalid/expired message.
 * On failure, generates a fresh token (stored for CsrfForm) and calls onInvalid.
 */
export const withCsrfForm = async (
  request: Request,
  onInvalid: (message: string, status: number) => Response,
  handler: (form: FormParams) => Response | Promise<Response>,
): Promise<Response> => {
  const csrf = await requireCsrfForm(request, () =>
    onInvalid(CSRF_INVALID_FORM_MESSAGE, 403),
  );
  return csrf.ok ? handler(csrf.form) : csrf.response;
};

/**
 * Authenticated GET-by-ID route handler factory.
 * Loads entity by ID, returns 404 if missing, renders with session context.
 * @param role - "owner" requires owner role, null allows any authenticated user
 */
export const authenticatedGetById =
  (role: AdminLevel | null) =>
  <T>(
    load: (id: number) => Promise<T | null>,
    render: (entity: T, session: AuthSession) => Response | Promise<Response>,
  ): IdRouteHandler =>
  (request, { id }) =>
    requireSessionOr(
      request,
      (session) => orNotFound(load(id), (entity) => render(entity, session)),
      role ?? undefined,
    );

/** Shorthand: owner GET-by-ID */
export const ownerGetById = authenticatedGetById("owner");

/** Owner POST-by-ID + CSRF */
export const ownerFormById =
  (
    handler: (
      id: number,
      session: AuthSession,
      form: FormParams,
    ) => Response | Promise<Response>,
  ): IdRouteHandler =>
  (request, { id }) =>
    withAuth(request, OWNER_FORM, (session, form) =>
      handler(id, session, form),
    );

/** Create JSON response */
export const jsonResponse = (data: unknown, status = 200): Response =>
  new Response(encodeBody(JSON.stringify(data)), {
    headers: { "content-type": "application/json; charset=utf-8" },
    status,
  });

/** Create plain text response */
export const plainResponse = (text: string, status = 200): Response =>
  new Response(encodeBody(text), {
    headers: { "content-type": "text/plain; charset=utf-8" },
    status,
  });

/** Shared auth failure response factories (avoids jscpd duplication) */
const htmlForbidden = () => htmlResponse("Forbidden", 403);
const jsonForbidden = () =>
  jsonResponse({ message: "Forbidden", status: "error" }, 403);

/** Auth failure responses keyed by reason, with html and json variants side-by-side. */
const AUTH_FAILURES = {
  forbidden: { html: htmlForbidden, json: jsonForbidden },
  "invalid-api-key": {
    html: htmlForbidden,
    json: () =>
      jsonResponse({ message: "Invalid API key", status: "error" }, 401),
  },
  "invalid-csrf": {
    html: () => htmlResponse("Invalid CSRF token", 403),
    json: jsonForbidden,
  },
  "not-authenticated": {
    html: () => redirectResponse("/admin"),
    json: () =>
      jsonResponse({ message: "Not authenticated", status: "error" }, 401),
  },
} satisfies Record<string, Record<"html" | "json", () => Response>>;

type AuthFailureReason = keyof typeof AUTH_FAILURES;
type AuthChannel = keyof (typeof AUTH_FAILURES)[AuthFailureReason];

/** Construct a standardized auth failure response. */
export const authFailure = (
  channel: AuthChannel,
  reason: AuthFailureReason,
): Response => AUTH_FAILURES[reason][channel]();

/** Create iCalendar response */
export const icsResponse = (ics: string): Response =>
  new Response(encodeBody(ics), {
    headers: { "content-type": "text/calendar; charset=utf-8" },
  });

/** Create RSS/XML response */
export const rssResponse = (xml: string): Response =>
  new Response(encodeBody(xml), {
    headers: { "content-type": "application/rss+xml; charset=utf-8" },
  });

/** Parse JSON body, returning empty object for non-JSON or GET requests */
const parseJsonBody = async (
  request: Request,
): Promise<Record<string, unknown> | Response> => {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return {};
  try {
    return await request.json();
  } catch {
    logError({
      code: ErrorCode.VALIDATION_FORM,
      detail: "Malformed JSON body",
    });
    return jsonResponse(
      { message: "Invalid request body", status: "error" },
      400,
    );
  }
};

/** Verify a CSRF token, returning a channel-appropriate failure or null */
const verifyCsrf = async (
  token: string,
  channel: AuthChannel,
): Promise<Response | null> => {
  if (await verifySignedCsrfToken(token)) return null;
  if (channel === "json")
    logError({ code: ErrorCode.AUTH_CSRF_MISMATCH, detail: "JSON API" });
  return authFailure(channel, "invalid-csrf");
};

/** Validate CSRF and parse body for the given mode.
 *
 * `skipCsrf` only applies to JSON bodies (used for API key auth). Form and
 * multipart bodies are always CSRF-checked because API key clients use JSON. */
const parseCsrfBody = async (
  request: Request,
  mode: BodyMode,
  skipCsrf: boolean,
): Promise<FormParams | FormData | Record<string, unknown> | Response> => {
  const channel = channelFor(mode);
  if (mode === "json") {
    if (!skipCsrf) {
      const err = await verifyCsrf(
        request.headers.get("x-csrf-token") ?? "",
        channel,
      );
      if (err) return err;
    }
    return parseJsonBody(request);
  }
  if (mode === "form") {
    const form = await parseFormData(request);
    const err = await verifyCsrf(form.getString("csrf_token"), channel);
    return err ?? form;
  }
  const fd = await request.formData();
  const err = await verifyCsrf(
    String(fd.get("csrf_token") ?? "").trim(),
    channel,
  );
  return err ?? fd;
};

/** Derive the auth channel (html vs json) from the body mode */
const channelFor = (mode: BodyMode): AuthChannel =>
  mode === "json" ? "json" : "html";

/** Resolve session from cookie or API key */
const resolveSession = async (
  request: Request,
  channel: AuthChannel,
  allowApiKey?: boolean,
): Promise<{ session: AuthSession; authKind: AuthKind } | Response> => {
  if (allowApiKey) {
    const s = await getAuthenticatedApiKey(request);
    if (s) return { authKind: "apiKey", session: s };
    if (getBearerToken(request)) return authFailure(channel, "invalid-api-key");
  }
  const session = await getAuthenticatedSession(request);
  if (!session) return authFailure(channel, "not-authenticated");
  return { authKind: "cookie", session };
};

/** Unified auth pipeline: authenticate, enforce role, validate CSRF, parse body. */
export async function withAuth<T extends BodyMode>(
  request: Request,
  policy: AuthPolicy<T>,
  handler: (
    session: AuthSession,
    body: ParsedBody<T>,
    authKind: AuthKind,
  ) => Response | Promise<Response>,
): Promise<Response> {
  const channel = channelFor(policy.body);
  const auth = await resolveSession(request, channel, policy.allowApiKey);
  if (isResponse(auth)) return auth;
  if (policy.role && auth.session.adminLevel !== policy.role)
    return authFailure(channel, "forbidden");
  const body = await parseCsrfBody(
    request,
    policy.body,
    auth.authKind === "apiKey",
  );
  if (isResponse(body)) return body;
  return handler(auth.session, body as ParsedBody<T>, auth.authKind);
}
