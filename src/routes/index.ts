/**
 * Routes module - main exports and router
 * Uses lazy loading to minimize startup time for edge scripts
 */

import { once, reduce } from "#fp";
import { loadEffectiveDomain } from "#lib/config.ts";
import {
  clearFlashCookie,
  clearSessionCookie,
  parseFlashValue,
} from "#lib/cookies.ts";
import { maybeRunPrunes } from "#lib/db/prune.ts";
import { runWithQueryLogContext } from "#lib/db/query-log.ts";
import { settings } from "#lib/db/settings.ts";
import { isReadOnly } from "#lib/env.ts";
import {
  hasFlash,
  runWithFlashContext,
  setFlashContext,
} from "#lib/flash-context.ts";
import { clearSavedFormData } from "#lib/forms.tsx";
import { detectIframeMode } from "#lib/iframe.ts";
import {
  createRequestTimer,
  ErrorCode,
  formatRequestError,
  logError,
  logRequest,
  runWithRequestId,
} from "#lib/logger.ts";
import { addPendingWork, flushPendingWork } from "#lib/pending-work.ts";
import { runWithRequestCache } from "#lib/request-cache.ts";
import { runWithSessionContext } from "#lib/session-context.ts";
import { getRethrowErrors } from "#lib/test-overrides.ts";
import {
  applySecurityHeaders,
  contentTypeRejectionResponse,
  getCleanUrl,
  isEmbeddablePath,
  isValidContentType,
  isWebhookPath,
} from "#routes/middleware.ts";
import { createRouter } from "#routes/router.ts";
import { routeStatic } from "#routes/static.ts";
import type { ServerContext } from "#routes/types.ts";
import {
  htmlResponse,
  jsonResponse,
  normalizePath,
  notFoundResponse,
  parseCookies,
  parseRequest,
  redirectResponse,
  SessionKeyError,
  temporaryErrorResponse,
  withCookie,
} from "#routes/utils.ts";
import { readOnlyPage } from "#templates/public.tsx";

/** Router function type - reuse from router.ts */
type RouterFn = ReturnType<typeof createRouter>;

/** Lazy-load admin routes (only needed for authenticated admin requests) */
const loadAdminRoutes = once(async () => {
  const { routeAdmin } = await import("#routes/admin/index.ts");
  return routeAdmin;
});

/** Lazy-load public page handlers (home, events, terms, contact) */
const loadPublicPages = once(async () => {
  const {
    handleHome,
    handlePublicEvents,
    handlePublicTerms,
    handlePublicContact,
  } = await import("#routes/public/pages.ts");
  return {
    handleHome,
    handlePublicContact,
    handlePublicEvents,
    handlePublicTerms,
  };
});

/** Lazy-load ticket reservation router */
const loadTicketRoutes = once(async () => {
  const { routeTicket } = await import("#routes/public/ticket-routes.ts");
  return routeTicket;
});

/** Lazy-load setup routes */
const loadSetupRoutes = once(async () => {
  const { createSetupRouter } = await import("#routes/setup.ts");
  return createSetupRouter(settings.setup.isComplete);
});

/** Lazy-load payment/webhook routes */
const loadPaymentRoutes = once(async () => {
  const { routePayment } = await import("#routes/webhooks.ts");
  return routePayment;
});

/** Lazy-load join/invite routes */
const loadJoinRoutes = once(async () => {
  const { routeJoin } = await import("#routes/join.ts");
  return routeJoin;
});

/** Lazy-load ticket view routes */
const loadTicketViewRoutes = once(async () => {
  const { routeTicketView } = await import("#routes/tickets.ts");
  return routeTicketView;
});

/** Lazy-load check-in routes */
const loadCheckinRoutes = once(async () => {
  const { routeCheckin } = await import("#routes/checkin.ts");
  return routeCheckin;
});

/** Lazy-load image proxy routes */
const loadImageRoutes = once(async () => {
  const { routeImage } = await import("#routes/images.ts");
  return routeImage;
});

/** Lazy-load feed routes (ICS, RSS) */
const loadFeedRoutes = once(async () => {
  const { routeFeed } = await import("#routes/feeds.ts");
  return routeFeed;
});

/** Lazy-load demo reset routes */
const loadDemoResetRoutes = once(async () => {
  const { routeDatabaseReset } = await import(
    "#routes/admin/database-reset.ts"
  );
  return routeDatabaseReset;
});

/** Lazy-load attachment download routes */
const loadAttachmentRoutes = once(async () => {
  const { attachmentRoutes } = await import("#routes/attachments.ts");
  return createRouter(attachmentRoutes);
});

/** Lazy-load Apple Wallet pass routes */
const loadWalletRoutes = once(async () => {
  const { routeWallet } = await import("#routes/wallet.ts");
  return routeWallet;
});

