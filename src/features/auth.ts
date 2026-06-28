/**
 * Authentication and session utilities
 */

import { parseFormData } from "#routes/csrf.ts";
import {
  htmlResponse,
  jsonResponse,
  redirectResponse,
} from "#routes/response.ts";
import { parseCookies } from "#routes/url.ts";
import { getRequestClientIp } from "#shared/client-context.ts";
import { getSessionCookieName } from "#shared/cookies.ts";
import { unwrapKeyWithToken } from "#shared/crypto/keys.ts";
import { generateSecureToken } from "#shared/crypto/utils.ts";
import { signCsrfToken, verifySignedCsrfToken } from "#shared/csrf.ts";
import {
  isApiKeyRateLimited,
  recordApiKeyAttempt,
} from "#shared/db/api-key-attempts.ts";
import { getApiKeyByToken, touchApiKeyLastUsed } from "#shared/db/api-keys.ts";
import { deleteSession, getSession } from "#shared/db/sessions.ts";
import { decryptAdminLevel, getUserAuthFieldsById } from "#shared/db/users.ts";
import type { FormParams } from "#shared/form-data.ts";
import { setSavedFormData } from "#shared/forms.tsx";
import { SCANNER_CSRF_MAX_AGE_S } from "#shared/limits.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { nowMs } from "#shared/now.ts";
import { getCachedSession, setCachedSession } from "#shared/session-context.ts";
import { getSettingsNagItemsForOwner } from "#shared/settings-nags.ts";
import {
  type AdminLevel,
  CONTENT_ADMIN_LEVELS,
  DELIVERY_ADMIN_LEVELS,
  isRecord,
  type NagItem,
  SITE_ADMIN_LEVELS,
  STAFF_ADMIN_LEVELS,
} from "#shared/types.ts";

// SessionKeyError and the session→private-key derivation live in #shared so
// shared-layer modules (e.g. the activity log) can reach them without importing
// the feature layer. Re-exported here for the central request error handler
// (#routes/index.ts), which special-cases it into a re-authenticate response.
// Route handlers derive the key directly via requireRequestPrivateKey /
// getRequestPrivateKey (#shared/session-private-key.ts) — the request-scoped,
// thread-free form that needs no session argument.
export { SessionKeyError } from "#shared/session-private-key.ts";
// Re-export for callers that need it
export { generateSecureToken };

/** Session with wrapped data key for private key derivation, and user role */
export type AuthSession = {
  token: string;
  wrappedDataKey: string | null;
  userId: number;
  adminLevel: AdminLevel;
  settingsNagItems?: readonly NagItem[];
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
  const user = await getUserAuthFieldsById(session.user_id);
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

  if (adminLevel === "owner") {
    result.settingsNagItems = await getSettingsNagItemsForOwner();
  }

  setCachedSession(result);
  return result;
};

/** Where a user should land after authenticating, based on their role.
 * Delivery agents go straight to their run sheet (the only page they may see);
 * editors go to the listings index (the dashboard shows financials they may not
 * see); staff go to the dashboard. */
export const adminLandingPath = (adminLevel: AdminLevel): string => {
  if (adminLevel === "agent") return "/admin/deliveries";
  if (adminLevel === "editor") return "/admin/listings";
  return "/admin";
};

/** Where a listing create/edit/upload action should return the user. Staff land
 * on the attendee-centric detail page; editors (who can't open it) return to the
 * edit form so a successful save never bounces them to a forbidden page. */
