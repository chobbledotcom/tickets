/**
 * Shared utilities for route handlers
 */

import { err, filter, map, ok, pipe, type Result, reduce } from "#fp";
import { constantTimeEqual, generateSecureToken } from "#lib/crypto.ts";
import { deleteSession, getEventWithCount, getSession } from "#lib/db";
import type { EventWithCount } from "#lib/types.ts";
import { notFoundPage } from "#templates";
import type { ServerContext } from "./types.ts";

// Re-export for use by other route modules
export { generateSecureToken };

/**
 * Get client IP from request
 * Note: This server runs directly on edge, not behind a proxy,
 * so we use the direct connection IP from the server context.
 * The IP is passed via the server's requestIP() in Bun.serve.
 */
export const getClientIp = (
  request: Request,
  server?: ServerContext,
): string => {
  // Use Bun's server.requestIP() if available
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

  return pipe(
    map((part: string) => part.trim().split("=")),
    filter(([key, value]) => Boolean(key && value)),
    reduce((acc, [key, value]) => {
      acc.set(key, value);
      return acc;
    }, new Map<string, string>()),
  )(header.split(";"));
};

/**
 * Get authenticated session if valid
 * Returns null if not authenticated
 */
export const getAuthenticatedSession = async (
  request: Request,
): Promise<{ token: string; csrfToken: string } | null> => {
  const cookies = parseCookies(request);
  const token = cookies.get("__Host-session");
  if (!token) return null;

  const session = await getSession(token);
  if (!session) return null;

  if (session.expires < Date.now()) {
    await deleteSession(token);
    return null;
  }

  return { token, csrfToken: session.csrf_token };
};

/**
 * Check if request has valid session
 */
export const isAuthenticated = async (request: Request): Promise<boolean> => {
  return (await getAuthenticatedSession(request)) !== null;
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
 * Create a GET-only route handler for static content
 */
export const staticGetRoute =
  (body: string, contentType: string) =>
  (method: string): Response | null =>
    method === "GET"
      ? new Response(body, { headers: { "content-type": contentType } })
      : null;

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
 * Parse request URL and extract path/method
 */
export const parseRequest = (
  request: Request,
): { url: URL; path: string; method: string } => {
  const url = new URL(request.url);
  return { url, path: url.pathname, method: request.method };
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
 * Fetch event or return 404 response
 */
export const fetchEventOr404 = async (
  eventId: number,
): Promise<Result<EventWithCount>> => {
  const event = await getEventWithCount(eventId);
  return event ? ok(event) : err(htmlResponse(notFoundPage(), 404));
};

/**
 * Handle event with Result - unwrap to Response
 */
export const withEvent = async (
  eventId: number,
  handler: (event: EventWithCount) => Response | Promise<Response>,
): Promise<Response> => {
  const result = await fetchEventOr404(eventId);
  return result.ok ? handler(result.value) : result.response;
};

/** Session with CSRF token */
export type AuthSession = { token: string; csrfToken: string };

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
export const requireSessionOr = async (
  request: Request,
  handler: (session: AuthSession) => Response | Promise<Response>,
): Promise<Response> =>
  withSession(request, handler, () => redirect("/admin/"));

/** CSRF form result type (for public forms using double-submit cookie) */
export type CsrfFormResult =
  | { ok: true; form: URLSearchParams }
  | { ok: false; response: Response };

/** Cookie name for public form CSRF tokens */
const CSRF_COOKIE_NAME = "csrf_token";

/** Generate CSRF cookie string */
export const csrfCookie = (token: string, path: string): string =>
  `${CSRF_COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=${path}; Max-Age=3600`;

/**
 * Parse form with CSRF validation (double-submit cookie pattern)
 * This is the integral CSRF check - you cannot get form data without validating CSRF
 */
export const requireCsrfForm = async (
  request: Request,
  onInvalid: (newToken: string) => Response,
): Promise<CsrfFormResult> => {
  const cookies = parseCookies(request);
  const cookieCsrf = cookies.get(CSRF_COOKIE_NAME) || "";
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
    return { ok: false, response: redirect("/admin/") };
  }

  const form = await parseFormData(request);
  const csrfToken = form.get("csrf_token") || "";
  if (!validateCsrfToken(session.csrfToken, csrfToken)) {
    return { ok: false, response: htmlResponse("Invalid CSRF token", 403) };
  }

  return { ok: true, session, form };
};

/**
 * Handle request with auth form - unwrap AuthFormResult
 */
export const withAuthForm = async (
  request: Request,
  handler: (
    session: AuthSession,
    form: URLSearchParams,
  ) => Response | Promise<Response>,
): Promise<Response> => {
  const auth = await requireAuthForm(request);
  return auth.ok ? handler(auth.session, auth.form) : auth.response;
};

/** Route handler type */
export type RouteHandler = (
  request: Request,
  path: string,
  method: string,
) => Promise<Response | null>;

/** Route handler with server context */
export type RouteHandlerWithServer = (
  request: Request,
  path: string,
  method: string,
  server?: ServerContext,
) => Promise<Response | null>;

/** ID-based route handlers */
type IdHandlers = {
  GET?: (id: number) => Promise<Response>;
  POST?: (id: number) => Promise<Response>;
  PATCH?: (id: number) => Promise<Response>;
  DELETE?: (id: number) => Promise<Response>;
};

/**
 * Create a route handler that extracts ID from path pattern
 */
export const createIdRoute =
  (
    pattern: RegExp,
    getHandlers: (request: Request) => IdHandlers,
  ): RouteHandler =>
  (request, path, method) =>
    routeWithId(path, pattern, method, getHandlers(request));

/** Route definition for declarative routing */
type RouteMatch = {
  path: string;
  method: string;
  handler: () => Response | Promise<Response>;
};

/**
 * Match first route and execute handler
 */
export const matchRoute = async (
  path: string,
  method: string,
  routes: RouteMatch[],
): Promise<Response | null> => {
  const match = routes.find((r) => r.path === path && r.method === method);
  return match ? match.handler() : null;
};

/**
 * Chain route handlers - try each until one returns a response
 */
export const chainRoutes = async (
  ...handlers: Array<() => Promise<Response | null>>
): Promise<Response | null> => {
  for (const handler of handlers) {
    const result = await handler();
    if (result) return result;
  }
  return null;
};

/**
 * Extract ID from route pattern and dispatch to handlers by method
 */
export const routeWithId = async (
  path: string,
  pattern: RegExp,
  method: string,
  handlers: IdHandlers,
): Promise<Response | null> => {
  const match = path.match(pattern);
  if (!match?.[1]) return null;

  const id = Number.parseInt(match[1], 10);
  const handler = handlers[method as keyof typeof handlers];
  return handler ? handler(id) : null;
};