/** Lazy-load Google Wallet pass routes */
const loadGoogleWalletRoutes = once(async () => {
  const { routeGoogleWallet } = await import("#routes/google-wallet.ts");
  return routeGoogleWallet;
});

/** Lazy-load Apple Wallet web service routes (v1 API for pass updates) */
const loadWalletWebserviceRoutes = once(async () => {
  const { routeWalletWebservice } = await import(
    "#routes/wallet-webservice.ts"
  );
  return routeWalletWebservice;
});

/** Lazy-load public API routes */
const loadApiRoutes = once(async () => {
  const { routeApi } = await import("#routes/api.ts");
  return routeApi;
});

/** Lazy-load admin API routes */
const loadAdminApiRoutes = once(async () => {
  const { adminApiRoutes } = await import("#routes/admin/api.ts");
  return createRouter(adminApiRoutes);
});

export type { PaymentCspConfig } from "#routes/middleware.ts";
// Re-export middleware functions for testing
export {
  buildCspHeader,
  getCleanUrl,
  getSecurityHeaders,
  isEmbeddablePath,
  isValidContentType,
} from "#routes/middleware.ts";

// Re-export types
export type { ServerContext } from "#routes/types.ts";

/** Extract first path segment for O(1) prefix dispatch */
const getPrefix = (path: string): string => {
  const i = path.indexOf("/", 1);
  return i === -1 ? path.slice(1) : path.slice(1, i);
};

/** Create a lazy-loaded route handler (prefix already matched by dispatch map) */
const lazyRoute =
  (load: () => Promise<RouterFn>): RouterFn =>
  async (request, path, method, server) =>
    (await load())(request, path, method, server);

/** Read-only mode message */
const READ_ONLY_MESSAGE = "This site is in read-only mode";

/** Paths that should redirect to /read-only when visited via GET in read-only mode */
const READ_ONLY_GET_PATTERNS = [
  /^\/admin\/event\/new$/,
  /^\/admin\/event\/\d+\/edit$/,
  /^\/admin\/event\/\d+\/duplicate$/,
  /^\/admin\/groups\/new$/,
  /^\/admin\/groups\/\d+\/edit$/,
];

/** Paths that should be blocked when POSTed in read-only mode */
const READ_ONLY_POST_PATTERNS = [
  /^\/ticket\//,
  /^\/admin\/event$/,
  /^\/admin\/event\/\d+\/edit$/,
  /^\/admin\/groups$/,
  /^\/admin\/groups\/\d+\/edit$/,
  /^\/admin\/groups\/\d+\/add-events$/,
  /^\/admin\/event\/\d+\/attendee$/,
];

/**
 * Guard that blocks mutating requests in read-only mode.
 * Returns a response to send, or null to allow the request through.
 */
const readOnlyGuard = (path: string, method: string): Response | null => {
  if (!isReadOnly()) return null;

  // Block all JSON API mutations (POST/PUT/DELETE on /api/*)
  if (path.startsWith("/api/") && method !== "GET" && method !== "OPTIONS") {
    return jsonResponse({ error: true, message: READ_ONLY_MESSAGE }, 403);
  }

  // Block GET pages for create/edit forms
  if (method === "GET") {
    for (const pattern of READ_ONLY_GET_PATTERNS) {
      if (pattern.test(path)) return redirectResponse("/read-only");
    }
  }

  // Block form POSTs for create/edit actions
  if (method === "POST") {
    for (const pattern of READ_ONLY_POST_PATTERNS) {
      if (pattern.test(path)) return redirectResponse("/read-only");
    }
  }

  return null;
};

type PublicPagesModule = Awaited<ReturnType<typeof loadPublicPages>>;

/** Exact path for a single-segment public page (must stay aligned with getPrefix) */
const publicPagePath = (prefix: string): string =>
  prefix === "" ? "/" : `/${prefix}`;

type PublicGetPageSpec = {
  prefix: string;
  pick: (pages: PublicPagesModule) => () => Response | Promise<Response>;
};

const PUBLIC_GET_PAGES: PublicGetPageSpec[] = [
  { pick: (p) => p.handleHome, prefix: "" },
  { pick: (p) => p.handlePublicEvents, prefix: "events" },
  { pick: (p) => p.handlePublicTerms, prefix: "terms" },
  { pick: (p) => p.handlePublicContact, prefix: "contact" },
];

const publicPageHandlers = reduce(
  (acc: Record<string, RouterFn>, spec: PublicGetPageSpec) => {
    const { prefix, pick } = spec;
    const path = publicPagePath(prefix);
    acc[prefix] = async (_request, reqPath, method) => {
      if (reqPath !== path || method !== "GET") return null;
      return pick(await loadPublicPages())();
    };
    return acc;
  },
  {},
)(PUBLIC_GET_PAGES);