export const listingReturnPath = (
  adminLevel: AdminLevel,
  id: number,
): string =>
  adminLevel === "editor"
    ? `/admin/listing/${id}/edit`
    : `/admin/listing/${id}`;

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

  // Throttle brute-force guessing per IP. Only failed lookups are counted, so a
  // client with a valid key is never locked out; once an IP is locked, even a
  // correct token is rejected until the lockout expires.
  const ip = getRequestClientIp();
  if (await isApiKeyRateLimited(ip)) {
    logError({
      code: ErrorCode.AUTH_INVALID_SESSION,
      detail: "API key authentication rate limited",
    });
    return null;
  }

  const apiKeyRow = await getApiKeyByToken(token);
  if (!apiKeyRow) {
    await recordApiKeyAttempt(ip);
    logError({
      code: ErrorCode.AUTH_INVALID_SESSION,
      detail: "Bearer token does not match any API key",
    });
    return null;
  }

  const user = await getUserAuthFieldsById(apiKeyRow.user_id);
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
export type AuthPolicy<T extends BodyMode = BodyMode> = {
  body: T;
  /** Require exactly this role. */
  role?: AdminLevel;
  /** Allow any of these roles (use instead of `role` for multi-role gates). */
  roles?: readonly AdminLevel[];
  allowApiKey?: boolean;
  /** Override the CSRF token max-age (seconds). Defaults to the standard 1 hour. */
  csrfMaxAge?: number;
};

/**
 * Whether a session's role satisfies a gate.
 * - `roles` given: membership test.
 * - single `role` given: exact match (owner-only or agent-only gates).
 * - neither: any back-office staff (owner|manager). Delivery agents are
 *   excluded by default so introducing the agent class can never widen access
 *   to an existing staff page that didn't explicitly opt them in.
 */
const sessionRoleAllowed = (
  level: AdminLevel,
  role: AdminLevel | undefined,
  roles: readonly AdminLevel[] | undefined,
): boolean => {
  if (roles) return roles.includes(level);
  if (role) return level === role;
  return (STAFF_ADMIN_LEVELS as readonly AdminLevel[]).includes(level);
};

/** Auth policy presets — use with withAuth to avoid repeating policy objects */
export const OWNER_FORM: AuthPolicy<"form"> = { body: "form", role: "owner" };
export const AUTH_FORM: AuthPolicy<"form"> = { body: "form" };
/** Agent-only form gate (delivery run-sheet actions). */
export const AGENT_FORM: AuthPolicy<"form"> = { body: "form", role: "agent" };
/** Content-editing form gate: staff plus the content-only `editor`. Used for the
 * listing/group create-edit actions and the public-site content saves editors
 * are opted into. */
export const CONTENT_FORM: AuthPolicy<"form"> = {
  body: "form",
  roles: CONTENT_ADMIN_LEVELS,
};
/** Content-editing multipart gate (listing create/edit with image uploads). */
export const CONTENT_MULTIPART: AuthPolicy<"multipart"> = {
  body: "multipart",
  roles: CONTENT_ADMIN_LEVELS,
};
/** Public-site content form gate: owner + editor only (managers stay excluded
 * from site editing — see {@link SITE_ADMIN_LEVELS}). */
export const SITE_FORM: AuthPolicy<"form"> = {
  body: "form",
  roles: SITE_ADMIN_LEVELS,
};
/** Delivery run-sheet form gate: staff + agent, but NOT editor. */
export const DELIVERY_FORM: AuthPolicy<"form"> = {
  body: "form",
  roles: DELIVERY_ADMIN_LEVELS,
};
/** Form gate that admits any authenticated user, agents and editors included —
 * used for actions every logged-in user must reach, like logout. */
export const ANY_USER_FORM: AuthPolicy<"form"> = {
  body: "form",
  roles: ["owner", "manager", "agent", "editor"],
};
export const AUTH_MULTIPART: AuthPolicy<"multipart"> = { body: "multipart" };
export const OWNER_MULTIPART: AuthPolicy<"multipart"> = {
  body: "multipart",
  role: "owner",
};
export const ADMIN_API: AuthPolicy<"json"> = {
  allowApiKey: true,
  body: "json",
};
/**
 * Owner-only JSON API: like ADMIN_API but restricted to the owner role, for
 * resources whose web management is owner-only (e.g. holidays). Keeps the JSON
 * API authorization aligned with the UI so a manager cannot perform via the API
 * what the dashboard denies them.
 */
export const OWNER_API: AuthPolicy<"json"> = {
  allowApiKey: true,
  body: "json",
  role: "owner",
};
/**
 * Scanner check-in API: cookie-authenticated JSON with a CSRF max-age matching
 * the session lifetime, so a logged-in admin can keep the scanner page open for
 * a whole listing without check-ins failing on CSRF expiry.
 */
