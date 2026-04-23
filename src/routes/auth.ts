/**
 * Authentication and session utilities
 */

import { getSessionCookieName } from "#lib/cookies.ts";
import {
  getPrivateKeyFromSession,
  unwrapKeyWithToken,
} from "#lib/crypto/keys.ts";
import { generateSecureToken } from "#lib/crypto/utils.ts";
import { signCsrfToken, verifySignedCsrfToken } from "#lib/csrf.ts";
import { getApiKeyByToken, touchApiKeyLastUsed } from "#lib/db/api-keys.ts";
import { deleteSession, getSession } from "#lib/db/sessions.ts";
import { settings } from "#lib/db/settings.ts";
import { decryptAdminLevel, getUserById } from "#lib/db/users.ts";
import type { FormParams } from "#lib/form-data.ts";
import { ErrorCode, logError } from "#lib/logger.ts";
import { nowMs } from "#lib/now.ts";
import { getCachedSession, setCachedSession } from "#lib/session-context.ts";
import type { AdminLevel } from "#lib/types.ts";
import { parseFormData } from "#routes/csrf.ts";
import {
  htmlResponse,
  jsonResponse,
  redirectResponse,
} from "#routes/response.ts";
import { parseCookies } from "#routes/url.ts";

// Re-export for callers that need it
export { generateSecureToken };

/** Thrown when a session's private key cannot be derived (e.g. wrappedDataKey missing or unwrap failure) */
export class SessionKeyError extends Error {
  constructor() {
    super("Private key unavailable for session");
  }
}

/** Session with wrapped data key for private key derivation, and user role */
export type AuthSession = {
  token: string;
  wrappedDataKey: string | null;
  userId: number;
  adminLevel: AdminLevel;
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
  if (role && session.adminLevel !== role) {
    return authFailure(channel, "forbidden");
  }
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

/** Session guard: require auth and call handler with session */
export type SessionGuard<TSession> = (
  request: Request,
  handler: (session: TSession) => Response | Promise<Response>,
) => Promise<Response>;

/** Factory for creating authenticated page handlers */
export const authPage =
  <TSession>(requireSession: SessionGuard<TSession>) =>
  (
    render: (session: TSession) => string | Promise<string>,
  ): ((request: Request) => Promise<Response>) =>
  (request) =>
    requireSession(request, async (session) => {
      const { applyFlash } = await import("#routes/csrf.ts");
      applyFlash(request);
      return htmlResponse(await render(session));
    });

/** Owner-only GET page: authenticate, apply flash, render HTML */
export const ownerPage = authPage(requireOwnerOr);

/** Authenticated GET page: authenticate, apply flash, render HTML */
export const sessionPage = authPage(requireSessionOr);

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
  if (channel === "json") {
    logError({ code: ErrorCode.AUTH_CSRF_MISMATCH, detail: "JSON API" });
  }
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
  if (policy.role && auth.session.adminLevel !== policy.role) {
    return authFailure(channel, "forbidden");
  }
  const body = await parseCsrfBody(
    request,
    policy.body,
    auth.authKind === "apiKey",
  );
  if (isResponse(body)) return body;
  return handler(auth.session, body as ParsedBody<T>, auth.authKind);
}