/** Prefix dispatch table — O(1) lookup replaces the sequential ?? chain */
const prefixHandlers: Record<string, RouterFn> = {
  ...publicPageHandlers,
  // Prefix-matched lazy-loaded route groups
  admin: lazyRoute(loadAdminRoutes),
  api: async (request, path, method, server) => {
    // Admin API is always available (auth-protected)
    const adminResult = await (await loadAdminApiRoutes())(
      request,
      path,
      method,
      server,
    );
    if (adminResult) return adminResult;
    // Public API requires feature flag
    return settings.showPublicApi
      ? (await loadApiRoutes())(request, path, method, server)
      : null;
  },
  attachment: lazyRoute(loadAttachmentRoutes),
  checkin: lazyRoute(loadCheckinRoutes),
  demo: lazyRoute(loadDemoResetRoutes),
  feeds: lazyRoute(loadFeedRoutes),
  gwallet: lazyRoute(loadGoogleWalletRoutes),
  image: lazyRoute(loadImageRoutes),
  join: lazyRoute(loadJoinRoutes),
  payment: lazyRoute(loadPaymentRoutes),
  "read-only": (_request, path, method) =>
    path === "/read-only" && method === "GET"
      ? Promise.resolve(htmlResponse(readOnlyPage()))
      : Promise.resolve(null),
  t: lazyRoute(loadTicketViewRoutes),
  ticket: lazyRoute(loadTicketRoutes),
  v1: lazyRoute(loadWalletWebserviceRoutes),
  wallet: lazyRoute(loadWalletRoutes),
};

/**
 * Route main application requests (after setup is complete)
 * Uses prefix dispatch for O(1) route group lookup instead of sequential matching
 */
const routeMainApp: RouterFn = async (request, path, method, server) => {
  const blocked = readOnlyGuard(path, method);
  if (blocked) return blocked;

  const prefix = getPrefix(path);
  if (!Object.hasOwn(prefixHandlers, prefix)) return notFoundResponse();
  return (
    (await prefixHandlers[prefix]?.(request, path, method, server)) ??
    notFoundResponse()
  );
};

/**
 * Handle incoming requests (internal, without security headers)
 * Uses path-based lazy loading to minimize cold start time
 */
const handleRequestInternal = async (
  request: Request,
  path: string,
  method: string,
  server?: ServerContext,
): Promise<Response> => {
  // Static routes always available (minimal overhead)
  const staticResponse = await routeStatic(request, path, method);
  if (staticResponse) return staticResponse;

  // Setup routes - only load for /setup paths
  if (path === "/setup" || path.startsWith("/setup/")) {
    const routeSetup = await loadSetupRoutes();
    const setupResponse = await routeSetup(request, path, method);
    if (setupResponse) return setupResponse;
  }

  // Require setup before accessing other routes
  if (!(await settings.setup.isComplete())) {
    return redirectResponse("/setup");
  }

  return (await routeMainApp(request, path, method, server))!;
};

/** Log request and return response */
const logAndReturn = (
  response: Response,
  method: string,
  path: string,
  getElapsed: () => number,
): Response => {
  logRequest({
    durationMs: getElapsed(),
    method,
    path,
    status: response.status,
  });
  return response;
};

/**
 * Buffer POST bodies BEFORE entering async context wrappers. The Bunny Edge
 * runtime can garbage-collect the underlying request body resource during
 * awaits, so we must capture it while the resource is still alive.
 * This applies to webhook bodies (JSON) and multipart form uploads (file
 * data backed by Blob resources that are especially prone to GC).
 * Use normalizePath on the raw pathname so trailing-slash variants like
 * /payment/webhook/ are correctly detected (the router normalizes later,
 * but by then the body resource may already be garbage-collected).
 */
const bufferRequestIfNeeded = async (request: Request): Promise<Request> => {
  const { pathname } = new URL(request.url);
  const contentType = request.headers.get("content-type") ?? "";
  const needsBodyBuffer =
    request.method === "POST" &&
    (isWebhookPath(normalizePath(pathname)) ||
      contentType.startsWith("multipart/form-data"));
  if (!needsBodyBuffer) return request;
  const bufferedBody = new Uint8Array(await request.arrayBuffer());
  return new Request(request.url, {
    body: bufferedBody,
    headers: request.headers,
    method: request.method,
  });
};

/**
 * If the GET URL contains tracking parameters (fbclid, utm_*, etc.), return a
 * 301 redirect to a clean URL so the CDN can cache it.
 */