export const SCANNER_JSON: AuthPolicy<"json"> = {
  body: "json",
  csrfMaxAge: SCANNER_CSRF_MAX_AGE_S,
};

/**
 * Core session + role gate. Returns the session on success, or a
 * channel-appropriate failure Response.
 */
const requireSessionFor = async (
  request: Request,
  channel: AuthChannel,
  role?: AdminLevel,
  roles?: readonly AdminLevel[],
): Promise<AuthSession | Response> => {
  const session = await getAuthenticatedSession(request);
  if (!session) return authFailure(channel, "not-authenticated");
  if (!sessionRoleAllowed(session.adminLevel, role, roles)) {
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

/** Build a session guard that requires an exact role. */
const requireRoleOr =
  (role: AdminLevel) =>
  (request: Request, handler: SessionHandler): Promise<Response> =>
    requireSessionOr(request, handler, role);

/** Require owner session — shorthand for requireSessionOr with owner role */
export const requireOwnerOr = requireRoleOr("owner");

/** Require agent session — shorthand for requireSessionOr with agent role */
export const requireAgentOr = requireRoleOr("agent");

/** Build a session guard that admits any of the given roles. */
const requireRolesOr =
  (roles: readonly AdminLevel[]) =>
  async (request: Request, handler: SessionHandler): Promise<Response> => {
    const result = await requireSessionFor(request, "html", undefined, roles);
    return isResponse(result) ? result : handler(result);
  };

/** Require a content-editing session (staff or editor) — 403 outside
 * {@link CONTENT_ADMIN_LEVELS}. Used for the listing/group create-edit pages. */
export const requireContentOr = requireRolesOr(CONTENT_ADMIN_LEVELS);

/** Require a site-editing session (owner or editor) — 403 outside
 * {@link SITE_ADMIN_LEVELS}. Managers stay excluded from site editing. */
export const requireSiteOr = requireRolesOr(SITE_ADMIN_LEVELS);

/** Require a delivery-run-sheet session (staff or agent, NOT editor) — 403
 * outside {@link DELIVERY_ADMIN_LEVELS}. */
export const requireDeliveryOr = requireRolesOr(DELIVERY_ADMIN_LEVELS);

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

/** Content-editing GET page (staff or editor): authenticate, apply flash,
 * render HTML. */
export const contentPage = authPage(requireContentOr);

/** Site-editing GET page (owner or editor): authenticate, apply flash,
 * render HTML. */
export const sitePage = authPage(requireSiteOr);

/** Delivery-run-sheet GET page (staff or agent): authenticate, apply flash,
 * render HTML. */
export const deliveryPage = authPage(requireDeliveryOr);

/** Agent-only GET page: authenticate, apply flash, render HTML */
export const agentPage = authPage(requireAgentOr);

/** Require any authenticated user (owner, manager or agent). Used for pages
 * that staff and delivery agents alike must reach, like the deliveries run
 * sheet — agents are sent here, staff opt in via the Calendar submenu. Every
 * valid session already holds one of the three roles, so authentication is the
 * only gate. */
export const requireAnyUserOr = async (
  request: Request,
  handler: SessionHandler,
): Promise<Response> => {
  const session = await getAuthenticatedSession(request);
  if (!session) return authFailure("html", "not-authenticated");
  return handler(session);
};

/** Any-authenticated-user GET page: authenticate, apply flash, render HTML */
export const anyUserPage = authPage(requireAnyUserOr);

/** Shared auth failure response factories (avoids jscpd duplication) */
const htmlForbidden = () => htmlResponse("Forbidden", 403);
const jsonForbidden = () => jsonResponse({ error: "Forbidden" }, 403);

/** Auth failure responses keyed by reason, with html and json variants side-by-side. */
const AUTH_FAILURES = {
  forbidden: { html: htmlForbidden, json: jsonForbidden },
  "invalid-api-key": {
    html: htmlForbidden,
    json: () => jsonResponse({ error: "Invalid API key" }, 401),
  },
  "invalid-csrf": {
    html: () => htmlResponse("Invalid CSRF token", 403),
    json: jsonForbidden,
  },
  "not-authenticated": {
    html: () => redirectResponse("/admin"),
    json: () => jsonResponse({ error: "Not authenticated" }, 401),
  },
} satisfies Record<string, Record<"html" | "json", () => Response>>;

type AuthFailureReason = keyof typeof AUTH_FAILURES;
type AuthChannel = keyof (typeof AUTH_FAILURES)[AuthFailureReason];

/** Construct a standardized auth failure response. */
export const authFailure = (
  channel: AuthChannel,
  reason: AuthFailureReason,
): Response => AUTH_FAILURES[reason][channel]();

/**
 * Safe HTTP methods (RFC 7231 §4.2.1): read-only, so a request using one cannot
 * mutate state and carries no body. Such requests need no CSRF token — CSRF
 * defends state-changing submissions, and cross-origin reads of the response are
 * already blocked by the Same-Origin Policy. This lets cookie-authenticated
 * calendar clients fetch GET /caldav/events.ics without an x-csrf-token header
 * they have no way to attach.
 */
const isSafeMethod = (request: Request): boolean =>
  request.method === "GET" || request.method === "HEAD";

/** Parse JSON body, returning empty object for non-JSON GET/HEAD requests */
const parseJsonBody = async (
  request: Request,
): Promise<Record<string, unknown> | Response> => {
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  const bodyRequired = !isSafeMethod(request);

  if (!contentType.includes("application/json")) {
    if (bodyRequired) {
      return jsonResponse({ error: "Invalid request body" }, 400);
    }
    return {};
  }
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    logError({
      code: ErrorCode.VALIDATION_FORM,
      detail: "Malformed JSON body",
    });
    return jsonResponse({ error: "Invalid request body" }, 400);
  }
  if (!isRecord(parsed)) {
    return jsonResponse({ error: "Invalid request body" }, 400);
  }
  return parsed;
};

/** Verify a CSRF token, returning a channel-appropriate failure or null */
const verifyCsrf = async (
  token: string,
  channel: AuthChannel,
  maxAge?: number,
): Promise<Response | null> => {
  if (await verifySignedCsrfToken(token, maxAge)) return null;
  if (channel === "json") {
    logError({ code: ErrorCode.AUTH_CSRF_MISMATCH, detail: "JSON API" });
  }
  return authFailure(channel, "invalid-csrf");
};

/** Validate CSRF and parse body for the given mode.
 *
 * `skipCsrf` only applies to JSON bodies (used for API key auth). Form and
 * multipart bodies are always CSRF-checked because API key clients use JSON.
 * Safe-method (GET/HEAD) JSON requests also skip CSRF: they cannot mutate state,
 * so the token is moot — this keeps read-only JSON routes (e.g. the calendar
 * feed) reachable by cookie sessions that can't send an x-csrf-token header.
 * `maxAge` overrides the CSRF token expiry window (seconds). */
const parseCsrfBody = async (
  request: Request,
  mode: BodyMode,
  skipCsrf: boolean,
  maxAge?: number,
): Promise<FormParams | FormData | Record<string, unknown> | Response> => {
  const channel = channelFor(mode);
  if (mode === "json") {
    if (!skipCsrf && !isSafeMethod(request)) {
      const err = await verifyCsrf(
        request.headers.get("x-csrf-token") ?? "",
        channel,
        maxAge,
      );
      if (err) return err;
    }
    return parseJsonBody(request);
  }
  if (mode === "form") {
    const form = await parseFormData(request);
    // Capture the submission so a later validation-failure redirect can stash
    // it for re-filling, mirroring requireCsrfForm for public forms.
    setSavedFormData(form);
    const err = await verifyCsrf(form.getString("csrf_token"), channel, maxAge);
    return err ?? form;
  }
  const fd = await request.formData();
  const err = await verifyCsrf(
    String(fd.get("csrf_token") ?? "").trim(),
    channel,
    maxAge,
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
  if (!sessionRoleAllowed(auth.session.adminLevel, policy.role, policy.roles)) {
    return authFailure(channel, "forbidden");
  }
  const body = await parseCsrfBody(
    request,
    policy.body,
    auth.authKind === "apiKey",
    policy.csrfMaxAge,
  );
  if (isResponse(body)) return body;
  return handler(auth.session, body as ParsedBody<T>, auth.authKind);
}