const trackingParamRedirect = (url: URL, method: string): Response | null => {
  if (method !== "GET") return null;
  const cleanUrl = getCleanUrl(url);
  if (!cleanUrl) return null;
  return new Response(null, {
    headers: { location: cleanUrl },
    status: 301,
  });
};

/**
 * Populate flash context from keyed cookie (flash ID in URL).
 * Returns flashId when a flash was set so the caller can clear the cookie later.
 */
const applyFlashFromCookie = (request: Request): string | null => {
  const flashId = new URL(request.url).searchParams.get("flash");
  const flashRaw = flashId
    ? parseCookies(request).get(`flash_${flashId}`)
    : null;
  const flash = flashRaw ? parseFlashValue(flashRaw) : null;
  if (flash) setFlashContext(flash);
  return flash ? flashId : null;
};

/**
 * Run settings load, schedule pruning, resolve effective domain.
 * These are per-request setup tasks that must happen before routing.
 */
const prepareRequestEnvironment = async (request: Request): Promise<void> => {
  // Ensure settings cache is populated before reading custom domain.
  // loadAll() is a no-op when the cache is still valid (60 s TTL).
  await settings.loadAll();

  // Schedule DB pruning as fire-and-forget pending work. Each
  // prune task self-guards via its last_pruned_* timestamp, so
  // this is near-free on most requests.
  addPendingWork(maybeRunPrunes());

  // Load effective domain (custom_domain from DB if set, else request hostname)
  loadEffectiveDomain(request.url);
};

/** Route the request and attach security headers / flash cookie clearing */
const routeAndFinalize = async (
  request: Request,
  path: string,
  method: string,
  server: ServerContext | undefined,
): Promise<Response> => {
  const embeddable = isEmbeddablePath(path);
  const consumedFlashId = applyFlashFromCookie(request);

  const response = await handleRequestInternal(request, path, method, server);

  // Clear keyed flash cookie if one was consumed
  if (consumedFlashId && hasFlash()) {
    withCookie(response, clearFlashCookie(consumedFlashId));
  }

  return applySecurityHeaders(response, embeddable);
};

/**
 * Convert a thrown error from the routing pipeline into a response, honoring
 * the test rethrow flag and SessionKeyError special case.
 */
const handleRoutingError = (
  error: unknown,
  method: string,
  path: string,
): Response => {
  logError({
    code: ErrorCode.CDN_REQUEST,
    detail: formatRequestError(method, path, error),
  });
  // In tests, surface the real error instead of swallowing it
  // behind a generic "Temporary Error" page
  if (
    getRethrowErrors() &&
    !(error instanceof SessionKeyError) &&
    !Deno.env.get("TEST_EXPECT_ERROR")
  ) {
    throw error;
  }
  if (error instanceof SessionKeyError) {
    return redirectResponse("/admin", clearSessionCookie());
  }
  return temporaryErrorResponse();
};

/**
 * The core request pipeline that runs inside all async context wrappers.
 * Performs parsing, early redirects, content-type validation, routing,
 * error handling, and logging.
 */
const processRequest = async (
  effectiveRequest: Request,
  server: ServerContext | undefined,
): Promise<Response> => {
  const { url, path, method } = parseRequest(effectiveRequest);
  const getElapsed = createRequestTimer();
  detectIframeMode(effectiveRequest.url);
  clearSavedFormData();

  try {
    const trackingRedirect = trackingParamRedirect(url, method);
    if (trackingRedirect) {
      return logAndReturn(trackingRedirect, method, path, getElapsed);
    }

    await prepareRequestEnvironment(effectiveRequest);

    // Content-Type validation: reject POST requests without proper Content-Type
    // (webhook endpoints accept JSON, all others require form-urlencoded)
    if (!isValidContentType(effectiveRequest, path)) {
      return logAndReturn(
        contentTypeRejectionResponse(),
        method,
        path,
        getElapsed,
      );
    }

    try {
      const response = await routeAndFinalize(
        effectiveRequest,
        path,
        method,
        server,
      );
      return logAndReturn(response, method, path, getElapsed);
    } catch (error) {
      return logAndReturn(
        handleRoutingError(error, method, path),
        method,
        path,
        getElapsed,
      );
    }
  } finally {
    await flushPendingWork();
  }
};

/**
 * Handle incoming requests with security headers and domain validation
 */
export const handleRequest = async (
  request: Request,
  server?: ServerContext,
): Promise<Response> => {
  const effectiveRequest = await bufferRequestIfNeeded(request);

  return runWithRequestId(() =>
    runWithRequestCache(() =>
      runWithQueryLogContext(() =>
        runWithFlashContext(() =>
          runWithSessionContext(() => processRequest(effectiveRequest, server)),
        ),
      ),
    ),
  );
};
